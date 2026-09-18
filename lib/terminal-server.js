// lib/terminal-server.js — 对话里的真终端：xterm.js ⇄ WebSocket ⇄ ssh -tt
//
// /vps-sh 一问一答，菜单脚本、top、vim 这类要反复按键的程序用不了。这里给界面一条
// 实时连接，服务器那头是真正的伪终端，跟在 ssh 里一样操作。
//
// DSH 两种形态走同一套代码：
//   DSH Desktop  界面是 Electron 打开的 http://127.0.0.1:端口，webServer 外面还包了
//                一层「只认 Desktop 自己的界面」的校验
//   dsh web      浏览器打开 http://本机或局域网地址:端口（或反向代理的 https），登录靠 DSH 发的 Cookie
// 连接地址一律由界面用 location.origin 拼（http→ws，https→wss），不写死端口和主机。
//
// dsh-host-webserver 转交升级请求时**不做任何鉴权**，所以这里自己把关，缺一不可：
//   1. DSH 自己的浏览器校验（connection 服务：Host/Origin 围栏 + 登录 Cookie），有就必须过
//   2. 同源：Origin 的 host 必须等于 Host，挡住别的网页偷偷连
//   3. 每次启动随机生成、注入页面的 token（浏览器 WebSocket 不能加请求头，放在子协议里带过来）
//   4. 默认只许本机打开；局域网、反向代理进来的，要在设置里手动允许
//   5. 只能连这个对话绑定的那台机器
//
// 不用 node-pty（原生模块，装插件时容易编译失败）：伪终端由 `ssh -tt` 在服务器上申请，
// 本机这头只是管道。窗口大小没法经管道传过去，改为另开一条 ssh 对那个 tty 执行
// `stty rows/cols`，内核会给前台程序发 SIGWINCH，全屏程序就会按新尺寸重画。

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { WebSocketServer } from 'ws'
import { appendAudit } from './audit.js'
import { readHosts, sessionBinding } from './config.js'
import { shellQuote } from './payload.js'
import { runProcess } from './spawn.js'
import { assertAlias, baseOptions, classifySshFailure, sshArgs } from './ssh.js'

export const TERMINAL_PATH = '/api-vps/ws/terminal'
export const TERMINAL_PROTOCOL = 'dsh-vps-terminal'
export const TTY_MARK = '__DSH_TTY__='
export const XTERM_VERSION = '6.0.0'

const MAX_TERMINALS = 8
const MARK_WAIT_MS = 5000
const MARK_MAX_BYTES = 64 * 1024
const HIGH_WATER = 4 * 1024 * 1024
const LOW_WATER = 256 * 1024
const PING_MS = 20_000
const RESIZE_DEBOUNCE_MS = 120
const KILL_GRACE_MS = 2000
const RING_MAX = 512 * 1024 // 断线重连时能补发的输出上限
const TTY_RE = /^\/dev\/[A-Za-z0-9/._-]{1,64}$/

// —————————————————————— 把关 ——————————————————————

function hostnameOf(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname
  } catch {
    return ''
  }
}

function loopbackAddress(addr) {
  const a = String(addr ?? '').toLowerCase()
  return a === '::1' || /^127\./.test(a) || /^::ffff:127\./.test(a)
}

function loopbackHostname(name) {
  const n = String(name ?? '').toLowerCase()
  return n === 'localhost' || n === '[::1]' || /^127(\.\d{1,3}){3}$/.test(n)
}

/**
 * 是不是本机打开的：连接来自本机，**并且**地址栏写的也是本机地址。
 * 只看来源地址不够：同一台机器上的反向代理转进来的请求，来源也是 127.0.0.1。
 */
export function isLoopbackRequest(req) {
  return loopbackAddress(req?.socket?.remoteAddress) && loopbackHostname(hostnameOf(req?.headers?.host))
}

