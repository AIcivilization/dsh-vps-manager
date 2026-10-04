// 设置页「更新」：GitHub 上有新版就提示；点了交给 DSH 的插件管理器装 npm 上的那个版本
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { writeHosts } from '../lib/config.js'
import { registerRoutes } from '../lib/routes.js'
import { checkUpdate, compareVersions, runUpdate } from '../lib/update.js'

const require = createRequire(import.meta.url)

async function sandboxEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-update-'))
  const env = { HOME: dir, DSH_HOME: join(dir, '.dsh') }
  await writeHosts({ current: '', hosts: {} }, env)
  return env
}

/** 假的网络：GitHub 最新发布、npm 上 latest；null = 连不上 */
function fakeNet({ github, npm, npmMirror }) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const answer = (body) => (body === null ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true, status: 200, json: async () => body }))
    if (url.includes('api.github.com')) return answer(github === null ? null : { tag_name: `v${github}`, name: `v${github} · something`, html_url: `https://github.com/x/y/releases/tag/v${github}` })
    if (url.startsWith('https://registry.npmjs.org')) return answer(npm === null ? null : { version: npm })
    if (url.startsWith('https://registry.npmmirror.com')) return answer(npmMirror === undefined || npmMirror === null ? null : { version: npmMirror })
    return answer(null)
  }
  return { fetchImpl, calls }
}

test('版本比较：数字逐位比；同一个 x.y.z 正式版比预发布版新', () => {
  assert.ok(compareVersions('0.6.10', '0.6.9') > 0)
  assert.ok(compareVersions('0.7.0', '0.6.99') > 0)
  assert.equal(compareVersions('v0.6.2', '0.6.2'), 0)
  assert.ok(compareVersions('0.6.2', '0.6.2-rc.1') > 0)
  assert.ok(compareVersions('0.6.2-rc.1', '0.6.2-rc.2') < 0)
})

test('检查更新：GitHub 和 npm 都有新版 → 可以更新到 npm 上那个', async () => {
  const env = await sandboxEnv()
  const { fetchImpl } = fakeNet({ github: '0.6.3', npm: '0.6.3' })
  const info = await checkUpdate({ env, fetchImpl, running: '0.6.2', installed: '0.6.2' })
  assert.equal(info.available, true)
  assert.equal(info.installable, '0.6.3')
  assert.equal(info.latest, '0.6.3')
  assert.match(info.github.url, /releases\/tag\/v0\.6\.3/)
  assert.equal(info.command, 'dsh plugin add dsh-vps-manager@0.6.3')
})

test('检查更新：GitHub 先发了、npm 还没同步 → 提示有新版，但先不让装', async () => {
  const env = await sandboxEnv()
  const info = await checkUpdate({ env, fetchImpl: fakeNet({ github: '0.6.3', npm: '0.6.2' }).fetchImpl, running: '0.6.2', installed: '0.6.2' })
  assert.equal(info.available, true)
  assert.equal(info.latest, '0.6.3')
  assert.equal(info.installable, '')
})

test('检查更新：已是最新；装了新版还没重启 → 说重启生效，不再让装', async () => {
  const env = await sandboxEnv()
  const same = await checkUpdate({ env, fetchImpl: fakeNet({ github: '0.6.2', npm: '0.6.2' }).fetchImpl, running: '0.6.2', installed: '0.6.2', force: true })
  assert.equal(same.available, false)
  const pending = await checkUpdate({ env, fetchImpl: fakeNet({ github: '0.6.3', npm: '0.6.3' }).fetchImpl, running: '0.6.2', installed: '0.6.3', force: true })
  assert.equal(pending.restartPending, '0.6.3')
  assert.equal(pending.available, false, '磁盘上已经是最新的')
  assert.equal(pending.installable, '')
})

test('检查更新：6 小时内用存着的结果，不重复问网络；force 才马上重查；npm 官方源连不上就问镜像；全连不上不报错', async () => {
  const env = await sandboxEnv()
  const first = fakeNet({ github: '0.6.3', npm: null, npmMirror: '0.6.3' })
  const a = await checkUpdate({ env, fetchImpl: first.fetchImpl, running: '0.6.2', installed: '0.6.2' })
  assert.equal(a.npm.registry, 'https://registry.npmmirror.com')
  assert.equal(a.installable, '0.6.3')
  const second = fakeNet({ github: '0.6.9', npm: '0.6.9' })
  const b = await checkUpdate({ env, fetchImpl: second.fetchImpl, running: '0.6.2', installed: '0.6.2' })
  assert.equal(second.calls.length, 0, '6 小时内不再问网络')
  assert.equal(b.latest, '0.6.3')
  const c = await checkUpdate({ env, fetchImpl: second.fetchImpl, running: '0.6.2', installed: '0.6.2', force: true })
  assert.equal(c.latest, '0.6.9')
  const offline = await checkUpdate({ env, fetchImpl: fakeNet({ github: null, npm: null }).fetchImpl, running: '0.6.2', installed: '0.6.2', force: true })
  assert.equal(offline.offline, true)
  assert.equal(offline.latest, '0.6.9', '连不上时沿用上次查到的')
})

