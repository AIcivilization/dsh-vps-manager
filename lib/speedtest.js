// lib/speedtest.js — 状态页的「网速」和「挑机器」两张卡片：在用户自己的电脑上测
//
// 设计见 工作流/dsh-vps-manager-网络体检设计.md 第二步。用户定的：
//   - 「网速」：这台 VPS 走代理和不走代理各多快，以签约带宽为 100%
//   - 直连这台 VPS 测带宽时，在 VPS 上临时开一个测速服务，防火墙只对用户家的 IP 放行，测完就关；
//     第一次先问；被云厂商安全组挡住、或服务器上没有 python3，就退回经 SSH 测（写明偏低）
//   - 「挑机器」：填几个 IP / 域名 / Looking Glass 地址，从这台电脑直连测，放在一起比
//
// 用户电脑上常开着代理软件（小火箭等），规则模式：国外网站走代理、其余直连；而且接管了 DNS，
// 系统查到的是 198.18.x.x 这种只有它认识的假 IP。所以（2026-10-15 实测）：
//   走代理：照常发请求，交给代理软件按规则走；测完核对出口 IP 是不是这台 VPS
//   不走代理：绑定物理网卡（curl --interface en0、ping -b en0），域名自己用阿里 DNS 的 HTTPS 接口查
//            （同样绑物理网卡），绕开代理软件；测完核对出口 IP 是不是用户家的宽带
// 下载、上传用 fast.com 的 Netflix 测速服务器：用户平时就用 fast 测，结果对得上。
// （Cloudflare 的测速接口实测走代理只有几 Mbps，100 MB 起直接拒绝，不用它）
// 全部用 curl 和 ping 两个系统命令：Node 自己的网络请求绑不了网卡。

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, dshHome } from './config.js'
import { L } from './i18n.js'

// —————————————————————— 跑系统命令 ——————————————————————

const PROXY_ENV = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']

/**
 * 跑一个命令，收齐输出。uploadBytes：往 stdin 灌这么多个 0（测上传用），对方停了就停
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
export function execCommand(cmd, args, { timeoutMs = 30_000, env = process.env, uploadBytes = 0 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { env, stdio: [uploadBytes ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error.message })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (error) => { stderr += error.message })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    if (uploadBytes) {
      const chunk = Buffer.alloc(1 << 20)
      let left = uploadBytes
      const pump = () => {
        while (left > 0) {
          const piece = left >= chunk.length ? chunk : chunk.subarray(0, left)
          left -= piece.length
          if (!child.stdin.write(piece)) {
            child.stdin.once('drain', pump)
            return
          }
        }
        child.stdin.end()
      }
      child.stdin.on('error', () => {}) // curl 到时间先退出，stdin 断了是正常的
      pump()
    }
  })
}

// —————————————————————— 两条路：走代理 / 不走代理 ——————————————————————

const TUN_RE = /^(utun|tun|tap|wg|ipsec|ppp|gif|stf|tailscale|zt)/i

/**
 * 看这台电脑的网络：默认路由走哪块网卡（是不是代理软件的隧道）、物理网卡是哪块、系统代理设了没有
 * @returns {{ platform, defaultIface, tun: boolean, iface: string|null, proxy: string|null }}
 */
export async function detectPaths({ exec = execCommand, platform = process.platform } = {}) {
  const out = { platform, defaultIface: null, tun: false, iface: null, proxy: null }
  if (platform === 'darwin') {
    const route = await exec('route', ['-n', 'get', 'default'], { timeoutMs: 5000 })
    out.defaultIface = /interface:\s*(\S+)/.exec(route.stdout)?.[1] ?? null
    const list = (await exec('ifconfig', ['-l'], { timeoutMs: 5000 })).stdout.trim().split(/\s+/)
    for (const name of list.filter((n) => /^en\d+$/.test(n))) {
      const info = (await exec('ifconfig', [name], { timeoutMs: 5000 })).stdout
      if (/status:\s*active/.test(info) && /\binet (?!169\.254\.)\d+\.\d+\.\d+\.\d+/.test(info)) {
        out.iface = name
        break
      }
    }
    const proxy = (await exec('scutil', ['--proxy'], { timeoutMs: 5000 })).stdout
    const val = (k) => new RegExp(`\\b${k}\\s*:\\s*(\\S+)`).exec(proxy)?.[1]
    if (val('HTTPSEnable') === '1' && val('HTTPSProxy')) out.proxy = `http://${val('HTTPSProxy')}:${val('HTTPSPort') ?? 80}`
    else if (val('HTTPEnable') === '1' && val('HTTPProxy')) out.proxy = `http://${val('HTTPProxy')}:${val('HTTPPort') ?? 80}`
  } else if (platform === 'linux') {
    const route = await exec('ip', ['route', 'show', 'default'], { timeoutMs: 5000 })
    out.defaultIface = /\bdev\s+(\S+)/.exec(route.stdout)?.[1] ?? null
    const addrs = (await exec('ip', ['-o', '-4', 'addr', 'show', 'scope', 'global'], { timeoutMs: 5000 })).stdout
    out.iface = addrs.split('\n').map((l) => /^\d+:\s*(\S+)/.exec(l)?.[1]).find((n) => n && !TUN_RE.test(n) && n !== 'lo') ?? null
  }
  out.tun = Boolean(out.defaultIface && TUN_RE.test(out.defaultIface))
  // 不是隧道的话，默认路由本来就是直连，不用绑网卡
  if (!out.tun) out.iface = null
  return out
}

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^[0-9a-f:]+$/i.test(h)

/** curl 走哪条路的参数 */
function pathArgs(path, net) {
  if (path === 'direct') return ['--noproxy', '*', ...(net.iface ? ['--interface', net.iface] : [])]
  // 走代理：隧道模式下照常发就行；只设了系统代理（没开隧道）就显式指定代理
  return !net.tun && net.proxy ? ['-x', net.proxy] : []
}
const pathEnv = (path) => {
  if (path !== 'direct') return process.env
  const env = { ...process.env }
  for (const k of PROXY_ENV) delete env[k]
  return env
}

