import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHosts } from '../lib/config.js'
import { registerCommands } from '../lib/commands.js'
import { apply } from '../lib/index.js'
import { runProcess } from '../lib/spawn.js'
import { buildToolDefinitions } from '../lib/tools.js'

function fakeCtx({ approval } = {}) {
  const tools = []
  const commands = []
  const skills = []
  const guards = []
  const listeners = []
  const injected = new Map()
  // 仿 cordis：没在 inject 里声明就直接读 skills / agents，会抛（DSH 实测报错原文）
  const services = {
    skills: { register: (def) => { skills.push(def); return () => {} } },
    commands: { register: (def) => { commands.push(def); return () => {} } },
  }
  const scoped = (names) => new Proxy({}, {
    get(_t, key) {
      if (key === 'on') return (event, fn, opts) => { listeners.push({ event, fn, opts }); return () => {} }
      if (key in services) {
        if (!names.includes(key)) throw new Error(`cannot get property "${key}" without inject`)
        return services[key]
      }
      return undefined
    },
  })
  const ctx = {
    tools: {
      register: (def) => { tools.push(def); return () => {} },
      guard: (fn) => { guards.push(fn); return () => {} },
    },
    approval: approval ? { request: approval } : undefined,
    logger: { warn: (m) => ctx._warnings.push(m) },
    inject(names, cb) {
      injected.set(names.join(','), cb)
      // commands / skills / agents 立即回调（模拟服务已挂载），webServer 不回调（模拟 headless）
      if (!names.includes('webServer')) cb(scoped(names))
    },
    _tools: tools,
    _commands: commands,
    _skills: skills,
    _guards: guards,
    _listeners: listeners,
    _injected: injected,
    _warnings: [],
  }
  for (const key of ['skills', 'commands']) {
    Object.defineProperty(ctx, key, { get() { throw new Error(`cannot get property "${key}" without inject`) } })
  }
  return ctx
}

/** 仿 cordis 宿主：没 inject 就读 ctx.approval 会抛，只能 ctx.get('approval')；结果词汇照真实 dsh-user-approval */
function hostWithApproval(request) {
  const approval = { request }
  return Object.defineProperty({ get: (name) => (name === 'approval' ? approval : undefined) }, 'approval', {
    get() { throw new Error('cannot get property "approval" without inject') },
  })
}

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-wire-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: 'hk', hosts: { hk: { note: '香港', group: '生产' } } }, env)
  const sshConfig = join(home, 'ssh_config')
  await writeFile(sshConfig, 'Host hk\n  HostName 1.2.3.4\n  Port 22\n  User root\n')
  const runner = (alias, payload, opts = {}) =>
    runProcess('sh', ['-s'], {
      input: payload,
      env: { ...process.env, HOME: home },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    })
  return { home, env, runner, sshOptions: { configFile: sshConfig } }
}

test('apply：5 个工具、21 条命令、1 个 skill、本机 bash 守卫、VPS 模式监听，全部注册成功', async () => {
  const ctx = fakeCtx()
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-apply-'))
  apply(ctx, { env: { HOME: home, DSH_HOME: join(home, '.dsh') } })
  await new Promise((r) => setTimeout(r, 100)) // 工具与 skill 是异步注册

  // 注册失败只会进日志，所以日志里不能有任何「失败」
  assert.deepEqual(ctx._warnings, [], `注册时有警告：${ctx._warnings.join(' | ')}`)

  assert.deepEqual(ctx._tools.map((t) => t.name).sort(), [
    'vps_exec', 'vps_hosts', 'vps_recipe', 'vps_task', 'vps_write_file',
  ])
  const names = ctx._commands.map((c) => c.name)
  assert.equal(names.length, 21, names.join(','))
  for (const n of names) assert.match(n, /^vps-/, '所有命令必须同前缀，否则打 /vps 只筛出一半')
  assert.equal(ctx._skills.length, 1)
  assert.match(ctx._skills[0].name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'DSH 的 skill 名规则')
  assert.ok(ctx._skills[0].description.length > 0)
  assert.equal(ctx._skills[0].invocation.modelInvocable, true)
  assert.equal(ctx._skills[0].invocation.userInvocable, false)
  assert.equal(ctx._guards.length, 1, '本机 bash 守卫要挂上')
  assert.deepEqual(ctx._listeners.map((l) => [l.event, l.opts?.prepend]), [['agent/pre-step', true]])
  assert.ok(ctx._injected.has('webServer'), 'webServer 必须走 inject，headless 下不注册')
  assert.ok(ctx._injected.has('skills') && ctx._injected.has('agents'), 'skills 与 agents 必须走 inject')
})

