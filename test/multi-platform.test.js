// Windows / macOS / Linux 都能用；同一台服务器可以被几台电脑上的插件一起管
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deviceName, homeDir, paths, sshConfigPath, upsertDropinHost, writeHosts } from '../lib/config.js'
import { STATUS, runRemote } from '../lib/engine.js'
import { keyComment, knownFingerprints, sshCopyIdCommand } from '../lib/onboarding.js'
import { loadRecipes } from '../lib/recipes.js'
import { runProcess } from '../lib/spawn.js'
import { baseOptions, canMultiplex, classifySshFailure, noSshClientHint, sshArgs, sshCloseMaster } from '../lib/ssh.js'
import { runUninstall } from '../lib/uninstall.js'

// —— Windows ——

test('Windows 上不开连接复用（自带的 OpenSSH 不支持，开了每条命令都失败）', () => {
  assert.equal(canMultiplex('win32'), false)
  assert.equal(canMultiplex('darwin'), true)
  assert.equal(canMultiplex('linux'), true)
  const win = baseOptions({ platform: 'win32' }).join(' ')
  assert.doesNotMatch(win, /ControlMaster=auto|ControlPersist/)
  assert.match(win, /ControlMaster=no/)
  assert.match(win, /ControlPath=none/)
  assert.match(baseOptions({ platform: 'darwin' }).join(' '), /ControlMaster=auto/)
  assert.match(baseOptions({ platform: 'linux' }).join(' '), /ControlPersist=10m/)
})

test('Windows 上没有主连接可关：直接返回，不去跑 ssh -O exit', async () => {
  assert.equal(await sshCloseMaster('hk', { platform: 'win32' }), false)
})

test('内置菜谱一定读得到（Windows 上曾因路径写法全部丢失：「没有这条菜谱：probe」）', async () => {
  const { byId } = await loadRecipes({ includeUser: false })
  assert.ok(byId.has('probe'), '体检菜谱 probe 必须在')
  assert.ok(byId.size >= 20)
})

test('lib 里不拿 URL.pathname 当文件路径（Windows 上是 /C:/...，有空格和中文时是 %xx）', async () => {
  const dir = new URL('../lib/', import.meta.url)
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.js') && n !== 'client.js')) {
    const text = await readFile(new URL(f, dir), 'utf8')
    assert.doesNotMatch(text, /import\.meta\.url\)\.pathname|\)\.pathname, '/, `${f} 用了 URL.pathname`)
  }
})

test('Windows 的家目录按 USERPROFILE（ssh 只认它），其他系统按 HOME', () => {
  assert.equal(homeDir({ USERPROFILE: 'C:\\Users\\wf', HOME: '/c/Users/other' }, 'win32'), homeDir({ HOME: 'C:\\Users\\wf' }, 'darwin'))
  assert.equal(homeDir({ HOME: '/tmp/h' }, 'win32'), homeDir({ HOME: '/tmp/h' }, 'linux'), '测试沙盒只给 HOME 时照旧用 HOME')
  assert.equal(homeDir({ HOME: '/home/a', USERPROFILE: 'C:\\x' }, 'linux'), '/home/a')
})

test('ssh 配置里的路径：Windows 反斜杠换成正斜杠，有空格加引号', () => {
  assert.equal(sshConfigPath('C:\\Users\\10047\\.ssh\\dsh_vps_ed25519'), 'C:/Users/10047/.ssh/dsh_vps_ed25519')
  assert.equal(sshConfigPath('C:\\Users\\John Smith\\.ssh\\k'), '"C:/Users/John Smith/.ssh/k"')
  assert.equal(sshConfigPath('/Users/wf/.ssh/dsh_vps_ed25519'), '/Users/wf/.ssh/dsh_vps_ed25519')
  assert.equal(sshConfigPath('/home/a b/.ssh/k'), '"/home/a b/.ssh/k"')
})

