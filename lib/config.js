// lib/config.js — 插件自己的配置与 ~/.ssh/config 的读写（设计第四节）
//
// 分工：~/.ssh/config 管「怎么连」，hosts.yml 管「是什么、怎么管」，
// state.json 管「探测到了什么」（插件自管，删了会重新探测）。
//
// 插件写的机器放在 ~/.ssh/config.d/dsh-vps.conf，只在用户的 ~/.ssh/config 最顶部
// 加一行 Include（必须在第一个 Host / Match 之前，否则就变成条件包含）。

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import YAML from 'yaml'

export const CONFIRM_LEVELS = ['careful', 'relaxed', 'auto']
export const DEFAULT_CONFIRM = 'careful'
export const DEFAULT_SAFETY_NET_SECONDS = 120

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HOSTNAME_RE = /^[A-Za-z0-9._:-]{1,253}$/
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/
const INCLUDE_LINE = 'Include config.d/dsh-vps.conf'
const INCLUDE_COMMENT = '# Added by dsh-vps-manager'

export class ConfigError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

// —— 路径 ——

/** $DSH_HOME 必须读环境变量解析后的值，不能硬编码 ~/.dsh */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME?.trim()
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.dsh')
}

export function paths(env = process.env) {
  const home = env.HOME ? resolve(env.HOME) : homedir()
  const base = join(dshHome(env), 'vps-manager')
  return {
    home,
    base,
    hostsFile: join(base, 'hosts.yml'),
    recipesDir: join(base, 'recipes'),
    stateFile: join(base, 'state.json'),
    trustFile: join(base, 'trust.json'),
    auditDir: join(base, 'audit'),
    spillDir: join(base, 'spill'),
    sshDir: join(home, '.ssh'),
    sshConfig: join(home, '.ssh', 'config'),
    sshDropinDir: join(home, '.ssh', 'config.d'),
    sshDropin: join(home, '.ssh', 'config.d', 'dsh-vps.conf'),
    defaultKey: join(home, '.ssh', 'dsh_vps_ed25519'),
  }
}

export async function ensureDirs(env = process.env) {
  const p = paths(env)
  for (const dir of [p.base, p.recipesDir, p.auditDir, p.spillDir]) {
    await mkdir(dir, { recursive: true })
  }
  await chmod(p.base, 0o700).catch(() => {})
  return p
}

/** 原子写：临时文件 + rename。崩在写一半会毁掉整个文件 */
export async function atomicWrite(file, content, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, { mode })
  await rename(tmp, file)
}

const exists = (file) => access(file, constants.F_OK).then(() => true, () => false)

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// —— hosts.yml ——

function normalizeHosts(doc) {
  const out = {
    schema: 1,
    current: typeof doc?.current === 'string' ? doc.current : '',
    settings: {
      confirm: CONFIRM_LEVELS.includes(doc?.settings?.confirm) ? doc.settings.confirm : DEFAULT_CONFIRM,
      safetyNetSeconds: Number(doc?.settings?.safetyNetSeconds) > 0
        ? Math.floor(Number(doc.settings.safetyNetSeconds))
        : DEFAULT_SAFETY_NET_SECONDS,
      allowPanelExecOnLan: doc?.settings?.allowPanelExecOnLan === true,
    },
    groups: {},
    hosts: {},
  }
  for (const [name, group] of Object.entries(doc?.groups ?? {})) {
    out.groups[name] = {
      confirm: CONFIRM_LEVELS.includes(group?.confirm) ? group.confirm : undefined,
    }
  }
  for (const [alias, host] of Object.entries(doc?.hosts ?? {})) {
    if (!ALIAS_RE.test(alias)) continue
    out.hosts[alias] = {
      note: typeof host?.note === 'string' ? host.note : '',
      group: typeof host?.group === 'string' ? host.group : '',
      confirm: CONFIRM_LEVELS.includes(host?.confirm) ? host.confirm : undefined,
      managed: host?.managed !== false, // 连接配置是不是插件写的
    }
  }
  if (out.current && !out.hosts[out.current]) out.current = ''
  return out
}

export async function readHosts(env = process.env) {
  const { hostsFile } = paths(env)
  if (!(await exists(hostsFile))) return normalizeHosts({})
  const text = await readFile(hostsFile, 'utf8')
  let doc
  try {
    doc = YAML.parse(text)
  } catch (error) {
    throw new ConfigError('hosts_yaml_invalid', `hosts.yml 格式有误：${error.message}`)
  }
  return normalizeHosts(doc)
}

export async function writeHosts(doc, env = process.env) {
  const normalized = normalizeHosts(doc)
  const body = YAML.stringify({
    schema: 1,
    current: normalized.current || undefined,
    settings: normalized.settings,
    groups: Object.keys(normalized.groups).length ? normalized.groups : undefined,
    hosts: normalized.hosts,
  })
  const header = [
    '# dsh-vps-manager 的机器清单（可以手工编辑）',
    '# confirm: careful 谨慎 | relaxed 放手 | auto 全自动；优先级 机器 > 组 > 全局',
    '',
  ].join('\n')
  await atomicWrite(paths(env).hostsFile, header + body)
  return normalized
}

