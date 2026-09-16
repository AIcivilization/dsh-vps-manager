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
  const injected = new Map()
  return {
    tools: { register: (def) => { tools.push(def); return () => {} } },
    commands: { register: (def) => { commands.push(def); return () => {} } },
    skills: { register: (def) => { skills.push(def); return () => {} } },
    approval: approval ? { request: approval } : undefined,
    logger: { warn: () => {} },
    inject(names, cb) {
      injected.set(names.join(','), cb)
      // commands 立即回调（模拟服务已挂载），webServer 不回调（模拟 headless）
      if (names.includes('commands')) cb(this)
    },
    _tools: tools,
    _commands: commands,
    _skills: skills,
    _injected: injected,
  }
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

test('apply 注册 5 个工具、13 条命令、1 个 skill，并把可选服务放进 inject', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  await new Promise((r) => setTimeout(r, 50)) // 工具与 skill 是异步注册

  assert.deepEqual(ctx._tools.map((t) => t.name).sort(), [
    'vps_exec', 'vps_hosts', 'vps_recipe', 'vps_task', 'vps_write_file',
  ])
  const names = ctx._commands.map((c) => c.name)
  assert.equal(names.length, 18, names.join(","))
  for (const n of names) assert.match(n, /^vps-/, '所有命令必须同前缀，否则打 /vps 只筛出一半')
  assert.ok(names.includes('vps-install'))
  assert.ok(names.includes('vps-tasks'))
  assert.equal(ctx._skills.length, 1)
  assert.equal(ctx._skills[0].invocation.modelInvocable, true)
  assert.equal(ctx._skills[0].invocation.userInvocable, false)
  assert.ok(ctx._injected.has('webServer'), 'webServer 必须走 inject，headless 下不注册')
})

test('工具层：没有审批就拒绝改动，用户允许后才执行', async () => {
  const { env, runner, sshOptions } = await sandbox()
  const asked = []

  const denyCtx = { approval: { request: async (req) => { asked.push(req); return 'deny' } } }
  const [defs1, defs2] = await Promise.all([
    buildToolDefinitions(denyCtx, { env, runner }),
    buildToolDefinitions({ approval: { request: async (req) => { asked.push(req); return 'allow' } } }, { env, runner }),
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
  const ctx = { approval: { request: async () => { asked += 1; return 'allow' } } }
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
  const listed = await list.handler({ rawInput: '' })
  assert.match(listed.text, /★/)
  assert.match(listed.text, /hk/)
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
  assert.match(plan.text, /--yes/, '必须告诉用户怎么确认')
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
  assert.match(help.text, /面板/)
})
