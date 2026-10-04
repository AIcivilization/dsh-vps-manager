// 令牌：DSH 官方桌面版的页面从本地打开（不经过 tapIndex），令牌对不上时界面要自己悄悄换新的，不提示、不罢工
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { writeHosts } from '../lib/config.js'
import { registerRoutes } from '../lib/routes.js'

const require = createRequire(import.meta.url)

/** 模拟 DSH 的 webServer + cordis 上下文：路由表、tapIndex，以及 webserver/index-inject 事件 */
function fakeCtx() {
  const exact = new Map()
  const taps = new Set()
  const listeners = new Map()
  const webServer = {
    config: { host: '127.0.0.1', port: 3000 },
    register({ path, handler }) {
      if (exact.has(path)) throw new Error(`webserver: duplicate exact route "${path}"`)
      exact.set(path, handler)
      return () => exact.delete(path)
    },
    tapIndex(fn) {
      taps.add(fn)
      return () => taps.delete(fn)
    },
    // 和 DSH 一样：每次发一次事件，订阅的人往表里推自己的行
    collectIndexInjections() {
      const table = []
      for (const fn of listeners.get('webserver/index-inject') ?? []) fn(table)
      return table
    },
  }
  const ctx = {
    webServer,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name).delete(fn)
    },
  }
  return { ctx, exact, taps, listeners }
}

async function sandboxEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-token-'))
  const env = { HOME: dir, DSH_HOME: join(dir, '.dsh') }
  await writeHosts({ current: '', hosts: {} }, env)
  return env
}

async function call(exact, path, { method = 'POST', headers = {}, body = {} } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  const out = {}
  await exact.get(path)(req, { writeHead: (c) => { out.code = c }, end: (t) => { out.body = JSON.parse(t) } })
  return out
}

test('官方桌面版：令牌也作为结构化注入行交出去（页面从本地打开、只认这种行）；网页版的 tapIndex 照旧', async () => {
  const { ctx, taps, listeners } = fakeCtx()
  const reg = registerRoutes(ctx, { env: await sandboxEnv(), token: 'abc123abc123abc123abc123' })
  const rows = ctx.webServer.collectIndexInjections()
  assert.deepEqual(rows, [{ kind: 'global', name: '__DSH_VPS_TOKEN__', value: 'abc123abc123abc123abc123' }])
  assert.equal(taps.size, 1, '老版本 DSH 只有 tapIndex')
  reg.dispose()
  assert.equal(listeners.get('webserver/index-inject').size, 0, '卸载时一并撤掉')
  assert.equal(taps.size, 0)
})

test('/api-vps/token：同源、JSON 才给当前令牌；跨站、非 JSON、GET 都不给', async () => {
  const { ctx, exact } = fakeCtx()
  const reg = registerRoutes(ctx, { env: await sandboxEnv() })
  const ok = await call(exact, '/api-vps/token')
  assert.equal(ok.code, 200)
  assert.equal(ok.body.token, reg.token, '不需要带令牌就能取（正是令牌对不上时用的）')
  assert.equal((await call(exact, '/api-vps/token', { headers: { origin: 'https://evil.example' } })).code, 403)
  assert.equal((await call(exact, '/api-vps/token', { headers: { 'content-type': 'text/plain' } })).code, 415)
  assert.equal((await call(exact, '/api-vps/token', { method: 'GET' })).code, 405)
  // 别的接口仍然要令牌
  assert.equal((await call(exact, '/api-vps/overview')).code, 403)
  assert.equal((await call(exact, '/api-vps/overview', { headers: { 'x-dsh-vps-token': reg.token } })).code, 200)
})

// —— 界面 ——

async function loadClient({ token = 'test-token-123', fetchImpl, transport } = {}) {
  let spec = null
  globalThis.window = {
    __ModuleLoader__: { load: (s) => { spec = s } },
    __DSH_VPS_TOKEN__: token,
    location: { origin: 'dsh-app://app' },
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  if (transport) globalThis.__DSH_TRANSPORT__ = transport
  else delete globalThis.__DSH_TRANSPORT__
  globalThis.fetch = fetchImpl
  await import(`../lib/client.js?${Math.random()}`)
  return spec.factory((n) => require(n))
}

test('页面里根本没有令牌（官方桌面版、注入行没赶上）：先悄悄取一个，再发请求，不报错', async () => {
  const calls = []
  const exported = await loadClient({
    token: '',
    fetchImpl: async (url, init) => {
      calls.push(url)
      if (url === '/api-vps/token') return { status: 200, json: async () => ({ ok: true, token: 'fresh-token-0123456789' }) }
      if (init?.headers?.['x-dsh-vps-token'] === 'fresh-token-0123456789') return { status: 200, json: async () => ({ ok: true, hosts: ['la'] }) }
      return { status: 403, json: async () => ({ ok: false, error: 'token 不对' }) }
    },
  })
  const data = await exported.__test.api('overview')
  assert.deepEqual(data.hosts, ['la'])
  assert.deepEqual(calls, ['/api-vps/token', '/api-vps/overview'])
})

test('令牌对不上（DSH 重启过、插件热更新过）：悄悄换新的再试一次，用户看不到任何提示', async () => {
  const calls = []
  const exported = await loadClient({
    token: 'stale-token-0000000000',
    fetchImpl: async (url, init) => {
      calls.push(url)
      if (url === '/api-vps/token') return { status: 200, json: async () => ({ ok: true, token: 'fresh-token-0123456789' }) }
      if (init?.headers?.['x-dsh-vps-token'] === 'fresh-token-0123456789') return { status: 200, json: async () => ({ ok: true, hosts: ['la'] }) }
      return { status: 403, json: async () => ({ ok: false, error: 'token 不对' }) }
    },
  })
  const data = await exported.__test.api('overview')
  assert.deepEqual(data.hosts, ['la'])
  assert.deepEqual(calls, ['/api-vps/overview', '/api-vps/token', '/api-vps/overview'])
  assert.equal(globalThis.window.__DSH_VPS_TOKEN__, 'fresh-token-0123456789')
})

test('好几个请求同时发现令牌不对：只换一次', async () => {
  let tokenCalls = 0
  const exported = await loadClient({
    token: 'stale-token-0000000000',
    fetchImpl: async (url, init) => {
      if (url === '/api-vps/token') {
        tokenCalls += 1
        await new Promise((r) => setTimeout(r, 10))
        return { status: 200, json: async () => ({ ok: true, token: 'fresh-token-0123456789' }) }
      }
      if (init?.headers?.['x-dsh-vps-token'] === 'fresh-token-0123456789') return { status: 200, json: async () => ({ ok: true }) }
      return { status: 403, json: async () => ({ ok: false, error: 'token 不对' }) }
    },
  })
  await Promise.all([1, 2, 3].map(() => exported.__test.api('overview')))
  assert.equal(tokenCalls, 1)
})

test('终端连哪里：官方桌面版用 DSH 给的实时连接地址（127.0.0.1），其他情况用页面自己的地址', async () => {
  const desktop = await loadClient({ fetchImpl: async () => ({}), transport: { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:51234' } })
  assert.equal(desktop.__test.streamOrigin(), 'http://127.0.0.1:51234')
  assert.match(desktop.__test.terminalUrl(desktop.__test.streamOrigin(), 's1', 80, 24), /^ws:\/\/127\.0\.0\.1:51234\/api-vps\/ws\/terminal\?/)
  const web = await loadClient({ fetchImpl: async () => ({}) })
  assert.equal(web.__test.streamOrigin(), 'dsh-app://app')
  delete globalThis.__DSH_TRANSPORT__
})
