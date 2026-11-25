// lib/trend.js — 状态页的「过去 24 小时」：CPU、内存、网速的曲线
//
// 设计见 工作流/dsh-vps-manager-趋势与网速设计.md。两个来源合在一起画：
//   1. 服务器上的 sysstat（sar）：它自己每 10 分钟记一次，DSH 没开时的也有。没装就给「安装 sysstat」（先问）
//   2. 这台电脑每次看状态时记下的一个点（右侧栏开着时每分钟一次），存 $DSH_HOME/vps-manager/history/<别名>.jsonl
// 都只读，不费流量；读 sar 是点开状态页时一次 SSH，10 分钟内不重复读。

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from './config.js'

// —————————————————————— 服务器上：读 sar ——————————————————————
// 用到 prelude 里的 has_cmd。读今天和昨天两个文件（每天一个 saDD，也认 saYYYYMMDD）。
// 时间用 LC_ALL=C 才是 24 小时制。内存那列在不同版本位置不同，按表头找 %memused；网速只要默认网卡那一行。
// 一行：su=日期 时间|CPU 忙的百分比，sr=日期 时间|内存已用百分比，sn=日期 时间|收 kB/s|发 kB/s
// 注意：这是 JS 模板字符串，脚本里不能出现「美元符 + 左花括号」和反引号
export const TREND_SCRIPT = String.raw`
if ! has_cmd sar; then printf 'sar=0\n'; exit 0; fi
printf 'sar=1\n'
printf 'tz=%s\n' "$(date +%z)"
[ -f /etc/default/sysstat ] && grep -q '^ENABLED="false"' /etc/default/sysstat && printf 'sar_off=1\n'
SA=/var/log/sysstat; [ -d "$SA" ] || SA=/var/log/sa
dev=$(ip route show default 2>/dev/null | awk '{for (i=1; i<NF; i++) if ($i=="dev") {print $(i+1); exit}}')
read_day() {
  d=$1; f=$SA/sa$2; [ -f "$f" ] || f=$SA/sa$3; [ -f "$f" ] || return 0
  printf 'sar_day=%s\n' "$d"
  LC_ALL=C S_TIME_FORMAT=ISO sar -u -f "$f" 2>/dev/null | awk -v d="$d" '$1 ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ && $2 == "all" { printf "su=%s %s|%.1f\n", d, $1, 100 - $NF }'
  LC_ALL=C S_TIME_FORMAT=ISO sar -r -f "$f" 2>/dev/null | awk -v d="$d" '
    $1 !~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ { next }
    { for (i = 2; i <= NF; i++) if ($i == "%memused") { col = i; next } }
    col && $col ~ /^[0-9.]+$/ { printf "sr=%s %s|%s\n", d, $1, $col }'
  [ -n "$dev" ] && LC_ALL=C S_TIME_FORMAT=ISO sar -n DEV -f "$f" 2>/dev/null | awk -v d="$d" -v dev="$dev" '
    $1 !~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ { next }
    $2 == "IFACE" { for (i = 2; i <= NF; i++) { if ($i == "rxkB/s") rc = i; if ($i == "txkB/s") tc = i }; next }
    $2 == dev && rc && tc { printf "sn=%s %s|%s|%s\n", d, $1, $rc, $tc }'
}
y=$(date -d yesterday +%Y-%m-%d 2>/dev/null) && read_day "$y" "$(date -d yesterday +%d)" "$(date -d yesterday +%Y%m%d)"
read_day "$(date +%Y-%m-%d)" "$(date +%d)" "$(date +%Y%m%d)"
`

/** sar 那几行 → { sar, off, cpu: [[毫秒, %]], mem: [[毫秒, %]], net: [[毫秒, 收 B/s, 发 B/s]] } */
export function parseTrend(stdout) {
  const out = { sar: false, off: false, cpu: [], mem: [], net: [] }
  let tz = '+00:00'
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim())
  for (const l of lines) {
    if (l === 'sar=1') out.sar = true
    else if (l === 'sar_off=1') out.off = true
    else if (/^tz=[+-]\d{4}$/.test(l)) tz = `${l.slice(3, 6)}:${l.slice(6)}`
  }
  const at = (s) => {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s)
    const t = m ? Date.parse(`${m[1]}T${m[2]}${tz}`) : NaN
    return Number.isFinite(t) ? t : null
  }
  for (const l of lines) {
    const m = /^(su|sr|sn)=([^|]+)\|(.*)$/.exec(l)
    if (!m) continue
    const t = at(m[2])
    if (t === null) continue
    const v = m[3].split('|').map(Number)
    if (!v.every(Number.isFinite)) continue
    if (m[1] === 'su') out.cpu.push([t, v[0]])
    else if (m[1] === 'sr') out.mem.push([t, v[0]])
    else if (v.length === 2) out.net.push([t, v[0] * 1024, v[1] * 1024])
  }
  // 配置文件写着没打开，但新版 Ubuntu 是定时器在记、不看那个开关：读到了记录就算开着（2026-11-18 用户真机就是这样）
  if (out.cpu.length) out.off = false
  return out
}

// —————————————————————— 这台电脑上记的点 ——————————————————————

