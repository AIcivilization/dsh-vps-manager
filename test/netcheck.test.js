// 状态页的「网络」卡片（网络体检第一步）：国内连不连得上、AI 和流媒体能不能用、IP 干不干净
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { writeHosts } from '../lib/config.js'
import { withLang } from '../lib/i18n.js'
import { NET_SCRIPT, checkChina, judgeNet, netText, parseNet, portsToProbe, privateAddress } from '../lib/netcheck.js'
import { registerRoutes } from '../lib/routes.js'
import { registerCommands } from '../lib/commands.js'

const HAN = /[\u4e00-\u9fff]/

// —— 脚本输出的样本（照 2026-10-15 实测的格式）——
const US = [
  'cf=200|https://www.cloudflare.com/cdn-cgi/trace|US|209.146.116.150',
  'oai_trace=200|https://chatgpt.com/cdn-cgi/trace|US',
  'oai=401|https://api.openai.com/v1/models|',
  'ant=401|https://api.anthropic.com/v1/models|',
  'yt=200|https://www.youtube.com/premium|US|',
  'nf1=200|https://www.netflix.com/title/81280792|US',
  'nf2=200|https://www.netflix.com/title/70143836',
  'dis=200|https://www.disneyplus.com/|us',
  'ipinfo=200|https://ipinfo.io/json|US|AS46783 EASY LINK LLC',
  'ipapi=200|http://ip-api.com/json/?fields=countryCode,as,hosting|US|false|AS46783 EASY LINK LLC',
  'dnsbl=bl.spamcop.net|',
  'dnsbl=zen.spamhaus.org|127.255.255.254',
].join('\n')
const HK = [
  'cf=200|https://www.cloudflare.com/cdn-cgi/trace|HK|103.73.67.92',
  'oai_trace=200|https://chatgpt.com/cdn-cgi/trace|HK',
  'oai=403|https://api.openai.com/v1/models|unsupported_country_region_territory',
  'ant=403|https://api.anthropic.com/v1/models|Request not allowed',
  'yt=200|https://www.youtube.com/premium|HK|',
  'nf1=200|https://www.netflix.com/title/81280792|HK',
  'nf2=404|https://www.netflix.com/title/70143836',
  'dis=200|https://www.disneyplus.com/zh-hk|hk',
  'ipinfo=200|https://ipinfo.io/json|HK|AS60068 Datacamp Limited',
  'ipapi=200|http://ip-api.com/json/?fields=countryCode,as,hosting|HK|true|AS60068 Datacamp Limited',
].join('\n')

const china = (ports) => ({ target: '203.0.113.10', ports })
const cnAll = (ok = true) => [
  { isp: 'telecom', city: 'Guangzhou', ok, ms: ok ? 180 : null },
  { isp: 'telecom', city: 'Nanjing', ok, ms: ok ? 220 : null },
  { isp: 'unicom', city: 'Shanghai', ok, ms: ok ? 210 : null },
  { isp: 'mobile', city: 'Beijing', ok, ms: ok ? 60 : null },
]
const abroadAll = (ok = true) => [{ country: 'US', city: 'Buffalo', ok, ms: 16 }, { country: 'JP', city: 'Tokyo', ok, ms: 2 }, { country: 'DE', city: 'Falkenstein', ok, ms: 6 }]
const item = (j, id) => j.items.find((i) => i.id === id)

test('判断：美国这台全都能用；结论是人话，数字收进细节；英文界面没有汉字', async () => {
  const data = parseNet(US)
  const ch = china([{ port: 22, cn: cnAll(), abroad: abroadAll() }, { port: 443, cn: cnAll(), abroad: abroadAll() }])
  await withLang('zh', async () => {
    const j = judgeNet(data, ch)
    assert.equal(j.worst, 'ok')
    assert.deepEqual(j.items.map((i) => i.id), ['china', 'chatgpt', 'claude', 'gemini', 'google', 'youtube', 'netflix', 'disney', 'ip'])
    assert.equal(item(j, 'china').text, '电信、联通、移动都能连（端口 22、443）')
    assert.match(item(j, 'china').detail, /端口 22：国内 电信（Guangzhou） 通 180 ms/)
    assert.match(item(j, 'china').detail, /会把服务器地址交给它/, '要说清楚用了公共探测网络')
    assert.equal(item(j, 'chatgpt').text, '能用（OpenAI 认为你在美国）')
    assert.equal(item(j, 'gemini').text, '能用（按谷歌认为你在美国推断）')
    assert.equal(item(j, 'netflix').text, '能看全部片库（美国区）')
    assert.equal(item(j, 'ip').text, '各家网站都认为你在美国；不是机房 IP，看流媒体更容易；没上主要的垃圾邮件黑名单')
    assert.match(item(j, 'ip').detail, /209\.146\.116\.150 · AS46783/)
  })
  await withLang('en', async () => {
    const j = judgeNet(data, ch)
    for (const i of j.items) {
      assert.doesNotMatch(`${i.title} ${i.text} ${i.detail ?? ''}`, HAN, `${i.id}：${i.text}`)
    }
    assert.equal(item(j, 'china').text, 'Reachable from China Telecom, Unicom and Mobile (ports 22, 443)')
  })
})

