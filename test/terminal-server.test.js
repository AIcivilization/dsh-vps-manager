// 对话里的真终端：鉴权、本机限制、输入输出、窗口大小、断开清理。
// 用真的 http 服务 + ws 客户端走完整条链路，ssh 换成本机 sh 假装的远端，不碰任何服务器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { bindSession, writeHosts } from '../lib/config.js'
import {
  TERMINAL_PATH,
  TERMINAL_PROTOCOL,
  checkUpgrade,
  clampSize,
  createMarkFilter,
  isLoopbackRequest,
  OutputRing,
  registerTerminal,
  remoteScript,
  resizeScript,
  terminalSshArgs,
} from '../lib/terminal-server.js'

// —————————————————————— 纯函数 ——————————————————————

test('tty 报告行被摘掉，拆成几段到达也认得出来', () => {
  const f = createMarkFilter()
  assert.equal(f.push(Buffer.from('__DSH_T')).length, 0, '没看到换行前先攒着')
  assert.equal(f.push(Buffer.from('TY__=/dev/pt')).length, 0)
  const out = f.push(Buffer.from('s/3\r\nroot@hk:~# '))
  assert.equal(out.toString(), 'root@hk:~# ')
  assert.equal(f.tty, '/dev/pts/3')
  assert.equal(f.done, true)
  assert.equal(f.push(Buffer.from('__DSH_TTY__=/dev/pts/9\n')).toString(), '__DSH_TTY__=/dev/pts/9\n', '只摘第一行，之后原样转发')
})

test('一直等不到报告就放弃，原样转发；报告里的 tty 不像路径就不用', () => {
  const f = createMarkFilter({ maxBytes: 10 })
  assert.equal(f.push(Buffer.from('hello')).length, 0)
  assert.equal(f.push(Buffer.from(' world!!')).toString(), 'hello world!!')
  assert.equal(f.tty, '')

  const g = createMarkFilter()
  g.push(Buffer.from('__DSH_TTY__=not a tty\n'))
  assert.equal(g.tty, '')
})

test('ssh 参数：申请伪终端、关掉转义字符、别名在 -- 之后且过白名单', () => {
  const args = terminalSshArgs('hk', remoteScript({ cols: 100, rows: 30 }))
  assert.equal(args[0], '-tt')
  assert.deepEqual(args.slice(1, 3), ['-e', 'none'])
  assert.ok(!args.includes('-T'), '-T 会禁止伪终端')
  assert.ok(args.includes('BatchMode=yes'), '不能卡在密码提示上')
  assert.equal(args.at(-2), 'hk')
  assert.equal(args.at(-3), '--')
  assert.throws(() => terminalSshArgs('-oProxyCommand=x', 'sh'), /别名不合法/)
})

test('远端脚本：先报 tty、设尺寸，再换成登录 shell；尺寸有上下限', () => {
  const script = remoteScript({ cols: 120, rows: 40 })
  assert.match(script, /^exec sh -c '/)
  assert.match(script, /__DSH_TTY__=%s/)
  assert.match(script, /stty sane iutf8 38400 rows 40 cols 120 \|\|/, '复用主连接时终端模式是全零，必须先恢复')
  assert.match(script, /\|\| stty sane rows 40 cols 120; \}/, '不认 iutf8 / 速率的系统退回最简写法')
  assert.match(script, /exec "\$\{SHELL:-\/bin\/sh\}" -l/)
  assert.deepEqual(clampSize(99999, -3), { cols: 500, rows: 5 })
  assert.deepEqual(clampSize('abc', undefined), { cols: 80, rows: 24 })
})

test('调整大小：Linux 与 BSD 两种 stty 写法；tty 不合法就不执行', () => {
  assert.equal(
    resizeScript('/dev/pts/3', 100, 40),
    'stty -F /dev/pts/3 rows 40 cols 100 2>/dev/null || stty -f /dev/pts/3 rows 40 cols 100',
  )
  assert.equal(resizeScript('/dev/pts/3; rm -rf /', 80, 24), null)
  assert.equal(resizeScript('', 80, 24), null)
})

test('本机判断：来源和地址栏都得是本机', () => {
  const req = (remoteAddress, host) => ({ socket: { remoteAddress }, headers: { host } })
  assert.equal(isLoopbackRequest(req('127.0.0.1', '127.0.0.1:8787')), true)
  assert.equal(isLoopbackRequest(req('::ffff:127.0.0.1', 'localhost:8787')), true)
  assert.equal(isLoopbackRequest(req('::1', '[::1]:8787')), true)
  assert.equal(isLoopbackRequest(req('192.168.1.5', '192.168.1.2:8787')), false, '局域网')
  assert.equal(isLoopbackRequest(req('127.0.0.1', 'dsh.example.com')), false, '同机反向代理进来的')
})

