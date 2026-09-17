// 设置页「卸载」：只动插件自己留下的东西；服务器上的事先做；插件本身最后移除。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDirs, paths, writeHosts } from '../lib/config.js'
import { runProcess } from '../lib/spawn.js'
import { PACKAGE_NAME, runUninstall, uninstallPreview } from '../lib/uninstall.js'

const KEY_BODY = 'AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake12'
const OTHER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOth me@laptop'

const exists = (f) => stat(f).then(() => true, () => false)

async function sandbox({ userConfig = 'Host github.com\n  User git\n' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-uninstall-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await ensureDirs(env)
  await writeHosts({ current: 'hk', hosts: { hk: {} } }, env)
  const p = paths(env)
  await mkdir(join(home, '.ssh', 'config.d'), { recursive: true })
  // 插件加 Include 的真实样子：注释 + Include + 空行 + 用户原来的内容
  await writeFile(p.sshConfig, `# Added by dsh-vps-manager\nInclude config.d/dsh-vps.conf\n\n${userConfig}`)
  await writeFile(p.sshDropin, 'Host hk\n  HostName 1.2.3.4\n')
  await writeFile(p.defaultKey, 'PRIVATE')
  await writeFile(`${p.defaultKey}.pub`, `ssh-ed25519 ${KEY_BODY} dsh-vps`)
  const runner = (alias, payload, opts = {}) => runProcess('sh', ['-s'], {
    input: payload, env: { ...process.env, HOME: home }, signal: opts.signal, timeoutMs: opts.timeoutMs,
    onStdout: opts.onStdout, onStderr: opts.onStderr,
  })
  return { home, env, p, runner }
}

test('预览：只列真的存在的东西，并说明能不能直接移除、重启', async () => {
  const { env } = await sandbox()
  const pv = await uninstallPreview({ env })
  assert.equal(pv.packageName, PACKAGE_NAME)
  assert.deepEqual(pv.hosts, ['hk'])
  assert.deepEqual(pv.present, { sshConfig: true, key: true, data: true })
  assert.deepEqual(pv.desktop, { canRemove: false, canRestart: false })
  assert.equal(pv.removeCommand, 'dsh plugin remove dsh-vps-manager')

  const withDesktop = await uninstallPreview({ env, desktop: { pnpm: {}, profileDir: '/p', actions: {} } })
  assert.deepEqual(withDesktop.desktop, { canRemove: true, canRestart: true })
})

test('本机清理：只去掉插件加的 Include，用户自己的配置一字不动，改前备份', async () => {
  const { env, p } = await sandbox()
  const res = await runUninstall({ env, choices: { sshConfig: true, key: true, data: true } })
  assert.equal(res.ok, true, JSON.stringify(res.steps))

  assert.equal(await readFile(p.sshConfig, 'utf8'), 'Host github.com\n  User git\n', '用户原来的内容必须原样保留')
  assert.match(await readFile(`${p.sshConfig}.dsh-uninstall-bak`, 'utf8'), /Include config\.d\/dsh-vps\.conf/)
  assert.equal(await exists(p.sshDropin), false)
  assert.equal(await exists(`${p.sshDropin}.uninstall-bak`), true, 'drop-in 改名留作备份，不是直接删')
  assert.equal(await exists(p.defaultKey), false)
  assert.equal(await exists(`${p.defaultKey}.pub`), false)
  assert.equal(await exists(p.base), false)
  assert.equal(await exists(join(env.DSH_HOME)), true, '只删 vps-manager，不能动整个 DSH 目录')
})

test('不勾的项一律不动', async () => {
  const { env, p } = await sandbox()
  const res = await runUninstall({ env, choices: { sshConfig: true } })
  assert.deepEqual(res.steps.map((s) => s.id), ['sshConfig'])
  assert.equal(await exists(p.defaultKey), true)
  assert.equal(await exists(p.base), true)
})

test('服务器上：清插件目录；有任务在跑就跳过', async () => {
  const { env, home, runner } = await sandbox()
  const cache = join(home, '.cache', 'dsh-vps')
  await mkdir(join(cache, 'tasks', 't1'), { recursive: true })
  const cleaned = await runUninstall({ env, runner, choices: { remoteCache: true } })
  assert.equal(cleaned.steps[0].ok, true, cleaned.steps[0].text)
  assert.match(cleaned.steps[0].text, /^hk：已删除 ~\/\.cache\/dsh-vps/)
  assert.equal(await exists(join(cache, 'tasks')), false)

  // 用本进程的 pid 冒充一个还活着的改动任务
  await mkdir(join(cache, 'lock'), { recursive: true })
  await writeFile(join(cache, 'lock', 'pid'), String(process.pid))
  const busy = await runUninstall({ env, runner, choices: { remoteCache: true } })
  assert.equal(busy.steps[0].ok, false)
  assert.match(busy.steps[0].text, /有任务正在跑，没清/)
  assert.equal(await exists(join(cache, 'lock')), true)
})

test('服务器上：只撤销插件钥匙那一行，别的钥匙保留，改前备份', async () => {
  const { env, home, runner, p } = await sandbox()
  const ak = join(home, '.ssh', 'authorized_keys')
  await writeFile(ak, `${OTHER_KEY}\nssh-ed25519 ${KEY_BODY} dsh-vps\n`)
  const res = await runUninstall({ env, runner, choices: { revokeKey: true } })
  assert.equal(res.steps[0].ok, true, res.steps[0].text)
  assert.match(res.steps[0].text, /已从 authorized_keys 删掉插件钥匙/)
  assert.equal(await readFile(ak, 'utf8'), `${OTHER_KEY}\n`)
  assert.match(await readFile(`${ak}.dsh-vps-bak`, 'utf8'), new RegExp(KEY_BODY))

  // 本机公钥已经没了：没法判断是哪一行，宁可不撤销
  await writeFile(`${p.defaultKey}.pub`, '')
  const noKey = await runUninstall({ env, runner, choices: { revokeKey: true } })
  assert.equal(noKey.steps[0].ok, false)
  assert.match(noKey.steps[0].text, /找不到插件专用钥匙的公钥/)
})

test('顺序：服务器上的先做，本机连接配置和钥匙后删，插件本身最后', async () => {
  const { env, runner } = await sandbox()
  const calls = []
  const desktop = {
    profileDir: '/profiles/desktop',
    pnpm: { runPlugin: (args, dir) => { calls.push({ args, dir }); return { stdout: null, stderr: null, done: Promise.resolve({ exitCode: 0, signal: null }) } } },
    actions: {},
  }
  const res = await runUninstall({
    env, runner, desktop,
    choices: { data: true, key: true, sshConfig: true, plugin: true, revokeKey: true, remoteCache: true },
  })
  assert.deepEqual(res.steps.map((s) => s.id), ['remoteCache', 'revokeKey', 'sshConfig', 'key', 'data', 'plugin'])
  assert.deepEqual(calls, [{ args: ['remove', 'dsh-vps-manager'], dir: '/profiles/desktop' }])
  assert.equal(res.canRestart, true)
})

test('移除插件：DSH Desktop 走宿主服务；失败说清原因；普通 dsh 给出命令', async () => {
  const { env } = await sandbox()
  const { EventEmitter } = await import('node:events')
  const stderr = new EventEmitter()
  const failing = {
    profileDir: '/p',
    pnpm: {
      runPlugin: () => {
        setTimeout(() => stderr.emit('data', Buffer.from('ERR_PNPM_something went wrong\n')), 0)
        return { stdout: new EventEmitter(), stderr, done: new Promise((r) => setTimeout(() => r({ exitCode: 1, signal: null }), 10)) }
      },
    },
  }
  const failed = await runUninstall({ env, desktop: failing, choices: { plugin: true } })
  assert.equal(failed.steps[0].ok, false)
  assert.match(failed.steps[0].text, /退出码 1.*ERR_PNPM_something went wrong/)

  const busy = { profileDir: '/p', pnpm: { runPlugin: () => { throw new Error('another desktop pnpm operation is already running') } } }
  assert.match((await runUninstall({ env, desktop: busy, choices: { plugin: true } })).steps[0].text, /another desktop pnpm operation/)

  const plain = await runUninstall({ env, choices: { plugin: true } })
  assert.equal(plain.steps[0].ok, false)
  assert.match(plain.steps[0].text, /dsh plugin remove dsh-vps-manager/)
  assert.equal(plain.canRestart, false)
})
