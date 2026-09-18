import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigError,
  effectiveConfirm,
  ensureInclude,
  getHost,
  importCandidates,
  paths,
  readHosts,
  scanSshAliases,
  upsertDropinHost,
  removeDropinHost,
  trustHash,
  isTrusted,
  validateConnection,
  writeHosts,
  normalizeTerminalPrefs,
} from '../lib/config.js'

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-cfg-'))
  await mkdir(join(home, '.ssh'), { recursive: true })
  return { HOME: home, DSH_HOME: join(home, '.dsh') }
}

test('hosts.yml 读写往返，未知机器给出可读报错', async () => {
  const env = await sandbox()
  await writeHosts({
    current: 'hk',
    settings: { confirm: 'careful' },
    groups: { 生产: { confirm: 'careful' }, 测试: { confirm: 'relaxed' } },
    hosts: {
      hk: { note: '香港，建站用', group: '生产' },
      jp: { note: '日本，测试机', group: '测试', confirm: 'auto' },
    },
  }, env)

  const doc = await readHosts(env)
  assert.equal(doc.current, 'hk')
  assert.equal(doc.hosts.hk.note, '香港，建站用')
  assert.equal(getHost(doc, 'jp').group, '测试')
  assert.throws(() => getHost(doc, 'nope'), (e) => e instanceof ConfigError && e.code === 'unknown_host')
  assert.throws(() => getHost(doc, '-oProxyCommand=x'), (e) => e.code === 'invalid_alias')

  const text = await readFile(paths(env).hostsFile, 'utf8')
  assert.match(text, /# dsh-vps-manager/)
})

test('确认档位优先级：机器 > 组 > 全局', async () => {
  const env = await sandbox()
  await writeHosts({
    settings: { confirm: 'relaxed' },
    groups: { 生产: { confirm: 'careful' } },
    hosts: {
      a: { group: '生产' }, // 取组的 careful
      b: {}, // 取全局的 relaxed
      c: { group: '生产', confirm: 'auto' }, // 机器自己的最优先
    },
  }, env)
  const doc = await readHosts(env)
  assert.equal(effectiveConfirm(doc, 'a'), 'careful')
  assert.equal(effectiveConfirm(doc, 'b'), 'relaxed')
  assert.equal(effectiveConfirm(doc, 'c'), 'auto')
})

test('current 指向不存在的机器时自动清空', async () => {
  const env = await sandbox()
  await mkdir(paths(env).base, { recursive: true })
  await writeFile(paths(env).hostsFile, 'schema: 1\ncurrent: ghost\nhosts:\n  hk: {}\n')
  const doc = await readHosts(env)
  assert.equal(doc.current, '')
})

test('hosts.yml 格式坏掉时报可读错误，不静默吞掉', async () => {
  const env = await sandbox()
  await mkdir(paths(env).base, { recursive: true })
  await writeFile(paths(env).hostsFile, 'hosts:\n  hk: {note: "未闭合\n')
  await assert.rejects(readHosts(env), (e) => e instanceof ConfigError && e.code === 'hosts_yaml_invalid')
})

test('连接字段校验', () => {
  assert.deepEqual(validateConnection({ hostname: '1.2.3.4', port: 2222, user: 'root' }), {
    hostname: '1.2.3.4',
    port: 2222,
    user: 'root',
  })
  assert.throws(() => validateConnection({ hostname: 'a b', port: 22 }), (e) => e.code === 'invalid_hostname')
  assert.throws(() => validateConnection({ hostname: '1.2.3.4', port: 0 }), (e) => e.code === 'invalid_port')
  assert.throws(() => validateConnection({ hostname: '1.2.3.4', port: 22, user: 'root;rm' }), (e) => e.code === 'invalid_user')
  assert.throws(() => validateConnection({ alias: '-x', hostname: '1.2.3.4', port: 22 }), (e) => e.code === 'invalid_alias')
})

test('扫描 ~/.ssh/config：跳过通配符与 Match、剥行尾注释、跟随 Include', async () => {
  const env = await sandbox()
  const p = paths(env)
  await mkdir(p.sshDropinDir, { recursive: true })
  await writeFile(p.sshConfig, [
    'Include config.d/*.conf',
    'Host *',
    '  ServerAliveInterval 60',
    'Host vps  # 行尾注释',
    '  HostName 203.0.113.10  # 换成真实公网 IP',
    'Host a b',
    '  HostName 10.0.0.1',
    'Match host nope',
    '  User x',
  ].join('\n'))
  await writeFile(join(p.sshDropinDir, 'extra.conf'), 'Host imported\n  HostName 5.6.7.8\n')

  const aliases = (await scanSshAliases(p.sshConfig)).map((x) => x.alias)
  assert.deepEqual(aliases.sort(), ['a', 'b', 'imported', 'vps'])
})

test('导入候选排除已登记的机器和代码托管条目', async () => {
  const env = await sandbox()
  const p = paths(env)
  await writeFile(p.sshConfig, 'Host hk\nHost github.com\nHost newbox\n')
  await writeHosts({ hosts: { hk: {} } }, env)
  const candidates = (await importCandidates(env)).map((x) => x.alias)
  assert.deepEqual(candidates, ['newbox'])
})

test('插件写自己的 drop-in，并在 ~/.ssh/config 顶部加 Include（先备份）', async () => {
  const env = await sandbox()
  const p = paths(env)
  await writeFile(p.sshConfig, 'Host old\n  HostName 1.1.1.1\n')

  await upsertDropinHost({ alias: 'hk', hostname: '1.2.3.4', port: 2222, user: 'root', identityFile: '~/.ssh/dsh_vps_ed25519' }, env)

  const dropin = await readFile(p.sshDropin, 'utf8')
  assert.match(dropin, /Host hk/)
  assert.match(dropin, /HostName 1\.2\.3\.4/)
  assert.match(dropin, /Port 2222/)
  assert.match(dropin, /IdentitiesOnly yes/)

  const config = await readFile(p.sshConfig, 'utf8')
  const lines = config.split('\n').filter(Boolean)
  assert.match(lines[0], /^# Added by dsh-vps-manager/)
  assert.equal(lines[1], 'Include config.d/dsh-vps.conf', 'Include 必须在第一个 Host 之前')
  assert.match(config, /Host old/, '用户原有内容不能丢')
  assert.match(await readFile(`${p.sshConfig}.dsh-bak`, 'utf8'), /Host old/)

  // 再写一次不应重复插入 Include
  const again = await ensureInclude(env)
  assert.equal(again.changed, false)

  // 更新同一台机器：块被替换而不是追加
  await upsertDropinHost({ alias: 'hk', hostname: '9.9.9.9', port: 22, user: 'root' }, env)
  const updated = await readFile(p.sshDropin, 'utf8')
  assert.equal(updated.match(/Host hk/g).length, 1)
  assert.match(updated, /HostName 9\.9\.9\.9/)

  assert.equal(await removeDropinHost('hk', env), true)
  assert.doesNotMatch(await readFile(p.sshDropin, 'utf8'), /Host hk/)
})

test('自定义菜谱按哈希记信任', async () => {
  const env = await sandbox()
  assert.equal(await isTrusted('deadbeef', env), false)
  await trustHash('deadbeef', { id: 'my-thing', source: 'panel' }, env)
  assert.equal(await isTrusted('deadbeef', env), true)
})

test('终端设置规范化：三种颜色方案、字号 11–20、保留时长', () => {
  assert.deepEqual(normalizeTerminalPrefs(undefined), { theme: 'system', fontSize: 13, keepMinutes: 10 })
  assert.deepEqual(normalizeTerminalPrefs({ theme: 'light', fontSize: '15', keepMinutes: 60 }), { theme: 'light', fontSize: 15, keepMinutes: 60 })
  assert.equal(normalizeTerminalPrefs({ theme: 'dark' }).theme, 'dark')
  assert.equal(normalizeTerminalPrefs({ fontSize: 10 }).fontSize, 13)
  assert.equal(normalizeTerminalPrefs({ fontSize: 21 }).fontSize, 13)
  assert.equal(normalizeTerminalPrefs({ keepMinutes: 0 }).keepMinutes, 10)
})
