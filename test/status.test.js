// 终端面板的「状态」页签：一次采完、规则判断、本机缓存、点了才让 AI 解读
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { bindSession, readState, writeHosts, writeState } from '../lib/config.js'
import { _resetLang, withLang } from '../lib/i18n.js'
import { registerRoutes } from '../lib/routes.js'
import { STATUS_SCRIPT, certLevel, collectStatus, interpretStatus, judge, parseStatus, readStatusCache, statusBrief } from '../lib/status.js'

const HAN = /[一-鿿]/

// 一台真实感的机器上采集脚本的输出（键=值 + 记录行，没有句子）
const SAMPLE = [
  'priv=root', 'host=mail', 'os=Ubuntu 24.04.1 LTS', 'os_id=ubuntu', 'os_ver=24.04', 'init=systemd', 'pkg=apt',
  'kernel=6.8.0-45-generic', 'arch=x86_64', 'uptime=1054800', 'cores=2', 'load=1.42 0.98 0.71', 'cpu=37',
  'proc_cpu=dsh-web|18.2', 'proc_cpu=caddy|6.1', 'proc_mem=java|1268736', 'proc_mem=dsh-web|545280',
  'memtotal=3984588', 'memavailable=325058', 'swaptotal=2097148', 'swapfree=629144',
  'disk=/|60817408|54136832|6680576|89', 'disk=/boot|944128|325632|618496|35', 'inode=/|34', 'inode=/boot|2',
  'net=eth0|872310000000|251150000000',
  'svc_running=31', 'svc_failed=backup-sync.service', 'svc_failed=certbot.service', 'svc_down=myapp.service',
  'svc_name=caddy', 'svc_name=docker', 'svc_name=dsh-web',
  'timer=certbot.timer|certbot.service', 'timer=apt-daily.timer|apt-daily.service',
  'docker=1',
  'ctr=mailserver|running|Up 12 days|mailserver/docker-mailserver', 'ctr=old-test|exited|Exited (137) 2 days ago|nginx:alpine',
  'ctr_policy=mailserver|unless-stopped', 'ctr_policy=old-test|no',
  'port=0.0.0.0:22|users:(("sshd",pid=812,fd=3))', 'port=[::]:22|users:(("sshd",pid=812,fd=4))',
  'port=0.0.0.0:443|users:(("caddy",pid=1201,fd=7))', 'port=127.0.0.1:8787|users:(("dsh-web",pid=2210,fd=20))',
  'fw=ufw|1', 'fw_allow=22/tcp', 'fw_allow=443/tcp',
  'cron_lines=3', 'cron_files=5',
  `cert=mail.example.com|${new Date(Date.now() + 9.5 * 86_400_000).toUTCString()}|letsencrypt`,
  `cert=dsh.example.com|${new Date(Date.now() + 63.5 * 86_400_000).toUTCString()}|caddy`,
  'updates=23', 'updates_sec=5', 'reboot=1', 'login_fail=312', 'f2b=1',
  'plugin_trash=129024', 'plugin_backups=8500',
  'task=20261002-101500-ab12|DESKTOP-AB12|recipe',
].join('\n')

