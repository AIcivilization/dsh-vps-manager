// scripts/windows-e2e.mjs — 在真的 Windows 上把用户会走的路走一遍
//
// GitHub Actions 的 Windows 机器上跑：用 Windows 自带的 OpenSSH 客户端，连 WSL 里起的 Linux sshd
// （密码登录，端口 2222）。和用户操作的顺序一样：
//   填密码添加机器（放公钥 + 体检）→ 测连通 → 执行命令 → 远端任务 → 文件页（列目录、上传、
//   下载、编辑、回收站）→ 终端（伪终端、调窗口大小）→ 密码填错 → 卸载时撤销钥匙
//
// 会改运行它的这台电脑的 ~/.ssh（加连接配置和插件钥匙），所以只在 CI 里跑：要设 CI=true。
//
// 环境变量：E2E_PASSWORD（必填；CI 里故意带 % ^ & | " 这类命令行特殊字符）、
//           E2E_HOST（默认 127.0.0.1）、E2E_PORT（默认 2222）、E2E_USER（默认 tester）

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

if (process.env.CI !== 'true') {
  console.error('这个脚本会改本机的 ~/.ssh，只在 CI 里跑（设 CI=true）')
  process.exit(2)
}
const PASSWORD = process.env.E2E_PASSWORD
if (!PASSWORD) {
  console.error('缺少 E2E_PASSWORD')
  process.exit(2)
}
const HOST = process.env.E2E_HOST || '127.0.0.1'
const PORT = Number(process.env.E2E_PORT || 2222)
const USER = process.env.E2E_USER || 'tester'
const ALIAS = 'e2e'
const SESSION = 'sess-e2e'

// 插件数据放临时目录；ssh 配置和钥匙照真实情况写到用户目录（ssh 只认那里）
const env = { ...process.env, DSH_HOME: await mkdtemp(join(tmpdir(), 'dsh-vps-e2e-')) }

const { registerRoutes } = await import('../lib/routes.js')
const { bindSession, paths } = await import('../lib/config.js')
const { checkReach } = await import('../lib/reach.js')
const { STATUS, runRemote } = await import('../lib/engine.js')
const { runUninstall } = await import('../lib/uninstall.js')
const { scanFingerprint } = await import('../lib/onboarding.js')
const { createMarkFilter, remoteScript, resizeScript, terminalSshArgs } = await import('../lib/terminal-server.js')
const { shellQuote } = await import('../lib/payload.js')
const { runProcess } = await import('../lib/spawn.js')
const { baseOptions, sshArgs } = await import('../lib/ssh.js')
const { sshClientVersion } = await import('../lib/health.js')

// —— 和 DSH 一样把设置页接口挂起来，按浏览器发请求的样子调用 ——
const routes = new Map()
const webServer = {
  config: { host: '127.0.0.1', port: 3000 },
  register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) },
  tapIndex() { return () => {} },
}
const reg = registerRoutes({ webServer }, { env })
const LOCAL = { remoteAddress: '127.0.0.1' }

async function api(path, body = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', 'x-dsh-vps-token': reg.token }
  req.socket = LOCAL
  const out = {}
  await routes.get(`/api-vps/${path}`)(req, { writeHead: (c) => { out.code = c }, end: (t) => { out.body = t ? JSON.parse(t) : null } })
  return out.body
}
const files = (path, body = {}) => api(`files/${path}`, { sessionId: SESSION, ...body })

// —— 逐步执行，出错继续往下走，最后汇总 ——
const results = []
async function step(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, ms: Date.now() - started })
    console.log(`✓ ${name}（${Date.now() - started} ms）${detail ? `\n    ${String(detail).replace(/\n/g, '\n    ')}` : ''}`)
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error })
    console.log(`✗ ${name}\n    ${String(error?.stack ?? error).replace(/\n/g, '\n    ')}`)
  }
}

console.log(`平台 ${process.platform} ${process.arch} · Node ${process.version} · ${await sshClientVersion()}`)
console.log(`连接选项：${baseOptions().join(' ')}`)
console.log(`用户目录 ${paths(env).home}\n`)

await step('填错密码：说清是密码不对，不保存机器', async () => {
  const res = await api('onboarding/connect', { hostname: HOST, port: PORT, user: USER, password: `${PASSWORD}-wrong`, alias: 'e2e-bad' })
  assert.equal(res.ok, true, res.error)
  assert.equal(res.connected, false)
  assert.equal(res.reason, 'wrong_password', JSON.stringify(res))
  return res.hint
})