/** 绕开代理软件查真实 IP：阿里 DNS 的 HTTPS 接口，同样绑物理网卡（系统 DNS 被代理软件接管了） */
export async function realResolve(host, net, { exec = execCommand, cache = new Map() } = {}) {
  if (isIp(host)) return host
  if (cache.has(host)) return cache.get(host)
  for (const dns of ['223.5.5.5', '223.6.6.6']) {
    const res = await exec('curl', ['-s', '-m', '6', ...pathArgs('direct', net), `https://${dns}/resolve?name=${encodeURIComponent(host)}&type=1`], { timeoutMs: 8000, env: pathEnv('direct') })
    try {
      const ip = JSON.parse(res.stdout).Answer?.find((a) => a.type === 1)?.data
      if (ip) {
        cache.set(host, ip)
        return ip
      }
    } catch {
      // 换一个再试
    }
  }
  return null
}

const FORMAT = '%{http_code} %{size_download} %{size_upload} %{time_connect} %{time_appconnect} %{time_pretransfer} %{time_starttransfer} %{time_total} %{remote_ip}\n'

/** 一次 curl：返回状态码、收发了多少、各阶段用时 */
export function parseCurlStats(text) {
  const [code, down, up, connect, appconnect, pretransfer, start, total, ip] = String(text ?? '').trim().split('\n').pop().split(/\s+/)
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return { code: n(code), down: n(down), up: n(up), connect: n(connect), appconnect: n(appconnect), pretransfer: n(pretransfer), start: n(start), total: n(total), ip: ip ?? '' }
}

/**
 * 发一次请求。direct 时域名换成真实 IP（--resolve），绑物理网卡
 * @param opts.seconds  最多跑几秒（到点算正常结束）
 * @param opts.upload   上传这么多字节（POST），否则是 GET
 */
export async function curlOnce(url, path, net, { exec = execCommand, seconds = 10, upload = 0, cache } = {}) {
  const args = ['-s', '-o', '/dev/null', '-m', String(seconds), '-w', FORMAT, ...pathArgs(path, net)]
  if (path === 'direct') {
    const u = new URL(url)
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (!isIp(host)) {
      const ip = await realResolve(host, net, { exec, cache })
      if (!ip) return { code: 0, down: 0, up: 0, connect: 0, appconnect: 0, pretransfer: 0, start: 0, total: 0, ip: '', error: 'resolve' }
      args.push('--resolve', `${host}:${u.port || (u.protocol === 'https:' ? 443 : 80)}:${ip}`)
    }
  }
  if (upload) args.push('--data-binary', '@-', '-H', 'content-type: application/octet-stream')
  args.push(url)
  const res = await exec('curl', args, { timeoutMs: (seconds + 5) * 1000, env: pathEnv(path), uploadBytes: upload })
  return parseCurlStats(res.stdout)
}

/** 出口：Cloudflare 看到的来源 IP 和国家（核对测试流量真走了哪条路） */
export async function egressOf(path, net, { exec = execCommand, cache } = {}) {
  const args = ['-s', '-m', '8', ...pathArgs(path, net)]
  const host = 'www.cloudflare.com'
  if (path === 'direct') {
    const ip = await realResolve(host, net, { exec, cache })
    if (!ip) return null
    args.push('--resolve', `${host}:443:${ip}`)
  }
  const res = await exec('curl', [...args, `https://${host}/cdn-cgi/trace`], { timeoutMs: 10_000, env: pathEnv(path) })
  const ip = /^ip=(.+)$/m.exec(res.stdout)?.[1]?.trim()
  return ip ? { ip, country: /^loc=([A-Z]{2})$/m.exec(res.stdout)?.[1] ?? null } : null
}

/** 多个连接一起下载（或只开一个），按「真正在传数据的时间」算速度，去掉建连接、等首字节的时间 */
export async function downloadSpeed(urls, path, net, { exec = execCommand, conns = 6, seconds = 8, cache } = {}) {
  if (!urls.length) return null
  const runs = await Promise.all(Array.from({ length: conns }, (_, i) => curlOnce(urls[i % urls.length], path, net, { exec, seconds, cache })))
  const ok = runs.filter((r) => r.down > 0)
  if (!ok.length) return { mbps: 0, bytes: 0, conns }
  const bytes = ok.reduce((s, r) => s + r.down, 0)
  const span = Math.max(...ok.map((r) => r.total - r.start).filter((t) => t > 0), 0.001)
  return { mbps: Math.round((bytes * 8) / span / 1e6), bytes, conns }
}

export async function uploadSpeed(url, path, net, { exec = execCommand, seconds = 6, bytes = 400 * 1024 * 1024, cache } = {}) {
  const r = await curlOnce(url, path, net, { exec, seconds, upload: bytes, cache })
  const span = r.total - r.pretransfer
  return r.up > 0 && span > 0 ? { mbps: Math.round((r.up * 8) / span / 1e6), bytes: r.up } : null
}

/** 小请求的往返时间（毫秒）：一次请求、一次响应，用来测走代理时的延迟（ICMP ping 过不了代理） */
export async function httpLatency(url, path, net, { exec = execCommand, count = 5, cache } = {}) {
  const samples = []
  for (let i = 0; i < count; i++) {
    const r = await curlOnce(url, path, net, { exec, seconds: 5, cache })
    const base = r.appconnect || r.connect
    if (r.code && r.start > base) samples.push(Math.round((r.start - base) * 1000))
  }
  return stats(samples)
}

function stats(samples) {
  if (!samples.length) return null
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
  const jitter = samples.length > 1 ? Math.round(samples.slice(1).reduce((s, v, i) => s + Math.abs(v - samples[i]), 0) / (samples.length - 1)) : 0
  return { avg, min: Math.min(...samples), jitter, samples: samples.length }
}

/** 解析 ping 的汇总行（macOS、Linux、Windows 三种写法） */
export function parsePing(text) {
  const s = String(text ?? '')
  const loss = /([\d.]+)% (?:packet )?loss/.exec(s)?.[1] ?? /\((\d+)% loss\)/.exec(s)?.[1]
  const unix = /= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/.exec(s)
  if (unix) return { loss: Number(loss ?? 0), min: Math.round(Number(unix[1])), avg: Math.round(Number(unix[2])), jitter: Math.round(Number(unix[4])) }
  const win = /Minimum = (\d+)ms, Maximum = (\d+)ms, Average = (\d+)ms/.exec(s)
  if (win) return { loss: Number(loss ?? 0), min: Number(win[1]), avg: Number(win[3]), jitter: Math.round((Number(win[2]) - Number(win[1])) / 2) }
  return loss !== undefined ? { loss: Number(loss), min: null, avg: null, jitter: null } : null
}

