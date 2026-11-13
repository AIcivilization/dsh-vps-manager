// 月流量：本月用了多少 / 每月额度。用量来自服务器上的 vnstat，额度用户填
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeHosts } from '../lib/config.js'
import { withLang } from '../lib/i18n.js'
import { STATUS_SCRIPT, judge, parseStatus, statusBrief } from '../lib/status.js'
import { VNSTAT_INSTALL_SCRIPT, VNSTAT_SCRIPT, cycleOf, parseVnstat, readTrafficSettings, trafficLevel, trafficUsage, writeTrafficSettings } from '../lib/traffic.js'
import { registerRoutes } from '../lib/routes.js'

// 2026-11-13 在 Ubuntu 24.04 容器里装 vnstat 2.12 实跑的 `vnstat --json d -i eth0`
const V2 = new URL('./fixtures/vnstat2-day.json', import.meta.url).pathname
// vnstat 1.x（jsonversion 1，单位 KiB）的同一种输出
const V1 = '{"vnstatversion":"1.18","jsonversion":"1","interfaces":[{"id":"eth0","created":{"date":{"year":2026,"month":10,"day":20}},"updated":{"date":{"year":2026,"month":11,"day":13},"time":{"hour":10,"minutes":5}},"traffic":{"total":{"rx":3000,"tx":4000},"days":[{"id":0,"date":{"year":2026,"month":11,"day":13},"rx":1000,"tx":2000},{"id":1,"date":{"year":2026,"month":11,"day":12},"rx":2000,"tx":2000}]}}]}'

/** 在本机的 sh 里跑那段脚本：vnstat 换成吐固定的 JSON，日期固定 */
function runScript(json) {
  const sh = `has_cmd() { return 0; }\nvnstat() { printf '%s' '${json.replace(/'/g, "'\\''")}'; }\ndate() { echo 2026,11,13; }\ndev=eth0\n${VNSTAT_SCRIPT}`
  return execFileSync('sh', ['-c', sh]).toString()
}
const kvOf = (out) => {
  const kv = {}
  const days = []
  for (const l of out.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(l)
    if (!m) continue
    if (m[1] === 'vn_day') days.push(m[2])
    else kv[m[1]] = m[2]
  }
  return parseVnstat(kv, days)
}

test('脚本：不能有 JS 插值和反引号；进了状态采集；vnstat 2.x（中间多一个 timestamp）和 1.x（KiB）都读得出每天的量', async () => {
  for (const s of [VNSTAT_SCRIPT, VNSTAT_INSTALL_SCRIPT]) {
    assert.ok(!s.includes('${'))
    assert.ok(!s.includes('`'))
  }
  assert.ok(STATUS_SCRIPT.includes(VNSTAT_SCRIPT))
  const v2 = kvOf(runScript(await readFile(V2, 'utf8')))
  assert.equal(v2.ver, '2')
  assert.equal(v2.today, '2026-11-13')
  assert.equal(v2.created, '2026-11-13')
  assert.deepEqual(v2.days, [{ date: '2026-11-13', rx: 20160023, tx: 110343 }])
  const v1 = kvOf(runScript(V1))
  assert.equal(v1.created, '2026-10-20')
  assert.deepEqual(v1.days, [{ date: '2026-11-13', rx: 1024000, tx: 2048000 }, { date: '2026-11-12', rx: 2048000, tx: 2048000 }], '1.x 的 KiB 换成字节')
  assert.equal(parseVnstat({}, []), null, '没装 vnstat')
})

test('周期：每月几号重置；31 号重置遇到小月按月底；跨年', () => {
  assert.deepEqual(cycleOf('2026-11-13', 1), { start: '2026-11-01', end: '2026-12-01' })
  assert.deepEqual(cycleOf('2026-11-13', 28), { start: '2026-10-28', end: '2026-11-28' })
  assert.deepEqual(cycleOf('2026-11-28', 28), { start: '2026-11-28', end: '2026-12-28' })
  assert.deepEqual(cycleOf('2026-02-28', 31), { start: '2026-02-28', end: '2026-03-31' })
  assert.deepEqual(cycleOf('2026-01-05', 15), { start: '2025-12-15', end: '2026-01-15' })
  assert.deepEqual(cycleOf('2026-12-20', 15), { start: '2026-12-15', end: '2027-01-15' })
})