/** 浏览器 WebSocket 不能加请求头：token 放在子协议列表里，形如 "dsh-vps-terminal, <token>" */
export function protocolsOf(req) {
  return String(req?.headers?.['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 升级之前的鉴权。任何一步不过都直接拒绝，不给任何细节。
 * @returns {{ ok: true } | { ok: false, code: number }}
 */
export function checkUpgrade(req, { token, connection } = {}) {
  if (typeof connection?.requestRejection === 'function') {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) return { ok: false, code: rejection }
  }
  const host = req?.headers?.host
  const origin = req?.headers?.origin
  if (!host) return { ok: false, code: 400 }
  if (origin) {
    try {
      if (new URL(origin).host !== host) return { ok: false, code: 403 }
    } catch {
      return { ok: false, code: 403 }
    }
  }
  const protocols = protocolsOf(req)
  if (!token || !protocols.includes(TERMINAL_PROTOCOL) || !protocols.includes(token)) return { ok: false, code: 403 }
  return { ok: true }
}

function rejectSocket(socket, code) {
  const text = code === 401 ? 'unauthorized' : 'forbidden'
  try {
    socket.end([
      `HTTP/1.1 ${code === 401 ? '401 Unauthorized' : code === 400 ? '400 Bad Request' : '403 Forbidden'}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${text.length}`,
      '',
      text,
    ].join('\r\n'))
  } catch {
    socket.destroy()
  }
}

// —————————————————————— ssh 与远端脚本 ——————————————————————

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function clampSize(cols, rows) {
  return { cols: clampInt(cols, 20, 500, 80), rows: clampInt(rows, 5, 300, 24) }
}

/**
 * 远端要跑的东西：先报告自己的 tty（调窗口大小要用），把终端模式和尺寸设好，再换成登录 shell。
 * 外面包一层 sh -c：ssh 把命令交给用户的登录 shell 解释，fish 之类不认 POSIX 写法。
 *
 * 必须先 `stty sane`（实测）：复用 ControlMaster 主连接、而本机这头又不是真终端时，
 * OpenSSH 会把全零的终端模式发给服务器 —— 不回显、回车不换行、Ctrl+C 失效。
 * iutf8 让退格能删整个中文字符；BSD / BusyBox 不认 iutf8 时退回不带它的写法。
 */
export function remoteScript({ cols, rows } = {}) {
  const size = clampSize(cols, rows)
  const dims = `rows ${size.rows} cols ${size.cols}`
  const inner = [
    `printf '${TTY_MARK}%s\\n' "$(tty)"`,
    `{ stty sane iutf8 38400 ${dims} || stty sane 38400 ${dims} || stty sane ${dims}; } 2>/dev/null`,
    'exec "${SHELL:-/bin/sh}" -l',
  ].join('; ')
  return `exec sh -c ${shellQuote(inner)}`
}

/** 伪终端要 -tt（本机 stdin 是管道，单个 -t 不会申请）；-e none 关掉 ~. 转义，免得打字误断 */
export function terminalSshArgs(alias, remote) {
  assertAlias(alias)
  return ['-tt', '-e', 'none', ...baseOptions().filter((opt) => opt !== '-T'), '--', alias, remote]
}

/** Linux 用 stty -F，BSD / macOS 用 stty -f */
export function resizeScript(tty, cols, rows) {
  if (!TTY_RE.test(String(tty ?? ''))) return null
  const size = clampSize(cols, rows)
  const set = (flag) => `stty ${flag} ${tty} rows ${size.rows} cols ${size.cols}`
  return `${set('-F')} 2>/dev/null || ${set('-f')}`
}

/**
 * 从输出开头摘掉 tty 报告那一行。报告在远端 shell 起来之前，正常情况下是第一行；
 * 等太久或攒太多还没看到，就放弃，原样转发（窗口大小调不了，终端照样能用）。
 */
export function createMarkFilter({ maxBytes = MARK_MAX_BYTES } = {}) {
  let pending = Buffer.alloc(0)
  let done = false
  let tty = ''
  const mark = Buffer.from(TTY_MARK)
  return {
    get done() {
      return done
    },
    get tty() {
      return tty
    },
    push(chunk) {
      if (done) return chunk
      pending = Buffer.concat([pending, chunk])
      const at = pending.indexOf(mark)
      if (at >= 0) {
        const nl = pending.indexOf(0x0a, at)
        if (nl >= 0) {
          tty = pending.subarray(at + mark.length, nl).toString('utf8').replace(/\r$/, '').trim()
          if (!TTY_RE.test(tty)) tty = ''
          const out = Buffer.concat([pending.subarray(0, at), pending.subarray(nl + 1)])
          pending = Buffer.alloc(0)
          done = true
          return out
        }
      }
      if (pending.length > maxBytes) return this.flush()
      return Buffer.alloc(0)
    },
    flush() {
      done = true
      const out = pending
      pending = Buffer.alloc(0)
      return out
    },
  }
}

// —————————————————————— 一个终端连接 ——————————————————————

function defaultSpawnTerminal({ alias, cols, rows, env }) {
  return spawn('ssh', terminalSshArgs(alias, remoteScript({ cols, rows })), {
    stdio: ['pipe', 'pipe', 'pipe'],
    // DSH 进程里通常没有 TERM；ssh 申请伪终端时会把它带过去，没有的话远端全屏程序画不出来
    env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    windowsHide: true,
  })
}

async function defaultResize({ alias, tty, cols, rows, env }) {
  const script = resizeScript(tty, cols, rows)
  if (!script) return false
  const res = await runProcess('ssh', sshArgs(alias, { command: `sh -c ${shellQuote(script)}` }), {
    env,
    timeoutMs: 8000,
  })
  return res.exitCode === 0
}

function sendJson(ws, data) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(data))
}

