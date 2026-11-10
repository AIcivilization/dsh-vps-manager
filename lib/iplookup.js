// lib/iplookup.js — 状态页的「IP 归属地」卡片：你这台电脑、这台 VPS、任意 IP 在哪、是哪家的
//
// 设计见 工作流/dsh-vps-manager-IP归属地与右侧栏终端设计.md。点了才查，零 token。
//   你这台电脑：家里宽带（绕开代理的出口）、走代理的出口（网速卡的 egressOf），
//              服务器看到的你（VPS 上的 SSH_CONNECTION）
//   这台 VPS：它自己访问外网时的 IPv4、IPv6
//   查 IP：用户填的 IP 或域名
// 归属地在这台电脑上查，走和浏览器一样的路：ip-api.com 为主（中文地名、运营商、是不是机房），
// ipinfo.io 第二意见（两家的国家对不上时说出来）。存本机的是原始结果（中英文地名各一份），
// 句子按界面语言现拼。里面有家里宽带的 IP，不往对话里发。

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, dshHome, readHosts } from './config.js'
import { runRemote } from './engine.js'
import { L, currentLang } from './i18n.js'
import { detectPaths, egressOf, execCommand, pathArgs, pathEnv } from './speedtest.js'

// —————————————————————— VPS 上：它自己的公网 IP、它看到的你 ——————————————————————
// 用到 prelude 里的 has_cmd。IPv4、IPv6 同时查（没有 IPv6 的会马上失败）。
// 注意：这是 JS 模板字符串，脚本里不能出现「美元符 + 左花括号」和反引号
export const IP_SCRIPT = String.raw`
trace() {
  if has_cmd curl; then curl "-$1" -s -m 6 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null
  elif has_cmd wget; then wget "-$1" -qO- -T 6 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null
  fi | sed -n 's/^ip=//p' | head -n 1
}
( printf 'v4=%s\n' "$(trace 4)" ) &
( printf 'v6=%s\n' "$(trace 6)" ) &
wait
printf '%s\n' "$SSH_CONNECTION" | awk 'NF { print "seen=" $1 }'
`

export function parseIpScript(stdout) {
  const kv = {}
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^(v4|v6|seen)=(.*)$/.exec(line.trim())
    if (m) kv[m[1]] = m[2].trim()
  }
  const ok = (v) => (v && isIp(v) ? v : null)
  return { v4: ok(kv.v4), v6: ok(kv.v6), seen: ok(kv.seen?.replace(/^::ffff:/i, '')) }
}

// —————————————————————— 地址分类 ——————————————————————

export const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || (/^[0-9a-f:.]+$/i.test(s) && s.includes(':'))

/**
 * 局域网、保留地址：数据库里没有归属地，不去查
 * @returns {'lan'|'loopback'|'cgnat'|'fake'|'reserved'|null}
 */
export function specialIp(ip) {
  const s = String(ip ?? '').toLowerCase()
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan'
    if (a === 127) return 'loopback'
    if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
    if (a === 198 && (b === 18 || b === 19)) return 'fake'
    if (a === 0 || (a === 169 && b === 254) || a >= 224) return 'reserved'
    return null
  }
  if (s === '::1') return 'loopback'
  if (/^f[cd]/.test(s)) return 'lan'
  if (/^fe[89ab]/.test(s) || s === '::') return 'reserved'
  return null
}

function specialText(kind) {
  return {
    lan: L('局域网地址，没有归属地', 'A local network address, with no location'),
    loopback: L('本机地址，没有归属地', 'A loopback address, with no location'),
    cgnat: L('运营商内网地址（CGNAT），没有归属地：你家宽带没有自己的公网 IP', 'A carrier-grade NAT address with no location: your broadband has no public IP of its own'),
    fake: L('代理软件的假 IP（Fake IP），不是真实地址', 'A proxy app\'s fake IP, not a real address'),
    reserved: L('保留地址，没有归属地', 'A reserved address, with no location'),
  }[kind] ?? ''
}

// —————————————————————— 查归属地（在这台电脑上） ——————————————————————

const IPAPI_FIELDS = 'status,message,country,countryCode,regionName,city,isp,org,as,mobile,proxy,hosting,query'
const curlArgs = (net) => ['-s', '-m', '8', ...pathArgs('proxy', net)]

