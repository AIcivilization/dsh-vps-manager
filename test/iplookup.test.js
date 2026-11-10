// 状态页的「IP 归属地」卡片：你这台电脑、这台 VPS、任意 IP 在哪、是哪家的
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeHosts } from '../lib/config.js'
import { withLang } from '../lib/i18n.js'
import { IP_SCRIPT, judgeIp, lookupMany, lookupOne, parseIpScript, readIpCache, runIpCheck, specialIp } from '../lib/iplookup.js'
import { registerRoutes } from '../lib/routes.js'

const HAN = /[一-鿿]/
const NET = { platform: 'darwin', tun: false, proxy: null, iface: null, defaultIface: 'en0' }

// 两家查询服务的假数据（地址都是文档用的）
const DB = {
  '198.51.100.20': { zh: ['中国', '广东', '深圳'], en: ['China', 'Guangdong', 'Shenzhen'], code: 'CN', isp: 'Chinanet', as: 'AS4134 CHINANET', hosting: false, mobile: false, ipinfo: 'CN' },
  '203.0.113.50': { zh: ['日本', '东京都', '东京'], en: ['Japan', 'Tokyo', 'Tokyo'], code: 'JP', isp: 'Example Cloud', as: 'AS64500 Example', hosting: true, mobile: false, ipinfo: 'JP' },
  '203.0.113.7': { zh: ['美国', '加利福尼亚州', '洛杉矶'], en: ['United States', 'California', 'Los Angeles'], code: 'US', isp: 'Example Host', as: 'AS64501 Host', hosting: true, mobile: false, ipinfo: 'HK' },
  '192.0.2.9': { zh: ['新加坡', '', '新加坡'], en: ['Singapore', '', 'Singapore'], code: 'SG', isp: 'Example SG', as: 'AS64502', hosting: false, mobile: true, ipinfo: 'SG' },
}