/** 直连 ping（绑物理网卡，绕开代理软件）。ICMP 被挡时丢包 100%，调用方再用 TCP 连接时间补 */
export async function pingStats(ip, net, { exec = execCommand, count = 10 } = {}) {
  const args = net.platform === 'win32'
    ? ['-n', String(count), ip]
    : [...(net.iface ? (net.platform === 'darwin' ? ['-b', net.iface] : ['-I', net.iface]) : []), '-c', String(count), '-i', '0.2', '-q', ip]
  const res = await exec('ping', args, { timeoutMs: count * 1500 + 5000 })
  return parsePing(`${res.stdout}\n${res.stderr}`)
}

/** TCP 建连接的时间（ICMP 被挡时的延迟），直连 */
export async function tcpConnectMs(ip, port, net, { exec = execCommand, count = 3 } = {}) {
  const samples = []
  for (let i = 0; i < count; i++) {
    const r = await curlOnce(`http://${ip.includes(':') ? `[${ip}]` : ip}:${port}/`, 'direct', net, { exec, seconds: 4 })
    if (r.connect > 0) samples.push(Math.round(r.connect * 1000))
  }
  return stats(samples)
}

// —————————————————————— fast.com 的测速服务器 ——————————————————————

// fast.com 网页里公开的 token（fast 的命令行工具也用它）
const FAST_API = 'https://api.fast.com/netflix/speedtest/v2?https=true&token=YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm&urlCount=5'

/** 离出口最近的几个 Netflix 测速服务器（走哪条路就离哪条路的出口近） */
export async function fastTargets(path, net, { exec = execCommand, cache } = {}) {
  const args = ['-s', '-m', '10', ...pathArgs(path, net)]
  if (path === 'direct') {
    const ip = await realResolve('api.fast.com', net, { exec, cache })
    if (!ip) return []
    args.push('--resolve', `api.fast.com:443:${ip}`)
  }
  const res = await exec('curl', [...args, FAST_API], { timeoutMs: 12_000, env: pathEnv(path) })
  try {
    return (JSON.parse(res.stdout).targets ?? []).map((t) => String(t.url)).filter((u) => u.startsWith('https://'))
  } catch {
    return []
  }
}
/** 下载用的地址：每个最多 25 MB（fast 网页也是这么取的），跑满时间就停 */
const fastRange = (url, bytes = 26_214_400) => {
  const [base, q = ''] = url.split('?')
  return `${base}/range/0-${bytes}${q ? `?${q}` : ''}`
}

// —————————————————————— VPS 上的临时测速服务 ——————————————————————
// 用到 prelude 里的 has_cmd、$SUDO。参数（校验过）：P_PORT、P_TOKEN、P_HOME（用户家的 IPv4）、P_SECS。
// 防火墙开着的话只对 P_HOME 放行这个端口；测速服务跑满 P_SECS 秒（或收到 /stop）就退出，
// 退出后由同一个后台脚本撤掉放行规则、删掉临时文件。注意：脚本里不能出现「美元符 + 左花括号」
export const SPEED_SERVER_SCRIPT = String.raw`
if ! has_cmd python3; then printf 'speed_err=nopython\n'; exit 0; fi
D="$HOME/.cache/dsh-vps/speedtest"
mkdir -p "$D" && chmod 700 "$D"
cat > "$D/server.py" <<'PYEOF'
import http.server, json, socketserver, sys, threading
port = int(sys.argv[1]); token = sys.argv[2]
peers = set(); lock = threading.Lock()
def snmp():
    try:
        rows = [l.split() for l in open('/proc/net/snmp') if l.startswith('Tcp:')]
        d = dict(zip(rows[0], rows[1]))
        return int(d['OutSegs']), int(d['RetransSegs'])
    except Exception:
        return None
start = snmp()
CHUNK = bytes(1 << 20)
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a):
        pass
    def cmd(self):
        p = self.path.split('?', 1)[0]
        pre = '/' + token + '/'
        if not p.startswith(pre):
            return None
        with lock:
            peers.add(self.client_address[0])
        return p[len(pre):]
    def reply(self, code, body=b'', kind='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if body:
            self.wfile.write(body)
    def do_GET(self):
        c = self.cmd()
        if c == 'down':
            q = dict(x.split('=', 1) for x in (self.path.split('?', 1) + [''])[1].split('&') if '=' in x)
            n = min(int(q.get('bytes', '0') or 0) or (1 << 30), 2 << 30)
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(n))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            try:
                while n > 0:
                    piece = CHUNK if n >= len(CHUNK) else CHUNK[:n]
                    self.wfile.write(piece)
                    n -= len(piece)
            except Exception:
                pass
        elif c == 'ping':
            self.reply(204)
        elif c == 'stats':
            now = snmp()
            out = (now[0] - start[0]) if now and start else None
            re = (now[1] - start[1]) if now and start else None
            with lock:
                seen = sorted(peers)
            self.reply(200, json.dumps({'peers': seen, 'out': out, 'retrans': re}).encode())
        elif c == 'stop':
            self.reply(204)
            threading.Thread(target=srv.shutdown, daemon=True).start()
        else:
            self.reply(404)
    def do_POST(self):
        if self.cmd() != 'up':
            self.reply(404)
            return
        got = 0
        try:
            if 'chunked' in (self.headers.get('Transfer-Encoding') or '').lower():
                while True:
                    size = int(self.rfile.readline().split(b';')[0].strip() or b'0', 16)
                    if size == 0:
                        self.rfile.readline()
                        break
                    left = size
                    while left > 0:
                        b = self.rfile.read(min(1 << 20, left))
                        if not b:
                            raise EOFError
                        left -= len(b)
                        got += len(b)
                    self.rfile.readline()
            else:
                left = int(self.headers.get('Content-Length') or 0)
                while left > 0:
                    b = self.rfile.read(min(1 << 20, left))
                    if not b:
                        break
                    left -= len(b)
                    got += len(b)
        except Exception:
            pass
        self.reply(200, json.dumps({'bytes': got}).encode())
class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
srv = S(('0.0.0.0', port), H)
srv.serve_forever()
PYEOF
fw=none; del=''
if [ "$SUDO" != "__NO_PRIV__" ]; then
  if has_cmd ufw && $SUDO ufw status 2>/dev/null | grep -q 'Status: active'; then
    fw=ufw
    $SUDO ufw allow from "$P_HOME" to any port "$P_PORT" proto tcp comment dsh-vps-speedtest >/dev/null 2>&1 || fw=failed
    del="$SUDO ufw delete allow from $P_HOME to any port $P_PORT proto tcp"
  elif has_cmd firewall-cmd && $SUDO firewall-cmd --state >/dev/null 2>&1; then
    fw=firewalld
    rule="rule family=ipv4 source address=$P_HOME port port=$P_PORT protocol=tcp accept"
    $SUDO firewall-cmd --add-rich-rule="$rule" >/dev/null 2>&1 || fw=failed
    del="$SUDO firewall-cmd --remove-rich-rule='$rule'"
  elif has_cmd iptables && $SUDO iptables -S INPUT 2>/dev/null | grep -qE '^-P INPUT (DROP|REJECT)| -j (DROP|REJECT)'; then
    fw=iptables
    spec="INPUT -s $P_HOME -p tcp --dport $P_PORT -m comment --comment dsh-vps-speedtest -j ACCEPT"
    $SUDO iptables -I $spec >/dev/null 2>&1 || fw=failed
    del="$SUDO iptables -D $spec"
  fi
elif (has_cmd ufw && ufw status 2>/dev/null | grep -q 'Status: active'); then
  fw=nopriv
fi
printf 'speed_fw=%s\n' "$fw"
[ "$fw" = failed ] || [ "$fw" = nopriv ] && exit 0
{
  printf 'timeout %s python3 "%s/server.py" %s %s\n' "$P_SECS" "$D" "$P_PORT" "$P_TOKEN"
  [ -n "$del" ] && printf '%s >/dev/null 2>&1\n' "$del"
  printf 'rm -f "%s/server.py" "%s/run.sh"\n' "$D" "$D"
} > "$D/run.sh"
if has_cmd setsid; then setsid sh "$D/run.sh" >/dev/null 2>&1 < /dev/null &
else nohup sh "$D/run.sh" >/dev/null 2>&1 < /dev/null &
fi
i=0
while [ $i -lt 25 ]; do
  if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q "[:.]$P_PORT "; then printf 'speed_ready=1\n'; exit 0; fi
  sleep 0.2; i=$((i + 1))
done
printf 'speed_ready=0\n'
`