async function curlJson(args, net, exec) {
  const res = await exec('curl', [...curlArgs(net), ...args], { timeoutMs: 10_000, env: pathEnv('proxy') })
  try {
    return JSON.parse(res.stdout)
  } catch {
    return null
  }
}

/**
 * ip-api.com 批量接口：一次请求查完，每个地址中文、英文地名各一份。免费版只有 http。
 * 批量接口不收域名，域名先用单个查询的接口解析（在国外解析，不受这台电脑的 DNS、代理软件的假 IP 影响）
 */
async function resolveDomain(name, net, exec) {
  const j = await curlJson([`http://ip-api.com/json/${encodeURIComponent(name)}?fields=status,message,query`], net, exec)
  return j?.status === 'success' && isIp(j.query) ? j.query : null
}

async function ipApi(queries, net, exec) {
  const body = JSON.stringify(queries.flatMap((q) => [{ query: q, fields: IPAPI_FIELDS, lang: 'zh-CN' }, { query: q, fields: IPAPI_FIELDS, lang: 'en' }]))
  const list = await curlJson(['-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', body, 'http://ip-api.com/batch'], net, exec)
  const out = new Map()
  if (!Array.isArray(list)) return out
  queries.forEach((q, i) => {
    const zh = list[i * 2]
    const en = list[i * 2 + 1]
    if (!zh && !en) return
    out.set(q, { zh, en })
  })
  return out
}

/** ipinfo.io：第二意见，只看国家、地区、城市、机构 */
async function ipinfo(ip, net, exec) {
  const j = await curlJson([`https://ipinfo.io/${encodeURIComponent(ip)}/json`], net, exec)
  if (!j || j.bogon || !j.country) return null
  return { country: j.country, region: j.region ?? '', city: j.city ?? '', org: j.org ?? '' }
}

const place = (r) => ({ country: r?.country ?? '', region: r?.regionName ?? '', city: r?.city ?? '' })

/**
 * 查一批地址的归属地。返回 { [查的东西]: 原始信息 }；局域网、保留地址不查
 * 原始信息：{ ip, special?, ok, error?, zh, en, code, isp, org, as, mobile, proxy, hosting, ipinfo }
 */
export async function lookupMany(queries, { exec = execCommand, net = null } = {}) {
  const list = [...new Set(queries.filter(Boolean))]
  const out = {}
  const ask = []
  for (const q of list) {
    const sp = isIp(q) ? specialIp(q) : null
    if (sp) out[q] = { ip: q, special: sp, ok: false }
    else ask.push(q)
  }
  if (!ask.length) return out
  const paths = net ?? (await detectPaths({ exec }))
  const resolved = new Map(await Promise.all(ask.map(async (q) => [q, isIp(q) ? q : await resolveDomain(q, paths, exec)])))
  const api = await ipApi([...new Set([...resolved.values()].filter(Boolean))], paths, exec)
  await Promise.all(ask.map(async (q) => {
    const target = resolved.get(q)
    if (!target) {
      out[q] = { ip: null, ok: false, error: 'invalid query' }
      return
    }
    const r = api.get(target)
    const zh = r?.zh
    if (!zh || zh.status !== 'success') {
      out[q] = { ip: isIp(q) ? q : (zh?.query && isIp(zh.query) ? zh.query : null), ok: false, error: zh?.message ?? (r ? 'fail' : 'unreachable') }
      if (out[q].ip && specialIp(out[q].ip)) out[q] = { ip: out[q].ip, special: specialIp(out[q].ip), ok: false }
      return
    }
    const ip = zh.query
    out[q] = {
      ip, ok: true,
      zh: place(zh), en: place(r.en ?? zh),
      code: zh.countryCode ?? '', isp: zh.isp ?? '', org: zh.org ?? '', as: zh.as ?? '',
      mobile: Boolean(zh.mobile), proxy: Boolean(zh.proxy), hosting: Boolean(zh.hosting),
      ipinfo: await ipinfo(ip, paths, exec),
    }
  }))
  return out
}

// —————————————————————— 说成人话 ——————————————————————

