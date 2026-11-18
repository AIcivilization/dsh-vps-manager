// 「此刻网速」和「过去 24 小时」：网速读网卡计数器；曲线 = 服务器上 sysstat 记的 + 这台电脑看状态时记的
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeHosts } from '../lib/config.js'
import { withLang } from '../lib/i18n.js'
import { STATUS_SCRIPT, judge, parseStatus, statusBrief } from '../lib/status.js'
import { SYSSTAT_INSTALL_SCRIPT, TREND_SCRIPT, buildTrend, parseTrend, readSamples, recordSample } from '../lib/trend.js'
import { registerRoutes } from '../lib/routes.js'

// 2026-11-18 在 Ubuntu 24.04 容器里装 sysstat 12.6.1 实跑的 `LC_ALL=C S_TIME_FORMAT=ISO sar -u / -r / -n DEV`
const F = new URL('./fixtures/sar/', import.meta.url).pathname

/** 在本机的 bash 里跑那段脚本：sar、date、ip 换成假的，sa 目录指到测试数据 */
async function runScript() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-sar-'))
  await writeFile(join(dir, 'sa18'), '')
  const sh = `has_cmd() { return 0; }
ip() { echo "default via 1.1.1.1 dev eth0"; }
date() { case "$*" in *%z*) echo +0800;; *yesterday*) return 1;; *%Y-%m-%d*) echo 2026-11-18;; *%Y%m%d*) echo 20261118;; *%d*) echo 18;; esac; }
sar() { case "$*" in *-u*) cat ${F}u.txt;; *-r*) cat ${F}r.txt;; *DEV*) cat ${F}n.txt;; esac; }
${TREND_SCRIPT.replace('SA=/var/log/sysstat; [ -d "$SA" ] || SA=/var/log/sa', `SA=${dir}`)}`
  return execFileSync('bash', ['-c', sh]).toString()
}

test('脚本：不能有 JS 插值和反引号；sar 的 CPU、内存（按表头找列）、默认网卡的收发都读得出；时间带上服务器的时区', async () => {
  for (const s of [TREND_SCRIPT, SYSSTAT_INSTALL_SCRIPT]) {
    assert.ok(!s.includes('${'))
    assert.ok(!s.includes('`'))
  }
  assert.match(SYSSTAT_INSTALL_SCRIPT, /ENABLED="true"/, 'Debian、Ubuntu 装完默认不记，要打开')
  const p = parseTrend(await runScript())
  assert.equal(p.sar, true)
  const t0 = Date.parse('2026-11-18T09:10:29+08:00')
  assert.deepEqual(p.cpu, [[t0, 3.9], [t0 + 2000, 4.3], [t0 + 4000, 5.1]])
  assert.deepEqual(p.mem.map((x) => x[1]), [22.25, 21.42, 21.92])
  assert.deepEqual(p.net[1], [t0 + 2000, 2443.2 * 1024, 18.7 * 1024], '只要 eth0，不要 lo；kB/s 换成字节')
  assert.deepEqual(parseTrend('sar=0'), { sar: false, off: false, cpu: [], mem: [], net: [] })
  assert.equal(parseTrend('sar=1\nsar_off=1').off, true)
  assert.equal(parseTrend('sar=1\nsar_off=1\ntz=+0000\nsu=2026-11-18 00:10:01|3.2').off, false, '配置写着没开，但读到了记录：就是开着')
})

test('曲线：sar 的点和本机记的点合在一起，只取过去 24 小时；摘要里有现在、平均、最高和什么时候', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const sar = { cpu: [[now - 30 * 3600_000, 99], [now - 3600_000, 80], [now - 1800_000, 20]], mem: [], net: [[now - 3600_000, 1000, 50]] }
  const local = [{ t: now - 60_000, cpu: 10, mem: 40, disk: 30, rx: 2000, tx: 100 }, { t: now - 2 * 86_400_000, cpu: 100, mem: 1, rx: null, tx: null }]
  const tr = buildTrend({ sar, local, now })
  assert.deepEqual(tr.cpu.points.map((x) => x[1]), [80, 20, 10], '超过 24 小时的不要')
  assert.equal(tr.cpu.max, 80)
  assert.equal(tr.cpu.maxAt, now - 3600_000)
  assert.equal(tr.cpu.now, 10)
  assert.equal(tr.cpu.avg, 36.7)
  assert.deepEqual(tr.rx.points.map((x) => x[1]), [1000, 2000])
  assert.deepEqual(tr.sources, { sar: true, local: 1 })
})