export const SPEED_SERVER_SPECS = [
  { name: 'port', required: true, pattern: '[1-9][0-9]{3,4}' },
  { name: 'token', required: true, pattern: '[a-f0-9]{32}' },
  { name: 'home', required: true, pattern: '[0-9]{1,3}(\\.[0-9]{1,3}){3}' },
  { name: 'secs', required: true, pattern: '[0-9]{2,3}' },
]

export function parseServerStart(stdout) {
  const kv = Object.fromEntries(String(stdout ?? '').split('\n').map((l) => /^(speed_[a-z]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]))
  return { error: kv.speed_err ?? null, fw: kv.speed_fw ?? null, ready: kv.speed_ready === '1' }
}

// VPS 出口：在 VPS 上测它自己到 fast.com 服务器多快（只读，经 SSH）
export const VPS_EGRESS_SCRIPT = String.raw`
if ! has_cmd curl; then printf 'egress_err=nocurl\n'; exit 0; fi
urls=$(curl -s -m 10 'https://api.fast.com/netflix/speedtest/v2?https=true&token=YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm&urlCount=4' | grep -o 'https://[^"]*' )
[ -z "$urls" ] && { printf 'egress_err=nofast\n'; exit 0; }
D=$(mktemp -d 2>/dev/null) || D=/tmp/dsh-vps-egress-$$
mkdir -p "$D"; trap 'rm -rf "$D"' EXIT
n=0
for u in $urls; do
  n=$((n + 1))
  base=$(echo "$u" | sed 's/?.*//'); q=$(echo "$u" | sed -n 's/^[^?]*?//p')
  curl -s -m 6 -o /dev/null -w '%{size_download} %{time_starttransfer} %{time_total}\n' "$base/range/0-26214400?$q" > "$D/r$n" 2>/dev/null &
done
wait
cat "$D"/r* | awk '{b += $1; t = $3 - $2; if (t > m) m = t} END {if (m > 0) printf "egress_mbps=%d\n", b * 8 / m / 1000000}'
`

// 退路：临时端口连不上（安全组挡住）或服务器上没有 python3 时，经 SSH 多路传数据测直连。
// 每路一条独立的 SSH 连接（不复用），服务器端 head 输出 0，这边数收到多少。SSH 加密和窗口有开销，会偏低
export async function sshStreamSpeed(alias, seconds = 8, conns = 8, { spawnImpl = spawn } = {}) {
  const { sshArgs } = await import('./ssh.js')
  const args = sshArgs(alias, { controlMaster: false, command: 'head -c 4294967296 /dev/zero' })
  const one = () => new Promise((resolve) => {
    let bytes = 0
    let first = 0
    let child
    try {
      child = spawnImpl('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    child.stdout.on('data', (d) => {
      if (!first) first = Date.now()
      bytes += d.length
    })
    const stop = () => child.kill('SIGKILL')
    const timer = setTimeout(stop, (seconds + 8) * 1000) // 连接本身最多等 8 秒
    const window = setInterval(() => {
      if (first && Date.now() - first >= seconds * 1000) stop()
    }, 200)
    child.on('error', () => {})
    child.on('close', () => {
      clearTimeout(timer)
      clearInterval(window)
      resolve(first ? { bytes, span: (Date.now() - first) / 1000 } : null)
    })
  })
  const runs = (await Promise.all(Array.from({ length: conns }, one))).filter(Boolean)
  if (!runs.length) return null
  const bytes = runs.reduce((s, r) => s + r.bytes, 0)
  const span = Math.max(...runs.map((r) => r.span), 0.001)
  return { mbps: Math.round((bytes * 8) / span / 1e6), bytes, conns: runs.length }
}

// —————————————————————— 判断（零 token，按界面语言现拼） ——————————————————————

const pct = (a, b) => (a && b ? Math.round((a / b) * 100) : null)

