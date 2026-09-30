// 同一个 DSH 里跑着两份插件（插件市场热装了新版、旧版还在跑）时，第二份不能把页面搞坏
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { writeHosts } from '../lib/config.js'
import { diagnostics } from '../lib/health.js'
import { registerRoutes } from '../lib/routes.js'
import { registerTerminal } from '../lib/terminal-server.js'

/** 模拟 DSH 的 webServer：同一路径注册两次就报错，和真的一样 */
function fakeServer() {
  const exact = new Map()
  const upgrades = new Map()
  const taps = new Set()
  return {
    exact, upgrades, taps,
    config: { host: '127.0.0.1', port: 3000 },
    register({ path, handler }) {
      if (exact.has(path)) throw new Error(`webserver: duplicate exact route "${path}"`)
      exact.set(path, handler)
      return () => exact.delete(path)
    },
    registerUpgrade({ path, handler }) {
      if (upgrades.has(path)) throw new Error(`webserver: duplicate upgrade route "${path}"`)
      upgrades.set(path, handler)
      return () => upgrades.delete(path)
    },
    tapIndex(fn) {
      taps.add(fn)
      return () => taps.delete(fn)
    },
    page() {
      let html = '<html><head></head><body></body></html>'
      for (const fn of taps) html = fn(html)
      return html
    },
  }
}

async function env() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-dup-'))
  const e = { HOME: dir, DSH_HOME: join(dir, '.dsh') }
  await writeHosts({ current: '', hosts: {} }, e)
  return e
}

test('第二份注册接口失败：不留下自己的令牌，页面里只有正在服务的那一份的令牌', async () => {
  const ws = fakeServer()
  const [e1, e2] = [await env(), await env()]
  const first = registerRoutes({ webServer: ws }, { env: e1, token: 'first-token' })
  const routeCount = ws.exact.size
  assert.throws(() => registerRoutes({ webServer: ws }, { env: e2, token: 'second-token' }), /duplicate exact route/)
  assert.equal(ws.exact.size, routeCount, '第二份不能多出或撤掉接口')
  const page = ws.page()
  assert.match(page, /first-token/)
  assert.doesNotMatch(page, /second-token/, '失败的那一份的令牌会让页面「令牌对不上」')
  first.dispose()
  assert.equal(ws.exact.size, 0)
  assert.equal(ws.taps.size, 0)
})

test('终端注册到一半失败：已经注册的实时连接也撤掉', async () => {
  const ws = fakeServer()
  const e = await env()
  ws.register({ path: '/api-vps/assets/xterm.mjs', handler: () => {} }) // 另一份占着这个文件路径
  assert.throws(() => registerTerminal({ webServer: ws }, { env: e, token: 't' }), /duplicate exact route/)
  assert.equal(ws.upgrades.size, 0, '不能留下半截的终端连接入口')
})

test('卸载有一步没成功：回复本身仍是成功，界面拿得到每一步的结果（曾显示「请求失败（HTTP 200）」）', async () => {
  const ws = fakeServer()
  const e = await env()
  const reg = registerRoutes({ webServer: ws }, { env: e })
  const req = Readable.from([Buffer.from(JSON.stringify({ choices: { plugin: true } }))])
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', 'x-dsh-vps-token': reg.token }
  req.socket = { remoteAddress: '127.0.0.1' }
  const out = {}
  await ws.exact.get('/api-vps/uninstall/run')(req, { writeHead: (c) => { out.code = c }, end: (t) => { out.body = JSON.parse(t) } })
  assert.equal(out.body.ok, true)
  assert.equal(out.body.allOk, false, '普通 dsh 下没法直接移除插件：这一步算没成功')
  assert.equal(out.body.steps[0].id, 'plugin')
  assert.match(out.body.steps[0].text, /dsh plugin remove/)
})

test('诊断：写明正在运行的版本；磁盘上的版本没变时不提示重启', async () => {
  const d = await diagnostics(await env())
  assert.match(d.plugin, /^\d+\.\d+\.\d+/)
  assert.equal(d.restartNeeded, '')
})