test('写进连接配置的钥匙路径用 ssh 认得的写法', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-mp-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await upsertDropinHost({ alias: 'hk', hostname: '1.2.3.4', port: 22, user: 'root', identityFile: 'C:\\Users\\10047\\.ssh\\dsh_vps_ed25519' }, env)
  const conf = await readFile(paths(env).sshDropin, 'utf8')
  assert.match(conf, /IdentityFile C:\/Users\/10047\/\.ssh\/dsh_vps_ed25519\n/)
})

test('指纹从 known_hosts 读（Windows 的 ssh-keyscan 取不到）：整理成界面认的写法，哈希过的也认', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-kh-'))
  const key = join(dir, 'hostkey')
  await runProcess('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
  const pub = (await readFile(`${key}.pub`, 'utf8')).trim().split(' ').slice(0, 2).join(' ')
  const kh = join(dir, 'known_hosts')
  await writeFile(kh, `[1.2.3.4]:2222 ${pub}\nexample.com ${pub}\n`)
  const custom = await knownFingerprints({ hostname: '1.2.3.4', port: 2222, knownHostsFile: kh })
  assert.equal(custom.length, 1)
  assert.match(custom[0], /^SHA256:\S+ \[1\.2\.3\.4\]:2222 \(ED25519\)$/)
  assert.equal((await knownFingerprints({ hostname: 'example.com', knownHostsFile: kh })).length, 1)
  await runProcess('ssh-keygen', ['-H', '-f', kh])
  assert.equal((await knownFingerprints({ hostname: '1.2.3.4', port: 2222, knownHostsFile: kh })).length, 1, '哈希过的 known_hosts')
  assert.deepEqual(await knownFingerprints({ hostname: '5.6.7.8', knownHostsFile: kh }), [])
})

test('钥匙权限太宽：单独说清楚，不当成「公钥没放上去」', () => {
  const stderr = [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @',
    'Load key "C:\\\\Users\\\\x\\\\.ssh\\\\dsh_vps_ed25519": bad permissions',
    'root@1.2.3.4: Permission denied (publickey).',
  ].join('\n')
  const r = classifySshFailure(stderr, 255)
  assert.equal(r.reason, 'key_permissions')
  assert.match(r.hint, /icacls/)
  assert.match(r.hint, /chmod 600/)
})

test('本机没装 ssh：Windows 告诉用户去「可选功能」装 OpenSSH 客户端', () => {
  assert.match(noSshClientHint('win32'), /可选功能.*OpenSSH 客户端/)
  assert.doesNotMatch(noSshClientHint('linux'), /可选功能/)
})

test('只有密码时自己在终端里放公钥：Windows 没有 ssh-copy-id，换成 type | ssh', () => {
  const win = sshCopyIdCommand({ identityFile: 'C:\\Users\\10047\\.ssh\\dsh_vps_ed25519', user: 'root', hostname: '1.2.3.4', port: 2222, platform: 'win32' })
  assert.equal(win, 'type "C:\\Users\\10047\\.ssh\\dsh_vps_ed25519.pub" | ssh -p 2222 root@1.2.3.4 "umask 077; mkdir -p ~/.ssh && tr -d \'\\r\' >> ~/.ssh/authorized_keys"')
  assert.ok(!win.includes('$'), 'PowerShell 会展开双引号里的 $')
  const mac = sshCopyIdCommand({ identityFile: '/Users/wf/.ssh/dsh_vps_ed25519', user: 'root', hostname: '1.2.3.4', platform: 'darwin' })
  assert.equal(mac, 'ssh-copy-id -i /Users/wf/.ssh/dsh_vps_ed25519.pub root@1.2.3.4')
})

test('ssh 参数里别名前面照样有 --（Windows 上也不能被当成选项）', () => {
  const args = sshArgs('hk', { platform: 'win32' })
  assert.equal(args[args.indexOf('hk') - 1], '--')
})

// —— 几台电脑管同一台服务器 ——