test('升级鉴权：DSH 登录校验、同源、token 缺一不可', () => {
  const token = 'a'.repeat(48)
  const base = {
    headers: {
      host: '127.0.0.1:8787',
      origin: 'http://127.0.0.1:8787',
      'sec-websocket-protocol': `${TERMINAL_PROTOCOL}, ${token}`,
    },
  }
  const withHeaders = (patch) => ({ headers: { ...base.headers, ...patch } })

  assert.deepEqual(checkUpgrade(base, { token }), { ok: true })
  assert.deepEqual(checkUpgrade(base, { token, connection: { requestRejection: () => undefined } }), { ok: true })
  assert.deepEqual(checkUpgrade(base, { token, connection: { requestRejection: () => 401 } }), { ok: false, code: 401 })
  assert.equal(checkUpgrade(withHeaders({ origin: 'https://evil.example' }), { token }).ok, false, '跨站网页')
  assert.equal(checkUpgrade(withHeaders({ 'sec-websocket-protocol': TERMINAL_PROTOCOL }), { token }).ok, false, '没带 token')
  assert.equal(checkUpgrade(withHeaders({ 'sec-websocket-protocol': `${TERMINAL_PROTOCOL}, ${'b'.repeat(48)}` }), { token }).ok, false)
  assert.equal(checkUpgrade(base, { token: '' }).ok, false, '服务端没有 token 时一律拒绝')
})

// —————————————————————— 整条链路 ——————————————————————

/** 模拟 dsh-host-webserver：普通路由按路径分发，升级请求原样转给注册的处理函数 */
async function startServer({ connection } = {}) {
  const routes = new Map()
  const upgrades = new Map()
  const webServer = {
    config: { host: '127.0.0.1', port: 0 },
    register: ({ path, handler }) => {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
    registerUpgrade: ({ path, handler }) => {
      upgrades.set(path, handler)
      return () => upgrades.delete(path)
    },
  }
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://x').pathname)
    if (!handler) {
      res.writeHead(404)
      return res.end()
    }
    return handler(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    const handler = upgrades.get(new URL(req.url, 'http://x').pathname)
    if (!handler) return socket.destroy()
    return handler(req, socket, head)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    webServer,
    webCtx: { webServer, get: (name) => (name === 'connection' ? connection : undefined) },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

async function sandbox(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-term-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({
    current: 'hk',
    hosts: { hk: { note: '香港' } },
    settings: { allowTerminalRemote: options.allowRemote === true },
  }, env)
  await bindSession('s1', 'hk', env)

  const children = []
  const resizes = []
  const token = 'f'.repeat(48)
  const srv = await startServer(options)
  const terminal = registerTerminal(srv.webCtx, {
    env,
    token,
    keepMs: options.keepMs ?? (() => 60_000),
    // 假装的远端：先报 tty，然后把收到的每一行回显出来；bye 以 7 退出；slow 过一会儿才输出
    spawnTerminal: options.spawnTerminal ?? (({ alias, cols, rows }) => {
      const child = spawn('sh', ['-c', [
        `printf '__DSH_TTY__=/dev/pts/9\\r\\n'`,
        `printf 'hello from %s %sx%s\\r\\n' ${alias} ${cols} ${rows}`,
        'while IFS= read -r line; do case "$line" in bye) exit 7;; slow) sleep 0.4; printf "slow-done\\r\\n";; *) printf "got:%s\\r\\n" "$line";; esac; done',
      ].join('; ')], { stdio: ['pipe', 'pipe', 'pipe'] })
      children.push(child)
      return child
    }),
    resize: async (req) => {
      resizes.push(req)
      return true
    },
  })

  const connect = ({ sessionId = 's1', protocols = [TERMINAL_PROTOCOL, token], headers = {}, cols = 90, rows = 20, resume, since, resumeOnly } = {}) => {
    const q = new URLSearchParams({ sessionId, cols: String(cols), rows: String(rows) })
    if (resume) q.set('resume', resume)
    if (since !== undefined) q.set('since', String(since))
    if (resumeOnly) q.set('resumeOnly', '1')
    const url = `ws://127.0.0.1:${srv.port}${TERMINAL_PATH}?${q}`
    const ws = new WebSocket(url, protocols, { origin: `http://127.0.0.1:${srv.port}`, headers })
    const frames = { text: '', json: [], bytes: 0 }
    ws.on('message', (data, isBinary) => {
      if (isBinary) frames.bytes += data.length
      if (isBinary) frames.text += data.toString()
      else frames.json.push(JSON.parse(String(data)))
    })
    const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
    const opened = new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })))
      ws.on('error', reject)
    })
    return { ws, frames, opened, closed }
  }

  return {
    env,
    token,
    srv,
    terminal,
    children,
    resizes,
    connect,
    cleanup: async () => {
      terminal.dispose()
      await srv.close()
    },
  }
}