test('工具层：没有审批就拒绝改动，用户允许后才执行', async () => {
  const { env, runner, sshOptions } = await sandbox()
  const asked = []

  const denyCtx = hostWithApproval(async (req) => { asked.push(req); return 'rejected' })
  const [defs1, defs2] = await Promise.all([
    buildToolDefinitions(denyCtx, { env, runner }),
    buildToolDefinitions(hostWithApproval(async (req) => { asked.push(req); return 'allowed-once' }), { env, runner }),
  ])
  const denyExec = defs1.find((d) => d.name === 'vps_exec')
  const allowExec = defs2.find((d) => d.name === 'vps_exec')

  const denied = await denyExec.execute(
    { host: 'hk', script: 'mkdir -p /tmp/dsh-vps-should-not-exist', intent: 'change', reason: '建目录' },
    { agent: 'a', callId: 'c1', signal: undefined },
  )
  assert.equal(denied.ok, false)
  assert.equal(denied.status, 'denied')
  assert.equal(denied.tier, 'change')
  assert.match(asked[0].reason, /改动：建目录/)
  assert.equal(asked[0].toolName, 'vps_exec', '真实 dsh-user-approval 读的是 toolName')
  assert.equal(asked[0].tool, undefined)

  const allowed = await allowExec.execute(
    { host: 'hk', script: 'echo 执行了', intent: 'change', reason: '测试' },
    { agent: 'a', callId: 'c2' },
  )
  assert.equal(allowed.ok, true, allowed.hint)
  assert.match(allowed.output, /执行了/)
})

test('工具层：只读脚本不弹确认', async () => {
  const { env, runner } = await sandbox()
  let asked = 0
  const ctx = hostWithApproval(async () => { asked += 1; return 'allowed-once' })
  const defs = await buildToolDefinitions(ctx, { env, runner })
  const exec = defs.find((d) => d.name === 'vps_exec')
  const res = await exec.execute({ host: 'hk', script: 'uname -s; id -u', intent: 'read' }, { agent: 'a', callId: 'c3' })
  assert.equal(res.tier, 'read')
  assert.equal(res.ok, true)
  assert.equal(asked, 0, '只读不该打扰用户')
})

test('工具层：未登记的机器直接拒绝，不会连出去', async () => {
  const { env, runner } = await sandbox()
  const defs = await buildToolDefinitions({}, { env, runner })
  const exec = defs.find((d) => d.name === 'vps_exec')
  await assert.rejects(
    exec.execute({ host: 'nope', script: 'echo hi', intent: 'read' }, { agent: 'a', callId: 'c4' }),
    /没有登记过这台机器/,
  )
})

test('命令层：查询命令直接出结果，抬头写清楚是哪台机器', async () => {
  const { env, runner, sshOptions } = await sandbox()
  const registered = []
  const ctx = { commands: { register: (def) => { registered.push(def); return () => {} } } }
  registerCommands(ctx, { env, runner, sshOptions })

  const sysinfo = registered.find((c) => c.name === 'vps-sysinfo')
  const res = await sysinfo.handler({ rawInput: '-h hk' })
  assert.equal(res.kind, 'success', res.text)
  assert.match(res.text, /^\[hk/, '第一行必须是机器抬头')
  assert.match(res.text, /系统:/)

  const list = registered.find((c) => c.name === 'vps-list')
  // ★ 标的是「这个对话绑定的」，不是全局当前机器（没绑定就没有 ★）
  const unbound = await list.handler({ rawInput: '', agent: { session: { id: 'sess-list' } } })
  assert.equal(unbound.text.split('\n')[0], '1 台机器 · 这个对话没有绑定机器')
  assert.doesNotMatch(unbound.text, /★/)
  await registered.find((c) => c.name === 'vps-use').handler({ rawInput: 'hk', agent: { session: { id: 'sess-list' } } })
  const listed = await list.handler({ rawInput: '', agent: { session: { id: 'sess-list' } } })
  assert.equal(listed.text.split('\n')[0], '1 台机器 · 这个对话绑定 hk（★）')
  assert.match(listed.text, /★ .*hk/)
})

test('命令层：/vps-install 不加 --yes 只出计划，不执行', async () => {
  const { env, runner, home } = await sandbox()
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner })
  const install = registered.find((c) => c.name === 'vps-install')

  const plan = await install.handler({ rawInput: 'install-nginx -h hk' })
  assert.equal(plan.kind, 'success')
  assert.match(plan.text, /计划：/)
  assert.match(plan.text, /脚本：/)
  assert.match(plan.text.split('\n')[0], /确认发 \/vps-yes/, '第一行必须告诉用户怎么确认')
  assert.match(plan.text, /检测结果/)

  const bad = await install.handler({ rawInput: '' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /用法/)
})