/** 速度够不够：按单个连接的速度看（看一个视频、下一个文件实际只用一个连接） */
function usage(single, latency, upload) {
  const items = []
  if (single !== null && single !== undefined) {
    items.push({ id: '8k', label: L('8K 视频', '8K video'), level: single >= 80 ? 'ok' : single >= 40 ? 'warn' : 'danger' })
    items.push({ id: '4k', label: L('4K 视频', '4K video'), level: single >= 25 ? 'ok' : single >= 15 ? 'warn' : 'danger' })
  }
  if (latency) {
    items.push({ id: 'call', label: L('视频通话', 'Video calls'), level: latency.avg < 150 && (upload ?? 10) >= 3 ? 'ok' : latency.avg < 300 ? 'warn' : 'danger' })
    items.push({ id: 'game', label: L('打游戏', 'Gaming'), level: latency.avg < 50 && latency.jitter < 10 ? 'ok' : latency.avg < 120 ? 'warn' : 'danger',
      note: latency.avg >= 50 ? L(`延迟 ${latency.avg} ms，竞技类偏高`, `${latency.avg} ms latency, high for competitive games`) : '' })
  }
  return items
}

/**
 * 「网速」卡片的结论。record = runSpeed 存下的原始结果；broadband = 签约带宽（Mbps，可能没填）
 * @returns {{ headline: { level, text }, rows: [...], usage: [...], notes: [...], detail: string }}
 */
export function judgeSpeed(record, { broadband = null, history = [] } = {}) {
  const r = record ?? {}
  const proxy = r.proxy ?? {}
  const direct = r.direct ?? {}
  const notes = []
  const best = proxy.multi?.mbps ?? null
  let headline
  if (best === null) {
    headline = { level: 'na', text: r.proxyError ?? L('这次没测出走代理的速度', 'The proxy speed could not be measured this time') }
  } else {
    const p = pct(best, broadband)
    const level = p !== null ? (p >= 80 ? 'ok' : p >= 40 ? 'warn' : 'danger') : best >= 300 ? 'ok' : best >= 50 ? 'warn' : 'danger'
    const word = level === 'ok' ? L('满速', 'Full speed') : level === 'warn' ? L('还行', 'Fair') : L('慢', 'Slow')
    headline = { level, text: p !== null ? L(`${word} · ${best} Mbps，宽带的 ${p}%`, `${word} · ${best} Mbps, ${p}% of your plan`) : L(`${best} Mbps`, `${best} Mbps`), pct: p, mbps: best }
  }
  // 走的路对不对：测到的出口不是这台，就说清楚
  if (proxy.egress && r.vpsIp && proxy.egress.ip !== r.vpsIp) {
    notes.push({ level: 'warn', text: L(`走代理时的出口是 ${proxy.egress.ip}，不是这台（${r.vpsIp}）：代理软件现在用的不是这台机器，或者测速服务器被分到了别的线路`, `The proxy exit was ${proxy.egress.ip}, not this server (${r.vpsIp}): your proxy app is not using this machine right now, or the test servers were routed elsewhere`) })
  }
  if (r.bypassFailed) {
    notes.push({ level: 'na', text: L('没能绕开这台电脑上的代理软件（直连和走代理的出口一样），"直连这台"这次没测', 'Could not bypass the proxy app on this computer (the direct and proxy exits are the same), so "direct to this server" was not tested') })
  }
  if (direct.via === 'proxy') {
    notes.push({ level: 'warn', text: L('"直连"的测试绕到了代理上（服务器看到的来源不是你家），直连结果不准', 'The "direct" test went through your proxy (the server did not see your home address), so the direct result is not reliable') })
  }
  if (direct.via === 'ssh') notes.push({ level: 'na', text: L('直连这台是经 SSH 测的（临时端口连不上），SSH 本身有开销，会偏低', 'Direct to this server was measured over SSH (the temporary port was unreachable); SSH overhead makes it read low') })
  // 慢在哪：代理比直连慢很多 → 协议或 CPU；直连就慢 → 线路；出口慢 → VPS 或机房
  const dm = direct.multi?.mbps ?? null
  if (best !== null && dm && direct.via !== 'proxy') {
    if (best < dm * 0.6) notes.push({ level: 'warn', text: L(`走代理（${best}）比直连（${dm}）慢很多：多半是代理协议或 VPS 的 CPU 拖了后腿`, `Through the proxy (${best}) is much slower than direct (${dm}): probably the proxy protocol or the server's CPU`) })
    else if (broadband && dm < broadband * 0.4) notes.push({ level: 'warn', text: L(`直连这台也只有 ${dm} Mbps：慢在线路本身（跨境、晚高峰），不是代理的问题`, `Even direct to this server is only ${dm} Mbps: the route itself is slow (cross-border, peak hours), not the proxy`) })
  }
  if (r.vpsEgress && best !== null && r.vpsEgress < best * 1.2 && r.vpsEgress < (broadband ?? 1000) * 0.5) {
    notes.push({ level: 'warn', text: L(`这台 VPS 自己上外网也只有 ${r.vpsEgress} Mbps：慢在 VPS 或机房`, `This VPS itself only reaches ${r.vpsEgress} Mbps to the internet: the VPS or its data centre is the bottleneck`) })
  }
  // 晚上和白天比（要有两边的记录）
  const evening = (t) => {
    const h = new Date(t).getHours()
    return h >= 19 && h <= 23
  }
  const mine = history.filter((x) => x.proxy?.multi?.mbps)
  const eve = mine.filter((x) => evening(x.at))
  const day = mine.filter((x) => !evening(x.at))
  if (eve.length && day.length) {
    const avg = (list) => Math.round(list.reduce((s, x) => s + x.proxy.multi.mbps, 0) / list.length)
    const e = avg(eve)
    const d = avg(day)
    if (e < d * 0.85) notes.push({ level: 'warn', text: L(`晚上（7～11 点）平均 ${e} Mbps，比白天的 ${d} 慢 ${100 - pct(e, d)}%`, `Evenings (7–11 pm) average ${e} Mbps, ${100 - pct(e, d)}% slower than daytime (${d})`) })
    else notes.push({ level: 'ok', text: L(`晚上（${e} Mbps）和白天（${d}）差不多`, `Evenings (${e} Mbps) are about the same as daytime (${d})`) })
  }
  const rows = [
    { id: 'proxy', label: L('走代理上网', 'Through the proxy'), down: best, single: proxy.single?.mbps ?? null, up: proxy.upload?.mbps ?? null, latency: proxy.latency?.avg ?? null },
    { id: 'direct', label: L('直连这台（不走代理）', 'Direct to this server'), down: dm, single: direct.single?.mbps ?? null, up: direct.upload?.mbps ?? null, latency: direct.ping?.avg ?? null, loss: direct.ping?.loss ?? null, skipped: direct.skipped ?? null },
  ]
  const detail = [
    proxy.egress ? L(`走代理的出口：${proxy.egress.ip}${proxy.egress.country ? `（${proxy.egress.country}）` : ''}`, `Proxy exit: ${proxy.egress.ip}${proxy.egress.country ? ` (${proxy.egress.country})` : ''}`) : '',
    r.home ? L(`你家宽带出口：${r.home.ip}${r.home.country ? `（${r.home.country}）` : ''}`, `Your broadband exit: ${r.home.ip}${r.home.country ? ` (${r.home.country})` : ''}`) : '',
    proxy.latency ? L(`走代理延迟 ${proxy.latency.avg} ms · 下载时 ${proxy.loaded?.avg ?? '?'} ms · 抖动 ${proxy.latency.jitter} ms`, `Proxy latency ${proxy.latency.avg} ms · while downloading ${proxy.loaded?.avg ?? '?'} ms · jitter ${proxy.latency.jitter} ms`) : '',
    direct.ping ? L(`直连 ping ${direct.ping.avg ?? '?'} ms · 抖动 ${direct.ping.jitter ?? '?'} ms · 丢包 ${direct.ping.loss}%`, `Direct ping ${direct.ping.avg ?? '?'} ms · jitter ${direct.ping.jitter ?? '?'} ms · loss ${direct.ping.loss}%`) : '',
    direct.retransPct !== undefined && direct.retransPct !== null ? L(`直连时服务器上的 TCP 重传 ${direct.retransPct}%`, `TCP retransmits on the server during the direct test: ${direct.retransPct}%`) : '',
    r.vpsEgress ? L(`VPS 自己上外网：${r.vpsEgress} Mbps`, `The VPS to the internet: ${r.vpsEgress} Mbps`) : '',
    direct.fw ? L(`临时端口 ${direct.port}，防火墙：${direct.fw}（测完已撤掉）`, `Temporary port ${direct.port}, firewall: ${direct.fw} (removed afterwards)`) : '',
    r.bytes ? L(`这次大约用掉 ${(r.bytes / 1e9).toFixed(1)} GB 流量`, `About ${(r.bytes / 1e9).toFixed(1)} GB of traffic used`) : '',
    L('下载、上传用 fast.com 的 Netflix 测速服务器；"直连"绕开电脑上的代理软件', 'Downloads and uploads use fast.com\'s Netflix test servers; "direct" bypasses the proxy app on this computer'),
  ].filter(Boolean).join('\n')
  return { headline, rows, usage: usage(proxy.single?.mbps ?? null, proxy.latency, proxy.upload?.mbps ?? null), notes, detail }
}

