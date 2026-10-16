// 状态页的「网速」和「挑机器」卡片：在这台电脑上测（假的 curl、ping，不连网）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { paths, writeHosts } from '../lib/config.js'
import { withLang } from '../lib/i18n.js'
import { registerRoutes } from '../lib/routes.js'
import {
  SPEED_SERVER_SCRIPT, detectPaths, findTestFile, judgeCandidates, judgeSpeed, parseEntry, parsePing, runCandidates, runSpeed,
} from '../lib/speedtest.js'

const HAN = /[一-鿿]/
const HOME_IP = '111.52.67.201'
const VPS_IP = '209.146.116.150'
const NET = { platform: 'darwin', defaultIface: 'utun6', tun: true, iface: 'en0', proxy: 'http://127.0.0.1:1082' }

// curl -w 的输出：状态码 收 发 建连 TLS 准备好 首字节 总 IP
const line = ({ code = 200, down = 0, up = 0, connect = 0.05, app = 0.1, pre = 0.1, start = 0.17, total = 0.2 } = {}) => `${code} ${down} ${up} ${connect} ${app} ${pre} ${start} ${total} 1.2.3.4\n`

/**
 * 假的 curl 和 ping。opts：
 *   proxyMbps / directMbps   每个连接多快
 *   sameExit                 直连和走代理的出口一样（绕不开代理软件）
 *   portOpen                 临时端口连得上
 *   files                    { 地址: 有没有这个测试文件 }
 */
function fakeExec({ proxyMbps = 150, directMbps = 160, sameExit = false, portOpen = true, peers = [HOME_IP], pages = {}, files = {}, pingText } = {}) {
  const calls = []
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'ping') {
      const ip = args[args.length - 1]
      if (pingText) return { code: 0, stdout: pingText(ip), stderr: '' }
      return { code: 0, stdout: '10 packets transmitted, 10 packets received, 0.0% packet loss\nround-trip min/avg/max/stddev = 180.1/182.4/190.0/2.6 ms\n', stderr: '' }
    }
    const url = args[args.length - 1]
    const direct = args.includes('--interface')
    if (url.includes('/resolve?name=')) {
      const name = decodeURIComponent(/name=([^&]+)/.exec(url)[1])
      if (name.includes('nowhere')) return { code: 0, stdout: '{"Status":3}', stderr: '' }
      return { code: 0, stdout: JSON.stringify({ Answer: [{ type: 1, data: name.startsWith('lg.') ? '45.32.1.1' : '104.16.124.96' }] }), stderr: '' }
    }
    if (url.endsWith('/cdn-cgi/trace')) return { code: 0, stdout: direct && !sameExit ? `ip=${HOME_IP}\nloc=CN\n` : `ip=${VPS_IP}\nloc=US\n`, stderr: '' }
    if (url.startsWith('https://api.fast.com/')) return { code: 0, stdout: JSON.stringify({ targets: [{ url: 'https://oca1.example/speedtest?c=us' }, { url: 'https://oca2.example/speedtest?c=us' }] }), stderr: '' }
    const upload = args.includes('--data-binary')
    const speedTo = (mbps, seconds) => ({ down: (mbps * 1e6 * seconds) / 8, start: 0.2, total: 0.2 + seconds })
    if (url.includes('/range/0-0')) {
      if (upload) return { code: 0, stdout: line({ up: (40e6 * 6) / 8, pre: 0.2, total: 6.2 }), stderr: '' }
      return { code: 0, stdout: line({ app: 0.1, start: 0.168 }), stderr: '' }
    }
    if (url.includes('/range/')) return { code: 0, stdout: line(speedTo(proxyMbps, Number(args[args.indexOf('-m') + 1]))), stderr: '' }
    // VPS 上的临时测速服务
    if (/:\d+\/[a-f0-9]{32}\//.test(url)) {
      if (!portOpen) return { code: 28, stdout: line({ code: 0, connect: 0 }), stderr: '' }
      if (url.endsWith('/ping')) return { code: 0, stdout: line({ code: 204 }), stderr: '' }
      if (url.endsWith('/stats')) return { code: 0, stdout: JSON.stringify({ peers, out: 10000, retrans: 40 }), stderr: '' }
      if (url.endsWith('/stop')) return { code: 0, stdout: '', stderr: '' }
      if (upload) return { code: 0, stdout: line({ up: (90e6 * 6) / 8, pre: 0.2, total: 6.2 }), stderr: '' }
      return { code: 0, stdout: line(speedTo(directMbps, Number(args[args.indexOf('-m') + 1]))), stderr: '' }
    }
    // 挑机器：Looking Glass 页面和测试文件
    if (pages[url]) return { code: 0, stdout: pages[url], stderr: '' }
    if (url in files) return { code: 0, stdout: files[url] ? line(speedTo(files[url], Number(args[args.indexOf('-m') + 1]))) : line({ code: 404 }), stderr: '' }
    if (/^http:\/\/[^/]+:(80|443)\/$/.test(url)) return { code: 0, stdout: line({ code: 0, connect: 0.2 }), stderr: '' }
    return { code: 0, stdout: line({ code: 404 }), stderr: '' }
  }
  return { exec, calls }
}

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-speed-'))
  return { HOME: home, DSH_HOME: join(home, '.dsh') }
}