test('命令层：没指定机器且没有当前机器时，提示怎么办', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-empty-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env })
  const res = await registered.find((c) => c.name === 'vps-sysinfo').handler({ rawInput: '' })
  assert.equal(res.kind, 'error')
  assert.match(res.text, /还没有添加机器/)
})

test('/vps-help 必须列出全部命令（新增命令漏写会在这里失败）', async () => {
  const { env, runner } = await sandbox()
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner })

  const help = await registered.find((c) => c.name === 'vps-help').handler({ rawInput: '' })
  assert.equal(help.kind, 'success')

  const missing = registered.map((c) => `/${c.name}`).filter((n) => !help.text.includes(n))
  assert.deepEqual(missing, [], `这些命令没出现在 /vps-help 里：${missing.join('、')}`)

  // 首行要自带信息量：DSH 折叠命令结果时只看得到它
  const first = help.text.split('\n')[0]
  assert.match(first, /条命令/)
  assert.match(first, /当前/)
  // 用法要写清楚参数，不只是命令名
  assert.match(help.text, /\/vps-install <菜谱id>/)
  assert.match(help.text, /\/vps-logs <服务名>/)
  // 三种用法都要提到
  assert.match(help.text, /跟 AI 说话/)
  assert.match(help.text, /DSH 设置 → VPS 管理/) // 加机器的地方（左侧面板已删除）
  assert.doesNotMatch(help.text, /左边栏|应用商店/)
})

test('开关关着时命令不执行；绑定后才有默认机器（用户实测发现的漏洞）', async () => {
  const { env, runner, sshOptions } = await sandbox() // hosts.yml 里 current 就是 hk
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner, sshOptions })
  const ping = registered.find((c) => c.name === 'vps-ping')
  const use = registered.find((c) => c.name === 'vps-use')
  const inv = { rawInput: '', agent: { session: { id: 'sess-1' } } }

  // 没打开开关：即使 hosts.yml 里有「当前机器」，也不许拿它当默认
  const denied = await ping.handler(inv)
  assert.equal(denied.kind, 'error')
  assert.match(denied.text, /未开 VPS 开关/)
  // 不能再叫人「加 -h」：/vps-ping 没声明 input，DSH 会把带参数的整句交给模型
  assert.doesNotMatch(denied.text, /-h /)
  assert.match(denied.text, /\/vps-use hk/)

  // 绑定这个对话之后，不带 -h 也能跑
  const bound = await use.handler({ ...inv, rawInput: 'hk' })
  assert.equal(bound.kind, 'success')
  assert.match(bound.text, /只影响这个对话/)
  const afterBind = await ping.handler(inv)
  assert.equal(afterBind.kind, 'success', afterBind.text)

  // 关掉开关 → 立刻回到「必须指定机器」
  const off = await use.handler({ ...inv, rawInput: 'off' })
  assert.equal(off.kind, 'success')
  const afterOff = await ping.handler(inv)
  assert.equal(afterOff.kind, 'error')
  assert.match(afterOff.text, /未开 VPS 开关/)
})

test('别的对话不受影响：绑定是会话级的', async () => {
  const { env, runner } = await sandbox()
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner })
  const ping = registered.find((c) => c.name === 'vps-ping')
  const use = registered.find((c) => c.name === 'vps-use')

  await use.handler({ rawInput: 'hk', agent: { session: { id: 'sess-A' } } })
  const a = await ping.handler({ rawInput: '', agent: { session: { id: 'sess-A' } } })
  const b = await ping.handler({ rawInput: '', agent: { session: { id: 'sess-B' } } })

  assert.equal(a.kind, 'success', 'A 对话绑定了，能跑')
  assert.equal(b.kind, 'error', 'B 对话没绑定，不该被 A 影响')
})