// —————————————————————— 跑一次「网速」 ——————————————————————

const speedDir = (env) => join(dshHome(env), 'vps-manager', 'speed')

export async function readSpeedSettings(env = process.env) {
  try {
    return JSON.parse(await readFile(join(speedDir(env), 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
}
export async function writeSpeedSettings(patch, env = process.env) {
  const next = { ...(await readSpeedSettings(env)), ...patch }
  await mkdir(speedDir(env), { recursive: true })
  await atomicWrite(join(speedDir(env), 'settings.json'), JSON.stringify(next, null, 2))
  return next
}

export async function readSpeedHistory(alias, env = process.env, days = 14) {
  const dir = join(speedDir(env), alias)
  const cutoff = Date.now() - days * 86_400_000
  try {
    const names = (await readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}T.*\.json$/.test(n)).sort()
    const out = []
    for (const n of names.slice(-60)) {
      try {
        const rec = JSON.parse(await readFile(join(dir, n), 'utf8'))
        if (Date.parse(rec.at) >= cutoff) out.push(rec)
      } catch {
        // 坏文件跳过
      }
    }
    return out
  } catch {
    return []
  }
}
export async function readSpeedCache(alias, env = process.env) {
  try {
    return JSON.parse(await readFile(join(speedDir(env), alias, 'latest.json'), 'utf8'))
  } catch {
    return null
  }
}
async function saveSpeed(alias, record, env) {
  const dir = join(speedDir(env), alias)
  await mkdir(dir, { recursive: true })
  await atomicWrite(join(dir, 'latest.json'), JSON.stringify(record, null, 2))
  await atomicWrite(join(dir, `${record.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(record))
  try {
    const cutoff = Date.now() - 90 * 86_400_000
    for (const n of await readdir(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})T/.exec(n)
      if (m && Date.parse(m[1]) < cutoff) await rm(join(dir, n), { force: true })
    }
  } catch {
    // 清理失败不要紧
  }
}

/**
 * 测一次这台 VPS 的网速：走代理（fast.com）、直连这台（临时测速服务，没同意或连不上就退回 SSH / 只 ping）、
 * VPS 自己上外网。各段依次跑，免得互相抢带宽。大约 40～60 秒
 * @param o.startServer  在 VPS 上起临时测速服务：(params) → { error, fw, ready }（routes 里用远端任务实现）
 * @param o.sshStream    经 SSH 多路传数据测直连：(seconds, conns) → { mbps, bytes } | null
 * @param o.vpsEgress    VPS 自己上外网：() → Mbps | null
 * @param o.allowPort    用户同意过临时开端口
 */
export async function runSpeed({ alias, vpsHost, allowPort = false, startServer, sshStream, vpsEgress, exec = execCommand, now = Date.now, env = process.env, net: givenNet }) {
  const net = givenNet ?? (await detectPaths({ exec }))
  const cache = new Map()
  const record = { at: new Date(now()).toISOString(), alias, net: { tun: net.tun, iface: net.iface, proxy: Boolean(net.proxy) }, proxy: {}, direct: {}, bytes: 0 }
  const vpsIp = vpsHost ? (isIp(vpsHost) ? vpsHost : await realResolve(vpsHost, net, { exec, cache })) : null
  record.vpsIp = vpsIp
  const [proxyEgress, home] = await Promise.all([egressOf('proxy', net, { exec, cache }), egressOf('direct', net, { exec, cache })])
  record.home = home
  record.proxy.egress = proxyEgress
  // 「直连」和「走代理」的出口一样：没能绕开代理软件（比如 Windows 上的隧道模式），直连测了也是走代理
  const bypassed = Boolean(home?.ip) && home.ip !== proxyEgress?.ip
  if (!bypassed) record.bypassFailed = true

  // 1. 走代理：fast.com 的服务器（离代理出口近），延迟 → 多连接下载（同时测下载时的延迟）→ 单连接 → 上传
  const targets = await fastTargets('proxy', net, { exec, cache })
  if (targets.length) {
    const ping = fastRange(targets[0], 0)
    record.proxy.latency = await httpLatency(ping, 'proxy', net, { exec, count: 5, cache })
    const [multi, loaded] = await Promise.all([
      downloadSpeed(targets.map((u) => fastRange(u)), 'proxy', net, { exec, conns: 6, seconds: 8, cache }),
      (async () => {
        await new Promise((r) => setTimeout(r, 2500))
        return httpLatency(ping, 'proxy', net, { exec, count: 3, cache })
      })(),
    ])
    record.proxy.multi = multi
    record.proxy.loaded = loaded
    record.proxy.single = await downloadSpeed([fastRange(targets[0])], 'proxy', net, { exec, conns: 1, seconds: 6, cache })
    record.proxy.upload = await uploadSpeed(fastRange(targets[1] ?? targets[0], 0), 'proxy', net, { exec, seconds: 6, cache })
    record.bytes += (multi?.bytes ?? 0) + (record.proxy.single?.bytes ?? 0) + (record.proxy.upload?.bytes ?? 0)
  } else {
    record.proxyError = L('连不上 fast.com 的测速服务器（走代理）', 'Could not reach fast.com\'s test servers through the proxy')
  }

  // 2. 直连这台：ping（绑物理网卡）；同意过就临时开端口测带宽，连不上退回 SSH
  if (vpsIp && !bypassed) {
    record.direct.skipped = 'bypass'
  } else if (vpsIp) {
    record.direct.ping = await pingStats(vpsIp, net, { exec, count: 10 })
    if (!allowPort) {
      record.direct.skipped = 'consent'
    } else if (!home?.ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(home.ip)) {
      record.direct.skipped = 'home'
    } else {
      const port = 20000 + Math.floor(Math.random() * 40000)
      const token = randomBytes(16).toString('hex')
      const started = await startServer({ port: String(port), token, home: home.ip, secs: '120' })
      record.direct.port = port
      record.direct.fw = started?.fw ?? null
      const base = `http://${vpsIp}:${port}/${token}`
      const reachable = started?.ready && (await curlOnce(`${base}/ping`, 'direct', net, { exec, seconds: 4, cache })).code === 204
      if (reachable) {
        record.direct.via = 'port'
        const big = `${base}/down?bytes=2147483648`
        record.direct.multi = await downloadSpeed([big], 'direct', net, { exec, conns: 6, seconds: 8, cache })
        record.direct.single = await downloadSpeed([big], 'direct', net, { exec, conns: 1, seconds: 6, cache })
        record.direct.upload = await uploadSpeed(`${base}/up`, 'direct', net, { exec, seconds: 6, cache })
        const statsRes = await exec('curl', ['-s', '-m', '5', ...pathArgs('direct', net), `${base}/stats`], { timeoutMs: 8000, env: pathEnv('direct') })
        try {
          const s = JSON.parse(statsRes.stdout)
          if (Array.isArray(s.peers) && s.peers.length && !s.peers.includes(home.ip)) record.direct.via = 'proxy'
          if (s.out > 0 && s.retrans !== null) record.direct.retransPct = Math.round((s.retrans / s.out) * 1000) / 10
        } catch {
          // 没拿到统计也不要紧
        }
        await exec('curl', ['-s', '-m', '4', ...pathArgs('direct', net), `${base}/stop`], { timeoutMs: 6000, env: pathEnv('direct') })
        record.bytes += (record.direct.multi?.bytes ?? 0) + (record.direct.single?.bytes ?? 0) + (record.direct.upload?.bytes ?? 0)
      } else {
        if (started?.error) record.direct.serverError = started.error
        const viaSsh = sshStream ? await sshStream(8, 8) : null
        if (viaSsh) {
          record.direct.via = 'ssh'
          record.direct.multi = viaSsh
          record.bytes += viaSsh.bytes ?? 0
        } else {
          record.direct.skipped = 'unreachable'
        }
      }
    }
  }

  // 3. VPS 自己上外网（经 SSH，只读）
  if (vpsEgress) record.vpsEgress = await vpsEgress()
  await saveSpeed(alias, record, env)
  return record
}

// —————————————————————— 挑机器：几个地址放一起比 ——————————————————————

const candFile = (env) => join(dshHome(env), 'vps-manager', 'candidates.json')
export async function readCandidates(env = process.env) {
  try {
    return JSON.parse(await readFile(candFile(env), 'utf8'))
  } catch {
    return { entries: [], results: null }
  }
}
export async function writeCandidates(doc, env = process.env) {
  await mkdir(join(dshHome(env), 'vps-manager'), { recursive: true })
  await atomicWrite(candFile(env), JSON.stringify(doc, null, 2))
  return doc
}

/** 用户填的一行：IP、域名，或 Looking Glass / 测试文件地址 */
export function parseEntry(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      const file = /\.(test|bin|dat|zip|img|iso|gz)$/i.test(u.pathname) ? u.href : null
      return { input: raw, host: u.hostname.replace(/^\[|\]$/g, ''), page: file ? null : u.href, file }
    } catch {
      return null
    }
  }
  const host = raw.replace(/^\[|\]$/g, '').replace(/\/.*$/, '')
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) return null
  return { input: raw, host, page: null, file: null }
}