test('判断：香港这台——OpenAI、Claude、Gemini 不支持；Netflix 只能看自制剧；机房 IP 说清楚影响', async () => {
  await withLang('zh', async () => {
    const j = judgeNet(parseNet(HK), null)
    assert.equal(item(j, 'chatgpt').level, 'danger')
    assert.equal(item(j, 'chatgpt').text, '不支持这个地区（OpenAI 认为你在香港）')
    assert.equal(item(j, 'claude').level, 'danger')
    assert.equal(item(j, 'gemini').text, '不支持：谷歌认为你在香港')
    assert.equal(item(j, 'google').text, '香港，和其他网站一致')
    assert.equal(item(j, 'netflix').level, 'warn')
    assert.equal(item(j, 'netflix').text, '只能看自制剧（香港区）')
    assert.equal(item(j, 'disney').text, '能用（香港区）')
    assert.match(item(j, 'ip').text, /是机房 IP（大多数 VPS 都是）：ChatGPT 一般没问题，部分流媒体会限制/)
    assert.equal(item(j, 'china').level, 'na', '没测国内就照实说没测')
    assert.equal(j.worst, 'danger')
  })
})

test('判断：谷歌认为在中国大陆（送中）单独报；各家看法不一致就是"广播 IP"；Disney+ 跳到 unavailable 就是不能用', async () => {
  const out = US
    .replace('yt=200|https://www.youtube.com/premium|US|', 'yt=200|https://www.youtube.com/premium|CN|is not available in your country')
    .replace('dis=200|https://www.disneyplus.com/|us', 'dis=200|https://www.disneyplus.com/unavailable|')
  await withLang('zh', async () => {
    const j = judgeNet(parseNet(out), null)
    assert.equal(item(j, 'google').level, 'danger')
    assert.match(item(j, 'google').text, /谷歌认为你在中国大陆（俗称"送中"）/)
    assert.equal(item(j, 'gemini').level, 'danger')
    assert.equal(item(j, 'youtube').level, 'warn')
    assert.equal(item(j, 'disney').text, '这个地区不能用')
    assert.equal(item(j, 'ip').level, 'warn')
    assert.match(item(j, 'ip').text, /各家看法不一致（俗称"广播 IP"）.*谷歌 → 中国大陆/)
  })
})

test('判断：上了黑名单只算"要注意"并说清影响；查不了的不当成问题；连不上的网站说"说不准"，不硬猜', async () => {
  const out = `${US}\ndnsbl=dnsbl-1.uceprotect.net|127.0.0.2`.replace('oai=401|https://api.openai.com/v1/models|', 'oai=000||')
  await withLang('zh', async () => {
    const j = judgeNet(parseNet(out), null)
    assert.equal(item(j, 'ip').level, 'warn')
    assert.match(item(j, 'ip').text, /上了 dnsbl-1\.uceprotect\.net 黑名单：影响发邮件，一般不影响上网/)
    assert.doesNotMatch(item(j, 'ip').text, /spamhaus/, 'Spamhaus 拒绝查询（127.255.255.x）不算上榜')
    assert.equal(item(j, 'chatgpt').level, 'na')
    assert.equal(item(j, 'chatgpt').text, '连不上 OpenAI，这次说不准')
  })
})

