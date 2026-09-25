// lib/onboarding.js — 添加机器向导（设计 5.2）
//
// 认证只支持密钥。但「第一次把公钥放上去」通常需要密码，这一步由用户自己完成，
// 插件全程不接触密码：
//   A 服务商后台添加公钥（新机器）
//   B 已能登录 → 复制一行命令到服务器上执行
//   C 只有密码 → 在系统终端里跑 ssh-copy-id，用户自己输密码
//   D 在添加表单里直接填密码（最常见，用户定的）：插件拿它登录一次，把公钥放上去，
//     之后一律用钥匙。密码只进那一次 ssh 子进程的环境变量，经 SSH_ASKPASS 小脚本交给 ssh：
//     不写盘、不进日志、不保存，用完就丢
//
// 插件自己用专用钥匙 ~/.ssh/dsh_vps_ed25519，不动用户原有的钥匙。

import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths, upsertDropinHost, validateConnection, writeHosts, readHosts } from './config.js'
import { runProcess } from './spawn.js'
import { probeHost } from './actions.js'
import { shellQuote } from './payload.js'
import { classifySshFailure } from './ssh.js'

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

// —————————————————————— D：填密码，插件帮你放公钥 ——————————————————————

const PUBKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\n'\\]*)?$/

/**
 * 在服务器上把一行公钥放进 authorized_keys：已经有就不重复加；原文件末尾没换行先补一个
 * （不然新公钥会接在上一行后面，两把都失效）；CentOS 这类开了 SELinux 的顺手修一下标签。
 */
export function authorizeScript(pubkey) {
  const key = String(pubkey ?? '').trim()
  if (!PUBKEY_RE.test(key)) throw new Error('公钥格式不对')
  return [
    'umask 077',
    'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
    'F="$HOME/.ssh/authorized_keys"; touch "$F" && chmod 600 "$F"',
    `K=${shellQuote(key)}`,
    'if ! grep -qxF "$K" "$F"; then',
    '  if [ -s "$F" ] && [ "$(tail -c 1 "$F" | wc -l | tr -d " ")" = 0 ]; then echo >> "$F"; fi',
    '  printf "%s\\n" "$K" >> "$F"',
    'fi',
    'command -v restorecon >/dev/null 2>&1 && restorecon -R "$HOME/.ssh" >/dev/null 2>&1',
    'echo DSHVPS_KEY_OK',
  ].join('\n')
}

/** 用密码登录失败时说人话：密码不对、服务器不许密码登录，和其余连接问题分开 */
export function classifyPasswordFailure(stderr = '', exitCode = null) {
  const text = String(stderr)
  if (/Permission denied \(publickey\)|no supported authentication methods available/i.test(text)) {
    return {
      reason: 'password_disabled',
      hint: '这台服务器关掉了密码登录，只认密钥。展开下面的「没有密码？」，用服务商后台或已有的登录方式把公钥放上去',
    }
  }
  if (/Permission denied/i.test(text)) {
    return { reason: 'wrong_password', hint: '密码不对，或者这个用户不允许用密码登录（有的系统默认禁止 root 用密码登录）' }
  }
  return classifySshFailure(text, exitCode)
}

/**
 * 用密码登录一次，把插件的公钥放上去。
 * 密码只出现在这一次 ssh 子进程的环境变量里；SSH_ASKPASS 指向一个不含任何秘密的小脚本，
 * 它把环境变量里的密码交给 ssh。小脚本所在的临时目录用完就删。
 */
export async function installKeyWithPassword({
  hostname, port = 22, user = 'root', password, pubkey, env = process.env, platform = process.platform, run = runProcess,
}) {
  if (!password) throw new Error('没有填密码')
  const target = validateConnection({ hostname, port, user })
  const script = authorizeScript(pubkey)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-askpass-'))
  const helper = join(dir, platform === 'win32' ? 'askpass.cmd' : 'askpass.sh')
  try {
    if (platform === 'win32') {
      // Windows 的 ssh 也认 SSH_ASKPASS；批处理的 echo 会吃掉特殊字符，所以让 Node（DSH 自己带的）来输出
      await writeFile(helper, `@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath}" -e "process.stdout.write(process.env.DSH_VPS_PW+'\\n')"\r\n`)
    } else {
      await writeFile(helper, '#!/bin/sh\nprintf \'%s\\n\' "$DSH_VPS_PW"\n', { mode: 0o700 })
    }
    const args = [
      '-T',
      '-p', String(target.port),
      '-o', 'PreferredAuthentications=keyboard-interactive,password',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=10',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      '-o', 'LogLevel=ERROR',
      '--', `${target.user || 'root'}@${target.hostname}`,
      `sh -c ${shellQuote(script)}`,
    ]
    const res = await run('ssh', args, {
      env: { ...env, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: env.DISPLAY || ':0', DSH_VPS_PW: String(password) },
      timeoutMs: 40_000,
    })
    if (res.exitCode === 0 && String(res.stdout).includes('DSHVPS_KEY_OK')) return { ok: true }
    return { ok: false, ...classifyPasswordFailure(res.stderr, res.exitCode) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 别名没填：按地址生成一个（1.2.3.4 → 1-2-3-4，vps.example.com → vps-example-com） */
export function autoAlias(hostname) {
  const base = String(hostname ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return base || 'vps'
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
