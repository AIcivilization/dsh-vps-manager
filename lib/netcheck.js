// lib/netcheck.js — 状态页的「网络」卡片：国内连不连得上、AI 和流媒体能不能用、IP 干不干净
//
// 设计见 工作流/dsh-vps-manager-网络体检设计.md（第一步：不需要测速的几项）。用户要的是"实用"：
// 普通人看得懂的结论（能用 / 不能用 / 要注意），数字收进「详细数据」。
//
//   1. 在 VPS 上（一次 SSH，只读）：用这台自己的 IP 访问各服务的特定地址，只回状态码和几个标记，
//      不回网页正文。判断规则在下面 judgeNet 里，各家网站改了规则就改这里
//   2. 国内能不能连：请 Globalping 公共探测网络（jsDelivr 运营，免费，每小时 250 次）从国内电信、
//      联通、移动的节点连这台的 SSH 端口和对外开放的端口，同时从国外几个节点连一次对照，
//      分清"被墙"和"端口没开"。会把服务器地址交给它（界面上写明）
//   3. 判断全用规则，零 token。存本机的是原始结果，结论按界面语言现拼
//
// 实测过的信号（2026-10-15）：
//   OpenAI     api.openai.com/v1/models 不带 key：能用 → 401 Missing bearer；不支持的地区 → 403 unsupported_country_region_territory
//   Anthropic  api.anthropic.com/v1/models 不带 key：能用 → 401 authentication_error；不支持 → 403「Request not allowed」
//   ChatGPT、Claude 的网页对 curl 一律给 Cloudflare 人机验证（拦的是"不是浏览器"，和 IP 无关），所以不看网页
//   谷歌认为你在哪：YouTube 页面里的 "INNERTUBE_CONTEXT_GL":"US"。Gemini 没有可靠的免 key 信号，按这个国家推断
//   Netflix    自制剧 81280792、外购剧 70143836 的片目页：都 200 = 全部片库；只有自制剧 200 = 只能看自制剧
//   Disney+    首页里 "region":"us"；不能用的地区跳到 …/unavailable（正常页面里也有 unavailable 这个词，只看跳转地址）
//   国内能不能连：Globalping 的 TCP ping 是真的建 TCP 连接，8.8.8.8:443、1.1.1.1:443 从国内节点全丢，百度、微软全通

import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, dshHome, readHosts } from './config.js'
import { runRemote } from './engine.js'
import { L, currentLang } from './i18n.js'
import { readStatusCache } from './status.js'