test('用量：只加这个周期里的天；三种计费方式；vnstat 周期中间才开始记要说；照速度估整个周期；到 80% 黄、95% 红、会超也黄', () => {
  const T = 1024 ** 4
  const vn = { today: '2026-11-13', created: '2026-09-01', updated: '2026-11-13', days: [
    { date: '2026-10-31', rx: 9 * T, tx: 9 * T }, // 上个周期，不算
    { date: '2026-11-01', rx: 1 * T, tx: 0.2 * T },
    { date: '2026-11-13', rx: 0.5 * T, tx: 0.3 * T },
  ] }
  const sum = trafficUsage(vn, { quota: 4 * T, resetDay: 1 })
  assert.equal(sum.used, 2 * T)
  assert.equal(sum.pct, 50)
  assert.equal(sum.partial, false)
  assert.equal(sum.daysLeft, 18)
  assert.equal(sum.projected, Math.round((2 * T / 13) * 30))
  assert.equal(trafficLevel(sum), 'warn', '13 天用了一半，照这样会超')
  assert.equal(trafficUsage(vn, { mode: 'out' }).used, 0.5 * T)
  assert.equal(trafficUsage(vn, { mode: 'max' }).used, 1.5 * T)
  assert.equal(trafficUsage(vn, {}).quota, null)
  assert.equal(trafficLevel(trafficUsage(vn, {})), 'ok', '没填额度不判轻重')
  assert.equal(trafficLevel(trafficUsage(vn, { quota: 2.2 * T })), 'warn')
  assert.equal(trafficLevel(trafficUsage(vn, { quota: 2 * T })), 'danger')
  assert.equal(trafficLevel(trafficUsage(vn, { quota: 100 * T })), 'ok')
  const late = trafficUsage({ ...vn, created: '2026-11-10' }, { quota: 4 * T })
  assert.equal(late.partial, true)
  assert.equal(late.since, '2026-11-10')
  assert.equal(trafficUsage({ ...vn, updated: '2026-11-10' }, {}).stale, true)
})

test('设置：存本机、按机器分开；填错了报错；额度填 0 就是不设', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-traffic-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeTrafficSettings('la', { quota: 4 * 1024 ** 4, resetDay: 28, mode: 'out' }, env)
  await writeTrafficSettings('hk', { resetDay: 5 }, env)
  const all = await readTrafficSettings(env)
  assert.deepEqual(all.la, { quota: 4 * 1024 ** 4, resetDay: 28, mode: 'out' })
  assert.deepEqual(all.hk, { resetDay: 5 })
  await writeTrafficSettings('la', { quota: 0 }, env)
  assert.equal((await readTrafficSettings(env)).la.quota, null)
  await assert.rejects(writeTrafficSettings('la', { resetDay: 32 }, env), /1 到 31|1 to 31/)
  await assert.rejects(writeTrafficSettings('la', { mode: 'both' }, env), /计费方式|counting/)
  await assert.rejects(writeTrafficSettings('la', { quota: -1 }, env), /月流量|allowance/)
})

const SAMPLE = 'priv=root\nhost=la\nos=Ubuntu 24.04\nuptime=100\ncores=1\nmemtotal=1000\nmemavailable=500\nnet=eth0|5000|6000\nvnstat=1\nvn_today=2026,11,13\nvn_ver=2\nvn_created=2026,10,01\nvn_updated=2026,11,13\nvn_day=2026,11,01,3298534883328,0\nvn_day=2026,11,13,0,549755813888'

test('状态页：用到 80% 以上进「需注意」；给 AI 的摘要里有本月流量', () => withLang('zh', () => {
  const data = parseStatus(SAMPLE)
  const j = judge(data, Date.now(), { traffic: { quota: 4 * 1024 ** 4, resetDay: 1 } })
  assert.equal(j.traffic.pct, 88)
  const item = j.attention.find((i) => i.type === 'traffic')
  assert.equal(item.level, 'warn')
  assert.match(statusBrief('la', data, j), /本月流量（2026-11-01 起，2026-12-01 重置）：已用 3584\.0 GB \/ 4096\.0 GB（88%）/)
  assert.ok(!judge(data, Date.now()).attention.some((i) => i.type === 'traffic'), '没填额度不进「需注意」')
  assert.equal(judge(parseStatus('priv=root\nnet=eth0|1|2')).traffic, null, '没装 vnstat')
}))