/**
 * 最近的输出，按字节偏移记账：断线重连时从浏览器已经收到的位置接着补发。
 * 超过上限就丢最旧的（起点偏移随之后移）。
 */
export class OutputRing {
  constructor(max = RING_MAX) {
    this.max = max
    this.chunks = []
    this.size = 0
    this.base = 0 // 环里第一个字节的偏移
  }

  get end() {
    return this.base + this.size
  }

  push(chunk) {
    if (!chunk.length) return
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.max && this.chunks.length > 1) {
      const first = this.chunks.shift()
      this.size -= first.length
      this.base += first.length
    }
    if (this.size > this.max) {
      // 单块就超上限：只留尾巴
      const only = this.chunks[0]
      const cut = only.length - this.max
      this.chunks[0] = only.subarray(cut)
      this.size -= cut
      this.base += cut
    }
  }

  /** 从 offset 开始的内容；offset 早于环的起点就从起点给 */
  since(offset) {
    const from = Math.max(Number(offset) || 0, this.base)
    if (from >= this.end) return { from: this.end, data: Buffer.alloc(0) }
    const all = Buffer.concat(this.chunks)
    return { from, data: all.subarray(from - this.base) }
  }
}

/**
 * 一个终端会话：服务器上的 shell 独立存在，浏览器的连接可以断开再接回。
 *
 * 为什么要这样（用户提的）：收起、切走对话、刷新页面、网络抖一下，都不该把服务器上
 * 正在跑的东西弄丢。连接断了只算「暂时离开」，会话保留一段时间（设置里可调），
 * 期间的输出记在环形缓冲里，接回来时从浏览器已收到的位置补发。
 * 只有用户点「结束」、shell 自己退出、或保留时间到了，才真正结束。
 */
