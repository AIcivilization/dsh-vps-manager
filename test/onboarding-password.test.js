// 添加机器：表单里填密码，插件用它登录一次放公钥，之后一律用钥匙。密码不落地、不保存
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { readHosts, writeHosts } from '../lib/config.js'
import { readAudit } from '../lib/audit.js'
import {
  authorizeScript, autoAlias, classifyPasswordFailure, installKeyWithPassword,
} from '../lib/onboarding.js'
import { registerRoutes } from '../lib/routes.js'
import { runProcess } from '../lib/spawn.js'

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHf0nWm3lG5c0xYk7cQbq2rZkq9h3u8p1mB8u2y3xYz0 dsh-vps-manager'

async function home() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-onboard-'))
  const run = (script) => runProcess('sh', ['-c', script], { env: { ...process.env, HOME: dir } })
  return { dir, run }
}

test('放公钥的脚本：第一次加上、再跑不重复、权限 700/600', async () => {
  const h = await home()
  const first = await h.run(authorizeScript(KEY))
  assert.match(first.stdout, /DSHVPS_KEY_OK/)
  await h.run(authorizeScript(KEY))
  const text = await readFile(join(h.dir, '.ssh', 'authorized_keys'), 'utf8')
  assert.equal(text, `${KEY}\n`, '跑两次也只有一行')
  assert.equal((await stat(join(h.dir, '.ssh'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(h.dir, '.ssh', 'authorized_keys'))).mode & 0o777, 0o600)
})

test('放公钥的脚本：原文件末尾没换行，先补一个，不把两把钥匙接成一行', async () => {
  const h = await home()
  await mkdir(join(h.dir, '.ssh'), { mode: 0o700 })
  await writeFile(join(h.dir, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAAoldkey user@laptop') // 没有换行
  await h.run(authorizeScript(KEY))
  const lines = (await readFile(join(h.dir, '.ssh', 'authorized_keys'), 'utf8')).split('\n')
  assert.deepEqual(lines, ['ssh-ed25519 AAAAoldkey user@laptop', KEY, ''])
})

test('公钥格式不对就不拼脚本（防注入）', () => {
  assert.throws(() => authorizeScript("ssh-ed25519 AAAA'; rm -rf ~; echo '"), /公钥格式不对/)
  assert.throws(() => authorizeScript('ssh-ed25519 AAAA x\nmalicious'), /公钥格式不对/)
  assert.throws(() => authorizeScript(''), /公钥格式不对/)
})

test('失败说人话：密码不对、服务器不许密码登录、其余交给通用分类', () => {
  assert.equal(classifyPasswordFailure('root@1.2.3.4: Permission denied (publickey,password).', 255).reason, 'wrong_password')
  assert.equal(classifyPasswordFailure('root@1.2.3.4: Permission denied (publickey).', 255).reason, 'password_disabled')
  assert.equal(classifyPasswordFailure('ssh: connect to host 1.2.3.4 port 22: Connection refused', 255).reason, 'refused')
  assert.equal(classifyPasswordFailure('Host key verification failed.', 255).reason, 'host_key_changed')
})

test('密码只进子进程的环境变量：不在命令行参数里；askpass 小脚本不含密码、用完就删', async () => {
  let seen = null
  const run = async (cmd, args, opts) => {
    // 这一刻小脚本还在：真的执行一下，确认它把环境变量里的密码交出来
    const out = await runProcess('sh', [opts.env.SSH_ASKPASS], { env: { PATH: process.env.PATH, DSH_VPS_PW: opts.env.DSH_VPS_PW } })
    seen = { cmd, args, env: opts.env, helperOut: out.stdout, helperText: await readFile(opts.env.SSH_ASKPASS, 'utf8') }
    return { exitCode: 0, stdout: 'DSHVPS_KEY_OK\n', stderr: '' }
  }
  const res = await installKeyWithPassword({ hostname: '1.2.3.4', port: 2222, user: 'root', password: "p@ss w'rd$1", pubkey: KEY, run, platform: 'linux' })
  assert.equal(res.ok, true)
  assert.equal(seen.cmd, 'ssh')
  assert.ok(!seen.args.join(' ').includes("p@ss w'rd$1"), '密码不能出现在命令行参数里（ps 看得见）')
  assert.ok(seen.args.includes('root@1.2.3.4'))
  assert.ok(seen.args.includes('2222'))
  assert.ok(seen.args.includes('PubkeyAuthentication=no'))
  assert.equal(seen.env.SSH_ASKPASS_REQUIRE, 'force')
  assert.equal(seen.env.DSH_VPS_PW, "p@ss w'rd$1")
  assert.equal(seen.helperOut, "p@ss w'rd$1\n", '特殊字符原样交给 ssh')
  assert.ok(!seen.helperText.includes('p@ss'), '小脚本里不写密码')
  await assert.rejects(access(seen.env.SSH_ASKPASS), '用完就删')
})

test('密码不对：返回原因，不抛异常', async () => {
  const run = async () => ({ exitCode: 255, stdout: '', stderr: 'root@1.2.3.4: Permission denied (publickey,password).' })
  const res = await installKeyWithPassword({ hostname: '1.2.3.4', password: 'x', pubkey: KEY, run, platform: 'linux' })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'wrong_password')
  assert.match(res.hint, /密码不对/)
})

test('别名自动生成', () => {
  assert.equal(autoAlias('209.146.116.150'), '209-146-116-150')
  assert.equal(autoAlias('VPS.Example.com'), 'vps-example-com')
  assert.equal(autoAlias('***'), 'vps')
})

// —— 接口 ——

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-onboard-route-'))
  const env = { HOME: dir, DSH_HOME: join(dir, '.dsh') }
  await writeHosts({ current: '', hosts: {} }, env)
  const routes = new Map()
  const ws = { config: { host: '127.0.0.1', port: 3000 }, register({ path, handler }) { routes.set(path, handler); return () => {} }, tapIndex() { return () => {} } }
  const installs = []
  const deps = {
    env,
    runner: (_a, payload, opts = {}) => runProcess('sh', ['-s'], { input: payload, env: { ...process.env, HOME: dir }, ...opts }),
    installKey: async (args) => {
      installs.push(args)
      return args.password === 'right' ? { ok: true } : { ok: false, reason: 'wrong_password', hint: '密码不对' }
    },
    scanFingerprint: async () => ({ ok: true, fingerprints: ['256 SHA256:abcdef 1.2.3.4 (ED25519)'] }),
  }
  const reg = registerRoutes({ webServer: ws }, deps)
  const call = async (body, remote = false) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', 'x-dsh-vps-token': reg.token }
    req.socket = { remoteAddress: remote ? '192.168.1.9' : '127.0.0.1' }
    const out = {}
    await routes.get('/api-vps/onboarding/connect')(req, { writeHead: (c) => { out.code = c }, end: (t) => { out.body = JSON.parse(t) } })
    return out.body
  }
  return { dir, env, installs, call }
}

