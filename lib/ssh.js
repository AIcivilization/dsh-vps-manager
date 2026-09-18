// lib/ssh.js — ssh 参数拼装、目标校验、失败分类（设计 8.2 / 8.3）
//
// 关键点：
//   - 每一条 -o 都必须显式给出：本机 `ssh -G` 实测默认是 batchmode no、
//     stricthostkeychecking ask、controlmaster false，少一条就会挂住或污染输出。
//   - 别名前面加 `--`，且只接受白名单字符：别名若以 `-` 开头（例如
//     `-oProxyCommand=...`）会被 ssh 当成选项，在本机执行命令。
//   - 环境变量不走 `-o SetEnv`（依赖服务端 AcceptEnv，多数系统会丢弃），改在载荷里 export。

import { runProcess, ProcessError } from './spawn.js'
import { REMOTE_COMMAND } from './payload.js'

export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export class SshError extends Error {
  constructor(reason, message, extra = {}) {
    super(message)
    this.name = 'SshError'
    this.reason = reason
    Object.assign(this, extra)
  }
}

export function assertAlias(alias) {
  if (!ALIAS_RE.test(String(alias ?? ''))) {
    throw new SshError('invalid_alias', `机器别名不合法：${alias}`)
  }
  return alias
}

/**
 * 基础 ssh 选项。
 * @param controlMaster false 时彻底绕开连接复用 —— 连通性保险测试必须这样，
 *        否则会复用改防火墙之前就建好的主连接，测出假的“能连”。
 */
export function baseOptions({ controlMaster = true, connectTimeout = 10 } = {}) {
  const opts = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Number(connectTimeout) || 10}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'LogLevel=ERROR',
  ]
  if (controlMaster) {
    opts.push(
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPath=~/.ssh/cm-%C',
      '-o', 'ControlPersist=10m',
    )
  } else {
    opts.push('-o', 'ControlMaster=no', '-o', 'ControlPath=none')
  }
  return opts
}

/** 完整 argv：[...选项, '--', 别名, 'sh -s'] */
export function sshArgs(alias, options = {}) {
  assertAlias(alias)
  const args = baseOptions(options)
  if (options.configFile) args.push('-F', options.configFile)
  if (Array.isArray(options.extraOptions)) {
    for (const opt of options.extraOptions) args.push('-o', String(opt))
  }
  args.push('--', alias, options.command ?? REMOTE_COMMAND)
  return args
}

const FAILURES = [
  [/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i, 'host_key_changed',
    '服务器指纹变了：可能是重装了系统，也可能是连接被劫持。确认刚重装过的话，在机器设置页点「重置指纹」'],
  [/Permission denied \(publickey|Too many authentication failures|no mutual signature/i, 'auth_failed',
    '认证被拒：公钥可能还没放到服务器上，或者用户名不对'],
  [/passphrase|incorrect passphrase|error in libcrypto|agent refused operation/i, 'key_passphrase',
    '这把钥匙有密码短语或需要 agent：先执行 ssh-add 再试'],
  [/Connection refused/i, 'refused', '端口拒绝连接：sshd 可能没在跑，或者端口填错了'],
  [/Connection timed out|Operation timed out|timed out while waiting/i, 'timeout',
    '连接超时：机器可能关机了，或者被防火墙挡住了'],
  [/Could not resolve hostname|Name or service not known|nodename nor servname/i, 'dns',
    '域名解析不了：检查地址是否填错'],
  [/Network is unreachable|No route to host/i, 'unreachable', '网络不可达'],
  [/Connection closed by|Connection reset by peer|kex_exchange_identification/i, 'closed',
    '连接被服务器关掉了：可能触发了 fail2ban 之类的防护'],
  [/Bad configuration option|bad configuration/i, 'config_error', 'ssh 配置有问题'],
  [/Could not open a connection to your authentication agent/i, 'agent_missing', '没有可用的 ssh-agent'],
]

/** 把 ssh 自己的报错分类成可解释的原因 */
export function classifySshFailure(stderr = '', exitCode = null) {
  const text = String(stderr)
  // 解析不了的「域名」其实是机器别名（没有点、不是 IP）：不是地址填错，是 SSH 配置里没有这台机器
  const unresolved = /Could not resolve hostname ([^:\s]+)/i.exec(text)?.[1]
  if (unresolved && ALIAS_RE.test(unresolved) && !unresolved.includes('.')) {
    return {
      reason: 'alias_missing',
      hint: `SSH 配置里找不到「${unresolved}」这台机器（~/.ssh/config.d/dsh-vps.conf 或 ~/.ssh/config 顶部的 Include 行不见了，常见于卸载后重装）。重启 DSH 会自动从备份恢复；恢复不了就到 设置 → VPS 管理 删除这台再重新添加`,
    }
  }
  for (const [re, reason, hint] of FAILURES) {
    if (re.test(text)) return { reason, hint }
  }
  if (exitCode === 255) {
    return { reason: 'ssh_unknown', hint: 'ssh 没能连上，原因不明；完整报错见 stderr' }
  }
  return { reason: 'unknown', hint: '未识别的失败' }
}

/**
 * 跑一次 ssh，把载荷从 stdin 喂进去。
 * 注意：这里不解析业务结果，交给 payload.parseOutput。
 */
export async function sshRun(alias, payload, options = {}) {
  const args = sshArgs(alias, options)
  try {
    return await runProcess('ssh', args, {
      input: payload,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 0,
      onStdout: options.onStdout,
      head: options.head,
      tail: options.tail,
    })
  } catch (error) {
    if (error instanceof ProcessError && error.code === 'not_found') {
      throw new SshError('no_ssh_client', '本机找不到 ssh 命令')
    }
    throw error
  }
}

/** `ssh -G` 的权威解析结果：免费、无解析 bug */
export async function sshResolve(alias, options = {}) {
  assertAlias(alias)
  const args = ['-G']
  if (options.configFile) args.push('-F', options.configFile)
  args.push('--', alias)
  const res = await runProcess('ssh', args, { signal: options.signal, timeoutMs: 10_000 })
  if (res.exitCode !== 0) {
    throw new SshError('resolve_failed', `无法解析 ${alias} 的 ssh 配置：${res.stderr.trim()}`)
  }
  const config = {}
  for (const line of res.stdout.split('\n')) {
    const i = line.indexOf(' ')
    if (i <= 0) continue
    const key = line.slice(0, i).toLowerCase()
    const value = line.slice(i + 1).trim()
    if (key === 'identityfile') {
      config.identityfile = config.identityfile ?? []
      config.identityfile.push(value)
    } else if (config[key] === undefined) {
      config[key] = value
    }
  }
  return {
    hostname: config.hostname ?? alias,
    port: Number(config.port ?? 22),
    user: config.user ?? '',
    identityFiles: config.identityfile ?? [],
    proxyJump: config.proxyjump && config.proxyjump !== 'none' ? config.proxyjump : '',
    raw: config,
  }
}

/** 显示用：hk · 1.2.3.4:22 */
export function describeTarget(alias, resolved) {
  const port = resolved?.port && resolved.port !== 22 ? `:${resolved.port}` : ''
  return `${alias} · ${resolved?.hostname ?? '?'}${port}`
}

/** 改了连接设置后关掉旧的主连接，让新设置立刻生效 */
export async function sshCloseMaster(alias, options = {}) {
  assertAlias(alias)
  const args = [...baseOptions({ controlMaster: true }), '-O', 'exit', '--', alias]
  try {
    const res = await runProcess('ssh', args, { timeoutMs: 5000, signal: options.signal })
    return res.exitCode === 0
  } catch {
    return false
  }
}