// —————————————————————— 在 VPS 上跑的脚本 ——————————————————————
// 用到 prelude 里的 has_cmd。只输出「键=值」：句子由界面按语言拼。
// 注意：这是 JS 模板字符串，脚本里不能出现「美元符 + 左花括号」（会被当成 JS 插值）
export const NET_SCRIPT = String.raw`
if ! has_cmd curl; then printf 'nocurl=1\n'; exit 0; fi
D=$(mktemp -d 2>/dev/null) || D=/tmp/dsh-vps-net-$$
mkdir -p "$D"
trap 'rm -rf "$D"' EXIT
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
# 取一个地址：正文存 $D/名字.b，「状态码|最后的地址」存 $D/名字.m；连不上时状态码是 000
get() { n=$1; shift; curl -sS -m 12 -A "$UA" -o "$D/$n.b" -w '%{http_code}|%{url_effective}' "$@" > "$D/$n.m" 2>/dev/null || true; }
get cf https://www.cloudflare.com/cdn-cgi/trace &
get oai_trace https://chatgpt.com/cdn-cgi/trace &
get oai https://api.openai.com/v1/models &
get ant https://api.anthropic.com/v1/models &
get yt https://www.youtube.com/premium &
get nf1 -L --max-redirs 3 https://www.netflix.com/title/81280792 &
get nf2 -L --max-redirs 3 https://www.netflix.com/title/70143836 &
get dis -L --max-redirs 5 https://www.disneyplus.com/ &
get ipinfo https://ipinfo.io/json &
get ipapi 'http://ip-api.com/json/?fields=countryCode,as,hosting' &
wait
m() { cat "$D/$1.m" 2>/dev/null; }
first() { grep -ao "$1" "$D/$2.b" 2>/dev/null | head -n 1; }
quoted() { sed 's/^[^:]*: *"//; s/"$//'; }
printf 'cf=%s|%s|%s\n' "$(m cf)" "$(sed -n 's/^loc=//p' "$D/cf.b" 2>/dev/null | head -n 1)" "$(sed -n 's/^ip=//p' "$D/cf.b" 2>/dev/null | head -n 1)"
printf 'oai_trace=%s|%s\n' "$(m oai_trace)" "$(sed -n 's/^loc=//p' "$D/oai_trace.b" 2>/dev/null | head -n 1)"
printf 'oai=%s|%s\n' "$(m oai)" "$(first 'unsupported_country[a-z_]*' oai)"
printf 'ant=%s|%s\n' "$(m ant)" "$(first 'Request not allowed' ant)"
printf 'yt=%s|%s|%s\n' "$(m yt)" "$(first '"INNERTUBE_CONTEXT_GL":"[A-Z]*"' yt | quoted)" "$(first 'is not available in your country' yt)"
printf 'nf1=%s|%s\n' "$(m nf1)" "$(first '"country":"[A-Z]*"' nf1 | quoted)"
printf 'nf2=%s\n' "$(m nf2)"
printf 'dis=%s|%s\n' "$(m dis)" "$(first '"region":"[a-zA-Z]*"' dis | quoted)"
printf 'ipinfo=%s|%s|%s\n' "$(m ipinfo)" "$(first '"country": *"[A-Z]*"' ipinfo | quoted)" "$(first '"org": *"[^"|]*"' ipinfo | quoted)"
printf 'ipapi=%s|%s|%s|%s\n' "$(m ipapi)" "$(first '"countryCode":"[A-Z]*"' ipapi | quoted)" "$(first '"hosting":[a-z]*' ipapi | sed 's/.*://')" "$(first '"as":"[^"|]*"' ipapi | quoted)"
# 黑名单：只查允许免费查询的几个；查不了（没有解析工具、被拒）就留空，界面上不当成问题
ip=$(sed -n 's/^ip=//p' "$D/cf.b" 2>/dev/null | head -n 1)
case "$ip" in
  *.*.*.*)
    rev=$(echo "$ip" | awk -F. '{print $4"."$3"."$2"."$1}')
    for z in zen.spamhaus.org bl.spamcop.net dnsbl-1.uceprotect.net; do
      (
        if has_cmd getent; then a=$(getent hosts "$rev.$z" 2>/dev/null | awk '{print $1}' | head -n 1)
        elif has_cmd dig; then a=$(dig +short +time=3 +tries=1 "$rev.$z" A 2>/dev/null | head -n 1)
        elif has_cmd host; then a=$(host -W 3 "$rev.$z" 2>/dev/null | awk '/has address/ {print $4; exit}')
        else a='?'
        fi
        printf 'dnsbl=%s|%s\n' "$z" "$a" > "$D/bl.$z"
      ) &
    done
    wait
    cat "$D"/bl.* 2>/dev/null
    ;;
esac
`

// —————————————————————— 解析 ——————————————————————

const COUNTRY_RE = /^[A-Z]{2}$/
const country = (v) => {
  const s = String(v ?? '').trim().toUpperCase()
  return COUNTRY_RE.test(s) ? s : null
}

/** 把脚本输出解析成结构化的数据（只有原始信号，不带结论） */
export function parseNet(stdout) {
  const kv = {}
  const dnsbl = []
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    if (m[1] === 'dnsbl') {
      const [zone, answer = ''] = m[2].split('|')
      if (zone) dnsbl.push({ zone, answer: answer.trim() })
    } else {
      kv[m[1]] = m[2]
    }
  }
  if (kv.nocurl) return { noCurl: true }
  // 每行开头是「状态码|最后的地址」，后面是这一项自己的标记
  const field = (k) => {
    const parts = String(kv[k] ?? '').split('|')
    const code = Number.parseInt(parts[0], 10)
    return { code: Number.isFinite(code) ? code : 0, url: parts[1] ?? '', rest: parts.slice(2) }
  }
  const cf = field('cf')
  const oaiTrace = field('oai_trace')
  const oai = field('oai')
  const ant = field('ant')
  const yt = field('yt')
  const nf1 = field('nf1')
  const nf2 = field('nf2')
  const dis = field('dis')
  const ipinfo = field('ipinfo')
  const ipapi = field('ipapi')
  const hosting = ipapi.rest[1] === 'true' ? true : ipapi.rest[1] === 'false' ? false : null
  return {
    cloudflare: { code: cf.code, country: country(cf.rest[0]), ip: (cf.rest[1] ?? '').trim() || null },
    openai: { code: oai.code, unsupported: Boolean(oai.rest[0]), traceCode: oaiTrace.code, country: country(oaiTrace.rest[0]) },
    anthropic: { code: ant.code, forbidden: Boolean(ant.rest[0]) },
    google: { code: yt.code, country: country(yt.rest[0]), premiumBlocked: Boolean(yt.rest[1]) },
    netflix: { original: nf1.code, licensed: nf2.code, country: country(nf1.rest[0]) },
    disney: { code: dis.code, url: dis.url, region: country(dis.rest[0]) },
    ipinfo: { code: ipinfo.code, country: country(ipinfo.rest[0]), org: (ipinfo.rest[1] ?? '').trim() || null },
    ipapi: { code: ipapi.code, country: country(ipapi.rest[0]), hosting, as: (ipapi.rest[2] ?? '').trim() || null },
    dnsbl,
  }
}