test('ping 的汇总行：macOS、Linux、Windows 三种写法；ICMP 被挡时只有丢包', () => {
  assert.deepEqual(parsePing('5 packets transmitted, 5 packets received, 0.0% packet loss\nround-trip min/avg/max/stddev = 24.810/25.744/27.886/1.096 ms'), { loss: 0, min: 25, avg: 26, jitter: 1 })
  assert.deepEqual(parsePing('10 packets transmitted, 9 received, 10% packet loss, time 1820ms\nrtt min/avg/max/mdev = 180.2/182.9/199.0/4.4 ms'), { loss: 10, min: 180, avg: 183, jitter: 4 })
  assert.deepEqual(parsePing('    Packets: Sent = 10, Received = 10, Lost = 0 (0% loss),\n    Minimum = 25ms, Maximum = 31ms, Average = 27ms'), { loss: 0, min: 25, avg: 27, jitter: 3 })
  assert.deepEqual(parsePing('10 packets transmitted, 0 packets received, 100.0% packet loss'), { loss: 100, min: null, avg: null, jitter: null })
})

test('看网络：Mac 上代理软件的隧道（utun）开着时，直连要绑物理网卡；系统代理地址读出来', async () => {
  const outputs = {
    'route -n get default': '   route to: default\n  interface: utun6\n',
    'ifconfig -l': 'lo0 gif0 en0 en1 utun6',
    'ifconfig en0': 'en0: flags=8863<UP>\n\tinet 192.168.50.97 netmask 0xffffff00\n\tstatus: active\n',
    'ifconfig en1': 'en1: flags=8863<UP>\n\tstatus: inactive\n',
    'scutil --proxy': '<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 1082\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 1082\n  HTTPSProxy : 127.0.0.1\n}',
  }
  const exec = async (cmd, args) => ({ code: 0, stdout: outputs[[cmd, ...args].join(' ')] ?? '', stderr: '' })
  assert.deepEqual(await detectPaths({ exec, platform: 'darwin' }), { platform: 'darwin', defaultIface: 'utun6', tun: true, iface: 'en0', proxy: 'http://127.0.0.1:1082' })
  const noTun = async (cmd, args) => ({ code: 0, stdout: [cmd, ...args].join(' ') === 'route -n get default' ? '  interface: en0\n' : outputs[[cmd, ...args].join(' ')] ?? '', stderr: '' })
  assert.equal((await detectPaths({ exec: noTun, platform: 'darwin' })).iface, null, '没开隧道时默认路由本来就是直连，不绑网卡')
})