test('AI 工具同样受开关约束：没绑定又没写 host 就报错', async () => {
  const { env, runner } = await sandbox()
  const defs = await buildToolDefinitions(hostWithApproval(async () => 'allowed-once'), { env, runner })
  const exec = defs.find((d) => d.name === 'vps_exec')

  await assert.rejects(
    exec.execute({ script: 'echo hi', intent: 'read' }, { agent: { session: { id: 'sess-none' } }, callId: 'c1' }),
    /没有指定机器/,
  )

  // 写了 host 就照常
  const ok = await exec.execute({ host: 'hk', script: 'echo hi', intent: 'read' }, { agent: { session: { id: 'sess-none' } }, callId: 'c2' })
  assert.equal(ok.ok, true, ok.hint)
})

test('提示的第一行必须自带答案（DSH 只显示第一行）', async () => {
  const { env, runner } = await sandbox()
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner })
  const inv = { rawInput: '', agent: { session: { id: 'sess-msg' } } }
  const firstLine = (res) => res.text.split('\n')[0]

  // 没开开关：第一行就要说清怎么办，不能被「三选一：」这类铺垫占掉
  const denied = firstLine(await registered.find((c) => c.name === 'vps-ping').handler(inv))
  assert.match(denied, /未开 VPS 开关/)
  assert.match(denied, /\/vps-use hk/, '第一行要给出可直接照抄、而且真能到达插件的办法')
  assert.ok(denied.length <= 45, `第一行太长会被截断：${denied.length} 字`)

  // 绑定成功：第一行是结果，不是套话
  const bound = firstLine(await registered.find((c) => c.name === 'vps-use').handler({ ...inv, rawInput: 'hk' }))
  assert.match(bound, /^已绑定 hk/)

  // 高危拦截（绑定之后才轮得到它判）：第一行要说清拦了什么、怎么确认
  const dangerRes = await registered.find((c) => c.name === 'vps-sh').handler({ ...inv, rawInput: 'rm -rf /tmp/x' })
  const danger = dangerRes.text.split('\n')
  assert.match(danger[0], /高危已拦下/)
  assert.match(danger[0], /删除文件/)
  assert.equal(danger[1], '确认要跑就发 /vps-yes（5 分钟内有效）', '第二行给不带参数的确认命令')
})

test('/vps-install 收 key=value 参数：名字错了当场说清这条菜谱收什么', async () => {
  const { env, runner } = await sandbox()
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner })
  const install = registered.find((c) => c.name === 'vps-install')
  const inv = { agent: { session: { id: 'sess-install' } } }

  // 写错参数名：不连机器就该拦下，并把可用参数抄给用户
  const wrong = await install.handler({ ...inv, rawInput: 'setup-swap sizemb=2048' })
  assert.equal(wrong.kind, 'error')
  assert.match(wrong.text.split('\n')[0], /参数不对：sizemb/)
  assert.match(wrong.text, /size_mb=2048/)
  assert.match(wrong.text, /swappiness=10/)

  // 少了等号也是同一类错
  const bare = await install.handler({ ...inv, rawInput: 'setup-swap 2048' })
  assert.equal(bare.kind, 'error')
  assert.match(bare.text, /要写成 key=value/)

  // 没这条菜谱：直接说没有，不要抛到 resolveAlias 的开关提示上去
  const nope = await install.handler({ ...inv, rawInput: 'no-such-recipe' })
  assert.equal(nope.kind, 'error')
  assert.match(nope.text, /没有这条菜谱/)
})

test('/vps-install 的计划页把参数和重发命令一起给出来', async () => {
  const { env, runner, sshOptions } = await sandbox()
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner, sshOptions })
  const inv = { agent: { session: { id: 'sess-plan' } } }
  await registered.find((c) => c.name === 'vps-use').handler({ ...inv, rawInput: 'hk' })

  const plan = await registered.find((c) => c.name === 'vps-install')
    .handler({ ...inv, rawInput: 'setup-swap size_mb=4096' })
  assert.equal(plan.kind, 'success')
  const first = plan.text.split('\n')[0]
  assert.match(first, /尚未执行/)
  assert.doesNotMatch(first, /装/, '配置类菜谱（swap、时区、系统更新）没有「装没装」，不许说「还没装」')
  assert.match(first, /确认发 \/vps-yes$/, '第一行给不带参数的确认命令')
  assert.match(plan.text, /size_mb = 4096.*本次指定/)
  assert.match(plan.text, /swappiness = 10/, '没指定的参数要显示默认值')
})