test('采集脚本只读：不改系统、不装东西、不输出句子（句子由界面按语言拼）', () => {
  for (const bad of [/\brm\s+-/, /apt(-get)?\s+install/, /systemctl\s+(start|stop|restart|enable|disable)/, /ufw\s+(allow|deny|enable)/, /\bkill\s+-(?!0\b)/, />\s*\/etc\//]) {
    assert.doesNotMatch(STATUS_SCRIPT, bad, `采集脚本里不该有：${bad}`)
  }
  const printfs = [...STATUS_SCRIPT.matchAll(/printf '([^']*)'/g)].map((m) => m[1])
  for (const f of printfs) assert.doesNotMatch(f, HAN, `输出里不该有汉字：${f}`)
})

test('解析：只有数字和名字；端口 IPv4 / IPv6 合并，分清对外和只在本机', () => {
  const d = parseStatus(SAMPLE)
  assert.equal(d.cores, 2)
  assert.deepEqual(d.load, [1.42, 0.98, 0.71])
  assert.equal(d.mem.total, 3984588 * 1024)
  assert.equal(d.disks[0].mount, '/')
  assert.equal(d.disks[0].inodePct, 34)
  assert.equal(d.services.running, 31)
  assert.deepEqual(d.services.failed, ['backup-sync.service'], '定时器拉起的失败单独算')
  assert.deepEqual(d.services.timerFailed, ['certbot.service'])
  assert.equal(d.containers.list.find((x) => x.name === 'old-test').policy, 'no')
  assert.deepEqual(d.ports.map((p) => [p.port, p.proc, p.local]), [[22, 'sshd', false], [443, 'caddy', false], [8787, 'dsh-web', true]])
  assert.equal(d.task.device, 'DESKTOP-AB12')
})

test('解析：采不到的是「取不到」(null)，不能当成 0', () => {
  const d = parseStatus('priv=none\ncores=\nload=\nuptime=\n')
  assert.equal(d.cores, null)
  assert.equal(d.uptime, null)
  assert.equal(d.cpu, null)
  assert.equal(d.mem, null)
  assert.equal(d.services, null, '不是 systemd、也没有 rc-status')
  assert.equal(d.containers, null, '没装 docker')
})

test('判断：规则判「需注意」，按轻重排；其余算正常；没权限的算取不到', () => {
  const j = judge(parseStatus(SAMPLE))
  const types = j.attention.map((i) => `${i.level}:${i.type}`)
  assert.deepEqual(types.slice(0, 2), ['danger:svc_failed', 'danger:svc_down'], '红的排前面')
  for (const t of ['warn:mem', 'warn:swap', 'warn:disk', 'warn:timer_failed', 'warn:ctr_exited', 'warn:cert', 'warn:reboot', 'warn:updates_sec']) assert.ok(types.includes(t), `缺 ${t}`)
  assert.ok(!types.includes('warn:login_fail'), '有 fail2ban 时登录失败多不算异常')
  assert.ok(j.ok.some((i) => i.type === 'load'))
  assert.ok(j.ok.some((i) => i.type === 'firewall'))

  const noRoot = judge(parseStatus('priv=none\ndocker=1\nctr_noaccess=1\nfw=unknown|0\ncores=2\nload=0.1 0.1 0.1\n'))
  assert.deepEqual(noRoot.na.map((i) => `${i.type}:${i.reason ?? ''}`).sort(), ['containers:root', 'firewall:root', 'login_fail:root', 'services:'])
})

test('判断：阈值（磁盘 85/95、证书 14/3 天、负载按核数）', () => {
  const at = (pct) => judge(parseStatus(`disk=/|100|${pct}|${100 - pct}|${pct}`)).attention.find((i) => i.type === 'disk')?.level
  assert.equal(at(84), undefined)
  assert.equal(at(85), 'warn')
  assert.equal(at(95), 'danger')
  const cert = (days) => judge(parseStatus(`cert=a.com|${new Date(Date.now() + days * 86_400_000 + 3_600_000).toUTCString()}|caddy`)).attention.find((i) => i.type === 'cert')?.level
  assert.equal(cert(30), undefined)
  assert.equal(cert(14), 'warn')
  assert.equal(cert(3), 'danger')
  const load = (l) => judge(parseStatus(`cores=2\nload=${l} 0 0`)).attention.find((i) => i.type === 'load')?.level
  assert.equal(load(1.9), undefined)
  assert.equal(load(2.5), 'warn')
  assert.equal(load(4.5), 'danger')
})

test('采集脚本：「设了开机自启却没在跑」不把开机跑一次就正常退出的服务算进去（真机上 dmesg 误报过）', () => {
  // 看脚本里判断的那段：一次性的、按需拉起的、条件不满足的跳过；常驻型没在跑、没启动过、出错退出才报
  assert.match(STATUS_SCRIPT, /ty != "oneshot" && tb == "" && cr != "no"/)
  assert.match(STATUS_SCRIPT, /ty == "notify" \|\| ty == "forking" \|\| ty == "dbus" \|\| st == "0" \|\| \(es != "" && es != "0"\)/)
})

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-status-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: 'la', hosts: { la: {} } }, env)
  await writeState({ hosts: { la: { facts: { os_id: 'ubuntu', services: 'old' } } } }, env)
  await bindSession('s1', 'la', env)
  // 冒充 ssh：不管脚本是什么，都回这台机器的输出
  const runner = async () => ({ stdout: `${'__DSH_BEGIN_x__'}`, stderr: '', exitCode: 0 })
  return { home, env, runner }
}