/** 在 Looking Glass 页面里找测试文件，优先 100MB 左右的 */
export function findTestFile(html, pageUrl) {
  const links = [...String(html ?? '').matchAll(/href\s*=\s*["']([^"'#]+\.(?:test|bin|dat|zip|img))["']/gi)].map((m) => m[1])
  if (!links.length) return null
  const score = (u) => (/100\s*m/i.test(u) ? 0 : /(?:^|\D)(?:50|200|250)\s*m/i.test(u) ? 1 : /1000\s*m|1\s*g/i.test(u) ? 2 : 3)
  const pick = links.sort((a, b) => score(a) - score(b))[0]
  try {
    return new URL(pick, pageUrl).href
  } catch {
    return null
  }
}

const COMMON_FILES = ['/100MB.test', '/100mb.test', '/100MB.bin', '/100mb.bin']

/** 测一个地址：直连 ping（ICMP 被挡就看 TCP 建连）；有测试文件就测下载速度 */
async function testEntry(entry, net, { exec, cache, download = true }) {
  const out = { input: entry.input, host: entry.host, ip: null, ping: null, tcp: null, file: null, down: null, single: null, error: null }
  out.ip = isIp(entry.host) ? entry.host : await realResolve(entry.host, net, { exec, cache })
  if (!out.ip) {
    out.error = 'resolve'
    return out
  }
  out.ping = await pingStats(out.ip, net, { exec, count: 10 })
  if (!out.ping || out.ping.loss >= 100) out.tcp = (await tcpConnectMs(out.ip, 443, net, { exec })) ?? (await tcpConnectMs(out.ip, 80, net, { exec }))
  if (!download) return out
  let file = entry.file
  if (!file && entry.page) {
    const page = await exec('curl', ['-s', '-m', '10', ...pathArgs('direct', net), ...(isIp(entry.host) ? [] : ['--resolve', `${entry.host}:${new URL(entry.page).port || (entry.page.startsWith('https') ? 443 : 80)}:${out.ip}`]), entry.page], { timeoutMs: 12_000, env: pathEnv('direct') })
    file = findTestFile(page.stdout, entry.page)
  }
  if (!file) {
    for (const p of COMMON_FILES) {
      const u = `http://${entry.host.includes(':') ? `[${entry.host}]` : entry.host}${p}`
      const r = await curlOnce(u, 'direct', net, { exec, seconds: 3, cache })
      if (r.code === 200 && r.down > 0) {
        file = u
        break
      }
    }
  }
  out.file = file
  if (file) {
    out.down = await downloadSpeed([file], 'direct', net, { exec, conns: 4, seconds: 6, cache })
    out.single = await downloadSpeed([file], 'direct', net, { exec, conns: 1, seconds: 6, cache })
  }
  return out
}