/** 假的 curl：按地址回答；记下查了什么 */
function fakeExec(log = []) {
  return async (cmd, args) => {
    const url = args.find((a) => /^https?:\/\//.test(a)) ?? ''
    log.push(url)
    if (url.includes('223.5.5.5/resolve')) return { code: 0, stdout: JSON.stringify({ Answer: [{ type: 1, data: '104.16.1.1' }] }), stderr: '' }
    if (url.includes('cdn-cgi/trace')) return { code: 0, stdout: args.includes('--noproxy') ? 'ip=198.51.100.20\nloc=CN\n' : 'ip=203.0.113.50\nloc=JP\n', stderr: '' }
    if (url.includes('ip-api.com/batch')) {
      const body = JSON.parse(args[args.indexOf('--data-binary') + 1])
      return {
        code: 0, stderr: '',
        stdout: JSON.stringify(body.map(({ query, lang }) => {
          const d = DB[query]
          if (!d) return { status: 'fail', message: 'invalid query', query }
          const [country, regionName, city] = lang === 'en' ? d.en : d.zh
          return { status: 'success', country, countryCode: d.code, regionName, city, isp: d.isp, org: d.isp, as: d.as, mobile: d.mobile, proxy: false, hosting: d.hosting, query }
        })),
      }
    }
    if (url.includes('ip-api.com/json/')) return { code: 0, stdout: JSON.stringify(url.includes('example.test') ? { status: 'success', query: '192.0.2.9' } : { status: 'fail', message: 'invalid query' }), stderr: '' }
    const m = /ipinfo\.io\/([^/]+)\/json/.exec(url)
    if (m) return { code: 0, stdout: JSON.stringify(DB[m[1]] ? { ip: m[1], country: DB[m[1]].ipinfo, city: 'X', region: 'Y', org: 'AS0 Z' } : { bogon: true }), stderr: '' }
    return { code: 7, stdout: '', stderr: 'unreachable' }
  }
}

test('脚本：不能有 JS 插值和反引号；解析 VPS 的 IPv4、IPv6 和它看到的你', () => {
  assert.ok(!IP_SCRIPT.includes('${'))
  assert.ok(!IP_SCRIPT.includes('`'))
  assert.deepEqual(parseIpScript('v4=203.0.113.7\nv6=2001:db8::7\nseen=::ffff:198.51.100.20\n'), { v4: '203.0.113.7', v6: '2001:db8::7', seen: '198.51.100.20' })
  assert.deepEqual(parseIpScript('v4=\nv6=<html>\n'), { v4: null, v6: null, seen: null })
})

test('地址分类：局域网、运营商内网、代理软件的假 IP、保留地址不去查', () => {
  assert.equal(specialIp('192.168.1.1'), 'lan')
  assert.equal(specialIp('172.20.0.1'), 'lan')
  assert.equal(specialIp('100.72.1.1'), 'cgnat')
  assert.equal(specialIp('198.18.0.5'), 'fake')
  assert.equal(specialIp('127.0.0.1'), 'loopback')
  assert.equal(specialIp('fd00::1'), 'lan')
  assert.equal(specialIp('8.8.8.8'), null)
  assert.equal(specialIp('2001:db8::1'), null)
})

test('查归属地：一次批量请求查完（中英文地名各一份），域名先解析；局域网地址不发出去', async () => {
  const log = []
  const info = await lookupMany(['198.51.100.20', '192.168.1.1', 'example.test', 'bad..name'], { exec: fakeExec(log), net: NET })
  assert.equal(log.filter((u) => u.includes('ip-api.com/batch')).length, 1)
  assert.ok(!log.some((u) => u.includes('192.168.1.1')), '局域网地址不发给查询服务')
  assert.equal(info['192.168.1.1'].special, 'lan')
  assert.deepEqual(info['198.51.100.20'].zh, { country: '中国', region: '广东', city: '深圳' })
  assert.equal(info['198.51.100.20'].en.city, 'Shenzhen')
  assert.equal(info['example.test'].ip, '192.0.2.9', '域名解析成 IP 再查')
  assert.equal(info['bad..name'].ok, false)
  const row = await withLang('zh', () => lookupOne('example.test', { exec: fakeExec(), net: NET }))
  assert.equal(row.place, '新加坡')
  assert.deepEqual(row.tags, ['手机网络'])
  await assert.rejects(lookupOne('rm -rf /', { exec: fakeExec(), net: NET }), /填一个 IP 或域名|Enter an IP/)
})

test('结论：走了代理时分「家里宽带」「走代理出去」两行，并说出服务器看到的你是哪个；两家数据库国家不一样时说出来', async () => {
  const info = await lookupMany(['198.51.100.20', '203.0.113.50', '203.0.113.7'], { exec: fakeExec(), net: NET })
  const rec = { checkedAt: new Date().toISOString(), me: { direct: '198.51.100.20', proxy: '203.0.113.50', seen: '203.0.113.50' }, vps: { v4: '203.0.113.7', v6: null }, info }
  const j = withLang('zh', () => judgeIp(rec))
  const me = j.groups.find((g) => g.id === 'me').rows
  assert.deepEqual(me.map((r) => [r.label, r.place, r.ip]), [['家里宽带', '中国 广东 深圳', '198.51.100.20'], ['走代理出去', '日本 东京都 东京', '203.0.113.50']])
  assert.deepEqual(me[1].tags, ['机房'])
  assert.ok(j.notes.some((n) => n.text === '服务器看到的你是代理的出口：你连这台走的是代理'))
  const vps = j.groups.find((g) => g.id === 'vps').rows
  assert.equal(vps[0].place, '美国 加利福尼亚州 洛杉矶')
  assert.match(vps[0].note, /^ipinfo 认为在中国香港/)
  // 直连这台；没开代理；看到的是第三个地址
  assert.ok(withLang('zh', () => judgeIp({ ...rec, me: { ...rec.me, seen: '198.51.100.20' } })).notes.some((n) => /你直连这台，没走代理/.test(n.text)))
  const plain = withLang('zh', () => judgeIp({ ...rec, me: { direct: '198.51.100.20', proxy: '198.51.100.20', seen: '198.51.100.20' } }))
  assert.deepEqual(plain.groups[0].rows.map((r) => r.label), ['你的公网 IP'])
  const other = withLang('zh', () => judgeIp({ ...rec, me: { ...rec.me, seen: '192.0.2.9' } }))
  assert.deepEqual(other.groups[0].rows.map((r) => r.label), ['家里宽带', '走代理出去', '服务器看到的你'])
  // 绕不开代理软件：家里宽带那行说测不出来；连不上服务器：VPS 那块说没查
  const noDirect = withLang('zh', () => judgeIp({ ...rec, me: { direct: null, proxy: '203.0.113.50', seen: null }, vps: {}, vpsError: '连接超时' }))
  assert.match(noDirect.groups[0].rows[0].note, /绕不开这台电脑上的代理软件/)
  assert.match(noDirect.groups[1].rows[0].note, /连不上服务器，这次没查：连接超时/)
  // 英文没有汉字
  const en = withLang('en', () => judgeIp(rec))
  for (const t of [...en.groups.flatMap((g) => [g.title, ...g.rows.flatMap((r) => [r.label, r.place, r.note, ...r.tags])]), ...en.notes.map((n) => n.text)]) assert.doesNotMatch(t, HAN, t)
})

test('接口：查一次存本机（一次 SSH）、读的时候按界面语言现拼；「查 IP」只查不存', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-ip-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: 'la', hosts: { la: {} } }, env)
  let ssh = 0
  const runner = (_a, payload) => {
    ssh += 1
    const nonce = /__DSH_BEGIN_([0-9a-f]+)__/.exec(payload)[1]
    return Promise.resolve({ stdout: `__DSH_BEGIN_${nonce}__\nv4=203.0.113.7\nv6=\nseen=203.0.113.50\n__DSH_RC_${nonce}__=0\n`, stderr: '', exitCode: 0, durationMs: 5 })
  }
  const exact = new Map()
  const ws = { config: { host: '127.0.0.1', port: 3000 }, register({ path, handler }) { exact.set(path, handler); return () => exact.delete(path) } }
  const reg = registerRoutes({ webServer: ws }, { env, runner, speedExec: fakeExec(), speedNet: NET })
  const call = async (path, body, lang = 'zh') => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', 'x-dsh-vps-token': reg.token, 'x-dsh-vps-lang': lang }
    req.socket = { remoteAddress: '127.0.0.1' }
    const out = {}
    await exact.get(`/api-vps/${path}`)(req, { writeHead: (c) => { out.code = c }, end: (t) => { out.body = JSON.parse(t) } })
    return out.body
  }
  assert.equal((await call('status/ip/get', { alias: 'la' })).ip, null)
  const [a, b] = await Promise.all([call('status/ip/check', { alias: 'la' }), call('status/ip/check', { alias: 'la' })])
  assert.equal(ssh, 1, '同一台同时只查一次')
  assert.equal(a.ip.checkedAt, b.ip.checkedAt)
  assert.equal(a.ip.groups[1].rows[0].place, '美国 加利福尼亚州 洛杉矶')
  const saved = await readIpCache('la', env)
  assert.equal(saved.me.direct, '198.51.100.20')
  assert.equal(saved.vps.v4, '203.0.113.7')
  const en = await call('status/ip/get', { alias: 'la' }, 'en')
  assert.equal(en.ip.groups[1].rows[0].place, 'United States California Los Angeles')
  const look = await call('ip/lookup', { query: '198.51.100.20' })
  assert.equal(look.row.place, '中国 广东 深圳')
  assert.equal(ssh, 1, '「查 IP」不连服务器')
  const bad = await call('ip/lookup', { query: '$(id)' })
  assert.equal(bad.ok, false)
  // runIpCheck 直接调：没登记的机器报错
  await assert.rejects(runIpCheck({ alias: 'nope', env, runner, exec: fakeExec(), net: NET }), /没有登记过这台机器|No such machine/)
})