test('采集：结果存本机；顺手刷新 VPS 模式给 AI 的机器信息（服务、容器、80/443 被谁占）', async () => {
  const { env } = await sandbox()
  const runner = (_a, payload) => {
    const nonce = /__DSH_BEGIN_([0-9a-f]+)__/.exec(payload)[1]
    return Promise.resolve({ stdout: `__DSH_BEGIN_${nonce}__\n${SAMPLE}\n__DSH_RC_${nonce}__=0\n`, stderr: '', exitCode: 0, durationMs: 5 })
  }
  const res = await collectStatus({ alias: 'la', env, runner })
  assert.equal(res.ok, true, res.hint)
  assert.equal(res.data.host, 'mail')
  const cache = await readStatusCache('la', env)
  assert.equal(cache.collectedAt, res.collectedAt)
  const facts = (await readState(env)).hosts.la.facts
  assert.equal(facts.services, 'caddy docker dsh-web')
  assert.equal(facts.containers, 'mailserver')
  assert.equal(facts.web_listeners, 'caddy')
  assert.equal(facts.os_id, 'ubuntu', '别的体检信息不动')
})

test('AI 解读：用 DSH 的默认模型；提示词和摘要按界面语言；结果存本机；拿不到模型服务时说清楚', async () => {
  const { env } = await sandbox()
  const runner = (_a, payload) => {
    const nonce = /__DSH_BEGIN_([0-9a-f]+)__/.exec(payload)[1]
    return Promise.resolve({ stdout: `__DSH_BEGIN_${nonce}__\n${SAMPLE}\n__DSH_RC_${nonce}__=0\n`, stderr: '', exitCode: 0, durationMs: 5 })
  }
  await collectStatus({ alias: 'la', env, runner })
  let seen = null
  const llm = {
    async *stream(options) {
      seen = options
      yield { type: 'text-delta', index: 0, text: 'Mostly fine. ' }
      yield { type: 'text-delta', index: 0, text: 'Memory is tight.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const defaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
  let interpretation
  try {
    ;({ interpretation } = await withLang('en', () => interpretStatus({ alias: 'la', env, llm, defaultModel })))
  } finally {
    _resetLang()
  }
  assert.equal(seen.provider, 'deepseek')
  assert.equal(seen.model, 'deepseek-chat')
  assert.match(seen.system, /in English/)
  assert.doesNotMatch(seen.messages[0].content[0].text, HAN, '英文界面给模型的摘要也是英文')
  assert.equal(interpretation.model, 'deepseek-chat')
  assert.ok(interpretation.text.length > 0)
  assert.equal((await readStatusCache('la', env)).interpretation.text, interpretation.text)

  await assert.rejects(interpretStatus({ alias: 'la', env }), (e) => e.code === 'no_llm')
})

test('接口：只看这个对话绑定的那台；get 先给本机缓存，collect 采新的，interpret 拿不到模型时给原因', async () => {
  const { env } = await sandbox()
  const runner = (_a, payload) => {
    const nonce = /__DSH_BEGIN_([0-9a-f]+)__/.exec(payload)[1]
    return Promise.resolve({ stdout: `__DSH_BEGIN_${nonce}__\n${SAMPLE}\n__DSH_RC_${nonce}__=0\n`, stderr: '', exitCode: 0, durationMs: 5 })
  }
  const routes = new Map()
  const ws = { config: { host: '127.0.0.1', port: 3000 }, register({ path, handler }) { routes.set(path, handler); return () => {} }, tapIndex() { return () => {} } }
  const reg = registerRoutes({ webServer: ws }, { env, runner })
  const call = async (path, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', 'x-dsh-vps-token': reg.token }
    req.socket = { remoteAddress: '127.0.0.1' }
    const out = {}
    await routes.get(`/api-vps/${path}`)(req, { writeHead() {}, end: (t) => { out.body = JSON.parse(t) } })
    return out.body
  }
  assert.match((await call('status/get', { sessionId: 'other' })).error, /还没打开 VPS 开关/)
  assert.equal((await call('status/get', { sessionId: 's1' })).status, null, '还没采过')
  const fresh = await call('status/collect', { sessionId: 's1' })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.status.data.host, 'mail')
  assert.ok(fresh.status.judged.attention.length > 0)
  assert.match(fresh.status.brief, /机器 la/)
  assert.equal(fresh.canInterpret, false)
  const cached = await call('status/get', { sessionId: 's1' })
  assert.equal(cached.status.collectedAt, fresh.status.collectedAt)
  const ai = await call('status/interpret', { sessionId: 's1' })
  assert.equal(ai.ok, true)
  assert.equal(ai.code, 'no_llm')
  assert.match(ai.error, /不让插件直接调用模型/)
})

// —— 界面 ——

async function loadClient(pageLang) {
  let spec = null
  globalThis.window = {
    __ModuleLoader__: { load: (s) => { spec = s } }, __DSH_VPS_TOKEN__: 't', confirm: () => true, innerHeight: 800,
    location: { origin: 'http://127.0.0.1:3000' }, addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  if (pageLang) globalThis.document = { documentElement: { lang: pageLang }, getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } }
  else delete globalThis.document
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) })
  await import(`../lib/client.js?${Math.random()}`)
  return spec.factory((n) => {
    if (n === 'react') return React
    throw new Error(n)
  })
}