test('公钥备注带上电脑名，服务器上一眼分得清是哪台电脑放的', () => {
  assert.equal(keyComment('DESKTOP-AB12CD'), 'dsh-vps-manager@DESKTOP-AB12CD')
  assert.equal(keyComment('wf的MacBook Pro.local'), 'dsh-vps-manager@wf-MacBook-Pro')
  assert.equal(keyComment(''), 'dsh-vps-manager')
  assert.equal(deviceName('a/b\\c d'), 'a-b-c-d')
})

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-mp-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  const runner = (_alias, payload, opts = {}) => runProcess('sh', ['-s'], {
    input: payload, env: { ...process.env, HOME: home }, signal: opts.signal, timeoutMs: opts.timeoutMs, onStdout: opts.onStdout,
  })
  return { home, env, runner }
}

test('另一台电脑的改动任务还在跑：排队提示里写明是哪台电脑发起的', async () => {
  const { env, runner } = await sandbox()
  const first = await runRemote({ alias: 'hk', body: 'sleep 2', mode: 'task', waitSeconds: 0, runner, env, meta: { source: 'ai' } })
  assert.equal(first.status, STATUS.detached, first.hint)
  const second = await runRemote({ alias: 'hk', body: 'echo hi', mode: 'task', waitSeconds: 0, runner, env })
  assert.equal(second.status, STATUS.locked)
  assert.equal(second.lockOwner.device, deviceName())
  assert.match(second.hint, new RegExp(`由电脑 ${deviceName()} 发起`))
  assert.match(second.hint, /另一台电脑/)
})

test('卸载时服务器上还有别的电脑的插件钥匙：共用的 ~/.cache/dsh-vps 保留，只撤销自己那一行', async () => {
  const { home, env, runner } = await sandbox()
  const p = paths(env)
  await writeHosts({ current: 'hk', hosts: { hk: {} } }, env)
  const MINE = 'AAAAC3NzaC1lZDI1NTE5AAAAIMineMineMineMineMineMineMineMineMineMineMine1'
  const WIN = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWinWinWinWinWinWinWinWinWinWinWinWinWin dsh-vps-manager@DESKTOP-AB12CD'
  await mkdir(p.sshDir, { recursive: true })
  await writeFile(`${p.defaultKey}.pub`, `ssh-ed25519 ${MINE} dsh-vps-manager@mac\n`)
  const ak = join(home, '.ssh', 'authorized_keys')
  await writeFile(ak, `${WIN}\nssh-ed25519 ${MINE} dsh-vps-manager@mac\n`)
  const cache = join(home, '.cache', 'dsh-vps', 'trash')
  await mkdir(cache, { recursive: true })

  const res = await runUninstall({ env, runner, choices: { remoteCache: true, revokeKey: true } })
  assert.equal(res.ok, true, JSON.stringify(res.steps))
  assert.match(res.steps[0].text, /别的电脑上的插件也在管这台服务器/)
  await readdir(cache) // 还在
  assert.equal(await readFile(ak, 'utf8'), `${WIN}\n`, 'Windows 那台的钥匙不能动')

  // 只剩自己时照常清掉
  const alone = await sandbox()
  await writeHosts({ current: 'hk', hosts: { hk: {} } }, alone.env)
  const ap = paths(alone.env)
  await mkdir(ap.sshDir, { recursive: true })
  await writeFile(`${ap.defaultKey}.pub`, `ssh-ed25519 ${MINE} dsh-vps-manager@mac\n`)
  await writeFile(join(alone.home, '.ssh', 'authorized_keys'), `ssh-ed25519 ${MINE} dsh-vps-manager@mac\nssh-rsa AAAAB3Nzaother me@laptop\n`)
  await mkdir(join(alone.home, '.cache', 'dsh-vps', 'tasks'), { recursive: true })
  const cleaned = await runUninstall({ env: alone.env, runner: alone.runner, choices: { remoteCache: true } })
  assert.match(cleaned.steps[0].text, /已删除 ~\/\.cache\/dsh-vps/)
})