test('界面：卡片排在「网络」后面；没查过有说明和「开始查」，查过一块一块列出来；下面能查任意 IP；没有「+AI」', async () => {
  let spec = null
  globalThis.window = {
    __ModuleLoader__: { load: (s) => { spec = s } }, __DSH_VPS_TOKEN__: 't', confirm: () => true, innerHeight: 800,
    location: { origin: 'http://127.0.0.1:3000' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  delete globalThis.document
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) })
  await import(`../lib/client.js?${Math.random()}`)
  const exported = spec.factory((n) => {
    if (n === 'react') return React
    throw new Error(n)
  })
  const { StatusView, termChrome, ipStore, ipLookStore } = exported.__test
  const { parseStatus, judge, statusBrief } = await import('../lib/status.js')
  const data = parseStatus('priv=root\nhost=la\nos=Ubuntu 24.04\nuptime=100\ncores=1\nmemtotal=1000\nmemavailable=500')
  const judged = judge(data)
  const view = withLang('zh', () => ({ alias: 'la', status: { collectedAt: new Date().toISOString(), data, judged, brief: statusBrief('la', data, judged) }, interpretation: null, canInterpret: true }))
  const render = () => renderToStaticMarkup(React.createElement(StatusView, { entry: { sessionId: 's1', alias: 'la', statusState: { view, loading: false, error: '', expanded: true } }, c: termChrome('light'), maximized: true, visible: false }))
  const before = render()
  assert.match(before, /IP 归属地/)
  assert.ok(before.indexOf('>网络<') < before.indexOf('>IP 归属地<') && before.indexOf('>IP 归属地<') < before.indexOf('>网速<'), '排在「网络」后面、「网速」前面')
  assert.match(before, /会把这些 IP 发给 ip-api\.com、ipinfo\.io/)
  assert.match(before, />开始查</)
  const info = await lookupMany(['198.51.100.20', '203.0.113.50', '203.0.113.7'], { exec: fakeExec(), net: NET })
  const st = ipStore.of('la')
  st.view = withLang('zh', () => ({ checkedAt: new Date().toISOString(), ...judgeIp({ me: { direct: '198.51.100.20', proxy: '203.0.113.50', seen: '203.0.113.50' }, vps: { v4: '203.0.113.7' }, info }) }))
  st.loaded = true
  ipLookStore.of('all').rows = [withLang('zh', () => ({ id: 'q:x', label: '192.0.2.9', ip: '192.0.2.9', place: '新加坡', isp: 'Example SG', tags: ['手机网络'], note: '', level: 'ok', detail: '' }))]
  const after = render()
  for (const t of ['你这台电脑', '家里宽带', '中国 广东 深圳 · Chinanet', '走代理出去', '这台 VPS', '服务器看到的你是代理的出口', '查 IP', '新加坡 · Example SG', '>重新查<']) assert.ok(after.includes(t), t)
  const card = after.slice(after.indexOf('>IP 归属地<'), after.indexOf('>网速<'))
  assert.doesNotMatch(card, />\+AI</, '里面有家里宽带的 IP，不往对话里发')
})
