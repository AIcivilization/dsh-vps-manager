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
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data))
}

/**
 * 把一个已经升级好的 WebSocket 接到 ssh 上。
 * @returns {{ close(reason?): void, done: Promise<void> }}
 */
export function attachTerminal(ws, options) {
  const {
    alias,
    cols,
    rows,
    env = process.env,
    spawnTerminal = defaultSpawnTerminal,
    resize = defaultResize,
    onEnd = () => {},
  } = options
  const started = Date.now()
  const filter = createMarkFilter()
  const stderrTail = []
  let child
  let ended = false
  let alive = true
  let paused = false
  let exitInfo = { code: null, signal: null }
  let ping = null
  let drain = null
  let readySent = false
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })

  const timers = new Set()
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
    return t
  }

  const end = (reason) => {
    if (ended) return
    ended = true
    for (const t of timers) clearTimeout(t)
    clearInterval(ping)
    clearInterval(drain)
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
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try {
        ws.close(1000, String(reason ?? '').slice(0, 100))
      } catch {
        ws.terminate()
      }
    }
    onEnd({ ...exitInfo, reason, durationMs: Date.now() - started })
    resolveDone()
  }

  // —— 输出：远端 → 浏览器 ——
  const forward = (chunk) => {
    if (!chunk.length || ws.readyState !== ws.OPEN) return
    ws.send(chunk, { binary: true })
    if (!paused && ws.bufferedAmount > HIGH_WATER) {
      paused = true
      child.stdout.pause()
    }
  }
  drain = setInterval(() => {
    if (paused && ws.bufferedAmount < LOW_WATER) {
      paused = false
      child?.stdout?.resume()
    }
  }, 50)

  try {
    child = spawnTerminal({ alias, cols, rows, env })
  } catch (error) {
    sendJson(ws, { t: 'error', message: `启动 ssh 失败：${error.message}` })
    end('spawn_failed')
    return { close: end, done }
  }

  child.on('error', (error) => {
    const message = error.code === 'ENOENT' ? '本机找不到 ssh 命令' : `ssh 出错：${error.message}`
    sendJson(ws, { t: 'error', message })
    end('spawn_failed')
  })

  child.stdout.on('data', (chunk) => {
    const out = filter.push(chunk)
    if (filter.done && !readySent) sendReady()
    forward(out)
  })
  child.stderr.on('data', (chunk) => {
    stderrTail.push(chunk)
    while (stderrTail.length > 20) stderrTail.shift()
    forward(chunk)
  })

  const sendReady = () => {
    readySent = true
    sendJson(ws, { t: 'ready', alias, resizable: Boolean(filter.tty) })
  }
  later(() => {
    if (!filter.done) {
      forward(filter.flush())
      sendReady()
    }
  }, MARK_WAIT_MS)

  child.on('exit', (code, signal) => {
    exitInfo = { code, signal }
    // 等管道里剩下的输出读完再收尾
    later(() => {
      if (!filter.done) forward(filter.flush())
      const stderr = Buffer.concat(stderrTail).toString('utf8')
      const failure = code === 255 ? classifySshFailure(stderr, code) : null
      sendJson(ws, { t: 'exit', code, signal, hint: failure?.hint ?? '' })
      end('exit')
    }, 150)
  })

  // —— 输入：浏览器 → 远端 ——
  let wantSize = null
  let resizing = false
  let resizeTimer = null
  const runResize = async () => {
    if (resizing || !wantSize || ended) return
    if (!filter.tty) return
    resizing = true
    const target = wantSize
    wantSize = null
    try {
      await resize({ alias, tty: filter.tty, cols: target.cols, rows: target.rows, env })
    } catch {
      // 调不了大小不影响终端本身
    } finally {
      resizing = false
      if (wantSize) runResize()
    }
  }

  ws.on('message', (data, isBinary) => {
    if (ended) return
    if (isBinary) {
      child.stdin.write(data)
      return
    }
    let msg
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (msg?.t === 'i' && typeof msg.d === 'string') {
      child.stdin.write(msg.d)
    } else if (msg?.t === 'r') {
      wantSize = clampSize(msg.cols, msg.rows)
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = later(runResize, RESIZE_DEBOUNCE_MS)
    }
  })
  child.stdin.on('error', () => {
    // 远端已经退出时写入会 EPIPE，由 exit 事件收尾
  })

  // —— 保活：反向代理和 NAT 会掐掉长时间没流量的连接 ——
  ws.on('pong', () => {
    alive = true
  })
  ping = setInterval(() => {
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

  ws.on('close', () => end('client_closed'))
  ws.on('error', () => end('socket_error'))

  return { close: end, done }
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
  const live = new Set()

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

    // 鉴权过了才说具体原因：这些是「你该去改设置」一类的提示，不是安全信息
    if (!isLoopbackRequest(req)) {
      const doc = await readHosts(env)
      if (doc.settings.allowTerminalRemote !== true) {
        throw new Error('VPS 终端默认只能在本机打开。要从局域网或反向代理使用，到 DSH 设置 → VPS 管理 里勾选「允许从其他设备打开 VPS 终端」')
      }
    }
    if (!sessionId) throw new Error('缺少对话 ID')
    const alias = await sessionBinding(sessionId, env)
    if (!alias) throw new Error('这个对话还没打开 VPS 开关')
    if (live.size >= MAX_TERMINALS) throw new Error(`开着的终端太多了（最多 ${MAX_TERMINALS} 个），先关掉几个`)

    const { cols, rows } = clampSize(url.searchParams.get('cols'), url.searchParams.get('rows'))
    const source = isLoopbackRequest(req) ? 'terminal' : 'terminal-remote'
    appendAudit({ source, alias, action: 'terminal', status: 'opened', note: `session ${sessionId}` }, env).catch(() => {})

    let session = null
    let finished = false
    session = attachTerminal(ws, {
      alias,
      cols,
      rows,
      env,
      spawnTerminal: deps.spawnTerminal,
      resize: deps.resize,
      onEnd: (info) => {
        finished = true
        if (session) live.delete(session)
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
    if (!finished) live.add(session)
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

  return {
    live,
    dispose: () => {
      for (const session of [...live]) session.close('plugin_unloaded')
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