async function until(fn, ms = 3000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail(`等了 ${ms}ms 条件仍未满足`)
}

test('连上以后：看不到 tty 报告行，打字有回显，退出码和收尾都对', async () => {
  const box = await sandbox()
  try {
    const c = box.connect()
    await c.opened
    await until(() => c.frames.text.includes('hello from hk 90x20'))
    assert.doesNotMatch(c.frames.text, /__DSH_TTY__/, 'tty 报告行不能显示给用户')
    const ready = c.frames.json[0]
    assert.equal(ready.t, 'ready')
    assert.equal(ready.alias, 'hk')
    assert.equal(ready.resizable, true)
    assert.equal(ready.resumed, false)
    assert.match(ready.id, /^[0-9a-f-]{36}$/, '会话 id 给浏览器，断线后凭它接回')

    c.ws.send(JSON.stringify({ t: 'i', d: 'ls -la\n' }))
    await until(() => c.frames.text.includes('got:ls -la'))
    assert.equal(box.terminal.live.size, 1)

    c.ws.send(JSON.stringify({ t: 'i', d: 'bye\n' }))
    await c.closed
    const exit = c.frames.json.find((m) => m.t === 'exit')
    assert.equal(exit.code, 7)
    await until(() => box.terminal.live.size === 0)
  } finally {
    await box.cleanup()
  }
})

test('调整窗口：连续拖动只发最后一次，用的是远端报告的 tty', async () => {
  const box = await sandbox()
  try {
    const c = box.connect()
    await c.opened
    await until(() => c.frames.json.some((m) => m.t === 'ready'))
    for (const cols of [100, 110, 120]) c.ws.send(JSON.stringify({ t: 'r', cols, rows: 33 }))
    await until(() => box.resizes.length >= 1)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(box.resizes.length, 1, '拖动过程中不要每一下都开一条 ssh')
    assert.equal(box.resizes[0].tty, '/dev/pts/9')
    assert.equal(box.resizes[0].alias, 'hk')
    assert.deepEqual([box.resizes[0].cols, box.resizes[0].rows], [120, 33])
    c.ws.close()
  } finally {
    await box.cleanup()
  }
})

test('断开连接不结束会话：接回来从断开的位置补发输出，接着能用', async () => {
  const box = await sandbox()
  try {
    const a = box.connect()
    await a.opened
    await until(() => a.frames.text.includes('hello from hk'))
    const id = a.frames.json[0].id
    // 发一个要过一会儿才出结果的命令，马上断开：结果是在「没人连着」的时候出来的
    a.ws.send(JSON.stringify({ t: 'i', d: 'slow\n' }))
    const received = a.frames.bytes
    a.ws.close()
    await a.closed
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(box.terminal.live.size, 1, '连接断了，会话还在')
    assert.equal(box.children[0].exitCode, null, 'ssh 还在跑')

    const b = box.connect({ resume: id, since: received })
    await b.opened
    await until(() => b.frames.text.includes('slow-done'))
    const ready = b.frames.json.find((m) => m.t === 'ready')
    assert.equal(ready.resumed, true)
    assert.equal(ready.id, id)
    assert.equal(ready.offset, received, '从浏览器已收到的位置接着发')
    assert.doesNotMatch(b.frames.text, /hello from/, '已经收到过的不重复发')
    assert.equal(box.children.length, 1, '没有另开 ssh')

    b.ws.send(JSON.stringify({ t: 'i', d: 'again\n' }))
    await until(() => b.frames.text.includes('got:again'))
  } finally {
    await box.cleanup()
  }
})