/**
 * 挑机器：几个地址一起测（ping 并行，下载一个一个来，免得抢你家的带宽），再加上现在用的这台当参照
 * @param o.reference  { label, host }：现在用的那台（只 ping）
 */
export async function runCandidates({ entries, reference, exec = execCommand, now = Date.now, net: givenNet }) {
  const net = givenNet ?? (await detectPaths({ exec }))
  const cache = new Map()
  const parsed = entries.map(parseEntry).filter(Boolean)
  // 先核对能不能绕开代理软件：直连和走代理的出口一样，就说明绕不开
  const [home, viaProxy] = await Promise.all([egressOf('direct', net, { exec, cache }), egressOf('proxy', net, { exec, cache })])
  const results = []
  for (const e of parsed) results.push(await testEntry(e, net, { exec, cache }))
  let ref = null
  if (reference?.host) {
    ref = { label: reference.label, ...(await testEntry({ input: reference.label, host: reference.host }, net, { exec, cache, download: false })) }
  }
  return { at: new Date(now()).toISOString(), results, reference: ref, bypass: !(home?.ip && viaProxy?.ip && home.ip === viaProxy.ip) }
}

/** 比较：按下载速度排，速度一样看延迟；给一句推荐 */
export function judgeCandidates(run) {
  if (!run?.results?.length) return null
  const lat = (r) => r.ping?.avg ?? r.tcp?.avg ?? null
  // 给人看的名字：去掉 https:// 和结尾的 /
  const short = (input) => String(input).replace(/^https?:\/\//i, '').replace(/\/$/, '')
  const rows = run.results.map((r) => ({
    input: r.input,
    label: short(r.input),
    ip: r.ip,
    latency: lat(r),
    jitter: r.ping?.jitter ?? r.tcp?.jitter ?? null,
    loss: r.ping?.loss ?? null,
    down: r.down?.mbps ?? null,
    single: r.single?.mbps ?? null,
    file: Boolean(r.file),
    error: r.error === 'resolve' ? L('查不到这个域名', 'Could not resolve this name') : !r.ping && !r.tcp ? L('连不上', 'Unreachable') : null,
  }))
  const usable = rows.filter((r) => !r.error && (r.latency !== null || r.down !== null))
  const ranked = [...usable].sort((a, b) => (b.down ?? -1) - (a.down ?? -1) || (a.latency ?? 1e9) - (b.latency ?? 1e9) || (a.loss ?? 0) - (b.loss ?? 0))
  const top = ranked[0]
  let verdict = null
  if (top) {
    const why = []
    if (top.down !== null && ranked.filter((r) => r.down !== null).length > 1) why.push(L(`下载最快（${top.down} Mbps）`, `fastest download (${top.down} Mbps)`))
    const fastestLat = Math.min(...usable.map((r) => r.latency ?? 1e9))
    if (top.latency !== null && top.latency === fastestLat && usable.length > 1) why.push(L(`延迟最低（${top.latency} ms）`, `lowest latency (${top.latency} ms)`))
    if (top.loss) why.push(L(`但丢包 ${top.loss}%`, `but ${top.loss}% loss`))
    verdict = usable.length > 1
      ? L(`推荐 ${top.label}${why.length ? `：${why.join('，')}` : ''}`, `Pick ${top.label}${why.length ? `: ${why.join(', ')}` : ''}`)
      : L(`${top.label}：${top.down !== null ? `下载 ${top.down} Mbps，` : ''}延迟 ${top.latency ?? '?'} ms`, `${top.label}: ${top.down !== null ? `${top.down} Mbps download, ` : ''}${top.latency ?? '?'} ms latency`)
  }
  const noFile = rows.some((r) => !r.error && !r.file)
  return {
    at: run.at,
    rows,
    reference: run.reference ? { label: run.reference.label, latency: lat(run.reference), loss: run.reference.ping?.loss ?? null } : null,
    verdict,
    best: usable.length > 1 ? top?.input ?? null : null,
    hints: [
      noFile ? L('只填 IP 的测不了下载速度（没找到测试文件）：填商家 Looking Glass 页面的地址，会自动找测试文件', 'Entries with only an IP cannot be speed-tested (no test file found): enter the provider\'s Looking Glass page and its test file is found automatically') : '',
      run.bypass === false ? L('没能绕开这台电脑上的代理软件，结果可能走了代理', 'Could not bypass the proxy app on this computer, so results may have gone through it') : '',
    ].filter(Boolean),
  }
}