test('/vps-task <任务号> --stop 直接终止；/vps-tasks 只列清单', async () => {
  const { env, runner, sshOptions } = await sandbox()
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner, sshOptions })
  const tasks = registered.find((c) => c.name === 'vps-tasks')
  const task = registered.find((c) => c.name === 'vps-task')
  assert.ok(task.input, '/vps-task 要收任务号，必须声明 input，否则 DSH 不把参数交给插件')
  assert.equal(tasks.input, undefined, '/vps-tasks 要回车就列，不能声明 input')
  const inv = { agent: { session: { id: 'sess-stop' } } }
  await registered.find((c) => c.name === 'vps-use').handler({ ...inv, rawInput: 'hk' })

  // 不给任务号：告诉他怎么补
  const noId = await task.handler({ ...inv, rawInput: '--stop' })
  assert.equal(noId.kind, 'error')
  assert.match(noId.text.split('\n')[0], /^用法：\/vps-task <任务号>/)

  // 给了任务号：走 cancel（沙箱里这个任务不存在，远端会说没有这个任务）
  const stopped = await task.handler({ ...inv, rawInput: 't-not-there --stop' })
  assert.match(stopped.text.split('\n')[0], /^\[hk\] 任务 t-not-there：/)
  assert.match(stopped.text, /没有这个任务/)

  // 列表页第一行要能一眼看出有没有在跑的
  const list = await tasks.handler({ ...inv, rawInput: '' })
  assert.equal(list.kind, 'success')
  assert.match(list.text.split('\n')[0], /^\[hk\] (没有任务记录|\d+ 个任务)/)
})

test('/vps-install --yes 自己就是确认：命令没有轮次，弹不出审批框也必须能装', async () => {
  const { env, runner, sshOptions, home } = await sandbox()
  const { paths } = await import('../lib/config.js')
  const { mkdir } = await import('node:fs/promises')
  const dir = paths(env).recipesDir
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'my-smoke.yml'), [
    'schema: 1',
    'recipes:',
    '  - id: my-smoke',
    '    kind: install',
    '    name: 冒烟菜谱',
    '    desc: 只 echo，不碰系统',
    '    risk: change',
    '    detect: |',
    '      exit 1',
    '    plan: |',
    '      1. echo',
    '    run: |',
    '      echo installed',
    '    verify: |',
    '      echo verified',
  ].join('\n'))

  const registered = []
  // 注意：ctx 里**没有** approval —— 命令在轮次外运行，宿主根本给不了审批框
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner, sshOptions })
  const inv = { agent: { session: { id: 'sess-yes' } } }
  await registered.find((c) => c.name === 'vps-use').handler({ ...inv, rawInput: 'hk' })

  const res = await registered.find((c) => c.name === 'vps-install')
    .handler({ ...inv, rawInput: 'my-smoke --yes' })
  assert.equal(res.kind, 'success', res.text)
  assert.doesNotMatch(res.text, /审批|未获确认/, '--yes 之后不该再去要审批')
  assert.match(res.text.split('\n')[0], /^\[hk\] 冒烟菜谱：完成/)
  assert.ok(home)
})