test('判断：服务器上没有 curl、SSH 连不上时，各项照实说没测，国内连通照样给结论', async () => {
  await withLang('zh', async () => {
    const noCurl = judgeNet(parseNet('nocurl=1'), null)
    assert.ok(noCurl.items.slice(1).every((i) => i.level === 'na' && /没有 curl/.test(i.text)))
    const ssh = judgeNet({ sshFailed: '连接超时' }, china([{ port: 22, cn: cnAll(false), abroad: abroadAll() }]))
    assert.equal(item(ssh, 'china').level, 'danger', 'SSH 连不上时，国内连通正好能说明是不是被墙了')
    assert.match(item(ssh, 'chatgpt').text, /连不上服务器，这几项没测：连接超时/)
  })
})

test('国内能不能连：只封了一个端口、整个被墙、端口没开、某家运营商连不上，各说各的', async () => {
  await withLang('zh', async () => {
    const one = judgeNet(parseNet(US), china([{ port: 22, cn: cnAll(), abroad: abroadAll() }, { port: 443, cn: cnAll(false), abroad: abroadAll() }]))
    assert.equal(item(one, 'china').level, 'danger')
    assert.equal(item(one, 'china').text, '端口 443 在国内被封了，端口 22 国内能连')
    const all = judgeNet(parseNet(US), china([{ port: 22, cn: cnAll(false), abroad: abroadAll() }, { port: 443, cn: cnAll(false), abroad: abroadAll() }]))
    assert.equal(item(all, 'china').text, '国内连不上、国外能连：这台在国内被墙了（试了端口 22、443）')
    const closed = judgeNet(parseNet(US), china([{ port: 8443, cn: cnAll(false), abroad: abroadAll(false) }]))
    assert.equal(item(closed, 'china').level, 'warn')
    assert.match(item(closed, 'china').text, /国内国外都连不上（端口 8443）：多半是端口没开或被防火墙挡了，不是墙的问题/)
    const mobile = cnAll().map((x) => (x.isp === 'mobile' ? { ...x, ok: false } : x))
    const partial = judgeNet(parseNet(US), china([{ port: 22, cn: mobile, abroad: abroadAll() }]))
    assert.equal(item(partial, 'china').level, 'warn')
    assert.equal(item(partial, 'china').text, '移动连不上（端口 22），其他运营商能连')
    const rate = judgeNet(parseNet(US), { error: 'rate' })
    assert.match(item(rate, 'china').text, /额度用完了（每小时 250 次）/)
  })
})

test('国内能不能连：请 Globalping 从国内三家运营商和国外节点用 TCP 连；额度用完、内网地址不硬测', async () => {
  const posts = []
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      posts.push(body)
      return { ok: true, status: 202, json: async () => ({ id: `m${body.measurementOptions.port}` }) }
    }
    const port = Number(url.split('/m').pop())
    const probe = (country, network, city, ok) => ({ probe: { country, network, city }, result: { status: 'finished', stats: { rcv: ok ? 2 : 0, avg: ok ? 40 : null, loss: ok ? 0 : 100 } } })
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'finished', results: [
        probe('CN', 'Chinanet Backbone', 'Guangzhou', port === 22),
        probe('CN', 'CHINA UNICOM China169 Backbone', 'Wuhan', port === 22),
        probe('CN', 'China Mobile Communications Group', 'Kunming', port === 22),
        probe('US', 'HostPapa', 'Buffalo', true),
      ] }),
    }
  }
  const res = await checkChina({ hostname: '203.0.113.10', ports: [22, 443], fetchImpl, sleep: async () => {} })
  assert.equal(posts.length, 2)
  assert.equal(posts[0].type, 'ping')
  assert.deepEqual(posts[0].measurementOptions, { packets: 2, protocol: 'TCP', port: 22 })
  assert.ok(posts[0].locations.some((l) => l.country === 'CN' && l.magic === 'China Mobile'), '要点名三家运营商')
  assert.deepEqual(res.ports.map((p) => [p.port, p.cn.map((x) => `${x.isp}:${x.ok}`).join(','), p.abroad.length]), [
    [22, 'telecom:true,unicom:true,mobile:true', 1],
    [443, 'telecom:false,unicom:false,mobile:false', 1],
  ])
  assert.deepEqual(await checkChina({ hostname: '203.0.113.10', ports: [22], fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) }), { error: 'rate', target: '203.0.113.10' })
  assert.deepEqual(await checkChina({ hostname: '192.168.1.9', ports: [22], fetchImpl }), { skipped: 'private', target: '192.168.1.9' })
  assert.equal(privateAddress('10.0.0.5'), true)
  assert.equal(privateAddress('100.100.1.1'), true, 'CGNAT / Tailscale 的地址也连不到')
  assert.equal(privateAddress('209.146.116.150'), false)
})

