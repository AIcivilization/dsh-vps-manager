// VPS 模式：开关打开 = 这个对话在操作服务器。说明只在绑定变化时发；本机 bash 只在绑定的对话里被拦。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindSession, paths, writeHosts } from '../lib/config.js'
import {
  PLUGIN, UNBOUND_TEXT, boundText, lastAnnouncement, localShellGuard, planAnnouncement, registerVpsMode,
} from '../lib/vps-mode.js'

async function sandbox({ facts } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-mode-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: '', hosts: { 'vps-dsh': { note: '洛杉矶' }, jp: {} } }, env)
  if (facts) {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths(env).base, { recursive: true })
    await writeFile(paths(env).stateFile, JSON.stringify({ hosts: { 'vps-dsh': { address: '209.146.116.150:22', facts } } }))
  }
  return { env }
}

/** 假会话：events 就是会话事件流，注入的说明会像真的一样追加进去 */
function fakeSession(id) {
  const events = []
  return {
    id,
    events,
    get seq() { return events.length },
    eventAt(i) { return events[i] },
    record(messages) { for (const m of messages) events.push({ type: 'user/message', data: m }) },
  }
}

function fakeAgents() {
  let listener = null
  return {
    ctx: { on: (event, fn, opts) => { assert.equal(event, 'agent/pre-step'); assert.equal(opts?.prepend, true); listener = fn; return () => {} } },
    async step(session) {
      const decision = await listener({ agent: { session }, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'continue', messages: [] }))
      session.record(decision.messages)
      return decision.messages.map((m) => m.content[0].text)
    },
  }
}

test('什么时候发说明：绑定变化才发', () => {
  assert.equal(planAnnouncement('vps-dsh', null), 'vps-dsh')
  assert.equal(planAnnouncement('vps-dsh', 'vps-dsh'), null)
  assert.equal(planAnnouncement('jp', 'vps-dsh'), 'jp', '换机器要重新说')
  assert.equal(planAnnouncement('', 'vps-dsh'), 'off')
  assert.equal(planAnnouncement('', 'off'), null)
  assert.equal(planAnnouncement('', null), null, '从没开过开关的对话什么都不发')
})

test('说明里写清系统，模型按系统写命令', async () => {
  const { env } = await sandbox({ facts: { os_id: 'ubuntu', os_ver: '24.04', os_family: 'debian', pkg: 'apt', init: 'systemd', arch: 'x86_64', privilege: 'root' } })
  const text = await boundText('vps-dsh', env)
  assert.match(text.split('\n')[0], /^\[VPS 模式\] 已绑定 vps-dsh$/)
  assert.match(text, /209\.146\.116\.150:22，洛杉矶/)
  assert.match(text, /ubuntu 24\.04（debian 系）· 包管理 apt · init systemd · 架构 x86_64 · 权限 root/)
  assert.match(text, /vps_exec/)
  assert.match(text, /本机 bash 在 VPS 模式下已停用/)

  // 还没体检：让模型先确认系统，不许猜
  const { env: env2 } = await sandbox()
  assert.match(await boundText('vps-dsh', env2), /还没有体检过.*cat \/etc\/os-release/)

  // 只读权限要提前说
  const { env: env3 } = await sandbox({ facts: { os_id: 'debian', os_ver: '12', privilege: 'none' } }) // 体检写的是 none
  assert.match(await boundText('vps-dsh', env3), /没有管理员权限/)

  // 已经在跑的 Web 服务和容器要写进去：实测模型没看端口就想另装 nginx，差点撞上 caddy
  const { env: env4 } = await sandbox({ facts: { os_id: 'ubuntu', os_ver: '24.04', privilege: 'root', web_listeners: 'caddy ', containers: 'mailserver ' } })
  const withServices = await boundText('vps-dsh', env4)
  assert.match(withServices, /80\/443 端口已被占用：caddy。.*不要另装 nginx/)
  assert.match(withServices, /在跑的容器：mailserver/)
  assert.match(withServices, /动手改之前先查现状/)
  const { env: env5 } = await sandbox({ facts: { os_id: 'ubuntu', os_ver: '24.04', web_listeners: '' } })
  assert.match(await boundText('vps-dsh', env5), /80\/443 端口：没有程序在监听/)
})

test('pre-step：开关打开发一次，重复的步骤不再发，关掉发一次关闭说明', async () => {
  const { env } = await sandbox({ facts: { os_id: 'ubuntu', os_ver: '24.04', pkg: 'apt', privilege: 'root' } })
  const agents = fakeAgents()
  registerVpsMode(agents.ctx, { env })
  const session = fakeSession('sess-mode-1')

  assert.deepEqual(await agents.step(session), [], '没开开关：什么都不发')

  await bindSession('sess-mode-1', 'vps-dsh', env)
  const first = await agents.step(session)
  assert.equal(first.length, 1)
  assert.match(first[0], /^\[VPS 模式\] 已绑定 vps-dsh/)
  const msg = session.events.at(-1).data
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'plugin')
  assert.equal(msg.source.plugin, PLUGIN)

  assert.deepEqual(await agents.step(session), [], '同一绑定不重复发')
  assert.deepEqual(await agents.step(session), [])

  await bindSession('sess-mode-1', null, env)
  assert.deepEqual(await agents.step(session), [UNBOUND_TEXT])
  assert.deepEqual(await agents.step(session), [], '关闭说明也只发一次')
})

test('DSH 重启后：从会话历史找回上次说明，不重复发', async () => {
  const { env } = await sandbox()
  const session = fakeSession('sess-mode-restart')
  await bindSession('sess-mode-restart', 'vps-dsh', env)

  const before = fakeAgents()
  registerVpsMode(before.ctx, { env })
  assert.equal((await before.step(session)).length, 1)
  assert.equal(lastAnnouncement(session), 'vps-dsh')

  const after = fakeAgents() // 新进程：内存里什么都没有
  registerVpsMode(after.ctx, { env })
  assert.deepEqual(await after.step(session), [], '历史里已经说过了')
})

test('两个窗口互不影响：只有绑定的对话收到说明、被拦 bash', async () => {
  const { env } = await sandbox()
  const agents = fakeAgents()
  registerVpsMode(agents.ctx, { env })
  const vpsWindow = fakeSession('sess-window-1')
  const codeWindow = fakeSession('sess-window-2')
  await bindSession('sess-window-1', 'vps-dsh', env)

  assert.equal((await agents.step(vpsWindow)).length, 1)
  assert.deepEqual(await agents.step(codeWindow), [])

  const bash = (session) => localShellGuard({ name: 'bash', agent: { session } })
  assert.match(bash(vpsWindow), /VPS 模式下本机 bash 已停用.*vps-dsh.*vps_exec/)
  assert.equal(bash(codeWindow), undefined, '另一个窗口照常用 bash')
  assert.equal(localShellGuard({ name: 'read', agent: { session: vpsWindow } }), undefined, '读文件不拦')
  assert.equal(localShellGuard({ name: 'vps_exec', agent: { session: vpsWindow } }), undefined)

  await bindSession('sess-window-1', null, env)
  assert.equal(bash(vpsWindow), undefined, '关掉开关立刻放行')
})