// —————————————————————— 国内能不能连（Globalping） ——————————————————————

const GLOBALPING = 'https://api.globalping.io/v1/measurements'
// 国内三家运营商的家宽节点（电信两个、联通一个、移动一个）+ 国外三个对照
export const PROBE_LOCATIONS = [
  { country: 'CN', magic: 'Chinanet', limit: 2 },
  { country: 'CN', magic: 'China Unicom', limit: 1 },
  { country: 'CN', magic: 'China Mobile', limit: 1 },
  { country: 'US', limit: 1 },
  { country: 'JP', limit: 1 },
  { country: 'DE', limit: 1 },
]

/** 节点所在网络 → 哪家运营商 */
export function ispOf(network) {
  const n = String(network ?? '').toLowerCase()
  if (/chinanet|china telecom|ctcc/.test(n)) return 'telecom'
  if (/unicom|china169|cncgroup/.test(n)) return 'unicom'
  if (/china mobile|cmnet|cmcc|tietong/.test(n)) return 'mobile'
  return 'other'
}

/** 内网、回环这类地址：公共探测点连不到，测了也没意义 */
export function privateAddress(host) {
  const h = String(host ?? '').trim().toLowerCase()
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)
}

/**
 * 从国内三家运营商和国外几个点，用 TCP 连这台的几个端口（真的建 TCP 连接，不是 ICMP ping）。
 * 每个端口一次测量；测量是并行的，大约 10 秒出结果。
 * @returns {{ target, ports: [{ port, cn: [{ isp, city, ok, ms }], abroad: [{ country, city, ok, ms }] }] } | { error, message? } | { skipped }}
 */
export async function checkChina({ hostname, ports, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxPolls = 30 }) {
  if (!hostname) return { error: 'noaddr' }
  if (privateAddress(hostname)) return { skipped: 'private', target: hostname }
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  const started = []
  for (const port of ports) {
    let res
    try {
      res = await fetchImpl(GLOBALPING, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'ping', target: hostname, locations: PROBE_LOCATIONS, measurementOptions: { packets: 2, protocol: 'TCP', port } }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      return { error: 'net', message: error.message, target: hostname }
    }
    if (res.status === 429) return { error: 'rate', target: hostname }
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body?.id) return { error: 'api', message: body?.error?.message ?? `HTTP ${res.status}`, target: hostname }
    started.push({ port, id: body.id })
  }
  const results = await Promise.all(started.map(async ({ port, id }) => {
    let data = null
    await sleep(2000)
    for (let i = 0; i < maxPolls; i++) {
      try {
        const res = await fetchImpl(`${GLOBALPING}/${id}`, { headers, signal: AbortSignal.timeout(15_000) })
        data = await res.json()
      } catch {
        data = null
      }
      if (data && data.status !== 'in-progress') break
      await sleep(1000)
    }
    const cn = []
    const abroad = []
    for (const r of data?.results ?? []) {
      const p = r.probe ?? {}
      const stats = r.result?.stats ?? {}
      const ok = Number(stats.rcv) > 0
      const ms = Number.isFinite(Number(stats.avg)) && stats.avg !== null ? Math.round(Number(stats.avg)) : null
      if (p.country === 'CN') cn.push({ isp: ispOf(p.network), city: p.city ?? '', ok, ms })
      else abroad.push({ country: p.country ?? '', city: p.city ?? '', ok, ms })
    }
    return { port, cn, abroad, finished: data?.status === 'finished' }
  }))
  return { target: hostname, ports: results }
}