export class TerminalSession {
  constructor(opts) {
    this.id = opts.id ?? randomUUID()
    this.alias = opts.alias
    this.conversation = opts.conversation
    this.env = opts.env ?? process.env
    this.cols = opts.cols
    this.rows = opts.rows
    this.spawnTerminal = opts.spawnTerminal ?? defaultSpawnTerminal
    this.resize = opts.resize ?? defaultResize
    this.keepMs = opts.keepMs ?? (() => 10 * 60_000)
    this.onEnd = opts.onEnd ?? (() => {})
    this.started = Date.now()
    this.filter = createMarkFilter()
    this.ring = new OutputRing(opts.ringMax ?? RING_MAX)
    this.stderrTail = []
    this.ws = null
    this.ended = false
    this.ready = false
    this.paused = false
    this.exitInfo = { code: null, signal: null }
    this.timers = new Set()
    this.detachSeq = 0
    this.keepTimer = null
    this.wantSize = null
    this.resizing = false
    this.resizeTimer = null
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve
    })
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
    return t
  }

  /** 启动 ssh。失败时抛错，由调用方告诉浏览器 */
  start() {
    this.child = this.spawnTerminal({ alias: this.alias, cols: this.cols, rows: this.rows, env: this.env })
    const child = this.child
    child.on('error', (error) => {
      const message = error.code === 'ENOENT' ? '本机找不到 ssh 命令' : `ssh 出错：${error.message}`
      sendJson(this.ws, { t: 'error', message })
      this.end('spawn_failed')
    })
    child.stdout.on('data', (chunk) => {
      const out = this.filter.push(chunk)
      if (this.filter.done && !this.ready) this.markReady()
      this.output(out)
    })
    child.stderr.on('data', (chunk) => {
      this.stderrTail.push(chunk)
      while (this.stderrTail.length > 20) this.stderrTail.shift()
      this.output(chunk)
    })
    child.stdin.on('error', () => {
      // 远端已经退出时写入会 EPIPE，由 exit 事件收尾
    })
    this.later(() => {
      if (!this.filter.done) {
        const rest = this.filter.flush()
        this.markReady()
        this.output(rest)
      }
    }, MARK_WAIT_MS)
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal }
      // 等管道里剩下的输出读完再收尾
      this.later(() => {
        if (!this.filter.done) this.output(this.filter.flush())
        const stderr = Buffer.concat(this.stderrTail).toString('utf8')
        const failure = code === 255 ? classifySshFailure(stderr, code) : null
        sendJson(this.ws, { t: 'exit', code, signal, hint: failure?.hint ?? '' })
        this.end('exit')
      }, 150)
    })
  }

  markReady() {
    this.ready = true
    sendJson(this.ws, this.readyFrame(false))
  }

  readyFrame(resumed, offset = this.ring.end) {
    return { t: 'ready', alias: this.alias, id: this.id, resizable: Boolean(this.filter.tty), resumed, offset }
  }

  /** 远端输出：先记进环里，接着的话转给浏览器 */
  output(chunk) {
    if (!chunk?.length) return
    this.ring.push(chunk)
    const ws = this.ws
    if (!ws || ws.readyState !== ws.OPEN) return
    ws.send(chunk, { binary: true })
    if (!this.paused && ws.bufferedAmount > HIGH_WATER) {
      this.paused = true
      this.child.stdout.pause()
    }
  }

  /** 接上一个浏览器连接。已有连接的话，旧的让位（同一个终端在别的窗口打开了） */
  attach(ws, { since = 0, resumed = false } = {}) {
    if (this.ended) return
    if (this.ws && this.ws !== ws) {
      const old = this.ws
      this.release()
      sendJson(old, { t: 'taken' })
      try {
        old.close(4409, 'taken')
      } catch {
        old.terminate()
      }
    }
    this.detachSeq += 1
    if (this.keepTimer) {
      clearTimeout(this.keepTimer)
      this.keepTimer = null
    }
    this.ws = ws
    let alive = true

    const onMessage = (data, isBinary) => {
      if (this.ended) return
      if (isBinary) {
        this.child.stdin.write(data)
        return
      }
      let msg
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      if (msg?.t === 'i' && typeof msg.d === 'string') {
        this.child.stdin.write(msg.d)
      } else if (msg?.t === 'r') {
        this.wantSize = clampSize(msg.cols, msg.rows)
        if (this.resizeTimer) clearTimeout(this.resizeTimer)
        this.resizeTimer = this.later(() => this.runResize(), RESIZE_DEBOUNCE_MS)
      } else if (msg?.t === 'end') {
        this.end('user_ended')
      }
    }
    const onPong = () => {
      alive = true
    }
    const onClose = () => {
      if (this.ws === ws) this.detach()
    }
    ws.on('message', onMessage)
    ws.on('pong', onPong)
    ws.on('close', onClose)
    ws.on('error', onClose)

    // 保活：反向代理和 NAT 会掐掉长时间没流量的连接
    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate()
        return
      }
      alive = false
      try {
        ws.ping()
      } catch {
        // 连接已经断了，close 事件会收尾
      }
    }, PING_MS)
    const drain = setInterval(() => {
      if (this.paused && ws.bufferedAmount < LOW_WATER) {
        this.paused = false
        this.child?.stdout?.resume()
      }
    }, 50)
    this.release = () => {
      clearInterval(ping)
      clearInterval(drain)
      ws.off('message', onMessage)
      ws.off('pong', onPong)
      ws.off('close', onClose)
      ws.off('error', onClose)
      if (this.ws === ws) this.ws = null
      if (this.paused) {
        this.paused = false
        this.child?.stdout?.resume()
      }
      this.release = () => {}
    }

    if (resumed) {
      // 接回来：从浏览器已收到的位置补发断开期间的输出
      const { from, data } = this.ring.since(since)
      sendJson(ws, this.readyFrame(true, from))
      if (data.length) ws.send(data, { binary: true })
    } else if (this.ready) {
      sendJson(ws, this.readyFrame(false))
    }
  }

  release() {}

  /** 浏览器连接没了：shell 留着，保留时间到了才结束 */
  detach() {
    this.release()
    if (this.ended) return
    const seq = ++this.detachSeq
    Promise.resolve()
      .then(() => this.keepMs())
      .catch(() => 10 * 60_000)
      .then((ms) => {
        if (this.ended || this.ws || seq !== this.detachSeq) return
        this.keepTimer = setTimeout(() => this.end('detached_timeout'), Math.max(0, Number(ms) || 0))
        this.keepTimer.unref?.()
      })
  }

  async runResize() {
    if (this.resizing || !this.wantSize || this.ended) return
    if (!this.filter.tty) return
    this.resizing = true
    const target = this.wantSize
    this.wantSize = null
    try {
      await this.resize({ alias: this.alias, tty: this.filter.tty, cols: target.cols, rows: target.rows, env: this.env })
    } catch {
      // 调不了大小不影响终端本身
    } finally {
      this.resizing = false
      if (this.wantSize) this.runResize()
    }
  }

  end(reason) {
    if (this.ended) return
    this.ended = true
    for (const t of this.timers) clearTimeout(t)
    if (this.keepTimer) clearTimeout(this.keepTimer)
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM')
      } catch {
        // 已经退了
      }
      const killer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        } catch {
          // 已经退了
        }
      }, KILL_GRACE_MS)
      killer.unref?.()
    }
    const ws = this.ws
    this.release()
    if (ws && (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)) {
      try {
        ws.close(1000, String(reason ?? '').slice(0, 100))
      } catch {
        ws.terminate()
      }
    }
    this.onEnd({ ...this.exitInfo, reason, durationMs: Date.now() - this.started })
    this.resolveDone()
  }

  close(reason) {
    this.end(reason)
  }
}