export function getHost(hostsDoc, alias) {
  if (!ALIAS_RE.test(String(alias ?? ''))) throw new ConfigError('invalid_alias', `机器别名不合法：${alias}`)
  const host = hostsDoc.hosts[alias]
  if (!host) {
    const known = Object.keys(hostsDoc.hosts).join('、') || '（还没有添加任何机器）'
    throw new ConfigError('unknown_host', `没有登记过这台机器：${alias}。已登记的有：${known}`)
  }
  return host
}

/** 确认档位：机器 > 组 > 全局 */
export function effectiveConfirm(hostsDoc, alias) {
  const host = hostsDoc.hosts[alias]
  if (host?.confirm) return host.confirm
  const group = host?.group ? hostsDoc.groups[host.group] : undefined
  if (group?.confirm) return group.confirm
  return hostsDoc.settings.confirm ?? DEFAULT_CONFIRM
}

// —— state.json / trust.json ——

async function readJson(file, fallback) {
  if (!(await exists(file))) return fallback
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export const readState = (env = process.env) => readJson(paths(env).stateFile, { schema: 1, hosts: {} })
export const writeState = (state, env = process.env) =>
  atomicWrite(paths(env).stateFile, `${JSON.stringify(state, null, 2)}\n`)

export const readTrust = (env = process.env) => readJson(paths(env).trustFile, { schema: 1, hashes: {} })
export const writeTrust = (trust, env = process.env) =>
  atomicWrite(paths(env).trustFile, `${JSON.stringify(trust, null, 2)}\n`)

export async function isTrusted(hash, env = process.env) {
  const trust = await readTrust(env)
  return Boolean(trust.hashes?.[hash])
}

export async function trustHash(hash, info = {}, env = process.env) {
  const trust = await readTrust(env)
  trust.hashes = trust.hashes ?? {}
  trust.hashes[hash] = { ...info, trustedAt: new Date().toISOString() }
  await writeTrust(trust, env)
  return trust
}

// —— 连接字段校验（机器设置页与向导共用）——

export function validateConnection({ hostname, port, user, alias }) {
  if (alias !== undefined && !ALIAS_RE.test(String(alias))) {
    throw new ConfigError('invalid_alias', '别名只能用字母、数字、点、下划线、连字符，且不能以连字符开头')
  }
  if (!HOSTNAME_RE.test(String(hostname ?? ''))) {
    throw new ConfigError('invalid_hostname', `地址不合法：${hostname}`)
  }
  const p = Number(port ?? 22)
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new ConfigError('invalid_port', `端口不合法：${port}`)
  }
  if (user !== undefined && user !== '' && !USER_RE.test(String(user))) {
    throw new ConfigError('invalid_user', `用户名不合法：${user}`)
  }
  return { hostname: String(hostname), port: p, user: user ? String(user) : '' }
}

// —— ~/.ssh/config ——

/** 扫描别名。跳过通配符与 Match 块，跟随 Include，剥掉行尾注释 */
export async function scanSshAliases(configFile, seen = new Set()) {
  const file = resolve(configFile)
  if (seen.has(file) || seen.size > 32) return []
  seen.add(file)
  if (!(await exists(file))) return []
  const text = await readFile(file, 'utf8')
  const aliases = []
  let inMatch = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const [keyword, ...rest] = line.split(/\s+/)
    const key = keyword.toLowerCase()
    if (key === 'match') {
      inMatch = true
      continue
    }
    if (key === 'host') {
      inMatch = false
      for (const token of rest) {
        if (/[*?!]/.test(token)) continue
        if (ALIAS_RE.test(token)) aliases.push({ alias: token, source: file })
      }
      continue
    }
    if (key === 'include' && !inMatch) {
      for (const pattern of rest) {
        const expanded = pattern.startsWith('~')
          ? join(homedir(), pattern.slice(1))
          : isAbsolute(pattern) ? pattern : join(dirname(file), pattern)
        for (const target of await expandGlob(expanded)) {
          aliases.push(...(await scanSshAliases(target, seen)))
        }
      }
    }
  }
  return aliases
}

async function expandGlob(pattern) {
  if (!/[*?]/.test(pattern)) return [pattern]
  const dir = dirname(pattern)
  const base = dirname(pattern) === pattern ? '' : pattern.slice(dir.length + 1)
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  try {
    const entries = await readdir(dir)
    return entries.filter((e) => re.test(e)).map((e) => join(dir, e))
  } catch {
    return []
  }
}