function regionName(code) {
  if (!code) return ''
  try {
    return new Intl.DisplayNames([currentLang() === 'zh' ? 'zh-CN' : 'en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** 中国 广东 深圳；北京 北京 只说一次。国家名照系统的标准译名（ip-api 的中文有时是繁体） */
function placeText(p, code = '') {
  const parts = [regionName(code) || p.country, p.region, p.city].map((x) => String(x ?? '').trim()).filter(Boolean)
  const seen = []
  for (const x of parts) {
    const bare = x.replace(/(省|市|自治区|特别行政区)$/, '')
    if (!seen.some((s) => s.replace(/(省|市|自治区|特别行政区)$/, '') === bare)) seen.push(x)
  }
  return seen.join(' ')
}

/**
 * 一个地址 → 界面上的一行。label 是「家里宽带」这类说明（查 IP 时是用户填的东西）
 * @returns {{ id, label, ip, place, isp, tags: string[], note, level: 'ok'|'na', detail }}
 */
export function ipRow(id, label, info, query = '') {
  if (!info) return { id, label, ip: query || null, place: '', isp: '', tags: [], note: L('没查到', 'Not found'), level: 'na', detail: '' }
  if (info.special) return { id, label, ip: info.ip, place: '', isp: '', tags: [], note: specialText(info.special), level: 'na', detail: '' }
  if (!info.ok) {
    const bad = /invalid query|reserved range|private range/i.test(info.error ?? '')
    return { id, label, ip: info.ip ?? (query || null), place: '', isp: '', tags: [], note: bad ? L('不是有效的公网 IP 或域名', 'Not a valid public IP or domain') : L('这次没查成（查询服务连不上）', 'Lookup failed this time (the lookup service is unreachable)'), level: 'na', detail: info.error ?? '' }
  }
  const p = currentLang() === 'zh' ? info.zh : info.en
  const tags = [
    info.hosting ? L('机房', 'Data center') : '',
    info.mobile ? L('手机网络', 'Mobile') : '',
    info.proxy ? L('代理 / VPN', 'Proxy / VPN') : '',
  ].filter(Boolean)
  // 第二意见：两家的国家对不上时说出来（网站按哪家的库判断，就会觉得你在哪）
  const other = info.ipinfo
  const differs = other && info.code && other.country && other.country !== info.code
  const note = differs ? L(`ipinfo 认为在${regionName(other.country)}：各家数据库不一样，网站按哪家判断就是哪里`, `ipinfo puts it in ${regionName(other.country)}: databases disagree, and each website goes by its own`) : ''
  const detail = [
    `ip-api: ${placeText(p, info.code)}${info.isp ? ` · ${info.isp}` : ''}${info.org && info.org !== info.isp ? ` · ${info.org}` : ''}${info.as ? ` · ${info.as}` : ''}`,
    other ? `ipinfo: ${[regionName(other.country), other.region, other.city].filter(Boolean).join(' ')}${other.org ? ` · ${other.org}` : ''}` : '',
  ].filter(Boolean).join('\n')
  return { id, label, ip: info.ip, place: placeText(p, info.code), isp: info.isp || info.org, tags, note, level: 'ok', detail }
}

/**
 * 存下的结果 → 卡片上的两块和几句结论
 * record = { checkedAt, me: { direct, proxy, seen }, vps: { v4, v6 }, info: { [ip]: 原始信息 } }
 */
export function judgeIp(record) {
  const { me = {}, vps = {}, info = {} } = record ?? {}
  const rows = []
  const notes = []
  const proxied = me.direct && me.proxy && me.direct !== me.proxy
  if (me.direct && !proxied) rows.push(ipRow('mine', L('你的公网 IP', 'Your public IP'), info[me.direct]))
  else {
    rows.push(me.direct ? ipRow('direct', L('家里宽带', 'Home broadband'), info[me.direct]) : { id: 'direct', label: L('家里宽带', 'Home broadband'), ip: null, place: '', isp: '', tags: [], note: L('测不出来：绕不开这台电脑上的代理软件', 'Could not tell: the proxy app on this computer could not be bypassed'), level: 'na', detail: '' })
    if (me.proxy) rows.push(ipRow('proxy', L('走代理出去', 'Through the proxy'), info[me.proxy]))
  }
  // 服务器看到的你：和上面哪一个一样，就说你连这台是怎么走的
  if (me.seen) {
    if (proxied && me.seen === me.proxy) notes.push({ level: 'ok', text: L('服务器看到的你是代理的出口：你连这台走的是代理', 'The server sees your proxy\'s exit: you reach it through the proxy') })
    else if (proxied && me.seen === me.direct) notes.push({ level: 'ok', text: L('服务器看到的是你家宽带：你直连这台，没走代理', 'The server sees your home broadband: you reach it directly, not through the proxy') })
    else if (me.seen === me.direct || me.seen === me.proxy) notes.push({ level: 'ok', text: L('服务器看到的你就是上面这个 IP', 'The server sees you as the IP above') })
    else {
      rows.push(ipRow('seen', L('服务器看到的你', 'As the server sees you'), info[me.seen]))
      notes.push({ level: 'ok', text: L('服务器看到的你和这台电脑上网的出口不一样：连这台走的是另一条线路（比如代理软件里单独的规则，或者跳板机）', 'The server sees a different address from your browsing exit: you reach it another way (a separate proxy rule, or a jump host)') })
    }
  }
  const vpsRows = []
  if (vps.v4) vpsRows.push(ipRow('v4', 'IPv4', info[vps.v4]))
  if (vps.v6) vpsRows.push(ipRow('v6', 'IPv6', info[vps.v6]))
  if (!vpsRows.length) vpsRows.push({ id: 'v4', label: 'IPv4', ip: null, place: '', isp: '', tags: [], note: record?.vpsError ? L(`连不上服务器，这次没查：${record.vpsError}`, `Could not reach the server, so it was not checked: ${record.vpsError}`) : L('没查到这台的公网 IP（服务器上没有 curl / wget，或上不了外网）', 'Could not find this server\'s public IP (no curl / wget on it, or no internet access)'), level: 'na', detail: '' })
  const v4 = info[vps.v4]
  if (v4?.ok && !v4.hosting) notes.push({ level: 'ok', text: L('这台的 IPv4 没被数据库标成机房 IP：网站把它当成普通用户，流媒体、AI 网站更容易过', 'This server\'s IPv4 is not flagged as a data-center IP: websites treat it like a regular user, so streaming and AI sites are less likely to block it') })
  return {
    groups: [
      { id: 'me', title: L('你这台电脑', 'This computer'), rows },
      { id: 'vps', title: L('这台 VPS', 'This VPS'), rows: vpsRows },
    ],
    notes,
  }
}

// —————————————————————— 跑一次、存本机 ——————————————————————

const dir = (env) => join(dshHome(env), 'vps-manager', 'ip')
const safe = (alias) => String(alias).replace(/[^\w.-]/g, '_')

export async function readIpCache(alias, env = process.env) {
  try {
    return JSON.parse(await readFile(join(dir(env), `${safe(alias)}.json`), 'utf8'))
  } catch {
    return null
  }
}

/** 查一次：VPS 上一次 SSH（只读），这台电脑上测两条出口，再一起查归属地 */
export async function runIpCheck({ alias, env = process.env, runner, exec = execCommand, net: givenNet = null, now = Date.now }) {
  const hosts = await readHosts(env)
  if (!hosts.hosts?.[alias]) throw new Error(L(`没有登记过这台机器：${alias}`, `No such machine: ${alias}`))
  const net = givenNet ?? (await detectPaths({ exec }))
  const [remote, direct, proxy] = await Promise.all([
    runRemote({ alias, body: IP_SCRIPT, mode: 'read', withPrelude: true, timeoutMs: 30_000, env, runner }),
    egressOf('direct', net, { exec }).catch(() => null),
    egressOf('proxy', net, { exec }).catch(() => null),
  ])
  const reached = remote.ok || remote.status === 'failed'
  const vps = reached ? parseIpScript(remote.stdout) : { v4: null, v6: null, seen: null }
  const me = { direct: direct?.ip ?? null, proxy: proxy?.ip ?? null, seen: vps.seen }
  const info = await lookupMany([me.direct, me.proxy, me.seen, vps.v4, vps.v6], { exec, net })
  const record = { checkedAt: new Date(now()).toISOString(), me, vps: { v4: vps.v4, v6: vps.v6 }, info, ...(reached ? {} : { vpsError: remote.hint || remote.status }) }
  await mkdir(dir(env), { recursive: true })
  await atomicWrite(join(dir(env), `${safe(alias)}.json`), JSON.stringify(record, null, 2))
  return record
}

/** 「查 IP」：用户填的 IP 或域名。只查不存 */
export async function lookupOne(query, { exec = execCommand, net = null } = {}) {
  const q = String(query ?? '').trim().replace(/^\[|\]$/g, '')
  if (!q || q.length > 253 || !/^[0-9a-z.:-]+$/i.test(q)) throw new Error(L('填一个 IP 或域名', 'Enter an IP or a domain'))
  const info = await lookupMany([q], { exec, net })
  return ipRow(`q:${q}`, q, info[q], q)
}