// —————————————————————— 判断（零 token，按界面语言现拼） ——————————————————————

// Gemini 不开放的地区（官方没有免 key 的检测办法，按谷歌认为你在哪推断）
const GEMINI_BLOCKED = new Set(['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU'])

const SHORT_NAMES = {
  zh: { CN: '中国大陆', HK: '香港', MO: '澳门', TW: '台湾', US: '美国', GB: '英国' },
  en: { CN: 'mainland China', HK: 'Hong Kong', MO: 'Macao', TW: 'Taiwan', US: 'the US', GB: 'the UK' },
}
/** 国家代码 → 给人看的名字（跟界面语言走） */
export function countryName(code) {
  if (!code) return ''
  const lang = currentLang() === 'zh' ? 'zh' : 'en'
  if (SHORT_NAMES[lang][code]) return SHORT_NAMES[lang][code]
  try {
    return new Intl.DisplayNames([lang === 'zh' ? 'zh-CN' : 'en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

const ISP_NAME = () => ({ telecom: L('电信', 'China Telecom'), unicom: L('联通', 'China Unicom'), mobile: L('移动', 'China Mobile'), other: L('其他', 'other') })
const joinList = (list) => list.join(currentLang() === 'zh' ? '、' : ', ')

/** 国内能不能连：一句话结论 + 细节 */
function judgeChina(ch) {
  const title = L('国内能不能连', 'Reachable from China')
  const via = L('用 Globalping 公共探测网络从国内电信、联通、移动的节点测（会把服务器地址交给它）', 'Tested from China Telecom, Unicom and Mobile nodes of the public Globalping network (the server address is shared with it)')
  if (!ch) return { id: 'china', title, level: 'na', text: L('这次没测', 'Not tested this time'), detail: via }
  if (ch.skipped === 'private') return { id: 'china', title, level: 'na', text: L(`地址是内网地址（${ch.target}），从外面测不了`, `The address is a private one (${ch.target}), so it cannot be tested from outside`) }
  if (ch.error === 'rate') return { id: 'china', title, level: 'na', text: L('公共探测的额度用完了（每小时 250 次），过一个小时再试', 'The public probe quota is used up (250 per hour); try again in an hour'), detail: via }
  if (ch.error === 'noaddr') return { id: 'china', title, level: 'na', text: L('不知道这台的地址，没法测', 'The address of this machine is unknown, so it cannot be tested') }
  if (ch.error) return { id: 'china', title, level: 'na', text: L(`这次没测成：${ch.message ?? ch.error}`, `Could not test this time: ${ch.message ?? ch.error}`), detail: via }
  const ports = ch.ports ?? []
  const isp = ISP_NAME()
  const per = ports.map((p) => {
    const cnOk = p.cn.filter((x) => x.ok)
    const failedIsps = [...new Set(p.cn.filter((x) => !x.ok).map((x) => x.isp))].filter((i) => !cnOk.some((x) => x.isp === i))
    return { port: p.port, cnTotal: p.cn.length, cnOk: cnOk.length, abroadOk: p.abroad.filter((x) => x.ok).length, abroadTotal: p.abroad.length, failedIsps }
  })
  const detail = [
    ...ports.map((p) => L(
      `端口 ${p.port}：国内 ${p.cn.map((x) => `${isp[x.isp]}${x.city ? `（${x.city}）` : ''} ${x.ok ? `通 ${x.ms ?? '?'} ms` : '不通'}`).join('，') || '没有节点'}；国外 ${p.abroad.map((x) => `${x.country} ${x.ok ? '通' : '不通'}`).join('，') || '没有节点'}`,
      `Port ${p.port} — China: ${p.cn.map((x) => `${isp[x.isp]}${x.city ? ` (${x.city})` : ''} ${x.ok ? `ok ${x.ms ?? '?'} ms` : 'failed'}`).join(', ') || 'no nodes'}; abroad: ${p.abroad.map((x) => `${x.country} ${x.ok ? 'ok' : 'failed'}`).join(', ') || 'no nodes'}`)),
    L('UDP 端口（Hysteria2、TUIC 这类代理）这里测不了', 'UDP ports (proxies such as Hysteria2 and TUIC) cannot be tested here'),
    via,
  ].join('\n')
  if (!per.length || per.every((p) => p.cnTotal === 0)) return { id: 'china', title, level: 'na', text: L('这次没有分到国内的探测节点，稍后再试', 'No probe nodes in China were available this time; try again later'), detail }
  const portList = (list) => joinList(list.map((p) => p.port))
  const portWord = (list) => (list.length > 1 ? 'ports' : 'port')
  const blocked = per.filter((p) => p.cnTotal && p.cnOk === 0 && p.abroadOk > 0)
  const closed = per.filter((p) => p.cnOk === 0 && p.abroadOk === 0)
  const open = per.filter((p) => p.cnOk > 0)
  if (blocked.length && !open.length) {
    return { id: 'china', title, level: 'danger', text: L(`国内连不上、国外能连：这台在国内被墙了（试了端口 ${portList(blocked)}）`, `Unreachable from China but reachable from abroad: this server is blocked in China (${portWord(blocked)} tried: ${portList(blocked)})`), detail }
  }
  if (blocked.length) {
    return { id: 'china', title, level: 'danger', text: L(`端口 ${portList(blocked)} 在国内被封了，端口 ${portList(open)} 国内能连`, `${portWord(blocked) === 'ports' ? 'Ports' : 'Port'} ${portList(blocked)} ${blocked.length > 1 ? 'are' : 'is'} blocked in China; ${portWord(open)} ${portList(open)} ${open.length > 1 ? 'are' : 'is'} reachable from China`), detail }
  }
  if (!open.length && closed.length) {
    return { id: 'china', title, level: 'warn', text: L(`国内国外都连不上（端口 ${portList(closed)}）：多半是端口没开或被防火墙挡了，不是墙的问题`, `Unreachable from both China and abroad (${portWord(closed)} ${portList(closed)}): probably closed or firewalled, not blocked by China`), detail }
  }
  const partial = open.filter((p) => p.failedIsps.length)
  if (partial.length) {
    const isps = joinList([...new Set(partial.flatMap((p) => p.failedIsps))].map((i) => isp[i]))
    return { id: 'china', title, level: 'warn', text: L(`${isps}连不上（端口 ${portList(partial)}），其他运营商能连`, `${isps} could not connect (${portWord(partial)} ${portList(partial)}); the other carriers could`), detail }
  }
  return { id: 'china', title, level: 'ok', text: L(`电信、联通、移动都能连（端口 ${portList(open)}）`, `Reachable from China Telecom, Unicom and Mobile (${portWord(open)} ${portList(open)})`), detail }
}

const unreachable = (code) => code === 0

/**
 * 把原始结果翻译成给人看的清单。每一项：{ id, title, level: ok | warn | danger | na, text, detail? }
 * na = 这次说不准（连不上那个网站、返回了没见过的东西）：照实说，不硬猜
 */
export function judgeNet(data, china) {
  const items = [judgeChina(china)]
  const d = data ?? {}
  if (d.sshFailed || d.noCurl) {
    const text = d.noCurl ? L('服务器上没有 curl，测不了这几项', 'There is no curl on the server, so these could not be checked') : L(`连不上服务器，这几项没测：${d.sshFailed}`, `Could not reach the server, so these were not checked: ${d.sshFailed}`)
    for (const [id, title] of [['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['google', L('谷歌认为你在哪', 'Where Google places you')], ['youtube', L('YouTube 会员', 'YouTube Premium')], ['netflix', 'Netflix'], ['disney', 'Disney+'], ['ip', 'IP']]) {
      items.push({ id, title, level: 'na', text })
    }
    return summarize(items)
  }
  const where = (code) => (code ? countryName(code) : L('未知', 'unknown'))
  const gl = d.google?.country ?? null

  // ChatGPT
  {
    const o = d.openai ?? {}
    const seen = o.country ? L(`（OpenAI 认为你在${where(o.country)}）`, ` (OpenAI places you in ${where(o.country)})`) : ''
    let item
    if (o.code === 401 && !o.unsupported) item = { level: 'ok', text: L(`能用${seen}`, `Available${seen}`) }
    else if (o.unsupported) item = { level: 'danger', text: L(`不支持这个地区${seen}`, `Not available in this region${seen}`) }
    else if (unreachable(o.code)) item = { level: 'na', text: L('连不上 OpenAI，这次说不准', 'Could not reach OpenAI, so this is unclear') }
    else item = { level: 'na', text: L(`说不准：OpenAI 返回了没见过的结果（HTTP ${o.code}）`, `Unclear: OpenAI returned something unfamiliar (HTTP ${o.code})`) }
    items.push({ id: 'chatgpt', title: 'ChatGPT', ...item })
  }
  // Claude
  {
    const a = d.anthropic ?? {}
    let item
    if (a.code === 401) item = { level: 'ok', text: L('能用', 'Available') }
    else if (a.code === 403 && a.forbidden) item = { level: 'danger', text: L('不支持这个地区', 'Not available in this region') }
    else if (unreachable(a.code)) item = { level: 'na', text: L('连不上 Anthropic，这次说不准', 'Could not reach Anthropic, so this is unclear') }
    else item = { level: 'na', text: L(`说不准：Anthropic 返回了没见过的结果（HTTP ${a.code}）`, `Unclear: Anthropic returned something unfamiliar (HTTP ${a.code})`) }
    items.push({ id: 'claude', title: 'Claude', ...item })
  }
  // Gemini：按谷歌认为你在哪推断
  {
    let item
    if (!gl) item = { level: 'na', text: L('说不准：没读出谷歌认为你在哪', 'Unclear: could not tell where Google places you') }
    else if (GEMINI_BLOCKED.has(gl)) item = { level: 'danger', text: L(`不支持：谷歌认为你在${where(gl)}`, `Not available: Google places you in ${where(gl)}`) }
    else item = { level: 'ok', text: L(`能用（按谷歌认为你在${where(gl)}推断）`, `Available (inferred from Google placing you in ${where(gl)})`) }
    items.push({ id: 'gemini', title: 'Gemini', ...item })
  }
  // 各家认为你在哪：多个来源投票
  const votes = [
    ['Cloudflare', d.cloudflare?.country],
    ['OpenAI', d.openai?.country],
    [L('谷歌', 'Google'), gl],
    ['ipinfo', d.ipinfo?.country],
    ['ip-api', d.ipapi?.country],
    ['Netflix', d.netflix?.country],
  ].filter(([, c]) => c)
  const tally = new Map()
  for (const [, c] of votes) tally.set(c, (tally.get(c) ?? 0) + 1)
  const majority = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  // 谷歌认为你在哪（送中）
  {
    let item
    if (!gl) item = { level: 'na', text: L('说不准：没读出谷歌的判断', 'Unclear: could not read Google\'s answer') }
    else if (gl === 'CN') item = { level: 'danger', text: L('谷歌认为你在中国大陆（俗称"送中"）：Gemini、YouTube 会员等会受限', 'Google places you in mainland China: Gemini, YouTube Premium and more will be restricted') }
    else if (majority && gl !== majority) item = { level: 'warn', text: L(`谷歌认为你在${where(gl)}，其他网站大多认为在${where(majority)}：谷歌的服务会按${where(gl)}来`, `Google places you in ${where(gl)}, while most other sites say ${where(majority)}: Google services will treat you as ${where(gl)}`) }
    else item = { level: 'ok', text: L(`${where(gl)}，和其他网站一致`, `In ${where(gl)}, the same as other sites`) }
    items.push({ id: 'google', title: L('谷歌认为你在哪', 'Where Google places you'), ...item })
  }
  // YouTube 会员
  {
    const g = d.google ?? {}
    let item
    if (g.premiumBlocked) item = { level: 'warn', text: L(`这个地区开不了（谷歌认为你在${where(gl)}）`, `Not offered here (Google places you in ${where(gl)})`) }
    else if (g.code === 200 && gl) item = { level: 'ok', text: L(`能开（${where(gl)}区）`, `Available (${where(gl)})`) }
    else if (unreachable(g.code)) item = { level: 'na', text: L('连不上 YouTube，这次说不准', 'Could not reach YouTube, so this is unclear') }
    else item = { level: 'na', text: L(`说不准（HTTP ${g.code}）`, `Unclear (HTTP ${g.code})`) }
    items.push({ id: 'youtube', title: L('YouTube 会员', 'YouTube Premium'), ...item })
  }
  // Netflix
  {
    const n = d.netflix ?? {}
    const region = n.country ? L(`（${where(n.country)}区）`, ` (${where(n.country)})`) : ''
    let item
    if (n.original === 200 && n.licensed === 200) item = { level: 'ok', text: L(`能看全部片库${region}`, `Full library${region}`) }
    else if (n.original === 200 && n.licensed === 404) item = { level: 'warn', text: L(`只能看自制剧${region}`, `Originals only${region}`) }
    else if (n.original === 403 || n.original === 404) item = { level: 'danger', text: L('不能看', 'Not available') }
    else if (unreachable(n.original)) item = { level: 'na', text: L('连不上 Netflix，这次说不准', 'Could not reach Netflix, so this is unclear') }
    else item = { level: 'na', text: L(`说不准（HTTP ${n.original} / ${n.licensed}）`, `Unclear (HTTP ${n.original} / ${n.licensed})`) }
    items.push({ id: 'netflix', title: 'Netflix', ...item })
  }
  // Disney+
  {
    const s = d.disney ?? {}
    let item
    if (/unavailable/i.test(s.url ?? '')) item = { level: 'danger', text: L('这个地区不能用', 'Not available in this region') }
    else if (s.code === 200 && s.region) item = { level: 'ok', text: L(`能用（${where(s.region)}区）`, `Available (${where(s.region)})`) }
    else if (unreachable(s.code)) item = { level: 'na', text: L('连不上 Disney+，这次说不准', 'Could not reach Disney+, so this is unclear') }
    else item = { level: 'na', text: L(`说不准（HTTP ${s.code}）`, `Unclear (HTTP ${s.code})`) }
    items.push({ id: 'disney', title: 'Disney+', ...item })
  }
  // IP 干不干净：各家认为在哪、机房还是家宽、黑名单
  {
    const parts = []
    let level = 'ok'
    if (!votes.length) {
      parts.push(L('说不准：没查到各家网站认为你在哪', 'Unclear: could not find where sites place you'))
      level = 'na'
    } else if (tally.size === 1) {
      parts.push(L(`各家网站都认为你在${where(majority)}`, `Every site places you in ${where(majority)}`))
    } else {
      level = 'warn'
      const groups = [...tally.keys()].map((c) => `${votes.filter(([, v]) => v === c).map(([s]) => s).join(L('、', ', '))} → ${where(c)}`)
      parts.push(L(`各家看法不一致（俗称"广播 IP"），容易被某些服务误判地区：${groups.join('；')}`, `Sites disagree about where you are (a "broadcast IP"), so some services may misjudge your region: ${groups.join('; ')}`))
    }
    const hosting = d.ipapi?.hosting
    if (hosting === true) parts.push(L('是机房 IP（大多数 VPS 都是）：ChatGPT 一般没问题，部分流媒体会限制', 'A data-centre IP (most VPSes are): usually fine for ChatGPT, some streaming services restrict it'))
    else if (hosting === false) parts.push(L('不是机房 IP，看流媒体更容易', 'Not a data-centre IP, which makes streaming easier'))
    const listed = (d.dnsbl ?? []).filter((b) => /^127\.0\.0\.\d+$/.test(b.answer))
    if (listed.length) {
      if (level === 'ok') level = 'warn'
      parts.push(L(`上了 ${listed.map((b) => b.zone).join('、')} 黑名单：影响发邮件，一般不影响上网`, `Listed on ${listed.map((b) => b.zone).join(', ')}: this affects sending email, usually not browsing`))
    } else if ((d.dnsbl ?? []).some((b) => b.answer === '')) {
      parts.push(L('没上主要的垃圾邮件黑名单', 'Not on the main spam blocklists'))
    }
    const org = d.ipinfo?.org ?? d.ipapi?.as
    items.push({ id: 'ip', title: 'IP', level, text: parts.join(L('；', '. ')), detail: [d.cloudflare?.ip, org].filter(Boolean).join(' · ') || undefined })
  }
  return summarize(items)
}

function summarize(items) {
  const count = (lv) => items.filter((i) => i.level === lv).length
  const worst = count('danger') ? 'danger' : count('warn') ? 'warn' : count('ok') ? 'ok' : 'na'
  return { items, worst, counts: { ok: count('ok'), warn: count('warn'), danger: count('danger'), na: count('na') } }
}

// —————————————————————— 跑一次、存本机 ——————————————————————

const KEEP_DAYS = 90
const netDir = (alias, env) => join(dshHome(env), 'vps-manager', 'net', alias)

export async function readNetCache(alias, env = process.env) {
  try {
    return JSON.parse(await readFile(join(netDir(alias, env), 'latest.json'), 'utf8'))
  } catch {
    return null
  }
}

async function saveNet(alias, record, env, now) {
  const dir = netDir(alias, env)
  await mkdir(dir, { recursive: true })
  await atomicWrite(join(dir, 'latest.json'), JSON.stringify(record, null, 2))
  // 每次的结果另存一份，以后比"白天 / 晚高峰""这周 / 上周"用；超过 90 天的删掉
  const stamp = record.checkedAt.replace(/[:.]/g, '-')
  await atomicWrite(join(dir, `${stamp}.json`), JSON.stringify(record))
  try {
    const cutoff = now() - KEEP_DAYS * 86_400_000
    for (const name of await readdir(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})T/.exec(name)
      if (m && Date.parse(m[1]) < cutoff) await rm(join(dir, name), { force: true })
    }
  } catch {
    // 清理失败不要紧
  }
}

/** 要从国内测的端口：SSH 端口，加上次状态页看到的、对外开放的 TCP 端口（优先 443、80），最多 3 个 */
export function portsToProbe(sshPort, statusData) {
  const ports = [Number(sshPort) || 22]
  const listening = (statusData?.ports ?? []).filter((p) => !p.local && Number.isFinite(p.port)).map((p) => p.port)
  const ranked = [...new Set(listening)].filter((p) => !ports.includes(p)).sort((a, b) => {
    const pref = (p) => (p === 443 ? 0 : p === 80 ? 1 : 2)
    return pref(a) - pref(b) || a - b
  })
  return [...ports, ...ranked].slice(0, 3)
}

/**
 * 体检一次：VPS 上的检查（SSH）和国内连通（Globalping）同时跑，大约 20～30 秒。
 * SSH 连不上时，国内连通照样测——有可能正是被墙了
 */
export async function runNetCheck({ alias, env = process.env, runner, fetchImpl = globalThis.fetch, sleep, now = Date.now, resolve }) {
  const hosts = await readHosts(env)
  if (!hosts.hosts?.[alias]) throw new Error(L(`没有登记过这台机器：${alias}`, `No such machine: ${alias}`))
  const resolveImpl = resolve ?? (async (a) => (await import('./ssh.js')).sshResolve(a))
  const vps = (async () => {
    const res = await runRemote({ alias, body: NET_SCRIPT, mode: 'read', withPrelude: true, timeoutMs: 45_000, env, runner })
    if (!res.ok && res.status !== 'failed') return { sshFailed: res.hint || res.status }
    return parseNet(res.stdout)
  })()
  const china = (async () => {
    let target
    try {
      target = await resolveImpl(alias)
    } catch {
      target = null
    }
    if (!target?.hostname) return { error: 'noaddr' }
    // 经跳板机才连得上的机器，地址多半是内网的，公共探测点连不到
    if (target.proxyJump) return { skipped: 'private', target: target.hostname }
    const cache = await readStatusCache(alias, env).catch(() => null)
    return checkChina({ hostname: target.hostname, ports: portsToProbe(target.port, cache?.data), fetchImpl, ...(sleep ? { sleep } : {}) })
  })()
  const [data, chinaResult] = await Promise.all([vps, china.catch((error) => ({ error: 'net', message: error.message }))])
  const record = { checkedAt: new Date(now()).toISOString(), data, china: chinaResult }
  await saveNet(alias, record, env, now)
  return record
}

const MARK = { ok: '✓', warn: '!', danger: '✗', na: '?' }

/** 命令（/vps-netcheck）里给人看的纯文本：一项一行，前面一个记号 */
export function netText(alias, record, judged) {
  const t = new Date(record.checkedAt)
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  const { ok, warn, danger, na } = judged.counts
  const tally = [
    ok ? L(`${ok} 项正常`, `${ok} fine`) : '',
    warn ? L(`${warn} 项要注意`, `${warn} to note`) : '',
    danger ? L(`${danger} 项不行`, `${danger} not working`) : '',
    na ? L(`${na} 项说不准`, `${na} unclear`) : '',
  ].filter(Boolean).join(L('，', ', '))
  const lines = [L(`[${alias}] 网络体检 · ${hhmm} · ${tally}`, `[${alias}] Network check-up · ${hhmm} · ${tally}`), '']
  for (const i of judged.items) lines.push(`${MARK[i.level] ?? '?'} ${i.title}${L('：', ': ')}${i.text}`)
  lines.push('', L('✓ 正常  ! 要注意  ✗ 不行  ? 说不准。完整细节在状态页的「网络」卡片', '✓ fine  ! note  ✗ not working  ? unclear. Full details are in the Network card on the Status tab'))
  return lines.join('\n')
}