await step('填密码添加机器：放公钥、保存、用钥匙体检', async () => {
  const res = await api('onboarding/connect', { hostname: HOST, port: PORT, user: USER, password: PASSWORD, alias: ALIAS, note: '测试机' })
  assert.equal(res.ok, true, res.error)
  assert.equal(res.keyInstalled, true, JSON.stringify(res))
  assert.equal(res.connected, true, `体检没过：${res.hint} ${JSON.stringify(res.probe)}`)
  assert.ok(res.fingerprints.length > 0, '没取到服务器指纹')
  return `钥匙 ${res.keyPath}\n指纹 ${res.fingerprints[0]}`
})

await step('机器设置页「查看指纹」：现扫不到时退回 known_hosts 里记下的', async () => {
  const raw = await runProcess('ssh-keyscan', ['-p', String(PORT), '-T', '5', HOST], { timeoutMs: 15_000 }).catch((e) => ({ exitCode: e.code, stdout: '', stderr: e.message }))
  const res = await scanFingerprint({ hostname: HOST, port: PORT })
  assert.equal(res.ok, true, res.hint)
  assert.match(res.fingerprints[0], /SHA256:\S+ .*\(\w+\)$/)
  return `ssh-keyscan 退出码 ${raw.exitCode}，输出 ${raw.stdout.trim().split('\n').length} 行，stderr：${raw.stderr.trim().slice(0, 200) || '（无）'}\n用的是 ${res.source ?? 'ssh-keyscan'}：${res.fingerprints[0]}`
})

await step('ssh 按别名连得上（~/.ssh/config 的 Include + 插件的连接配置）', async () => {
  const res = await runProcess('ssh', sshArgs(ALIAS, { command: 'echo alias-ok' }), { timeoutMs: 30_000 })
  assert.equal(res.exitCode, 0, res.stderr)
  assert.match(res.stdout, /alias-ok/)
})

await step('测连通（顶部方块）', async () => {
  const res = await checkReach(ALIAS, { env, force: true })
  assert.equal(res.reachable, true, res.hint)
})

await step('执行命令（vps_exec 走的路）', async () => {
  const res = await runRemote({ alias: ALIAS, body: 'echo "hello-$((40+2))"; uname -s; printf "中文输出\\n"', env })
  assert.equal(res.status, STATUS.done, res.hint)
  assert.match(res.stdout, /hello-42/)
  assert.match(res.stdout, /Linux/)
  assert.match(res.stdout, /中文输出/)
})

await step('远端任务（改动类操作走的路）', async () => {
  const res = await runRemote({ alias: ALIAS, body: 'sleep 1; echo task-done', mode: 'task', waitSeconds: 60, env, meta: { source: 'e2e' } })
  assert.equal(res.status, STATUS.done, `${res.status} ${res.hint}`)
  assert.match(res.stdout, /task-done/)
  return `任务 ${res.taskId}`
})

await bindSession(SESSION, ALIAS, env)
let home = ''
const blob = randomBytes(300 * 1024)

await step('文件页：常用位置、列目录、新建文件夹', async () => {
  const places = await files('places')
  assert.equal(places.ok, true, places.error)
  home = places.home
  assert.equal((await files('mkdir', { dir: home, name: 'e2e 目录' })).ok, true)
  const list = await files('list', { path: home })
  assert.equal(list.ok, true, list.error)
  assert.ok(list.entries.some((e) => e.name === 'e2e 目录'), JSON.stringify(list.entries.map((e) => e.name)))
  return `家目录 ${home}，${list.entries.length} 项`
})

await step('文件页：上传二进制文件（原样到达）', async () => {
  const target = `${home}/e2e 目录/blob.bin`
  const req = Readable.from([blob])
  req.method = 'POST'
  req.url = `/api-vps/files/upload?sessionId=${SESSION}&path=${encodeURIComponent(target)}&size=${blob.length}`
  req.headers = { host: '127.0.0.1:3000', 'content-type': 'application/octet-stream', 'x-dsh-vps-token': reg.token }
  req.socket = LOCAL
  const out = {}
  await routes.get('/api-vps/files/upload')(req, { writeHead: (c) => { out.code = c }, end: (t) => { out.body = JSON.parse(t) } })
  assert.equal(out.body?.ok, true, out.body?.error)
  const res = await runRemote({ alias: ALIAS, body: `wc -c < "$HOME/e2e 目录/blob.bin"; sha256sum "$HOME/e2e 目录/blob.bin"`, env })
  assert.match(res.stdout, new RegExp(`^\\s*${blob.length}\\s*$`, 'm'))
  const { createHash } = await import('node:crypto')
  assert.match(res.stdout, new RegExp(createHash('sha256').update(blob).digest('hex')))
})