function viewFor(lang) {
  const data = parseStatus(SAMPLE)
  const judged = judge(data)
  return withLang(lang, () => ({ alias: 'la', status: { collectedAt: new Date().toISOString(), data, judged, brief: statusBrief('la', data, judged) }, interpretation: null, canInterpret: true }))
}

test('界面：状态页（最大化）把需注意、资源、磁盘和各分区都画出来；英文界面没有一个汉字', async () => {
  for (const [lang, page] of [['zh', null], ['en', 'en']]) {
    const exported = await loadClient(page)
    const { StatusView, termChrome } = exported.__test
    const entry = { sessionId: 's1', alias: 'la', statusState: { view: viewFor(lang), loading: false, error: '', expanded: false, interpreting: false, interpError: '', notice: '' } }
    const html = renderToStaticMarkup(React.createElement(StatusView, { entry, c: termChrome('light'), maximized: true, visible: false }))
    if (lang === 'zh') {
      assert.match(html, /需注意 10 项/)
      assert.match(html, /backup-sync/)
      assert.match(html, /让 AI 解读/)
      for (const section of ['磁盘', '服务', '容器', '进程', '端口', '防火墙', '计划任务', '证书', '安全', '插件占用']) assert.match(html, new RegExp(section), `缺分区：${section}`)
    } else {
      assert.match(html, /10 need attention/)
      assert.match(html, /Interpret/)
      assert.doesNotMatch(html, HAN, '英文界面不该有汉字')
    }
  }
  delete globalThis.document
  _resetLang()
})

test('界面：默认高度只放结论、需注意和「其余正常」一行；点「展开全部」才出完整分区', async () => {
  const exported = await loadClient(null)
  const { StatusView, termChrome } = exported.__test
  const entry = { sessionId: 's1', alias: 'la', statusState: { view: viewFor('zh'), loading: false, error: '', expanded: false, interpreting: false, interpError: '', notice: '' } }
  const html = renderToStaticMarkup(React.createElement(StatusView, { entry, c: termChrome('light'), maximized: false, visible: false }))
  assert.match(html, /其余正常/)
  assert.match(html, /展开全部/)
  assert.doesNotMatch(html, /插件占用/, '默认高度不展开分区')
  entry.statusState.expanded = true
  const open = renderToStaticMarkup(React.createElement(StatusView, { entry, c: termChrome('light'), maximized: false, visible: false }))
  assert.match(open, /插件占用/)
})