test('接口：设置存本机并带回状态；安装 vnstat 走远端任务、记审计', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-traffic-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: 'la', hosts: { la: {} } }, env)
  const scripts = []
  const runner = (_a, payload) => {
    scripts.push(payload)
    const nonce = /__DSH_BEGIN_([0-9a-f]+)__/.exec(payload)?.[1]
    if (!nonce) return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 })
    return Promise.resolve({ stdout: `__DSH_BEGIN_${nonce}__\nvnstat_install=ok\n__DSH_RC_${nonce}__=0\n`, stderr: '', exitCode: 0, durationMs: 5 })
  }
  const exact = new Map()
  const ws = { config: { host: '127.0.0.1', port: 3000 }, register({ path, handler }) { exact.set(path, handler); return () => exact.delete(path) } }
  const reg = registerRoutes({ webServer: ws }, { env, runner })
  const call = async (path, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', 'x-dsh-vps-token': reg.token, 'x-dsh-vps-lang': 'zh' }
    req.socket = { remoteAddress: '127.0.0.1' }
    const out = {}
    await exact.get(`/api-vps/${path}`)(req, { writeHead: (c) => { out.code = c }, end: (t) => { out.body = JSON.parse(t) } })
    return out.body
  }
  const saved = await call('status/traffic/settings', { alias: 'la', quota: 4 * 1024 ** 4, resetDay: 28, mode: 'sum' })
  assert.equal(saved.ok, true)
  assert.deepEqual((await readTrafficSettings(env)).la, { quota: 4 * 1024 ** 4, resetDay: 28, mode: 'sum' })
  const bad = await call('status/traffic/settings', { alias: 'la', resetDay: 40 })
  assert.equal(bad.ok, false)
  const installed = await call('status/traffic/install', { alias: 'la' })
  assert.equal(installed.ok, true, installed.error)
  assert.equal(installed.outcome, 'ok')
  const { readAudit } = await import('../lib/audit.js')
  await new Promise((r) => setTimeout(r, 50)) // 审计是顺手写的，不等它
  assert.ok((await readAudit({ env })).some((x) => x.action === 'install-vnstat'))
})

test('界面：装了 vnstat 时资源格子显示本月流量和重置日；「月流量」卡排在最前，有额度、重置日、计费方式；没装时给「安装 vnstat」', async () => {
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
  const { StatusView, termChrome } = exported.__test
  const render = (text, settings, alias) => {
    const data = parseStatus(text)
    const judged = judge(data, Date.now(), { traffic: settings })
    const view = withLang('zh', () => ({ alias, status: { collectedAt: new Date().toISOString(), data, judged, brief: statusBrief(alias, data, judged) }, trafficSettings: settings, interpretation: null, canInterpret: true }))
    return renderToStaticMarkup(React.createElement(StatusView, { entry: { sessionId: 's1', alias, statusState: { view, loading: false, error: '', expanded: true } }, c: termChrome('light'), maximized: true, visible: false }))
  }
  const html = render(SAMPLE, { quota: 4 * 1024 ** 4, resetDay: 1, mode: 'sum' }, 'la')
  assert.match(html, /本月流量/)
  assert.match(html, /3\.5 \/ 4\.0 TB|3584\.0 GB \/ 4096\.0 GB|3\.5 TB \/ 4\.0 TB/)
  assert.match(html, /12 月 1 日重置/)
  assert.ok(html.indexOf('>月流量<') < html.indexOf('>网络<'), '「月流量」排在最前')
  assert.match(html, /已用 .*（88%）/)
  for (const t of ['收发相加', '只算出站', '收发取大', '号重置', '设置只存在这台电脑上']) assert.ok(html.includes(t), t)
  const none = render('priv=root\nhost=hk\nnet=eth0|5000|6000', null, 'hk')
  assert.match(none, /网络（开机以来）/)
  assert.match(none, />安装 vnstat</)
})
