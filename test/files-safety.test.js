import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATUS } from '../lib/engine.js'
import { assertWriteTarget, writeRemoteFile } from '../lib/files.js'
import { armSafetyNet, buildSummary, disarmSafetyNet, gate, needsApproval, testFreshConnection } from '../lib/safety.js'
import { readAudit } from '../lib/audit.js'
import { runProcess } from '../lib/spawn.js'

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-fs-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
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

test('写文件路径校验', () => {
  assert.equal(assertWriteTarget({ path: '/etc/nginx/a.conf' }), '/etc/nginx/a.conf')
  assert.throws(() => assertWriteTarget({ path: 'relative/x' }), (e) => e.code === 'path_invalid')
  assert.throws(() => assertWriteTarget({ path: '/etc/../root/x' }), (e) => e.code === 'path_invalid')
  assert.throws(() => assertWriteTarget({ path: '/etc/x', mode: '7778' }), (e) => e.code === 'mode_invalid')
  assert.throws(() => assertWriteTarget({ path: '/etc/x', owner: 'root; rm -rf /' }), (e) => e.code === 'owner_invalid')
})

test('写新文件：内容正确、权限正确、备份说明清楚', async () => {
  const { home, env, runner } = await sandbox()
  const target = join(home, 'etc', 'app.conf')
  await mkdir(join(home, 'etc'), { recursive: true })

  const res = await writeRemoteFile({
    alias: 'hk',
    path: target,
    content: "server {\n  listen 80;\n  server_name a.com; # 带引号和分号的内容\n}\n",
    mode: '644',
    taskId: 'write-test-1',
    runner,
    env,
  })
  assert.equal(res.status, STATUS.done, res.stdout)
  assert.equal(await readFile(target, 'utf8'), "server {\n  listen 80;\n  server_name a.com; # 带引号和分号的内容\n}\n")
  assert.match(res.stdout, /目标文件原本不存在/)
  assert.equal(res.backupPath, null)
})

test('覆盖已有文件会先备份，备份不落在原目录', async () => {
  const { home, env, runner } = await sandbox()
  const dir = join(home, 'etc', 'nginx', 'sites-enabled')
  await mkdir(dir, { recursive: true })
  const target = join(dir, 'a.com')
  await writeFile(target, '原始内容\n', { mode: 0o640 })
  await chmod(target, 0o640) // 创建时会被 umask 削掉，这里定死

  const res = await writeRemoteFile({
    alias: 'hk',
    path: target,
    content: '新内容\n',
    taskId: 'write-test-2',
    runner,
    env,
  })
  assert.equal(res.status, STATUS.done)
  assert.equal(await readFile(target, 'utf8'), '新内容\n')
  assert.ok(res.backupPath, '应给出备份路径')
  assert.match(res.backupPath, /\.cache\/dsh-vps\/backups\//, '备份必须放在专用目录，不能落在原目录')
  assert.equal(await readFile(res.backupPath, 'utf8'), '原始内容\n')
  assert.ok(res.restoreCommand.includes(res.backupPath))

  assert.equal((await stat(target)).mode & 0o777, 0o640, '覆盖之后权限要和原文件一样')

  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(dir), ['a.com'], '原目录里不能多出备份或临时文件')
})

test('校验不通过时自动还原原文件', async () => {
  const { home, env, runner } = await sandbox()
  const dir = join(home, 'etc')
  await mkdir(dir, { recursive: true })
  const target = join(dir, 'nginx.conf')
  await writeFile(target, '好的配置\n')

  const res = await writeRemoteFile({
    alias: 'hk',
    path: target,
    content: '坏的配置\n',
    validate: 'grep -q 好的 "$TARGET"', // 故意让校验失败
    taskId: 'write-test-3',
    runner,
    env,
  })
  assert.equal(res.status, STATUS.failed)
  assert.match(res.stdout, /校验没通过，正在还原/)
  assert.equal(await readFile(target, 'utf8'), '好的配置\n', '必须还原成原样')
})

test('生效命令失败时同样还原', async () => {
  const { home, env, runner } = await sandbox()
  await mkdir(join(home, 'etc'), { recursive: true })
  const target = join(home, 'etc', 'svc.conf')
  await writeFile(target, 'old\n')

  const res = await writeRemoteFile({
    alias: 'hk',
    path: target,
    content: 'new\n',
    validate: 'true',
    after: 'false',
    taskId: 'write-test-4',
    runner,
    env,
  })
  assert.equal(res.status, STATUS.failed)
  assert.match(res.stdout, /生效命令失败，正在还原/)
  assert.equal(await readFile(target, 'utf8'), 'old\n')
})