test('更新：交给 DSH 的插件管理器装 dsh-vps-manager@新版本；成功要重启；失败给原因和手动命令', async () => {
  const calls = []
  const ok = await runUpdate({
    running: '0.6.2',
    version: '0.6.3',
    pluginManager: { installBundle: async (spec, options) => { calls.push([spec, options]); return { application: 'restart-required', changed: true } } },
  })
  assert.deepEqual(calls, [['dsh-vps-manager@0.6.3', { enabled: true }]])
  assert.deepEqual(ok, { ok: true, version: '0.6.3', restart: true })

  const bad = await runUpdate({
    running: '0.6.2',
    version: '0.6.3',
    pluginManager: { installBundle: async () => ({ application: 'failed', error: { code: 'incompatible-version' } }) },
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'incompatible-version')
  assert.equal(bad.command, 'dsh plugin add dsh-vps-manager@0.6.3')

  const none = await runUpdate({ running: '0.6.2', version: '0.6.3', pluginManager: undefined })
  assert.equal(none.code, 'no-manager', '老版本 DSH 没有插件管理器：给出命令让用户自己运行')
  await assert.rejects(runUpdate({ running: '0.6.2', version: '0.6.1', pluginManager: {} }), /不比现在的/)
  await assert.rejects(runUpdate({ running: '0.6.2', version: '0.6.3; rm -rf /', pluginManager: {} }), /版本号不对/)
})

test('接口：update/check 带上能不能在这里装；update/run 要令牌、交给插件管理器', async () => {
  const env = await sandboxEnv()
  const exact = new Map()
  const ws = { config: { host: '127.0.0.1', port: 3000 }, register({ path, handler }) { exact.set(path, handler); return () => exact.delete(path) } }
  const installs = []
  const running = require('../package.json').version
  const next = running.replace(/\d+$/, (n) => String(Number(n) + 1))
  const deps = {
    env,
    fetchImpl: fakeNet({ github: next, npm: next }).fetchImpl,
    pluginManager: { installBundle: async (spec) => { installs.push(spec); return { application: 'restart-required' } } },
  }
  const reg = registerRoutes({ webServer: ws }, deps)
  const call = async (path, body, token = reg.token) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', 'x-dsh-vps-token': token }
    req.socket = { remoteAddress: '127.0.0.1' }
    const out = {}
    await exact.get(`/api-vps/${path}`)(req, { writeHead: (c) => { out.code = c }, end: (t) => { out.body = JSON.parse(t) } })
    return out
  }
  const check = await call('update/check', { force: true })
  assert.equal(check.body.installable, next)
  assert.equal(check.body.canInstall, true)
  assert.equal((await call('update/run', { version: next }, 'wrong')).code, 403)
  const run = await call('update/run', { version: next })
  assert.equal(run.body.ok, true)
  assert.equal(run.body.updated, true)
  assert.deepEqual(installs, [`dsh-vps-manager@${next}`])
  // 没装成：请求本身仍成功，原因和手动命令要交到界面上
  deps.pluginManager = { installBundle: async () => ({ application: 'failed', error: { code: 'incompatible-version' } }) }
  const failed = await call('update/run', { version: next })
  assert.equal(failed.body.ok, true)
  assert.equal(failed.body.updated, false)
  assert.equal(failed.body.code, 'incompatible-version')
  assert.match(failed.body.command, /dsh plugin add dsh-vps-manager@/)
})

// —— 界面 ——

async function loadClient() {
  let spec = null
  globalThis.window = {
    __ModuleLoader__: { load: (s) => { spec = s } },
    __DSH_VPS_TOKEN__: 't',
    location: { origin: 'http://127.0.0.1:3000' },
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) })
  await import(`../lib/client.js?${Math.random()}`)
  return spec.factory((n) => require(n))
}

test('设置页的更新按钮：有新版亮起「更新到 vX」；npm 没同步时灰着；装好待重启、更新中各有说法', async () => {
  const { updateView } = (await loadClient()).__test
  assert.equal(updateView(null, 'checking').label, '检查更新…')
  assert.deepEqual(
    (({ label, kind, disabled, action }) => ({ label, kind, disabled, action }))(updateView({ available: true, installable: '0.6.3', latest: '0.6.3' }, 'idle')),
    { label: '更新到 v0.6.3', kind: 'primary', disabled: false, action: 'run' },
  )
  const soon = updateView({ available: true, installable: '', latest: '0.6.3' }, 'idle')
  assert.equal(soon.disabled, true)
  assert.match(soon.title, /npm 上还没同步/)
  assert.equal(updateView({ restartPending: '0.6.3' }, 'idle').label, 'v0.6.3 已装好，重启后生效')
  assert.equal(updateView({ available: true, installable: '0.6.3' }, 'updating', 12).label, '正在更新…（12 秒）')
  assert.equal(updateView({ available: false }, 'idle').action, 'check', '已是最新：点了马上重查')
})
