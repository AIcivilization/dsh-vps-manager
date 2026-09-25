// 文件管理器的接口：只动对话绑定的那台、默认只许本机、每次改动记审计；上传下载走原始字节
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { bindSession, readHosts, writeHosts } from '../lib/config.js'
import { readAudit } from '../lib/audit.js'
import { registerRoutes } from '../lib/routes.js'
import { runProcess } from '../lib/spawn.js'
import { sharedFilesText, takeSharedFiles } from '../lib/terminal.js'

const LOCAL = { remoteAddress: '127.0.0.1' }

function jsonReq({ body = {}, headers = {}, socket = LOCAL } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', ...headers }
  req.socket = socket
  return req
}

function jsonRes() {
  const out = {}
  return {
    out,
    writeHead(code, headers) { out.code = code; out.headers = headers },
    end(text) { out.body = text ? JSON.parse(text) : null },
  }
}

function streamRes() {
  const chunks = []
  const res = new Writable({ write(chunk, _e, cb) { chunks.push(chunk); cb() } })
  res.writeHead = (code, headers) => { res.code = code; res.headers = headers }
  res.body = () => Buffer.concat(chunks)
  return res
}

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-files-routes-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: '', hosts: { hk: { note: '香港' } } }, env)
  await bindSession('sess-1', 'hk', env)
  const site = join(home, 'site')
  await mkdir(site)
  const spawnSsh = (_alias, script) => spawn('sh', ['-c', script], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
  const runner = (_alias, payload, opts = {}) => runProcess('sh', ['-s'], { input: payload, env: { ...process.env, HOME: home }, ...opts })
  const routes = new Map()
  const ws = {
    config: { host: '127.0.0.1', port: 3000 },
    register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) },
    tapIndex() { return () => {} },
  }
  const reg = registerRoutes({ webServer: ws }, { env, runner, spawnSsh })
  const call = async (path, body = {}, { socket = LOCAL, sessionId = 'sess-1' } = {}) => {
    const res = jsonRes()
    await routes.get(`/api-vps/files/${path}`)(jsonReq({ body: { sessionId, ...body }, headers: { 'x-dsh-vps-token': reg.token }, socket }), res)
    return res.out.body
  }
  return { home, env, site, routes, reg, call }
}

test('没打开 VPS 开关的对话：不给用', async () => {
  const s = await sandbox()
  const res = await s.call('list', { path: s.site }, { sessionId: 'other' })
  assert.equal(res.ok, false)
  assert.match(res.error, /还没打开 VPS 开关/)
})

test('从别的设备打开：默认拒绝，设置里放开后可以（和终端同一个开关）', async () => {
  const s = await sandbox()
  const lan = { remoteAddress: '192.168.1.20' }
  const denied = await s.call('list', { path: s.site }, { socket: lan })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /只能在运行 DSH 的这台电脑上打开/)

  const doc = await readHosts(s.env)
  await writeHosts({ ...doc, settings: { ...doc.settings, allowTerminalRemote: true } }, s.env)
  const allowed = await s.call('list', { path: s.site }, { socket: lan })
  assert.equal(allowed.ok, true)
})

test('浏览、新建、改名、删到回收站、还原、彻底删除，每次改动都记审计', async () => {
  const s = await sandbox()
  await writeFile(join(s.site, 'a.txt'), 'A')

  const places = await s.call('places')
  assert.equal(places.ok, true)
  assert.equal(places.home, s.home)
  assert.equal(places.alias, 'hk')

  const list = await s.call('list', { path: s.site })
  assert.deepEqual(list.entries.map((e) => e.name), ['a.txt'])

  assert.equal((await s.call('mkdir', { dir: s.site, name: 'img' })).ok, true)
  assert.equal((await s.call('rename', { dir: s.site, from: 'a.txt', to: 'b.txt' })).ok, true)
  const trashed = await s.call('trash', { paths: [join(s.site, 'b.txt')] })
  assert.equal(trashed.moved.length, 1)
  const bin = await s.call('trash-list')
  assert.equal(bin.items[0].origin, join(s.site, 'b.txt'))
  assert.equal((await s.call('restore', { ids: [bin.items[0].id] })).restored.length, 1)
  assert.equal(await readFile(join(s.site, 'b.txt'), 'utf8'), 'A')
  await s.call('trash', { paths: [join(s.site, 'img')] })
  assert.equal((await s.call('purge', { all: true })).ok, true)
  assert.deepEqual(await readdir(s.site), ['b.txt'])

  const actions = (await readAudit({ env: s.env })).filter((r) => r.source === 'files').map((r) => r.action)
  for (const a of ['mkdir', 'rename', 'trash', 'restore', 'purge']) assert.ok(actions.includes(a), `审计里缺 ${a}`)
})

test('服务器上的「不存在」「没权限」是提示，不是插件的错：失败返回并带原因', async () => {
  const s = await sandbox()
  const res = await s.call('list', { path: join(s.site, 'nope') })
  assert.equal(res.ok, false)
  assert.match(res.error, /目录不存在/)
  assert.equal(res.code, 'remote')
  const sys = await s.call('trash', { paths: ['/etc'] })
  assert.equal(sys.ok, false)
  assert.match(sys.error, /系统目录/)
})