test('页面刷新后从头补发；点「结束」才真正结束 ssh', async () => {
  const box = await sandbox()
  try {
    const a = box.connect()
    await a.opened
    await until(() => a.frames.text.includes('hello from hk'))
    const id = a.frames.json[0].id
    a.ws.close()
    await a.closed

    // 刷新后浏览器什么都没有：since=0，把环里的内容整个补回来
    const b = box.connect({ resume: id, since: 0, resumeOnly: true })
    await b.opened
    await until(() => b.frames.text.includes('hello from hk 90x20'))

    const child = box.children[0]
    const exited = new Promise((resolve) => child.on('exit', resolve))
    b.ws.send(JSON.stringify({ t: 'end' }))
    await exited
    await b.closed
    await until(() => box.terminal.live.size === 0)
  } finally {
    await box.cleanup()
  }
})

test('断开后超过保留时间：ssh 结束；再来接回只得到「已经没了」，不会偷偷另开一个', async () => {
  const box = await sandbox({ keepMs: () => 150 })
  try {
    const a = box.connect()
    await a.opened
    await until(() => a.frames.json.some((m) => m.t === 'ready'))
    const id = a.frames.json[0].id
    const child = box.children[0]
    const exited = new Promise((resolve) => child.on('exit', resolve))
    a.ws.close()
    await exited
    await until(() => box.terminal.live.size === 0)

    const b = box.connect({ resume: id, since: 0, resumeOnly: true })
    await b.opened
    await b.closed
    assert.deepEqual(b.frames.json, [{ t: 'gone' }])
    assert.equal(box.children.length, 1, '收起状态下会话没了，不该自己再开一个')
  } finally {
    await box.cleanup()
  }
})

test('同一个终端在另一个窗口打开：旧窗口让位，不会两边抢着输入', async () => {
  const box = await sandbox()
  try {
    const a = box.connect()
    await a.opened
    await until(() => a.frames.json.some((m) => m.t === 'ready'))
    const id = a.frames.json[0].id
    const b = box.connect({ resume: id, since: a.frames.bytes })
    await b.opened
    const code = await a.closed
    assert.equal(code, 4409)
    assert.ok(a.frames.json.some((m) => m.t === 'taken'))
    b.ws.send(JSON.stringify({ t: 'i', d: 'mine\n' }))
    await until(() => b.frames.text.includes('got:mine'))
    assert.equal(box.terminal.live.size, 1)
  } finally {
    await box.cleanup()
  }
})

test('对话换了机器或关了开关：它在旧机器上的终端结束，别的对话不受影响', async () => {
  const box = await sandbox()
  try {
    await bindSession('s2', 'hk', box.env)
    const a = box.connect({ sessionId: 's1' })
    const b = box.connect({ sessionId: 's2' })
    await Promise.all([a.opened, b.opened])
    await until(() => box.terminal.live.size === 2)
    box.terminal.endFor('s1', '')
    await a.closed
    await until(() => box.terminal.live.size === 1)
    box.terminal.endFor('s2', 'hk') // 绑的还是 hk：不动
    assert.equal(box.terminal.live.size, 1)
  } finally {
    await box.cleanup()
  }
})

test('输出环：超过上限丢最旧的，按偏移补发', () => {
  const ring = new OutputRing(10)
  ring.push(Buffer.from('abcdef'))
  ring.push(Buffer.from('ghij'))
  assert.equal(ring.end, 10)
  assert.equal(ring.since(4).data.toString(), 'efghij')
  ring.push(Buffer.from('klm'))
  assert.equal(ring.base, 6, '丢掉最旧的一整块')
  assert.equal(ring.since(0).from, 6, '要的太早就从还留着的地方给')
  assert.equal(ring.since(0).data.toString(), 'ghijklm')
  assert.equal(ring.since(13).data.length, 0)
  ring.push(Buffer.from('0123456789ABCDEF'))
  assert.equal(ring.size, 10, '单块超上限只留尾巴')
  assert.equal(ring.since(0).data.toString(), '6789ABCDEF')
})

test('鉴权不过直接拒绝升级：没 token、token 错、跨站、DSH 登录校验不过', async () => {
  const box = await sandbox()
  try {
    await assert.rejects(box.connect({ protocols: [TERMINAL_PROTOCOL] }).opened, (e) => e.status === 403)
    await assert.rejects(box.connect({ protocols: [TERMINAL_PROTOCOL, 'e'.repeat(48)] }).opened, (e) => e.status === 403)

    const url = `ws://127.0.0.1:${box.srv.port}${TERMINAL_PATH}?sessionId=s1`
    const evil = new WebSocket(url, [TERMINAL_PROTOCOL, box.token], { origin: 'https://evil.example' })
    await assert.rejects(new Promise((resolve, reject) => {
      evil.on('open', resolve)
      evil.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })))
      evil.on('error', reject)
    }), (e) => e.status === 403)
    assert.equal(box.children.length, 0, '一个 ssh 都不该启动')
  } finally {
    await box.cleanup()
  }

  const locked = await sandbox({ connection: { requestRejection: () => 401 } })
  try {
    await assert.rejects(locked.connect().opened, (e) => e.status === 401)
    assert.equal(locked.children.length, 0)
  } finally {
    await locked.cleanup()
  }
})