test('/vps-yes：只执行这个对话刚登记的那一件，执行一次就作废，5 分钟后作废', async () => {
  const { env, runner, sshOptions } = await sandbox()
  const { paths } = await import('../lib/config.js')
  const { mkdir } = await import('node:fs/promises')
  const dir = paths(env).recipesDir
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'my-echo.yml'), [
    'schema: 1',
    'recipes:',
    '  - id: my-echo',
    '    kind: install',
    '    name: 回声菜谱',
    '    desc: 只 echo，不碰系统',
    '    risk: change',
    '    params:',
    '      - name: word',
    '        pattern: "[a-z]{1,10}"',
    '        default: hello',
    '    detect: |',
    '      exit 1',
    '    plan: |',
    '      1. echo',
    '    run: |',
    '      echo "said $P_WORD"',
    '    verify: |',
    '      echo ok',
  ].join('\n'))

  let t = 1_000_000
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner, sshOptions, now: () => t })
  const cmd = (name) => registered.find((c) => c.name === name)
  const a = { agent: { session: { id: 'sess-a' } } }
  const b = { agent: { session: { id: 'sess-b' } } }
  await cmd('vps-use').handler({ ...a, rawInput: 'hk' })
  await cmd('vps-use').handler({ ...b, rawInput: 'hk' })

  assert.equal(cmd('vps-yes').input, undefined, '/vps-yes 必须是光名字命令，回车就执行')

  // 什么都没登记
  const nothing = await cmd('vps-yes').handler({ ...a, rawInput: '' })
  assert.equal(nothing.kind, 'error')
  assert.match(nothing.text, /^没有等你确认的操作/)

  // a 出计划（带参数）；b 的 /vps-yes 碰不到 a 的
  const plan = await cmd('vps-install').handler({ ...a, rawInput: 'my-echo word=bye' })
  assert.match(plan.text.split('\n')[0], /确认发 \/vps-yes$/)
  assert.equal((await cmd('vps-yes').handler({ ...b, rawInput: '' })).kind, 'error', '别的对话不能确认')

  // a 确认：按计划时的参数执行
  const done = await cmd('vps-yes').handler({ ...a, rawInput: '' })
  assert.equal(done.kind, 'success', done.text)
  assert.match(done.text.split('\n')[0], /^\[hk\] 回声菜谱：完成　word=bye/)
  assert.match(done.text, /said bye/)

  // 一次确认只执行一次
  assert.match((await cmd('vps-yes').handler({ ...a, rawInput: '' })).text, /^没有等你确认的操作/)

  // 过期：出计划后 6 分钟才确认
  await cmd('vps-install').handler({ ...a, rawInput: 'my-echo' })
  t += 6 * 60_000
  const late = await cmd('vps-yes').handler({ ...a, rawInput: '' })
  assert.equal(late.kind, 'error')
  assert.match(late.text, /^\[hk\] 确认已过期.*重新发 \/vps-install my-echo/)

  // 被拦下的高危命令同样走 /vps-yes
  const target = join(paths(env).base, 'to-delete')
  await mkdir(target, { recursive: true })
  const blocked = await cmd('vps-sh').handler({ ...a, rawInput: `rm -rf ${target}` })
  assert.match(blocked.text.split('\n')[0], /高危已拦下/)
  const ran = await cmd('vps-yes').handler({ ...a, rawInput: '' })
  assert.equal(ran.kind, 'success', ran.text)
  assert.match(ran.text, /已按高危执行/)
})

test('闸门：不许叫用户在「只认光名字」的命令后面写参数（DSH 会把整句交给模型）', async () => {
  // 宿主规则（dsh-client-ui-commands matchEnter）：没声明 input 的命令只认 `/名字`；
  // 后面带字就不算命令。实测 `/vps-reboot -h vps-dsh --yes` 被模型接走，模型自己 ssh 去重启了。
  const { env, runner } = await sandbox()
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner })
  const bare = registered.filter((d) => d.input === undefined).map((d) => d.name)
  assert.ok(bare.includes('vps-reboot') && bare.includes('vps-yes') && bare.includes('vps-tasks'))

  // /vps-help 里的用法：光名字命令后面不许跟任何东西
  const help = (await registered.find((c) => c.name === 'vps-help').handler({ rawInput: '' })).text
  for (const name of bare) {
    const line = help.split('\n').find((l) => l.trim().startsWith(`/${name} `) || l.trim() === `/${name}`)
    assert.ok(line, `/vps-help 里没有 /${name}`)
    const usage = line.trim().split(/\s{2,}/)[0]
    assert.equal(usage, `/${name}`, `/${name} 没声明 input，用法里不能写参数：${usage}`)
  }

  // 所有给人看的文字：lib 源码里的字符串、skill、两份 README
  const { readdir, readFile } = await import('node:fs/promises')
  const root = new URL('../', import.meta.url)
  const files = [
    ...(await readdir(new URL('lib/', root))).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
    'lib/skills/vps-operator.md',
    'README.md',
    'README.zh-CN.md',
  ]
  const pattern = new RegExp(`/(${bare.map((n) => n.replace(/-/g, '\\-')).join('|')})(?![\\w-]) +(?:--?[A-Za-z]|<|\\[|[A-Za-z0-9])`)
  const hits = []
  for (const file of files) {
    const text = await readFile(new URL(file, root), 'utf8')
    text.split('\n').forEach((line, i) => {
      const trimmed = line.trim()
      if (file.endsWith('.js') && (trimmed.startsWith('//') || trimmed.startsWith('*'))) return // 注释里写反例可以
      if (pattern.test(line)) hits.push(`${file}:${i + 1}  ${trimmed.slice(0, 100)}`)
    })
  }
  assert.deepEqual(hits, [], `这些地方叫人在光名字命令后面写参数，DSH 里到不了插件：\n${hits.join('\n')}`)
})