test('要测的端口：SSH 端口在前，再加上次状态页看到的对外端口（先 443、80），最多 3 个；只在本机监听的不测', () => {
  const data = { ports: [{ port: 8443 }, { port: 3000, local: true }, { port: 80 }, { port: 443 }, { port: 2222 }] }
  assert.deepEqual(portsToProbe(2222, data), [2222, 443, 80])
  assert.deepEqual(portsToProbe(22, null), [22])
})

test('VPS 上的脚本：真跑一遍（假的 curl、getent），只回状态码和标记，解析得出来', { skip: process.platform === 'win32' && '要用 sh 跑脚本' }, async () => {
  assert.doesNotMatch(NET_SCRIPT, /\$\{/, '脚本是 JS 模板字符串，不能有「美元符 + 左花括号」')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-net-'))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  // 假 curl：按地址写正文，按 -w 打出「状态码|地址」
  await writeFile(join(bin, 'curl'), `#!/bin/sh
out=''; url=''
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -w|-A|-m|--max-redirs) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
code=200
case "$url" in
  *cloudflare.com/cdn-cgi/trace) printf 'fl=1\\nip=203.0.113.10\\nloc=US\\n' > "$out" ;;
  *chatgpt.com/cdn-cgi/trace) printf 'loc=US\\n' > "$out" ;;
  *api.openai.com*) code=401; printf '{"error":{"message":"Missing bearer authentication in header"}}' > "$out" ;;
  *api.anthropic.com*) code=401; printf '{"type":"error","error":{"type":"authentication_error"}}' > "$out" ;;
  *youtube.com/premium) printf 'x "INNERTUBE_CONTEXT_GL":"US" y' > "$out" ;;
  *title/81280792) printf 'a "country":"US" b' > "$out" ;;
  *title/70143836) code=404; printf 'not found' > "$out" ;;
  *disneyplus.com*) printf 'z "region":"us" z' > "$out" ;;
  *ipinfo.io*) printf '{\\n  "country": "US",\\n  "org": "AS64500 Example Net"\\n}' > "$out" ;;
  *ip-api.com*) printf '{"countryCode":"US","as":"AS64500 Example Net","hosting":true}' > "$out" ;;
  *) code=000 ;;
esac
printf '%s|%s' "$code" "$url"
`)
  // 假 getent：只有 spamcop 说上榜
  await writeFile(join(bin, 'getent'), `#!/bin/sh
case "$2" in *spamcop*) echo "127.0.0.2 $2" ;; *) exit 2 ;; esac
`)
  await chmod(join(bin, 'curl'), 0o755)
  await chmod(join(bin, 'getent'), 0o755)
  const script = `has_cmd() { command -v "$1" >/dev/null 2>&1; }\n${NET_SCRIPT}`
  const { stdout } = await promisify(execFile)('sh', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 60_000 })
  const d = parseNet(stdout)
  assert.equal(d.cloudflare.ip, '203.0.113.10')
  assert.equal(d.openai.code, 401)
  assert.equal(d.google.country, 'US')
  assert.deepEqual([d.netflix.original, d.netflix.licensed, d.netflix.country], [200, 404, 'US'])
  assert.equal(d.disney.region, 'US')
  assert.deepEqual([d.ipinfo.country, d.ipinfo.org], ['US', 'AS64500 Example Net'])
  assert.deepEqual([d.ipapi.hosting, d.ipapi.as], [true, 'AS64500 Example Net'])
  assert.deepEqual(d.dnsbl.find((b) => b.zone === 'bl.spamcop.net'), { zone: 'bl.spamcop.net', answer: '127.0.0.2' })
  assert.deepEqual(d.dnsbl.find((b) => b.zone === 'zen.spamhaus.org'), { zone: 'zen.spamhaus.org', answer: '' })
})