test('发到对话：同一句话已经在排队就不再排一条（AI 忙时连点，停掉后会留下删不掉的重复消息）', async () => {
  const exported = await loadClient(null)
  const sent = []
  const input = {
    snapshot: { draft: '', queue: [] },
    setDraft(t) { this.snapshot = { ...this.snapshot, draft: t } },
    async submit(mode) {
      sent.push([this.snapshot.draft, mode])
      this.snapshot = { ...this.snapshot, draft: '', queue: [...this.snapshot.queue, { content: [{ type: 'text', text: sent.at(-1)[0] }] }] }
    },
  }
  const actx = { get: (n) => (n === 'conversation' ? { input: { for: () => input } } : undefined) }
  exported.apply({
    slots: { inject: () => {}, register: () => () => {} },
    inject: (names, cb) => { if (names.includes('sessions')) cb({ get: (n) => (n === 'sessions' ? { scope: () => actx } : undefined), effect() {} }) },
  })
  const { sendToChat } = exported.__test
  assert.equal(await sendToChat('s1', '看看这个文件'), 'sent')
  assert.equal(await sendToChat('s1', '看看这个文件'), 'queued', '已经在排队')
  assert.equal(await sendToChat('s1', '另一个问题'), 'sent')
  assert.deepEqual(sent, [['看看这个文件', 'queue'], ['另一个问题', 'queue']])
})

test('证书：Caddy 里过期、配置也没有它的旧文件不报；6 天的 IP 证书按自己的有效期算；签发日期、来源都解析出来', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  const d = parseStatus([
    'cert=209.146.116.150|Sep 24 17:05:26 2026 GMT|caddy|Sep 18 01:05:27 2026 GMT|0',
    'cert=dsh.example.com|Dec 18 14:25:31 2026 GMT|caddy|Sep 19 14:25:32 2026 GMT|1',
    'cert=api.example.com|Dec 15 02:55:05 2026 GMT|caddy|Sep 16 02:55:06 2026 GMT|1',
    'cert=ip.example.com|Oct  4 13:00:00 2026 GMT|caddy|Sep 27 21:00:00 2026 GMT|1',
    'cert=gone.example.com|Sep 30 00:00:00 2026 GMT|caddy|Jul  2 00:00:00 2026 GMT|1',
    'cert=old.example.com|Oct 20 00:00:00 2026 GMT|letsencrypt|Jul 22 00:00:00 2026 GMT|',
  ].join('\n'))
  assert.deepEqual(d.certs.find((c) => c.name === 'api.example.com'), { name: 'api.example.com', source: 'caddy', expires: '2026-12-15T02:55:05.000Z', starts: '2026-09-16T02:55:06.000Z', used: true })
  const j = judge(d, now)
  const level = Object.fromEntries(j.certs.map((c) => [c.name, c.level]))
  assert.equal(level['209.146.116.150'], 'stale', '过期、配置里没有：旧文件')
  assert.equal(level['gone.example.com'], 'danger', '过期但配置里还有：真出问题了')
  assert.equal(level['ip.example.com'], 'ok', '6 天的证书剩 2 天是正常的')
  assert.equal(level['old.example.com'], 'ok')
  assert.deepEqual(j.attention.filter((i) => i.type === 'cert').map((i) => i.name), ['gone.example.com'])
  const short = (expires) => certLevel({ expires, starts: '2026-09-27T00:00:00Z', source: 'caddy', used: true }, now).level
  assert.equal(short('2026-10-03T22:00:00Z'), 'warn', '6 天多的证书只剩 1 天多：该续没续')
  assert.equal(short('2026-10-03T02:00:00Z'), 'danger', '不到 1 天')
  assert.match(statusBrief('la', d, j), /209\.146\.116\.150 已过期但 Caddy 配置里已没有它/)
})