/** 代码托管之类的条目不是 VPS，导入候选里默认排除 */
const NON_VPS = /^(github|gitlab|bitbucket|codeberg|gitee|git|ssh)\./i

export async function importCandidates(env = process.env) {
  const p = paths(env)
  const all = await scanSshAliases(p.sshConfig)
  const managed = new Set((await readHosts(env)).hosts ? Object.keys((await readHosts(env)).hosts) : [])
  const seen = new Set()
  return all.filter(({ alias, source }) => {
    if (seen.has(alias) || managed.has(alias) || NON_VPS.test(alias)) return false
    if (source === p.sshDropin) return false
    seen.add(alias)
    return true
  })
}

function hostBlock({ alias, hostname, port, user, identityFile, proxyJump, note }) {
  const lines = [`Host ${alias}`]
  if (note) lines.push(`  # ${note.replace(/\n/g, ' ')}`)
  lines.push(`  HostName ${hostname}`)
  if (port && port !== 22) lines.push(`  Port ${port}`)
  if (user) lines.push(`  User ${user}`)
  if (identityFile) {
    lines.push(`  IdentityFile ${identityFile}`)
    lines.push('  IdentitiesOnly yes')
  }
  if (proxyJump) lines.push(`  ProxyJump ${proxyJump}`)
  return `${lines.join('\n')}\n`
}

export async function readDropin(env = process.env) {
  const { sshDropin } = paths(env)
  if (!(await exists(sshDropin))) return ''
  return readFile(sshDropin, 'utf8')
}

function splitBlocks(text) {
  const blocks = new Map()
  let current = null
  let buffer = []
  const flush = () => {
    if (current) blocks.set(current, buffer.join('\n').replace(/\n+$/, '\n'))
  }
  for (const line of text.split('\n')) {
    const m = /^Host\s+(\S+)\s*$/.exec(line.trim())
    if (m) {
      flush()
      current = m[1]
      buffer = [line]
    } else if (current) {
      buffer.push(line)
    }
  }
  flush()
  return blocks
}

/** 写入或更新插件自己的 Host 块（不碰用户原有内容） */
export async function upsertDropinHost(entry, env = process.env) {
  const p = paths(env)
  validateConnection(entry)
  await mkdir(p.sshDropinDir, { recursive: true, mode: 0o700 })
  const existing = await readDropin(env)
  if (existing) await copyFile(p.sshDropin, `${p.sshDropin}.bak`).catch(() => {})
  const blocks = splitBlocks(existing)
  blocks.set(entry.alias, hostBlock(entry))
  const header = '# 由 dsh-vps-manager 维护，手工改动可能被覆盖\n\n'
  await atomicWrite(p.sshDropin, header + [...blocks.values()].join('\n'), 0o600)
  await ensureInclude(env)
  return p.sshDropin
}

export async function removeDropinHost(alias, env = process.env) {
  const p = paths(env)
  const existing = await readDropin(env)
  if (!existing) return false
  const blocks = splitBlocks(existing)
  if (!blocks.delete(alias)) return false
  const header = '# 由 dsh-vps-manager 维护，手工改动可能被覆盖\n\n'
  await atomicWrite(p.sshDropin, header + [...blocks.values()].join('\n'), 0o600)
  return true
}

/**
 * 在 ~/.ssh/config 最顶部加一行 Include（先备份）。
 * 放在第一个 Host / Match 之后就会变成条件包含，所以必须在最前面。
 */
export async function ensureInclude(env = process.env) {
  const p = paths(env)
  const text = (await exists(p.sshConfig)) ? await readFile(p.sshConfig, 'utf8') : ''
  if (text.split('\n').some((line) => line.trim().toLowerCase() === INCLUDE_LINE.toLowerCase())) {
    return { changed: false, backup: null }
  }
  let backup = null
  if (text) {
    backup = `${p.sshConfig}.dsh-bak`
    await copyFile(p.sshConfig, backup)
  }
  const next = `${INCLUDE_COMMENT}\n${INCLUDE_LINE}\n\n${text}`
  await mkdir(p.sshDir, { recursive: true, mode: 0o700 })
  await atomicWrite(p.sshConfig, next, 0o600)
  return { changed: true, backup }
}

/** 用户不想动 ~/.ssh/config 时的退路：插件自带一份配置，Include 回用户的 */
export async function writeStandaloneConfig(env = process.env) {
  const p = paths(env)
  const body = [
    '# dsh-vps-manager 专用 ssh 配置（用 -F 指定）',
    '# -F 会让 ssh 忽略默认的用户配置与系统配置，所以这里手动 Include 回来',
    `Include ${p.sshDropin}`,
    `Include ${p.sshConfig}`,
    'Include /etc/ssh/ssh_config',
    '',
  ].join('\n')
  const file = join(p.base, 'ssh_config')
  await atomicWrite(file, body)
  return file
}

export async function removeFile(file) {
  await rm(file, { force: true })
}