test('测速：走代理用 fast.com 的服务器；直连这台临时开端口（只对你家 IP），测完关；核对来源确实是你家', async () => {
  const env = await sandbox()
  const { exec, calls } = fakeExec()
  const started = []
  const record = await runSpeed({
    alias: 'la', vpsHost: VPS_IP, allowPort: true, exec, net: NET, env,
    startServer: async (p) => { started.push(p); return { error: null, fw: 'ufw', ready: true } },
    sshStream: async () => assert.fail('端口连得上就不该退回 SSH'),
    vpsEgress: async () => 2400,
  })
  assert.deepEqual(record.home, { ip: HOME_IP, country: 'CN' })
  assert.equal(record.proxy.egress.ip, VPS_IP)
  assert.equal(record.proxy.multi.mbps, 900, '6 个连接 × 150')
  assert.equal(record.proxy.single.mbps, 150)
  assert.equal(record.proxy.upload.mbps, 40)
  assert.equal(record.proxy.latency.avg, 68)
  assert.equal(started.length, 1)
  assert.equal(started[0].home, HOME_IP, '防火墙只对你家的 IP 放行')
  assert.match(started[0].token, /^[a-f0-9]{32}$/)
  assert.equal(record.direct.via, 'port')
  assert.equal(record.direct.multi.mbps, 960)
  assert.equal(record.direct.retransPct, 0.4)
  assert.equal(record.vpsEgress, 2400)
  assert.ok(calls.some((c) => c[0] === 'curl' && c[c.length - 1].endsWith('/stop')), '测完要请服务停下')
  // 直连的请求都绑了物理网卡、去掉了代理；走代理的没绑
  for (const c of calls.filter((x) => x[0] === 'curl' && /:\d+\/[a-f0-9]{32}\//.test(x[x.length - 1]))) {
    assert.ok(c.includes('--interface') && c.includes('en0') && c.includes('--noproxy'), c.join(' '))
  }
  assert.ok(calls.filter((x) => x[0] === 'curl' && x[x.length - 1].includes('/range/')).every((c) => !c.includes('--interface')))
  await withLang('zh', async () => {
    const j = judgeSpeed(record, { broadband: 1000 })
    assert.equal(j.headline.level, 'ok')
    assert.equal(j.headline.text, '满速 · 900 Mbps，宽带的 90%')
    assert.deepEqual(j.usage.map((u) => `${u.id}:${u.level}`), ['8k:ok', '4k:ok', 'call:ok', 'game:warn'])
    assert.equal(j.rows[1].down, 960)
    assert.match(j.detail, /直连时服务器上的 TCP 重传 0\.4%/)
    assert.match(j.detail, /临时端口 \d+，防火墙：ufw（测完已撤掉）/)
  })
  await withLang('en', async () => {
    const j = judgeSpeed(record, { broadband: 1000 })
    assert.doesNotMatch(`${j.headline.text} ${j.detail} ${j.notes.map((n) => n.text).join(' ')} ${j.usage.map((u) => u.label + u.note).join(' ')}`, HAN)
  })
})

test('测速：没同意就不开端口；端口被安全组挡住退回经 SSH 测；绕不开代理软件时直连不测', async () => {
  const env = await sandbox()
  const noConsent = await runSpeed({ alias: 'la', vpsHost: VPS_IP, allowPort: false, exec: fakeExec().exec, net: NET, env, startServer: async () => assert.fail('没同意不能开端口') })
  assert.equal(noConsent.direct.skipped, 'consent')
  assert.equal(noConsent.direct.ping.avg, 182, '直连 ping 照样测')

  const blocked = await runSpeed({
    alias: 'la', vpsHost: VPS_IP, allowPort: true, exec: fakeExec({ portOpen: false }).exec, net: NET, env,
    startServer: async () => ({ error: null, fw: 'none', ready: true }),
    sshStream: async (seconds, conns) => ({ mbps: 420, bytes: 400e6, conns }),
  })
  assert.equal(blocked.direct.via, 'ssh')
  assert.equal(blocked.direct.multi.mbps, 420)
  await withLang('zh', () => assert.ok(judgeSpeed(blocked, { broadband: 1000 }).notes.some((n) => /经 SSH 测的.*会偏低/.test(n.text))))

  const same = await runSpeed({ alias: 'la', vpsHost: VPS_IP, allowPort: true, exec: fakeExec({ sameExit: true }).exec, net: NET, env, startServer: async () => assert.fail('绕不开代理就别开端口') })
  assert.equal(same.direct.skipped, 'bypass')
  await withLang('zh', () => assert.ok(judgeSpeed(same, {}).notes.some((n) => /没能绕开这台电脑上的代理软件/.test(n.text))))
})

test('判断：代理比直连慢很多 → 协议或 CPU；出口不是这台要说；"直连"绕到代理上要说；晚上和白天比', async () => {
  await withLang('zh', async () => {
    const base = { vpsIp: VPS_IP, home: { ip: HOME_IP }, proxy: { egress: { ip: VPS_IP }, multi: { mbps: 120 }, single: { mbps: 40 }, latency: { avg: 70, jitter: 3 } }, direct: { via: 'port', multi: { mbps: 880 } } }
    const slow = judgeSpeed(base, { broadband: 1000 })
    assert.equal(slow.headline.level, 'danger')
    assert.equal(slow.headline.text, '慢 · 120 Mbps，宽带的 12%')
    assert.ok(slow.notes.some((n) => /走代理（120）比直连（880）慢很多：多半是代理协议或 VPS 的 CPU/.test(n.text)))
    const elsewhere = judgeSpeed({ ...base, proxy: { ...base.proxy, egress: { ip: '5.6.7.8' } } }, { broadband: 1000 })
    assert.ok(elsewhere.notes.some((n) => /出口是 5\.6\.7\.8，不是这台/.test(n.text)))
    const leaked = judgeSpeed({ ...base, direct: { via: 'proxy', multi: { mbps: 100 } } }, { broadband: 1000 })
    assert.ok(leaked.notes.some((n) => /直连.*绕到了代理上/.test(n.text)))
    const at = (h, mbps) => ({ at: new Date(2026, 9, 10, h).toISOString(), proxy: { multi: { mbps } } })
    const hist = judgeSpeed(base, { broadband: 1000, history: [at(10, 900), at(14, 860), at(21, 400), at(22, 420)] })
    assert.ok(hist.notes.some((n) => /晚上（7～11 点）平均 410 Mbps，比白天的 880 慢 53%/.test(n.text)), hist.notes.map((n) => n.text).join(' | '))
    const unknownPlan = judgeSpeed(base, {})
    assert.equal(unknownPlan.headline.text, '120 Mbps', '没填签约带宽就不算百分比')
  })
})

test('挑机器：Looking Glass 页面里自动找测试文件；只填 IP 的试几个常见文件名；查不到的域名照实说', async () => {
  const page = 'https://lg.fast-vps.example/'
  const { exec } = fakeExec({
    pages: { [page]: '<a href="/files/1GB.test">1 GB</a> <a href="/files/100MB.test">100 MB</a>' },
    files: { 'https://lg.fast-vps.example/files/100MB.test': 300, 'http://198.51.100.7/100MB.test': 0, 'http://198.51.100.7/100mb.test': 0, 'http://198.51.100.7/100MB.bin': 0, 'http://198.51.100.7/100mb.bin': 0 },
    pingText: (ip) => (ip === '45.32.1.1'
      ? '10 packets transmitted, 10 packets received, 0.0% packet loss\nround-trip min/avg/max/stddev = 150.0/152.0/160.0/2.0 ms'
      : '10 packets transmitted, 10 packets received, 0.0% packet loss\nround-trip min/avg/max/stddev = 200.0/205.0/220.0/5.0 ms'),
  })
  const run = await runCandidates({ entries: [page, '198.51.100.7', 'nowhere.invalid'], reference: { label: 'la（现在用的）', host: VPS_IP }, exec, net: NET })
  assert.equal(run.results[0].file, 'https://lg.fast-vps.example/files/100MB.test', '优先 100MB 的')
  assert.equal(run.results[0].down.mbps, 1200, '4 个连接 × 300')
  assert.equal(run.results[1].file, null)
  assert.equal(run.results[2].error, 'resolve')
  assert.equal(run.reference.ping.avg, 205)
  assert.equal(run.bypass, true)
  await withLang('zh', async () => {
    const j = judgeCandidates(run)
    assert.equal(j.best, page)
    assert.equal(j.verdict, '推荐 lg.fast-vps.example：延迟最低（152 ms）')
    assert.equal(j.rows[2].error, '查不到这个域名')
    assert.match(j.hints.join(' '), /只填 IP 的测不了下载速度/)
    assert.deepEqual(j.reference, { label: 'la（现在用的）', latency: 205, loss: 0 })
  })
  assert.deepEqual(parseEntry(' https://lg.x.example/100MB.test '), { input: 'https://lg.x.example/100MB.test', host: 'lg.x.example', page: null, file: 'https://lg.x.example/100MB.test' })
  assert.equal(parseEntry('a b'), null)
  assert.equal(findTestFile('<a href="x.html">x</a>', page), null)
})

test('VPS 上的临时测速服务：ufw 开着就只对你家 IP 放行；服务退出后自动撤掉规则、删掉临时文件', { skip: process.platform === 'win32' && '要用 sh 跑脚本' }, async () => {
  assert.doesNotMatch(SPEED_SERVER_SCRIPT, /\$\{/, '脚本是 JS 模板字符串，不能有「美元符 + 左花括号」')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-speedsrv-'))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  const log = join(dir, 'calls.log')
  const fake = async (name, body) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`)
    await chmod(join(bin, name), 0o755)
  }
  await fake('ufw', `echo "ufw $*" >> "${log}"; [ "$1" = status ] && echo "Status: active"; exit 0`)
  await fake('python3', `echo "python3 $*" >> "${log}"; sleep 0.3`)
  await fake('timeout', 'shift; "$@"')
  await fake('ss', 'echo "LISTEN 0 128 0.0.0.0:23456 0.0.0.0:*"')
  const prelude = 'has_cmd() { command -v "$1" >/dev/null 2>&1; }\nSUDO=""\n'
  const params = "P_PORT='23456'\nP_TOKEN='0123456789abcdef0123456789abcdef'\nP_HOME='111.52.67.201'\nP_SECS='120'\n"
  const { stdout } = await promisify(execFile)('sh', ['-c', `${prelude}${params}${SPEED_SERVER_SCRIPT}`], { env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}` }, timeout: 20_000 })
  assert.match(stdout, /speed_fw=ufw/)
  assert.match(stdout, /speed_ready=1/)
  await new Promise((r) => setTimeout(r, 1500)) // 等后台的测速服务（假的，0.3 秒）退出、撤规则
  const calls = await readFile(log, 'utf8')
  assert.match(calls, /ufw allow from 111\.52\.67\.201 to any port 23456 proto tcp comment dsh-vps-speedtest/)
  assert.match(calls, /python3 .*speedtest\/server\.py 23456 0123456789abcdef0123456789abcdef/)
  assert.match(calls, /ufw delete allow from 111\.52\.67\.201 to any port 23456 proto tcp/, '服务退出后要撤掉规则')
  await assert.rejects(readFile(join(dir, '.cache/dsh-vps/speedtest/server.py')), '临时文件要删掉')
})