test('/vps-sh 迷你终端：记住目录、目录没了回家目录、交互命令改写、--private、--bg、超时提示', async () => {
  const { env, runner, sshOptions } = await sandbox()
  const { mkdtemp: mk, rm } = await import('node:fs/promises')
  const { takeUnshared } = await import('../lib/terminal.js')
  const registered = []
  registerCommands({ commands: { register: (d) => { registered.push(d); return () => {} } } }, { env, runner, sshOptions, shReadTimeoutSeconds: 2 })
  const sh = registered.find((c) => c.name === 'vps-sh')
  const inv = (rawInput) => ({ rawInput, agent: { session: { id: 'sess-term' } } })
  await registered.find((c) => c.name === 'vps-use').handler(inv('hk'))

  const dir = await mk(join(tmpdir(), 'dsh-vps-cwd-'))
  const went = await sh.handler(inv(`cd ${dir}`))
  assert.equal(went.kind, 'success', went.text)
  assert.equal(went.text.split('\n')[0], `[hk:${dir}] $ cd ${dir}`)
  assert.match(went.text, new RegExp(`（当前目录：${dir}）`))
  assert.doesNotMatch(went.text, /下次问 AI 时会附上/, '光换目录不附给 AI，也就不用提示')

  const here = await sh.handler(inv('pwd'))
  assert.match(here.text, /下次问 AI 时会附上这段输出/, '第一条会附给 AI 的命令要提示')
  assert.match(here.text.split('\n')[0], new RegExp(`^\\[hk:${dir}\\] \\$ pwd　${dir}$`), '下一条在记住的目录里执行')
  assert.doesNotMatch(here.text, /__DSH_VPS_CWD__/, '目录标记不能漏进输出')
  assert.doesNotMatch((await sh.handler(inv('pwd'))).text, /下次问 AI/, '只提示一次')

  // cd 失败：目录不变
  const bad = await sh.handler(inv('cd /definitely-not-here-xyz'))
  assert.equal(bad.kind, 'error')
  assert.match((await sh.handler(inv('pwd'))).text.split('\n')[0], new RegExp(`\\$ pwd　${dir}$`))

  // 记住的目录被删了：回到家目录并说明
  await rm(dir, { recursive: true, force: true })
  const gone = await sh.handler(inv('pwd'))
  assert.match(gone.text, /已经不存在，回到家目录/)
  assert.doesNotMatch(gone.text.split('\n')[0], new RegExp(dir))

  // 交互命令改写：输出里说明改了什么，并照改后的执行
  const logFile = join(await mk(join(tmpdir(), 'dsh-vps-log-')), 'app.log')
  await writeFile(logFile, 'line1\nline2\n')
  const tailed = await sh.handler(inv(`tail -f ${logFile}`))
  assert.equal(tailed.kind, 'success', tailed.text)
  assert.match(tailed.text, /（tail -f 会一直等新内容，改成最后 100 行）/)
  assert.match(tailed.text, /line2/)

  const vim = await sh.handler(inv('vim /etc/hosts'))
  assert.equal(vim.kind, 'error')
  assert.match(vim.text, /^没执行：vim 是交互式编辑器/)

  // --private：执行，但不记给 AI
  takeUnshared('sess-term')
  await sh.handler(inv('--private echo secret-stuff'))
  await sh.handler(inv('echo shared-stuff'))
  const shared = takeUnshared('sess-term')
  assert.deepEqual(shared.map((e) => e.command), ['echo shared-stuff'])

  // --bg：放到后台，立刻给任务号
  const bg = await sh.handler(inv('--bg sleep 1'))
  assert.equal(bg.kind, 'success', bg.text)
  assert.match(bg.text, /在后台跑，任务 \S+，用 \/vps-task \S+ 看进度/)

  // 只读命令超时：提示用 --bg
  const slow = await sh.handler(inv('sleep 5'))
  assert.match(slow.text, /超过 2 秒还没结束，已停止等待。跑得久的命令在前面加 --bg 放到后台/)
})
