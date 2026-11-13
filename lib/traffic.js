// lib/traffic.js — 状态页的「流量和到期」：本月用了多少 / 每月额度，还有服务器哪天到期
//
// 设计见 工作流/dsh-vps-manager-月流量设计.md。额度服务器上读不到（是服务商定的），用户在卡片里填一次；
// 用量靠服务器上的 vnstat 按天记（重启也不丢），按用户填的「每月几号重置」从每天的记录里加起来。
// 没装 vnstat 时只有开机以来的收发量，卡片上给「安装 vnstat」（会改服务器，先问）。
// 额度、重置日、计费方式、到期日只存这台电脑上（$DSH_HOME/vps-manager/traffic.json），按机器分开。
// 到期日也是用户填的（服务商定的，服务器上读不到）：提前 7 天黄、最后一天和过期红。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, dshHome } from './config.js'
import { L } from './i18n.js'

// —————————————————————— 服务器上：读 vnstat（拼进状态采集脚本，用到前面的 $dev） ——————————————————————
// vnstat 2.x 的 JSON 单位是字节，1.x（jsonversion 1）是 KiB。「某天」长这样（2.x 中间多一个 timestamp）：
//   "date":{"year":2026,"month":11,"day":13},"timestamp":1794528000,"rx":123,"tx":456
// 一行一天：vn_day=年,月,日,收,发。注意：这是 JS 模板字符串，脚本里不能出现「美元符 + 左花括号」和反引号
export const VNSTAT_SCRIPT = String.raw`
if has_cmd vnstat && [ -n "$dev" ]; then
  printf 'vnstat=1\n'
  printf 'vn_today=%s\n' "$(date +%Y,%m,%d)"
  vnstat --json d -i "$dev" 2>/dev/null | tr -d ' \n\r' | awk '
    {
      if (match($0, /"jsonversion":"[0-9]+"/)) { v = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", v); print "vn_ver=" v }
      if (match($0, /"created":\{"date":\{"year":[0-9]+,"month":[0-9]+,"day":[0-9]+/)) { t = substr($0, RSTART, RLENGTH); gsub(/[^0-9,]/, "", t); sub(/^,+/, "", t); print "vn_created=" t }
      if (match($0, /"updated":\{"date":\{"year":[0-9]+,"month":[0-9]+,"day":[0-9]+/)) { t = substr($0, RSTART, RLENGTH); gsub(/[^0-9,]/, "", t); sub(/^,+/, "", t); print "vn_updated=" t }
      s = $0; n = 0
      while (n < 70 && match(s, /"date":\{"year":[0-9]+,"month":[0-9]+,"day":[0-9]+\},("timestamp":[0-9]+,)?"rx":[0-9]+,"tx":[0-9]+/)) {
        t = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
        sub(/"timestamp":[0-9]+,/, "", t); gsub(/[^0-9,]/, "", t); print "vn_day=" t; n++
      }
    }'
fi
`

/** 状态采集里 vnstat 那几行 → { ver, today, created, updated, days: [{ date: 'YYYY-MM-DD', rx, tx }] } 或 null */
export function parseVnstat(kv, days) {
  if (kv.vnstat !== '1') return null
  const ymd = (v) => {
    const p = String(v ?? '').split(',').map(Number)
    return p.length === 3 && p.every(Number.isFinite) ? `${p[0]}-${String(p[1]).padStart(2, '0')}-${String(p[2]).padStart(2, '0')}` : null
  }
  const unit = kv.vn_ver === '1' ? 1024 : 1
  const list = days.map((v) => {
    const p = v.split(',').map(Number)
    return p.length === 5 && p.every(Number.isFinite) ? { date: ymd(p.slice(0, 3).join(',')), rx: p[3] * unit, tx: p[4] * unit } : null
  }).filter(Boolean)
  return { ver: kv.vn_ver ?? '', today: ymd(kv.vn_today), created: ymd(kv.vn_created), updated: ymd(kv.vn_updated), days: list }
}

// —————————————————————— 周期和用量 ——————————————————————

const MODES = ['sum', 'out', 'max']
const pad = (n) => String(n).padStart(2, '0')
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate() // m 从 1 开始
/** 某年某月的重置日：31 号重置、这个月只有 30 天，就是 30 号 */
const resetOn = (y, m, day) => `${y}-${pad(m)}-${pad(Math.min(day, daysIn(y, m)))}`

/** 今天所在的周期：[开始, 下次重置)，都是 YYYY-MM-DD（服务器所在时区的日期，和 vnstat 一致） */
export function cycleOf(today, resetDay = 1) {
  const [y, m] = today.split('-').map(Number)
  const day = Math.min(31, Math.max(1, Math.round(resetDay) || 1))
  const prev = m === 1 ? [y - 1, 12] : [y, m - 1]
  const next = m === 12 ? [y + 1, 1] : [y, m + 1]
  const thisReset = resetOn(y, m, day)
  return today >= thisReset ? { start: thisReset, end: resetOn(...next, day) } : { start: resetOn(...prev, day), end: thisReset }
}

const dayNo = (s) => Date.UTC(...s.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) / 86_400_000

/**
 * 这个周期用了多少。mode：sum 收发相加（多数服务商）、out 只算出站、max 收发取大的一边
 * @returns {{ start, end, rx, tx, used, quota, pct, mode, partial, since, projected, daysLeft, stale }}
 */