test('编辑：打开带指纹；别人改过就提示冲突；确认覆盖后保存，原文件有备份', async () => {
  const s = await sandbox()
  const conf = join(s.site, 'site.conf')
  await writeFile(conf, 'v1\n')
  const opened = await s.call('read', { path: conf })
  assert.equal(opened.content, 'v1\n')

  await writeFile(conf, 'changed by AI\n') // 打开之后被别人改了
  const clash = await s.call('save', { path: conf, content: 'mine\n', expectSha: opened.sha })
  assert.equal(clash.ok, true)
  assert.equal(clash.conflict, true)
  assert.equal(await readFile(conf, 'utf8'), 'changed by AI\n', '冲突时不能覆盖')

  const saved = await s.call('save', { path: conf, content: 'mine\n', expectSha: opened.sha, force: true })
  assert.equal(saved.ok, true, saved.error)
  assert.equal(await readFile(conf, 'utf8'), 'mine\n')
  assert.ok(saved.backupPath)
  assert.equal(await readFile(saved.backupPath, 'utf8'), 'changed by AI\n')
  assert.match(saved.sha, /^[0-9a-f]{64}$/)
})

test('让 AI 看看：读出来、打码，下次跟 AI 说话时附上一次', async () => {
  const s = await sandbox()
  const env = join(s.site, '.env')
  await writeFile(env, 'DB_HOST=127.0.0.1\nAPI_KEY=sk-abcdefghijklmnopqrstuvwxyz0123\n')
  takeSharedFiles('sess-1')
  const res = await s.call('share', { path: env })
  assert.equal(res.ok, true)
  assert.equal(res.truncated, false)
  const items = takeSharedFiles('sess-1')
  assert.equal(items.length, 1)
  const text = sharedFilesText(items)
  assert.match(text, /\[VPS 文件\]/)
  assert.match(text, /hk:.*\.env/)
  assert.match(text, /DB_HOST=127\.0\.0\.1/)
  assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz0123/, '密钥交给 AI 之前要打码')
  assert.deepEqual(takeSharedFiles('sess-1'), [], '只附一次')
})

test('下载：一次性票据，2 分钟内有效；文件原样传回', async () => {
  const s = await sandbox()
  await writeFile(join(s.site, '报告.txt'), '内容 123')
  const ticket = await s.call('download', { path: join(s.site, '报告.txt') })
  assert.equal(ticket.ok, true)
  assert.equal(ticket.name, '报告.txt')
  assert.match(ticket.url, /^\/api-vps\/files\/fetch\?t=[a-f0-9]{48}$/)

  const fetch = s.routes.get('/api-vps/files/fetch')
  const get = (url) => {
    const req = Readable.from([])
    req.method = 'GET'
    req.url = url
    req.headers = { host: '127.0.0.1:3000' }
    req.socket = LOCAL
    return req
  }
  const res = streamRes()
  await fetch(get(ticket.url), res)
  await new Promise((r) => res.on('finish', r))
  assert.equal(res.code, 200)
  assert.equal(res.body().toString(), '内容 123')
  assert.match(res.headers['content-disposition'], /filename\*=UTF-8''/)
  assert.equal(res.headers['content-length'], Buffer.byteLength('内容 123'))

  const again = streamRes()
  await fetch(get(ticket.url), again)
  assert.equal(again.code, 403, '票据只能用一次')
})

test('上传：请求体就是文件；要 token、要二进制类型；覆盖时先备份', async () => {
  const s = await sandbox()
  const upload = s.routes.get('/api-vps/files/upload')
  const target = join(s.site, 'logo.png')
  const send = async (buf, { token = s.reg.token, type = 'application/octet-stream', size = buf.length } = {}) => {
    const req = Readable.from([buf])
    req.method = 'POST'
    req.url = `/api-vps/files/upload?sessionId=sess-1&path=${encodeURIComponent(target)}&size=${size}`
    req.headers = { host: '127.0.0.1:3000', 'content-type': type, 'x-dsh-vps-token': token }
    req.socket = LOCAL
    const res = jsonRes()
    await upload(req, res)
    return res.out
  }
  assert.equal((await send(Buffer.from('x'), { token: 'wrong' })).code, 403)
  assert.equal((await send(Buffer.from('x'), { type: 'application/json' })).code, 415)

  const first = await send(Buffer.from([1, 2, 3, 4]))
  assert.equal(first.body.ok, true, first.body.error)
  assert.deepEqual([...await readFile(target)], [1, 2, 3, 4])

  const second = await send(Buffer.from([9, 9]))
  assert.equal(second.body.ok, true)
  assert.ok(second.body.backupPath)
  assert.deepEqual([...await readFile(second.body.backupPath)], [1, 2, 3, 4])

  const short = await send(Buffer.from([7]), { size: 5 })
  assert.equal(short.body.ok, false)
  assert.match(short.body.error, /不完整/)
  assert.deepEqual([...await readFile(target)], [9, 9], '不完整的上传不能覆盖原文件')
})