await step('文件页：下载（字节一致）', async () => {
  const ticket = await files('download', { path: `${home}/e2e 目录/blob.bin` })
  assert.equal(ticket.ok, true, ticket.error)
  const chunks = []
  const res = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
  res.writeHead = (code) => { res.code = code }
  const req = Readable.from([])
  req.method = 'GET'
  req.url = ticket.url
  req.headers = { host: '127.0.0.1:3000' }
  req.socket = LOCAL
  await routes.get('/api-vps/files/fetch')(req, res)
  await new Promise((r) => (res.writableFinished ? r() : res.on('finish', r)))
  assert.equal(res.code, 200)
  assert.ok(Buffer.concat(chunks).equals(blob), `下载到 ${Buffer.concat(chunks).length} 字节，应为 ${blob.length}`)
})

await step('文件页：编辑文本（打开、保存、冲突检测）', async () => {
  const path = `${home}/e2e 目录/site.conf`
  await runRemote({ alias: ALIAS, body: `printf 'v1\\n' > "$HOME/e2e 目录/site.conf"`, env })
  const opened = await files('read', { path })
  assert.equal(opened.content, 'v1\n')
  const saved = await files('save', { path, content: '第二版\n', expectSha: opened.sha })
  assert.equal(saved.ok, true, saved.error)
  const clash = await files('save', { path, content: 'x\n', expectSha: opened.sha })
  assert.equal(clash.conflict, true, '内容已经变了，旧指纹必须报冲突')
  assert.equal((await files('read', { path })).content, '第二版\n')
})

await step('文件页：删到回收站、还原', async () => {
  const path = `${home}/e2e 目录/site.conf`
  const trashed = await files('trash', { paths: [path] })
  assert.equal(trashed.moved?.length, 1, trashed.error)
  const bin = await files('trash-list')
  const item = bin.items.find((i) => i.origin === path)
  assert.ok(item, JSON.stringify(bin.items))
  assert.equal((await files('restore', { ids: [item.id] })).restored.length, 1)
})

await step('状态页签：一次 SSH 采完，规则判出需注意的项；打开时先给上次的结果', async () => {
  const res = await api('status/collect', { sessionId: SESSION })
  assert.equal(res.ok, true, res.error)
  assert.ok(res.status, `没采到：${JSON.stringify(res.failed)}`)
  const d = res.status.data
  assert.ok(d.mem?.total > 0, '内存')
  assert.ok(d.cores > 0, '核数')
  assert.ok(d.cpu !== null, 'CPU 使用率')
  assert.ok(d.disks.length > 0, '磁盘')
  assert.ok(d.uptime > 0, '运行时长')
  assert.ok(res.status.brief.includes('e2e'), '给 AI 的摘要')
  const again = await api('status/get', { sessionId: SESSION })
  assert.equal(again.status.collectedAt, res.status.collectedAt, '本机缓存')
  console.log(`STATUS_JSON ${JSON.stringify(res.status)}`) // 给界面做效果检查用的真实数据
  return `需注意 ${res.status.judged.attention.length} 项 · 正常 ${res.status.judged.ok.length} 项 · 取不到 ${res.status.judged.na.length} 项`
})

await step('终端：伪终端、命令回显、调整窗口大小、退出', async () => {
  const child = spawn('ssh', terminalSshArgs(ALIAS, remoteScript({ cols: 100, rows: 30 })), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
    windowsHide: true,
  })
  const filter = createMarkFilter()
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += filter.push(d).toString('utf8') })
  child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  const until = async (re, what, ms = 20_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (re.test(out)) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`等不到${what}。\n输出：${JSON.stringify(out.slice(-600))}\nstderr：${JSON.stringify(err.slice(-600))}`)
  }
  const deadline = Date.now() + 20_000
  while (!filter.done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert.ok(filter.tty, `没收到远端 tty 报告。stderr：${err}`)

  child.stdin.write('echo "term-$((6*7))"\r')
  await until(/term-42/, '命令输出')

  const resize = resizeScript(filter.tty, 120, 40)
  const r = await runProcess('ssh', sshArgs(ALIAS, { command: `sh -c ${shellQuote(resize)}` }), { timeoutMs: 20_000 })
  assert.equal(r.exitCode, 0, r.stderr)
  child.stdin.write('stty size\r')
  await until(/40 120/, '新的窗口大小')

  child.stdin.write('exit\r')
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15_000))])
  if (code === 'timeout') child.kill()
  assert.equal(code, 0, `退出码 ${code}`)
  return `tty ${filter.tty}${err.trim() ? `；ssh 的 stderr：${err.trim()}` : ''}`
})

await step('卸载：撤销本机钥匙后，用钥匙就登不上了', async () => {
  const res = await runUninstall({ env, choices: { revokeKey: true } })
  assert.equal(res.ok, true, JSON.stringify(res.steps))
  const after = await runRemote({ alias: ALIAS, body: 'echo still-in', env })
  assert.equal(after.status, STATUS.sshError, `撤销后应该连不上，实际：${after.status} ${after.stdout}`)
  assert.equal(after.reason, 'auth_failed', after.hint)
})

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
