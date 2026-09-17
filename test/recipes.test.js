import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../lib/config.js'
import { STATUS } from '../lib/engine.js'
import { classifyScript } from '../lib/risk.js'
import { RecipeError, loadRecipes, runRecipe, validateRecipe } from '../lib/recipes.js'
import { runProcess } from '../lib/spawn.js'

const emptyEnv = { HOME: '/nonexistent-dsh-vps', DSH_HOME: '/nonexistent-dsh-vps/.dsh' }

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-rec-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await mkdir(paths(env).recipesDir, { recursive: true })
  const runner = (alias, payload, opts = {}) =>
    runProcess('sh', ['-s'], {
      input: payload,
      env: { ...process.env, HOME: home },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    })
  return { home, env, runner }
}

test('内置菜谱全部通过校验', async () => {
  const { list, errors, conflicts } = await loadRecipes({ env: emptyEnv })
  assert.deepEqual(errors, [])
  assert.deepEqual(conflicts, [])
  assert.ok(list.length >= 10, '内置菜谱数量')
  assert.equal(new Set(list.map((r) => r.id)).size, list.length, 'id 不能重复')
  for (const r of list) {
    assert.ok(r.name && r.desc, `${r.id} 要有名称和说明`)
    for (const p of r.params) assert.ok(p.pattern, `${r.id} 的参数必须有 pattern`)
    if (r.kind !== 'query') {
      assert.equal(r.incomplete, false, `${r.id} 必须写 detect 和 verify`)
      assert.ok(r.plan, `${r.id} 要有给人看的 plan`)
    }
  }
})

test('内置查询菜谱不允许含高危写法（CI 闸门）', async () => {
  const { list } = await loadRecipes({ env: emptyEnv })
  for (const r of list.filter((x) => x.kind === 'query')) {
    assert.equal(r.tier, 'read', `${r.id} 查询类必须是只读档`)
    const c = classifyScript(`${r.run}\n${r.detect}\n${r.verify}`)
    assert.notEqual(c.tier, 'danger', `${r.id} 的脚本命中了高危规则：${JSON.stringify(c.dangers)}`)
  }
})