test('没打开 VPS 开关的对话：说清原因，不启动 ssh', async () => {
  const box = await sandbox()
  try {
    const c = box.connect({ sessionId: 'nobody' })
    await c.opened
    await c.closed
    assert.match(c.frames.json[0].message, /还没打开 VPS 开关/)
    assert.equal(box.children.length, 0)
  } finally {
    await box.cleanup()
  }
})

test('默认只许本机：地址栏不是本机地址时要在设置里允许', async () => {
  const box = await sandbox()
  try {
    // 模拟局域网 / 反向代理：Host 是域名，Origin 跟着一致
    const url = `ws://127.0.0.1:${box.srv.port}${TERMINAL_PATH}?sessionId=s1`
    const ws = new WebSocket(url, [TERMINAL_PROTOCOL, box.token], {
      headers: { host: 'dsh.example.com' },
      origin: 'https://dsh.example.com',
    })
    const frames = []
    ws.on('message', (d) => frames.push(JSON.parse(String(d))))
    await new Promise((resolve) => ws.on('close', resolve))
    assert.match(frames[0].message, /默认只能在本机打开/)
    assert.equal(box.children.length, 0)
  } finally {
    await box.cleanup()
  }

  const open = await sandbox({ allowRemote: true })
  try {
    const url = `ws://127.0.0.1:${open.srv.port}${TERMINAL_PATH}?sessionId=s1`
    const ws = new WebSocket(url, [TERMINAL_PROTOCOL, open.token], {
      headers: { host: 'dsh.example.com' },
      origin: 'https://dsh.example.com',
    })
    let text = ''
    ws.on('message', (d, isBinary) => {
      if (isBinary) text += d.toString()
    })
    await until(() => text.includes('hello from hk'))
    ws.close()
  } finally {
    await open.cleanup()
  }
})

test('ssh 连不上（退出码 255）：把原因翻译给用户', async () => {
  const box = await sandbox({
    spawnTerminal: () => spawn('sh', ['-c', 'echo "ssh: connect to host 1.2.3.4 port 22: Connection refused" >&2; exit 255'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  })
  try {
    const c = box.connect()
    await c.opened
    await c.closed
    const exit = c.frames.json.find((m) => m.t === 'exit')
    assert.equal(exit.code, 255)
    assert.match(exit.hint, /端口拒绝连接/)
    assert.match(c.frames.text, /Connection refused/, 'ssh 原始报错也显示在终端里')
  } finally {
    await box.cleanup()
  }
})

test('xterm.js 静态文件：GET 可取，类型正确；DSH 登录校验不过就拒绝', async () => {
  const box = await sandbox()
  try {
    const base = `http://127.0.0.1:${box.srv.port}/api-vps/assets`
    const js = await fetch(`${base}/xterm.mjs?v=6.0.0`)
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type'), /text\/javascript/)
    assert.match(await js.text(), /export\{\w+ as Terminal\}/)
    const fit = await fetch(`${base}/addon-fit.mjs`)
    assert.match(await fit.text(), /FitAddon/)
    const css = await fetch(`${base}/xterm.css`)
    assert.match(css.headers.get('content-type'), /text\/css/)
    assert.equal((await fetch(`${base}/xterm.mjs`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/../index.js`)).status, 404, '只提供白名单里的三个文件')
  } finally {
    await box.cleanup()
  }

  const locked = await sandbox({ connection: { requestRejection: () => 401 } })
  try {
    const res = await fetch(`http://127.0.0.1:${locked.srv.port}/api-vps/assets/xterm.mjs`)
    assert.equal(res.status, 401)
  } finally {
    await locked.cleanup()
  }
})

test('插件卸载：所有终端断开，路由全部反注册', async () => {
  const box = await sandbox()
  const c = box.connect()
  await c.opened
  await until(() => box.terminal.live.size === 1)
  box.terminal.dispose()
  await c.closed
  assert.equal(box.terminal.live.size, 0)
  await assert.rejects(box.connect().opened)
  await box.srv.close()
})