test('接口：带密码只收本机请求', async () => {
  const s = await sandbox()
  const res = await s.call({ hostname: '1.2.3.4', password: 'right' }, true)
  assert.equal(res.ok, false)
  assert.match(res.error, /只能在运行 DSH 的这台电脑上/)
  assert.equal(s.installs.length, 0)
})

test('接口：密码对 → 放公钥、保存机器、用钥匙体检；审计里没有密码', async () => {
  const s = await sandbox()
  const res = await s.call({ hostname: '1.2.3.4', port: 22, user: 'root', password: 'right', note: '洛杉矶' })
  assert.equal(res.ok, true, res.error)
  assert.equal(res.alias, '1-2-3-4')
  assert.equal(res.keyInstalled, true)
  assert.deepEqual(res.fingerprints, ['256 SHA256:abcdef 1.2.3.4 (ED25519)'])
  assert.equal(s.installs.length, 1)
  assert.match(s.installs[0].pubkey, /^ssh-ed25519 \S+ dsh-vps-manager$/, '放的是插件专用钥匙的公钥')

  const doc = await readHosts(s.env)
  assert.equal(doc.hosts['1-2-3-4'].note, '洛杉矶')
  const conf = await readFile(join(s.dir, '.ssh', 'config.d', 'dsh-vps.conf'), 'utf8')
  assert.match(conf, /Host 1-2-3-4[\s\S]*HostName 1\.2\.3\.4[\s\S]*IdentityFile/)
  const audit = JSON.stringify(await readAudit({ env: s.env }))
  assert.ok(audit.includes('add_host'))
  assert.ok(!audit.includes('right'), '审计里不能有密码')
  for (const f of ['hosts.yml', 'state.json']) {
    const text = await readFile(join(s.dir, '.dsh', 'vps-manager', f), 'utf8').catch(() => '')
    assert.ok(!text.includes('right'), `${f} 里不能有密码`)
  }
})

test('接口：密码不对 → 不保存机器，说清原因；别名重复直接拒绝', async () => {
  const s = await sandbox()
  const bad = await s.call({ hostname: '1.2.3.4', password: 'wrong' })
  assert.equal(bad.ok, true)
  assert.equal(bad.connected, false)
  assert.equal(bad.reason, 'wrong_password')
  assert.deepEqual(Object.keys((await readHosts(s.env)).hosts), [], '密码不对时不留半截配置')

  await s.call({ hostname: '1.2.3.4', password: 'right', alias: 'la' })
  const dup = await s.call({ hostname: '5.6.7.8', password: 'right', alias: 'la' })
  assert.equal(dup.ok, false)
  assert.match(dup.error, /已经有一台机器在用/)
})