// —————————————————————— 注册 ——————————————————————

const ASSETS = {
  'xterm.mjs': 'text/javascript; charset=utf-8',
  'addon-fit.mjs': 'text/javascript; charset=utf-8',
  'xterm.css': 'text/css; charset=utf-8',
}

/**
 * 注册终端连接和 xterm.js 静态文件。
 * @param webCtx 带 webServer 的上下文
 * @param deps { env, token, spawnTerminal?, resize? }
 */
export function registerTerminal(webCtx, deps = {}) {
  const server = webCtx.webServer
  if (!server || typeof server.registerUpgrade !== 'function') throw new Error('webServer 不支持实时连接')
  const env = deps.env ?? process.env
  const disposers = []
  const live = new Map() // 会话 id → TerminalSession（连着的、暂时断开的都算）
  const keepMs = deps.keepMs ?? (async () => {
    const doc = await readHosts(env)
    return (doc.settings.terminal?.keepMinutes ?? 10) * 60_000
  })

  // connection 可能比我们晚挂载，每次现取
  const connection = () => {
    try {
      return webCtx.get?.('connection')
    } catch {
      return undefined
    }
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has(TERMINAL_PROTOCOL) ? TERMINAL_PROTOCOL : false),
  })

  disposers.push(server.registerUpgrade({
    path: TERMINAL_PATH,
    handler: (req, socket, head) => {
      const check = checkUpgrade(req, { token: deps.token, connection: connection() })
      if (!check.ok) return rejectSocket(socket, check.code)
      wss.handleUpgrade(req, socket, head, (ws) => {
        openTerminal(ws, req).catch((error) => {
          sendJson(ws, { t: 'error', message: error.message ?? String(error) })
          ws.close(1011)
        })
      })
    },
  }))

  async function openTerminal(ws, req) {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const sessionId = String(url.searchParams.get('sessionId') ?? '').slice(0, 200)
    const resume = String(url.searchParams.get('resume') ?? '').slice(0, 64)
    const since = Math.max(0, Math.floor(Number(url.searchParams.get('since')) || 0))
    const resumeOnly = url.searchParams.get('resumeOnly') === '1'

    // 鉴权过了才说具体原因：这些是「你该去改设置」一类的提示，不是安全信息
    if (!isLoopbackRequest(req)) {
      const doc = await readHosts(env)
      if (doc.settings.allowTerminalRemote !== true) {
        throw new Error('VPS 终端默认只能在本机打开。要从局域网或反向代理使用，到 DSH 设置 → VPS 管理 → 终端 里勾选「允许从其他设备打开 VPS 终端」')
      }
    }
    if (!sessionId) throw new Error('缺少对话 ID')
    const alias = await sessionBinding(sessionId, env)
    if (!alias) throw new Error('这个对话还没打开 VPS 开关')

    // 接回原来的会话：必须是同一个对话、还绑着同一台机器
    if (resume) {
      const existing = live.get(resume)
      if (existing && !existing.ended && existing.conversation === sessionId) {
        if (existing.alias === alias) {
          existing.attach(ws, { since, resumed: true })
          return
        }
        existing.end('rebound')
      }
      if (resumeOnly) {
        sendJson(ws, { t: 'gone' })
        ws.close(1000, 'gone')
        return
      }
    }
    if (live.size >= MAX_TERMINALS) throw new Error(`开着的终端太多了（最多 ${MAX_TERMINALS} 个），先结束几个`)

    const { cols, rows } = clampSize(url.searchParams.get('cols'), url.searchParams.get('rows'))
    const source = isLoopbackRequest(req) ? 'terminal' : 'terminal-remote'
    const session = new TerminalSession({
      alias,
      conversation: sessionId,
      cols,
      rows,
      env,
      spawnTerminal: deps.spawnTerminal,
      resize: deps.resize,
      keepMs,
      onEnd: (info) => {
        live.delete(session.id)
        appendAudit({
          source,
          alias,
          action: 'terminal',
          status: 'closed',
          exitCode: info.code,
          durationMs: info.durationMs,
          note: info.reason,
        }, env).catch(() => {})
      },
    })
    live.set(session.id, session)
    appendAudit({ source, alias, action: 'terminal', status: 'opened', note: `session ${sessionId}` }, env).catch(() => {})
    session.attach(ws, { resumed: false })
    try {
      session.start()
    } catch (error) {
      sendJson(ws, { t: 'error', message: `启动 ssh 失败：${error.message}` })
      session.end('spawn_failed')
    }
  }

  /** 对话换了机器或关了开关：结束它在别的机器上的终端 */
  function endFor(conversation, keepAlias = '') {
    for (const session of [...live.values()]) {
      if (session.conversation === String(conversation) && session.alias !== keepAlias) session.end('rebound')
    }
  }

  // xterm.js 本体：公开的开源库，不含任何机密；照样走 DSH 的浏览器校验
  const assetDir = new URL('./vendor/xterm/', import.meta.url)
  for (const [file, type] of Object.entries(ASSETS)) {
    disposers.push(server.register({
      kind: 'exact',
      path: `/api-vps/assets/${file}`,
      handler: async (req, res) => {
        const rejection = connection()?.requestRejection?.(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          return res.end()
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          return res.end()
        }
        try {
          const body = await readFile(new URL(file, assetDir))
          res.writeHead(200, {
            'content-type': type,
            'content-length': body.length,
            // 地址里带版本号，换版本就是新地址
            'cache-control': 'private, max-age=604800, immutable',
            'x-content-type-options': 'nosniff',
          })
          return res.end(req.method === 'HEAD' ? undefined : body)
        } catch {
          res.writeHead(404)
          return res.end()
        }
      },
    }))
  }

  // DSH 进程退出时（没来得及卸载插件）也把 ssh 子进程带走，不留孤儿
  const killAll = () => {
    for (const session of live.values()) {
      try {
        session.child?.kill('SIGTERM')
      } catch {
        // 已经退了
      }
    }
  }
  process.once('exit', killAll)

  return {
    live,
    endFor,
    dispose: () => {
      process.removeListener('exit', killAll)
      for (const session of [...live.values()]) session.end('plugin_unloaded')
      for (const d of disposers) {
        try {
          d?.()
        } catch {
          // 反注册失败不影响卸载
        }
      }
      wss.close()
    },
  }
}