test('本机记的点：每次看完状态记一个（CPU、内存、根分区、此刻网速），读的时候按时间过滤', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-trend-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  const data = parseStatus('priv=root\ncpu=12\nmemtotal=1000\nmemavailable=250\ndisk=/|100|60|40|60\nnet_rate=1250000|50000')
  await recordSample('la', data, '2026-11-18T10:00:00Z', env)
  await recordSample('la', data, '2026-11-18T11:00:00Z', env)
  const all = await readSamples('la', env)
  assert.deepEqual(all[0], { t: Date.parse('2026-11-18T10:00:00Z'), cpu: 12, mem: 75, disk: 60, rx: 1250000, tx: 50000 })
  assert.equal((await readSamples('la', env, Date.parse('2026-11-18T10:30:00Z'))).length, 1)
})

test('此刻网速：状态采集在算 CPU 的那 1 秒前后各读一次网卡计数；进了给 AI 的摘要', () => withLang('zh', () => {
  assert.match(STATUS_SCRIPT, /na=\$\(net_now\)\nsleep 1\n/)
  assert.match(STATUS_SCRIPT, /printf "net_rate=%d\|%d\\n"/)
  const data = parseStatus('priv=root\nnet_rate=1250000|50000')
  assert.deepEqual(data.netRate, { rx: 1250000, tx: 50000 })
  assert.match(statusBrief('la', data, judge(data)), /此刻网速：收 10\.0 Mbps，发 0\.4 Mbps/)
  assert.equal(parseStatus('priv=root').netRate, null)
}))

test('接口：读 sar 一次 SSH，10 分钟内不重复读；刷新才重读；装 sysstat 走远端任务', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-trend-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: 'la', hosts: { la: {} } }, env)
  const sarOut = await runScript()
  let ssh = 0
  const runner = (_a, payload) => {
    ssh += 1
    const nonce = /__DSH_BEGIN_([0-9a-f]+)__/.exec(payload)?.[1]
    const body = `${sarOut}\nsysstat_install=ok` // 任务模式下脚本是编码后传的，认不出是哪段：两种回答都给
    return Promise.resolve({ stdout: nonce ? `__DSH_BEGIN_${nonce}__\n${body}\n__DSH_RC_${nonce}__=0\n` : '', stderr: '', exitCode: 0, durationMs: 5 })
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
  const a = await call('status/trend/get', { alias: 'la' })
  assert.equal(a.ok, true, a.error)
  assert.deepEqual(a.sar, { installed: true, off: false })
  await call('status/trend/get', { alias: 'la' })
  assert.equal(ssh, 1, '10 分钟内不重复读')
  await call('status/trend/get', { alias: 'la', refresh: true })
  assert.equal(ssh, 2)
  const inst = await call('status/trend/install', { alias: 'la' })
  assert.equal(inst.outcome, 'ok')
})

test('界面：「过去 24 小时」排在「流量和到期」后面，三条曲线带摘要；没装 sysstat 给「安装 sysstat」；资源那排有「此刻网速」', async () => {
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
  const { StatusView, termChrome, trendStore } = exported.__test
  const render = (alias) => {
    const data = parseStatus('priv=root\nhost=la\nnet=eth0|1|2\nnet_rate=1250000|50000\nvnstat=1\nvn_today=2026,11,18\nvn_day=2026,11,18,100,200')
    const judged = judge(data)
    const view = withLang('zh', () => ({ alias, status: { collectedAt: new Date().toISOString(), data, judged, brief: statusBrief(alias, data, judged) }, interpretation: null, canInterpret: true }))
    return renderToStaticMarkup(React.createElement(StatusView, { entry: { sessionId: 's1', alias, statusState: { view, loading: false, error: '' } }, c: termChrome('light'), maximized: true, visible: false }))
  }
  const now = Date.now()
  const st = trendStore.of('la')
  Object.assign(st, { loaded: true, sar: { installed: true, off: false }, view: buildTrend({ sar: { cpu: [[now - 3600_000, 50], [now - 600_000, 10]], mem: [[now - 600_000, 40]], net: [[now - 600_000, 125000, 1000]] }, local: [], now }) })
  const html = render('la')
  assert.match(html, /此刻网速/)
  assert.match(html, /10\.0 Mbps/)
  assert.ok(html.indexOf('>流量和到期<') < html.indexOf('>过去 24 小时<') && html.indexOf('>过去 24 小时<') < html.indexOf('>网络<'))
  assert.match(html, /现在 10% · 平均 30% · 最高 50%/)
  assert.match(html, /服务器上的 sysstat 每 10 分钟记一次/)
  assert.match(html, /<path d="M[0-9.]+ [0-9.]+ M[0-9.]+ [0-9.]+"/, '两个点隔了 50 分钟：断开，不连线')
  assert.doesNotMatch(html, />安装 sysstat</)
  Object.assign(trendStore.of('hk'), { loaded: true, sar: { installed: false, off: false }, view: buildTrend({ sar: null, local: [], now }) })
  const none = render('hk')
  assert.match(none, />安装 sysstat</)
  assert.match(none, /还没有记录/)
  Object.assign(trendStore.of('jp'), { loaded: true, sar: { installed: true, off: true }, view: buildTrend({ sar: null, local: [], now }) })
  assert.match(render('jp'), />打开记录</)
})