// —— 接口 ——

test('接口：签约带宽和"同意临时开端口"记在本机；挑机器的地址和结果存着，下次打开还在', async () => {
  const env = await sandbox()
  await writeHosts({ current: 'la', hosts: { la: {} } }, env)
  const exact = new Map()
  const ws = { config: { host: '127.0.0.1', port: 3000 }, register({ path, handler }) { exact.set(path, handler); return () => exact.delete(path) } }
  let tasks = 0
  const runner = (_a, payload) => {
    const nonce = /__DSH_BEGIN_([0-9a-f]+)__/.exec(payload)[1]
    const isTask = payload.includes('meta.json') // 远端任务才写 meta.json（脚本本身是 base64 编码的，看不到名字）
    if (isTask) tasks += 1
    const body = isTask ? `__DSH_TASK_${nonce}__=t1\nspeed_fw=ufw\nspeed_ready=1` : 'egress_mbps=2400'
    return Promise.resolve({ stdout: `__DSH_BEGIN_${nonce}__\n${body}\n__DSH_RC_${nonce}__=0\n`, stderr: '', exitCode: 0, durationMs: 5 })
  }
  const { exec } = fakeExec()
  const reg = registerRoutes({ webServer: ws }, { env, runner, speedExec: exec, speedNet: NET, resolve: async () => ({ hostname: VPS_IP, port: 22 }) })
  const call = async (path, body, lang = 'zh') => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', 'x-dsh-vps-token': reg.token, 'x-dsh-vps-lang': lang }
    req.socket = { remoteAddress: '127.0.0.1' }
    const out = {}
    await exact.get(`/api-vps/${path}`)(req, { writeHead: () => {}, end: (t) => { out.body = JSON.parse(t) } })
    return out.body
  }
  const before = await call('status/speed/get', { alias: 'la' })
  assert.deepEqual([before.speed, before.broadband, before.consent], [null, null, false])
  const first = await call('status/speed/run', { alias: 'la', broadband: 1000 })
  assert.equal(tasks, 0, '没同意就不开端口')
  assert.equal(first.broadband, 1000)
  assert.equal(first.speed.headline.text, '满速 · 900 Mbps，宽带的 90%')
  const second = await call('status/speed/run', { alias: 'la', allowPort: true })
  assert.equal(tasks, 1, '同意了才开（走远端任务）')
  assert.equal(second.consent, true)
  assert.equal(second.speed.rows[1].down, 960)
  const auditDir = paths(env).auditDir
  const audit = (await Promise.all((await readdir(auditDir)).map((f) => readFile(join(auditDir, f), 'utf8')))).join('')
  assert.match(audit, /"action":"speedtest"/, '开端口要记审计')
  assert.match(audit, /只对 111\.52\.67\.201 放行/)

  assert.deepEqual((await call('speed/candidates/get', {})).entries, [])
  await call('speed/candidates/save', { entries: [' 1.1.1.1 ', '', 'lg.example.com'] })
  assert.deepEqual((await call('speed/candidates/get', {})).entries, ['1.1.1.1', 'lg.example.com'])
  const ran = await call('speed/candidates/run', { entries: ['198.51.100.7'], alias: 'la' })
  assert.equal(ran.view.rows[0].latency, 182)
  assert.equal(ran.view.reference.label, 'la（现在用的）')
  const again = await call('speed/candidates/get', {})
  assert.deepEqual(again.entries, ['198.51.100.7'])
  assert.equal(again.view.rows.length, 1)
  assert.equal((await call('speed/candidates/run', { entries: [] })).ok, false)
})