// —— 接口与命令 ——

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-netroute-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: 'la', hosts: { la: {} } }, env)
  let ssh = 0
  const runner = (_a, payload) => {
    ssh += 1
    const nonce = /__DSH_BEGIN_([0-9a-f]+)__/.exec(payload)[1]
    return Promise.resolve({ stdout: `__DSH_BEGIN_${nonce}__\n${US}\n__DSH_RC_${nonce}__=0\n`, stderr: '', exitCode: 0, durationMs: 5 })
  }
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST') return { ok: true, status: 202, json: async () => ({ id: 'm1' }) }
    return { ok: true, status: 200, json: async () => ({ status: 'finished', results: [
      { probe: { country: 'CN', network: 'Chinanet Backbone', city: 'Guangzhou' }, result: { stats: { rcv: 2, avg: 180 } } },
      { probe: { country: 'CN', network: 'China Unicom', city: 'Wuhan' }, result: { stats: { rcv: 2, avg: 200 } } },
      { probe: { country: 'CN', network: 'China Mobile', city: 'Beijing' }, result: { stats: { rcv: 2, avg: 60 } } },
    ] }) }
  }
  const deps = { env, runner, fetchImpl, netSleep: async () => {}, resolve: async () => ({ hostname: '209.146.116.150', port: 22, proxyJump: '' }) }
  return { env, deps, ssh: () => ssh }
}

test('接口：体检一次存本机（另存一份历史，超过 90 天的删掉）；读的时候按界面语言现拼；两边同时点只测一次', async () => {
  const { env, deps, ssh } = await sandbox()
  const old = join(env.DSH_HOME, 'vps-manager', 'net', 'la')
  await mkdir(old, { recursive: true })
  await writeFile(join(old, '2025-01-01T00-00-00-000Z.json'), '{}')
  const exact = new Map()
  const ws = { config: { host: '127.0.0.1', port: 3000 }, register({ path, handler }) { exact.set(path, handler); return () => exact.delete(path) } }
  const reg = registerRoutes({ webServer: ws }, deps)
  const call = async (path, body, lang = 'zh') => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', 'x-dsh-vps-token': reg.token, 'x-dsh-vps-lang': lang }
    req.socket = { remoteAddress: '127.0.0.1' }
    const out = {}
    await exact.get(`/api-vps/${path}`)(req, { writeHead: (c) => { out.code = c }, end: (t) => { out.body = JSON.parse(t) } })
    return out.body
  }
  assert.equal((await call('status/net/get', { alias: 'la' })).net, null, '没体检过就是空的')
  const [a, b] = await Promise.all([call('status/net/check', { alias: 'la' }), call('status/net/check', { alias: 'la' })])
  assert.equal(ssh(), 1, '同一台同时只跑一次')
  assert.equal(a.ok, true)
  assert.deepEqual(a.net.items.map((i) => i.level), b.net.items.map((i) => i.level))
  assert.equal(a.net.items.find((i) => i.id === 'china').text, '电信、联通、移动都能连（端口 22）')
  const en = await call('status/net/get', { alias: 'la' }, 'en')
  assert.equal(en.net.items.find((i) => i.id === 'chatgpt').text, 'Available (OpenAI places you in the US)')
  const files = await readdir(old)
  assert.ok(files.includes('latest.json'))
  assert.ok(files.some((f) => /^20\d\d-.*\.json$/.test(f) && !f.startsWith('2025-01-01')), '这次的另存了一份')
  assert.ok(!files.includes('2025-01-01T00-00-00-000Z.json'), '超过 90 天的删掉')
  await assert.rejects(call('status/net/check', { alias: 'nope' }).then((r) => { if (!r.ok) throw new Error(r.error) }), /没有登记过这台机器/)
})

test('命令：/vps-netcheck 一项一行，前面一个记号；在 /vps-help 的「看信息」里', async () => {
  const { deps } = await sandbox()
  const registered = []
  registerCommands({ commands: { register: (def) => { registered.push(def); return () => {} } } }, deps)
  const res = await withLang('zh', () => registered.find((c) => c.name === 'vps-netcheck').handler({ rawInput: '-h la' }))
  assert.equal(res.kind, 'success', res.text)
  assert.match(res.text, /^\[la\] 网络体检 · \d\d:\d\d · 9 项正常/)
  assert.match(res.text, /\n✓ ChatGPT：能用（OpenAI 认为你在美国）\n/)
  assert.match(res.text, /完整细节在状态页的「网络」卡片/)
  const help = await withLang('zh', () => registered.find((c) => c.name === 'vps-help').handler({}))
  assert.match(help.text, /\/vps-netcheck\s+网络体检/)
  const text = await withLang('en', () => netText('la', { checkedAt: new Date().toISOString() }, judgeNet(parseNet(HK), null)))
  assert.doesNotMatch(text, HAN)
  assert.match(text, /✗ ChatGPT: Not available in this region \(OpenAI places you in Hong Kong\)/)
})