test('确认矩阵：谁自动、谁要问', () => {
  assert.equal(needsApproval('read', 'careful'), false)
  assert.equal(needsApproval('change', 'careful'), true)
  assert.equal(needsApproval('danger', 'careful'), true)
  assert.equal(needsApproval('change', 'relaxed'), false)
  assert.equal(needsApproval('danger', 'relaxed'), true)
  assert.equal(needsApproval('danger', 'auto'), false)
})

test('确认摘要是一句话，带机器、级别和哈希', () => {
  const s = buildSummary({
    label: '[hk · 1.2.3.4 · 生产]',
    tier: 'danger',
    action: 'ufw default deny incoming',
    detail: '连通性保险 120 秒',
    hash: 'a1b2c3d4e5f6',
  })
  assert.match(s, /^\[hk · 1\.2\.3\.4 · 生产\] ⚠ 高危/)
  assert.match(s, /连通性保险/)
  assert.match(s, /a1b2c3d4/)
  assert.ok(s.length <= 300)
})

test('没有审批界面时，改动类一律拒绝（失败关闭）', async () => {
  const { env } = await sandbox()
  const res = await gate({
    ctx: {},
    tier: 'change',
    confirmLevel: 'careful',
    summary: '改点东西',
    audit: { source: 'ai', alias: 'hk', action: 'exec' },
    env,
  })
  assert.equal(res.allowed, false)
  assert.equal(res.decision, 'unavailable')
  assert.match(res.hint, /无头|自动化/)

  const rows = await readAudit({ env })
  assert.equal(rows[0].decision, 'unavailable')
  assert.equal(rows[0].finalTier, 'change')
})

/** 仿 cordis 宿主：没 inject 就读 ctx.approval 会抛，只能 ctx.get('approval')；结果词汇照真实 dsh-user-approval */
function hostWithApproval(request) {
  const approval = { request }
  return Object.defineProperty({ get: (name) => (name === 'approval' ? approval : undefined) }, 'approval', {
    get() { throw new Error('cannot get property "approval" without inject') },
  })
}

test('用户点允许就放行；全自动档根本不问', async () => {
  const { env } = await sandbox()
  let asked = 0
  const ctx = hostWithApproval(async () => { asked += 1; return 'allowed-once' })

  const allowed = await gate({ ctx, tier: 'danger', confirmLevel: 'careful', summary: 'x', env })
  assert.equal(allowed.allowed, true)
  assert.equal(asked, 1)

  const auto = await gate({ ctx, tier: 'danger', confirmLevel: 'auto', summary: 'x', env })
  assert.equal(auto.allowed, true)
  assert.equal(auto.decision, 'auto')
  assert.equal(asked, 1, '全自动档不应再问')

  const denied = await gate({
    ctx: hostWithApproval(async () => 'rejected'),
    tier: 'change',
    confirmLevel: 'careful',
    summary: 'x',
    env,
  })
  assert.equal(denied.allowed, false)
  assert.equal(denied.decision, 'deny')
})

test('连通性保险：埋下的恢复任务会按时触发，取消后就不会', async () => {
  const { home, env, runner } = await sandbox()
  const marker = join(home, 'reverted')

  const armed = await armSafetyNet({ restore: `touch ${marker}`, seconds: 2, alias: 'hk', runner, env })
  assert.ok(armed.pid, '应拿到恢复任务的进程号')
  await new Promise((r) => setTimeout(r, 4500))
  await access(marker) // 到点自动恢复

  const marker2 = join(home, 'reverted2')
  const armed2 = await armSafetyNet({ restore: `touch ${marker2}`, seconds: 3, alias: 'hk', runner, env })
  await disarmSafetyNet({ pid: armed2.pid, alias: 'hk', runner, env })
  await new Promise((r) => setTimeout(r, 4500))
  await assert.rejects(access(marker2), '取消后不该再恢复')
})

test('全新连接测试走的是不复用的连接', async () => {
  const { env, runner } = await sandbox()
  const seen = []
  const spyRunner = (alias, payload, opts) => {
    seen.push(opts.controlMaster)
    return runner(alias, payload, opts)
  }
  const res = await testFreshConnection({ alias: 'hk', runner: spyRunner, env, attempts: 1 })
  assert.equal(res.ok, true)
  assert.deepEqual(seen, [false], '必须绕开 ControlMaster 复用')
})