test('菜谱里不许写 `$SUDO VAR=值 命令`（root 登录时 $SUDO 为空，会被当成命令名）', async () => {
  // 真机实测：vps-dsh（root 登录）上 system-update 以 127 失败，日志只有一行
  // `DEBIAN_FRONTEND=noninteractive: not found` —— 赋值前缀必须是字面量，
  // 经过 $SUDO 展开之后 shell 已经不把它当赋值了。正确写法是 $SUDO env VAR=值 命令。
  const { list } = await loadRecipes({ env: emptyEnv })
  const { readFile } = await import('node:fs/promises')
  const prelude = await readFile(new URL('../lib/prelude.sh', import.meta.url), 'utf8')
  const bad = /\$(?:SUDO|SUDO_OPT)\s+[A-Za-z_][A-Za-z_0-9]*=/
  // 前导脚本（pkg_install 等）每条菜谱都会用到，一起扫
  for (const r of [...list, { id: 'prelude.sh', run: prelude }]) {
    for (const [field, script] of [['detect', r.detect], ['run', r.run], ['verify', r.verify]]) {
      const hit = String(script ?? '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('#')) // 注释里写反例是允许的
        .find((line) => bad.test(line))
      assert.equal(hit, undefined, `${r.id} 的 ${field} 里有 $SUDO 后接赋值：${hit}　改成 $SUDO env VAR=值 命令`)
    }
  }
})

test('菜谱校验拦住常见错误', () => {
  const base = { id: 'x-thing', kind: 'install', run: 'echo hi' }
  assert.ok(validateRecipe(base))
  assert.throws(() => validateRecipe({ ...base, id: 'Bad Id' }), (e) => e instanceof RecipeError && e.code === 'invalid_id')
  assert.throws(() => validateRecipe({ ...base, kind: 'whatever' }), (e) => e.code === 'invalid_kind')
  assert.throws(() => validateRecipe({ ...base, run: undefined }), (e) => e.code === 'missing_run')
  assert.throws(() => validateRecipe({ ...base, kind: 'query', risk: 'change' }), (e) => e.code === 'invalid_risk')
  assert.throws(() => validateRecipe({ ...base, params: [{ name: 'domain' }] }), (e) => e.code === 'invalid_param')
  assert.throws(() => validateRecipe({ ...base, params: [{ name: 'domain', pattern: '[' }] }), (e) => e.code === 'invalid_param')
  assert.throws(() => validateRecipe({ ...base, timeout: 99999 }), (e) => e.code === 'invalid_timeout')
})

test('用户菜谱：档位取更严的，且不能覆盖内置', async () => {
  const { env } = await sandbox()
  await writeFile(join(paths(env).recipesDir, 'mine.yml'), [
    'schema: 1',
    'recipes:',
    '  - id: my-cleanup',
    '    kind: config',
    '    name: 清理',
    '    desc: 自己写的',
    '    risk: change',
    '    detect: "false"',
    '    verify: "true"',
    '    run: rm -rf /var/log/old',
    '  - id: install-docker',
    '    kind: install',
    '    name: 冒充内置',
    '    run: echo evil',
  ].join('\n'))

  const { byId, conflicts } = await loadRecipes({ env })
  const mine = byId.get('my-cleanup')
  assert.equal(mine.source, 'mine')
  assert.equal(mine.risk, 'change', '声明的是 change')
  assert.equal(mine.tier, 'danger', '静态判定 rm -rf 是高危，取更严的')
  assert.equal(conflicts.length, 1)
  assert.match(conflicts[0].message, /与内置菜谱同名/)
  assert.equal(byId.get('install-docker').source, 'builtin', '内置的不能被顶掉')
})

test('执行流程：未装 → 安装 → 验证', async () => {
  const { env, runner } = await sandbox()
  await writeFile(join(paths(env).recipesDir, 'flow.yml'), [
    'schema: 1',
    'recipes:',
    '  - id: my-flow',
    '    kind: install',
    '    name: 测试菜谱',
    '    desc: 用标记文件模拟安装',
    '    timeout: 20',
    '    detect: test -f "$HOME/.installed"',
    '    plan: 建立标记文件',
    '    run: |',
    '      touch "$HOME/.installed"',
    '      echo 安装完成',
    '    verify: test -f "$HOME/.installed" && echo 验证通过',
  ].join('\n'))
  const { byId } = await loadRecipes({ env })
  const recipe = byId.get('my-flow')

  const first = await runRecipe({ recipe, alias: 'hk', runner, env })
  assert.equal(first.detect, 'absent')
  assert.equal(first.phase, 'verify')
  assert.equal(first.ok, true)
  assert.match(first.runResult.stdout, /安装完成/)
  assert.match(first.verifyResult.stdout, /验证通过/)

  // 第二次：已装就不重复装
  const second = await runRecipe({ recipe, alias: 'hk', runner, env })
  assert.equal(second.detect, 'installed')
  assert.equal(second.ok, true)
  assert.match(second.hint, /已经装好了/)
  assert.equal(second.runResult, undefined, '不应再执行 run')
})

test('detect 说不清时停下来问人，不猜着装', async () => {
  const { env, runner } = await sandbox()
  const recipe = validateRecipe({
    id: 'my-unknown',
    kind: 'install',
    name: '检测不明',
    detect: 'exit 127',
    run: 'echo 不该执行到这里',
    verify: 'true',
  })
  const res = await runRecipe({ recipe, alias: 'hk', runner, env })
  assert.equal(res.detect, 'unknown')
  assert.equal(res.ok, false)
  assert.match(res.hint, /无法判断/)
  assert.equal(res.runResult, undefined)
})

test('已知权限不足时，连都不用连就能说清原因', async () => {
  const { env } = await sandbox()
  let called = false
  const runner = async () => {
    called = true
    return { stdout: '', stderr: '', exitCode: 0 }
  }
  const recipe = validateRecipe({
    id: 'my-need-root',
    kind: 'install',
    name: '要 root',
    requires: { privilege: 'root' },
    detect: 'false',
    run: 'echo x',
    verify: 'true',
  })
  const res = await runRecipe({ recipe, alias: 'hk', runner, env, facts: { privilege: 'none' } })
  assert.equal(res.status, STATUS.noPrivilege)
  assert.equal(called, false)
})

test('系统不适用时提前拦下', async () => {
  const { env } = await sandbox()
  const recipe = validateRecipe({
    id: 'my-debian-only',
    kind: 'install',
    name: '只支持 debian',
    requires: { os: ['debian'] },
    detect: 'false',
    run: 'echo x',
    verify: 'true',
  })
  const res = await runRecipe({ recipe, alias: 'hk', runner: async () => ({ stdout: '', stderr: '', exitCode: 0 }), env, facts: { osFamily: 'alpine', osId: 'alpine' } })
  assert.equal(res.status, STATUS.requiresUnmet)
  assert.match(res.hint, /不支持 alpine/)
})

test('detect 把服务「未运行」这类退出码当作未装，不当成说不清', async () => {
  const { env, runner } = await sandbox()
  // systemctl is-active 对未运行的服务返回 3
  const r3 = validateRecipe({ id: 'my-exit3', kind: 'install', name: 'x', detect: 'exit 3', run: 'echo x', verify: 'true' })
  const res3 = await runRecipe({ recipe: r3, alias: 'hk', runner, env })
  assert.equal(res3.detect, 'absent')
  // 命令找不到（127）仍然是说不清：可能是脚本写错了
  const r127 = validateRecipe({ id: 'my-exit127', kind: 'install', name: 'x', detect: 'exit 127', run: 'echo x', verify: 'true' })
  const res127 = await runRecipe({ recipe: r127, alias: 'hk', runner, env })
  assert.equal(res127.detect, 'unknown')
})