const KEEP_MS = 8 * 86_400_000
const dir = (env) => join(dshHome(env), 'vps-manager', 'history')
const file = (alias, env) => join(dir(env), `${String(alias).replace(/[^\w.-]/g, '_')}.jsonl`)

// 文件过了这个大小才整理一次（每分钟一个点、8 天约 1 MB）
const COMPACT_BYTES = 1536 * 1024
// 同一个文件的写入排队：整理是整份重写，和同时进来的追加交错会丢点（右侧栏和面板可能同时在采集）
const queues = new Map()

/** 每次看完状态记一个点：CPU、内存、根分区、此刻网速。文件变大了就去掉 8 天以前的 */
export function recordSample(alias, data, at, env = process.env) {
  const t = Date.parse(at)
  if (!Number.isFinite(t) || !data) return Promise.resolve()
  const mem = data.mem?.total ? Math.round(((data.mem.total - data.mem.avail) / data.mem.total) * 1000) / 10 : null
  const root = data.disks?.find((d) => d.mount === '/')?.pct ?? null
  const point = { t, cpu: data.cpu ?? null, mem, disk: root, rx: data.netRate?.rx ?? null, tx: data.netRate?.tx ?? null }
  const path = file(alias, env)
  const run = async () => {
    await mkdir(dir(env), { recursive: true })
    await appendFile(path, `${JSON.stringify(point)}\n`, { mode: 0o600 })
    if ((await stat(path)).size > COMPACT_BYTES) {
      const kept = (await readSamples(alias, env, t - KEEP_MS)).map((p) => JSON.stringify(p)).join('\n')
      await writeFile(path, kept ? `${kept}\n` : '', { mode: 0o600 })
    }
  }
  const next = (queues.get(path) ?? Promise.resolve()).then(run, run)
  const tail = next.catch(() => {})
  queues.set(path, tail)
  tail.then(() => {
    if (queues.get(path) === tail) queues.delete(path)
  })
  return next
}

export async function readSamples(alias, env = process.env, since = 0) {
  let text = ''
  try {
    text = await readFile(file(alias, env), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const p = JSON.parse(line)
      if (Number.isFinite(p.t) && p.t >= since) out.push(p)
    } catch {
      // 写到一半的行
    }
  }
  return out
}

// —————————————————————— 合成曲线 ——————————————————————

/** 一条曲线的摘要：现在、平均、最高（和它在什么时候） */
function summary(points) {
  if (!points.length) return null
  let sum = 0
  let max = points[0]
  for (const p of points) {
    sum += p[1]
    if (p[1] > max[1]) max = p
  }
  return { now: points.at(-1)[1], avg: Math.round((sum / points.length) * 10) / 10, max: max[1], maxAt: max[0] }
}

/**
 * sar 的点和本机记的点合在一起，取过去 24 小时。网速取收发里大的那个画一条线，摘要里收发分开
 * @returns {{ from, to, cpu, mem, net, rx, tx, sources: { sar, local } }}，每条是 { points: [[毫秒, 值]], ...摘要 }
 */
export function buildTrend({ sar = null, local = [], now = Date.now() }) {
  const from = now - 86_400_000
  const merge = (a, b) => [...a, ...b].filter((p) => p[0] >= from && p[0] <= now + 60_000 && Number.isFinite(p[1])).sort((x, y) => x[0] - y[0])
  const cpu = merge(sar?.cpu ?? [], local.filter((p) => p.cpu !== null).map((p) => [p.t, p.cpu]))
  const mem = merge(sar?.mem ?? [], local.filter((p) => p.mem !== null).map((p) => [p.t, p.mem]))
  const rx = merge((sar?.net ?? []).map((p) => [p[0], p[1]]), local.filter((p) => p.rx !== null).map((p) => [p.t, p.rx]))
  const tx = merge((sar?.net ?? []).map((p) => [p[0], p[2]]), local.filter((p) => p.tx !== null).map((p) => [p.t, p.tx]))
  const line = (points) => ({ points, ...(summary(points) ?? {}) })
  return {
    from, to: now,
    cpu: line(cpu), mem: line(mem), rx: line(rx), tx: line(tx),
    sources: { sar: Boolean(sar?.cpu?.length), local: local.filter((p) => p.t >= from).length },
  }
}

// —————————————————————— 安装 sysstat（会改服务器：走远端任务，先问用户） ——————————————————————
// Debian、Ubuntu 装完默认不记（/etc/default/sysstat 里 ENABLED="false"），要打开再启用服务
export const SYSSTAT_INSTALL_SCRIPT = String.raw`
need_root
if ! has_cmd sar; then
  pkg_install sysstat || { echo "sysstat_install=failed"; exit 1; }
fi
has_cmd sar || { echo "sysstat_install=failed"; exit 1; }
if [ -f /etc/default/sysstat ]; then $SUDO sed -i 's/^ENABLED="false"/ENABLED="true"/' /etc/default/sysstat; fi
svc_enable_start sysstat >/dev/null 2>&1 || true
if svc_active sysstat; then echo "sysstat_install=ok"; else echo "sysstat_install=nodaemon"; fi
`
