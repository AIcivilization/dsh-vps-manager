// lib/onboarding.js — 添加机器向导（设计 5.2）
//
// 认证只支持密钥。但「第一次把公钥放上去」通常需要密码，这一步由用户自己完成，
// 插件全程不接触密码：
//   A 服务商后台添加公钥（新机器）
//   B 已能登录 → 复制一行命令到服务器上执行
//   C 只有密码 → 在系统终端里跑 ssh-copy-id，用户自己输密码
//
// 插件自己用专用钥匙 ~/.ssh/dsh_vps_ed25519，不动用户原有的钥匙。

import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths, upsertDropinHost, validateConnection, writeHosts, readHosts } from './config.js'
import { runProcess } from './spawn.js'
import { probeHost } from './actions.js'

const exists = (f) => access(f, constants.F_OK).then(() => true, () => false)

/** 检查（必要时生成）插件专用钥匙 */
export async function ensureKey({ env = process.env, create = false, keyPath, passphrase = '' } = {}) {
  const p = paths(env)
  const file = keyPath || p.defaultKey
  const pub = `${file}.pub`
  if (await exists(pub)) {
    return { path: file, pubkey: (await readFile(pub, 'utf8')).trim(), created: false, ...(await keyInfo(file)) }
  }
  if (!create) return { path: file, pubkey: '', created: false, missing: true }

  await mkdir(p.sshDir, { recursive: true, mode: 0o700 })
  const res = await runProcess('ssh-keygen', [
    '-t', 'ed25519',
    '-f', file,
    '-N', passphrase,
    '-C', 'dsh-vps-manager',
  ], { timeoutMs: 30_000 })
  if (res.exitCode !== 0) throw new Error(`生成钥匙失败：${res.stderr || res.stdout}`)
  await chmod(file, 0o600).catch(() => {})
  return { path: file, pubkey: (await readFile(pub, 'utf8')).trim(), created: true, ...(await keyInfo(file)) }
}

async function keyInfo(file) {
  const res = await runProcess('ssh-keygen', ['-lf', `${file}.pub`], { timeoutMs: 10_000 }).catch(() => null)
  const fingerprint = res?.exitCode === 0 ? res.stdout.trim() : ''
  // 私钥有没有密码短语：用空密码尝试改密码，成功说明原来没有密码短语
  const probe = await runProcess('ssh-keygen', ['-y', '-P', '', '-f', file], { timeoutMs: 10_000 }).catch(() => null)
  return { fingerprint, hasPassphrase: probe ? probe.exitCode !== 0 : null }
}

/** 方式 B：用户在服务器上粘贴执行的一行命令 */
export function authorizedKeysCommand(pubkey) {
  const safe = String(pubkey).trim().replace(/'/g, "'\\''")
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${safe}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
}

/** 方式 C：在终端里跑的命令（密码由用户直接输给 ssh-copy-id，插件看不到） */
export function sshCopyIdCommand({ identityFile, user, hostname, port = 22 }) {
  const portPart = Number(port) === 22 ? '' : `-p ${Number(port)} `
  return `ssh-copy-id -i ${identityFile}.pub ${portPart}${user ? `${user}@` : ''}${hostname}`
}

/**
 * 在系统终端里打开方式 C 的命令。做不到就把命令交回给界面让用户自己复制。
 */
export async function openInTerminal({ command, platform = process.platform }) {
  if (platform === 'darwin') {
    const file = join(tmpdir(), `dsh-vps-${Date.now()}.command`)
    await writeFile(file, `#!/bin/sh\necho "把公钥放到服务器上（需要输入服务器密码）"\n${command}\necho\necho "完成后可以关闭这个窗口"\n`, { mode: 0o700 })
    const res = await runProcess('open', ['-a', 'Terminal', file], { timeoutMs: 10_000 }).catch((e) => ({ exitCode: 1, stderr: e.message }))
    setTimeout(() => unlink(file).catch(() => {}), 120_000)
    return { opened: res.exitCode === 0, command }
  }
  if (platform === 'linux') {
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      const res = await runProcess(term, ['-e', `sh -c '${command.replace(/'/g, "'\\''")}; read -p "按回车关闭"'`], { timeoutMs: 10_000 }).catch(() => null)
      if (res && res.exitCode === 0) return { opened: true, command, terminal: term }
    }
  }
  return { opened: false, command, hint: '没能自动打开终端，请手工复制这条命令到终端里执行' }
}

/** 取服务器指纹给用户看一眼（accept-new 之外的信息展示） */
export async function scanFingerprint({ hostname, port = 22, signal }) {
  const res = await runProcess('ssh-keyscan', ['-p', String(Number(port) || 22), '-T', '5', hostname], {
    timeoutMs: 15_000,
    signal,
  }).catch(() => null)
  if (!res || !res.stdout.trim()) return { ok: false, fingerprints: [], hint: '没能取到服务器指纹（可能端口不通）' }
  const tmp = join(tmpdir(), `dsh-vps-keyscan-${Date.now()}`)
  await writeFile(tmp, res.stdout)
  const fp = await runProcess('ssh-keygen', ['-lf', tmp], { timeoutMs: 10_000 }).catch(() => null)
  await unlink(tmp).catch(() => {})
  return {
    ok: true,
    fingerprints: (fp?.stdout ?? '').split('\n').filter(Boolean),
  }
}

/** 忘掉某台机器的指纹（重装系统后用；永远不自动执行） */
export async function resetHostKey({ hostname, port = 22 }) {
  const target = Number(port) === 22 ? hostname : `[${hostname}]:${Number(port)}`
  const res = await runProcess('ssh-keygen', ['-R', target], { timeoutMs: 10_000 }).catch((e) => ({ exitCode: 1, stderr: e.message }))
  return { ok: res.exitCode === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() }
}

/**
 * 保存一台机器：写 ssh 配置 + hosts.yml，然后体检一次。
 */
export async function saveHost({
  alias,
  hostname,
  port = 22,
  user = 'root',
  identityFile,
  proxyJump = '',
  note = '',
  group = '',
  confirm,
  managed = true,
  previousAlias,
  env = process.env,
  runner,
  probe = true,
}) {
  validateConnection({ alias, hostname, port, user })
  const p = paths(env)
  if (managed) {
    await upsertDropinHost({
      alias,
      hostname,
      port: Number(port),
      user,
      identityFile: identityFile ?? p.defaultKey,
      proxyJump,
      note,
    }, env)
  }

  const doc = await readHosts(env)
  const hosts = { ...doc.hosts }
  if (previousAlias && previousAlias !== alias) delete hosts[previousAlias]
  hosts[alias] = { note, group, confirm, managed }
  const current = doc.current === previousAlias ? alias : doc.current || alias
  await writeHosts({ ...doc, hosts, current }, env)

  const probed = probe ? await probeHost({ alias, env, runner }).catch((e) => ({ ok: false, hint: e.message })) : null
  return { ok: true, alias, probe: probed }
}