export function trafficUsage(vn, settings = {}) {
  if (!vn?.today) return null
  const mode = MODES.includes(settings.mode) ? settings.mode : 'sum'
  const { start, end } = cycleOf(vn.today, settings.resetDay ?? 1)
  let rx = 0
  let tx = 0
  for (const d of vn.days) {
    if (d.date >= start && d.date <= vn.today) {
      rx += d.rx
      tx += d.tx
    }
  }
  const used = mode === 'out' ? tx : mode === 'max' ? Math.max(rx, tx) : rx + tx
  const quota = Number(settings.quota) > 0 ? Number(settings.quota) : null
  const elapsed = Math.max(1, dayNo(vn.today) - dayNo(start) + 1)
  const total = dayNo(end) - dayNo(start)
  // vnstat 是这个周期中间才开始记的：之前的流量没记到
  const partial = Boolean(vn.created && vn.created > start)
  const counted = partial ? Math.max(1, dayNo(vn.today) - dayNo(vn.created) + 1) : elapsed
  return {
    start, end, rx, tx, used, quota, mode, partial, since: partial ? vn.created : null,
    pct: quota ? Math.round((used / quota) * 100) : null,
    projected: Math.round((used / counted) * total),
    daysLeft: dayNo(end) - dayNo(vn.today),
    // 最后记录的日期比今天早两天以上：vnstat 多半没在跑
    stale: Boolean(vn.updated && dayNo(vn.today) - dayNo(vn.updated) >= 2),
  }
}

/** 进「需注意」的阈值：用到 80% 黄、95% 红；照现在的速度会超额也黄 */
export function trafficLevel(u) {
  if (!u?.quota) return 'ok'
  if (u.pct >= 95) return 'danger'
  if (u.pct >= 80 || u.projected > u.quota) return 'warn'
  return 'ok'
}

// —————————————————————— 到期 ——————————————————————

/** 到期日 → { date, daysLeft }（daysLeft 负数是已经过期几天）；today 是 YYYY-MM-DD */
export function expiryOf(settings, today) {
  const date = settings?.expires
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !today) return null
  return { date, daysLeft: dayNo(date) - dayNo(today) }
}

export function expiryLevel(e) {
  if (!e) return 'ok'
  if (e.daysLeft <= 1) return 'danger'
  if (e.daysLeft <= 7) return 'warn'
  return 'ok'
}

/** 这台电脑上的今天（YYYY-MM-DD） */
export const localDay = (now = Date.now()) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// —————————————————————— 设置（存本机） ——————————————————————

const file = (env) => join(dshHome(env), 'vps-manager', 'traffic.json')

export async function readTrafficSettings(env = process.env) {
  try {
    return JSON.parse(await readFile(file(env), 'utf8'))
  } catch {
    return {}
  }
}

/** 某台机器的设置：quota 字节，resetDay 1–31，mode sum / out / max，expires YYYY-MM-DD。quota 填 0、expires 填空就是不设 */
export async function writeTrafficSettings(alias, patch, env = process.env) {
  const all = await readTrafficSettings(env)
  const cur = all[alias] ?? {}
  const next = { ...cur }
  if (patch.quota !== undefined) {
    const q = Number(patch.quota)
    if (!Number.isFinite(q) || q < 0 || q > 1e18) throw new Error(L('月流量填得不对', 'Invalid monthly allowance'))
    next.quota = q > 0 ? Math.round(q) : null
  }
  if (patch.resetDay !== undefined) {
    const d = Number(patch.resetDay)
    if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error(L('重置日要填 1 到 31', 'The reset day must be 1 to 31'))
    next.resetDay = d
  }
  if (patch.expires !== undefined) {
    const e = String(patch.expires ?? '').trim()
    if (e && !(/^\d{4}-\d{2}-\d{2}$/.test(e) && !Number.isNaN(Date.parse(`${e}T00:00:00Z`)))) throw new Error(L('到期日填得不对', 'Invalid expiry date'))
    next.expires = e || null
  }
  if (patch.mode !== undefined) {
    if (!MODES.includes(patch.mode)) throw new Error(L('计费方式不对', 'Invalid counting method'))
    next.mode = patch.mode
  }
  all[alias] = next
  await atomicWrite(file(env), JSON.stringify(all, null, 2))
  return next
}

// —————————————————————— 安装 vnstat（会改服务器：走远端任务，先问用户） ——————————————————————
// 用到 prelude 里的 pkg_install、svc_enable_start。RHEL 系的 vnstat 在 EPEL 里，没开 EPEL 会装不上，照实说。
// vnstat 1.x 不会自己加网卡，要 -u -i 建库
export const VNSTAT_INSTALL_SCRIPT = String.raw`
need_root
if ! has_cmd vnstat; then
  pkg_install vnstat || { echo "vnstat_install=failed"; exit 1; }
fi
has_cmd vnstat || { echo "vnstat_install=failed"; exit 1; }
dev=$(ip route show default 2>/dev/null | awk '{for (i=1; i<NF; i++) if ($i=="dev") {print $(i+1); exit}}')
case "$(vnstat --version 2>/dev/null)" in
  *" 1."*) [ -n "$dev" ] && $SUDO vnstat -u -i "$dev" >/dev/null 2>&1 ;;
esac
svc_enable_start vnstat >/dev/null 2>&1 || true
if svc_active vnstat; then echo "vnstat_install=ok"; else echo "vnstat_install=nodaemon"; fi
`
