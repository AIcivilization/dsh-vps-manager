// lib/health.js — 插件自己的体检：各部分注册得怎么样、DSH 版本验证过没有、最近出过什么错
//
// 为什么要有（用户提的）：DSH 还在快速迭代，某个接口一变，插件的某一块就会悄悄失效；
// 用户看到的只是「某个按钮没了」「命令没反应」。这里把每一块的注册结果记下来，
// /vps-doctor、设置页「反馈与诊断」、每天的兼容性检查（scripts/compat-smoke.mjs）都读它。
//
// 反馈只生成一个预填好的 GitHub 问题单链接，用户看过、自己提交；**不会自动上传任何东西**。
// 写进链接和本地错误记录的内容先经 maskSecrets 打码，不带机器地址。

import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDirs, paths } from './config.js'
import { maskSecrets } from './terminal.js'

const require = createRequire(import.meta.url)
const VERIFIED = require('./verified-dsh.json')

export const REPO_URL = 'https://github.com/AIcivilization/dsh-vps-manager'
const KEEP_MONTHS = 3
const MAX_ERRORS_PER_BOOT = 50

const state = {
  startedAt: new Date().toISOString(),
  parts: {}, // 名字 → { ok, detail, at }
  form: 'unknown', // desktop | web | unknown
  errorsThisBoot: 0,
}

/** 记一块注册的结果。detail：成功时写数量（如「5 个」），失败时写原因 */
export function markPart(name, ok, detail = '') {
  state.parts[name] = { ok: Boolean(ok), detail: String(detail ?? '').slice(0, 300), at: new Date().toISOString() }
}

export function setForm(form) {
  state.form = form
}

export function parts() {
  return structuredClone(state.parts)
}

// —————————————————————— DSH 版本 ——————————————————————

let versionCache = null

/** 从 file: 地址往上找名字对得上的 package.json，读版本号 */
async function versionNear(fileUrlOrPath, name) {
  let dir = dirname(fileUrlOrPath.startsWith('file:') ? fileURLToPath(fileUrlOrPath) : fileUrlOrPath)
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      if (pkg.name === name && pkg.version) return pkg.version
    } catch {
      // 这一层没有 package.json，往上找
    }
    dir = dirname(dir)
  }
  return ''
}

/**
 * 当前跑着的 DSH 版本，按可靠程度依次试（实测）：
 *   1. 启动 DSH 的就是 @deepseek-ai/dsh/lib/bin.js（dsh web、服务器上的 DSH）：读它自己的版本
 *   2. 解析 @deepseek-ai/dsh/package.json（这个包没有入口，只能按文件取）
 *   3. 退而读 dsh-tools 的版本：DSH Desktop 里各个包版本统一；但 npm 装的 DSH 里子包可能更新
 *      （DSH 0.1.5-rc.2 带的是 dsh-tools 0.1.5-rc.3），所以只作最后手段
 */
export async function dshVersion() {
  if (versionCache !== null) return versionCache
  versionCache = ''
  const entry = String(process.argv[1] ?? '')
  if (/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(entry)) {
    versionCache = await versionNear(entry, '@deepseek-ai/dsh')
    if (versionCache) return versionCache
  }
  for (const [spec, name] of [
    ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh'],
    ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tools'],
    ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm'],
  ]) {
    try {
      versionCache = await versionNear(import.meta.resolve(spec), name)
      if (versionCache) return versionCache
    } catch {
      // 宿主没提供这个包
    }
  }
  return versionCache
}

/** 验证过的 DSH 版本：每天的兼容性检查跑通过、并在真实环境里用过的（lib/verified-dsh.json） */
export function verifiedVersions() {
  return [...VERIFIED.versions]
}

/** @returns {{ version, status: 'verified' | 'unverified' | 'unknown', text }} */
export async function dshStatus() {
  return statusFor(await dshVersion())
}

export function statusFor(version) {
  if (!version) return { version: '', status: 'unknown', text: '读不到 DSH 版本' }
  if (VERIFIED.versions.includes(version)) return { version, status: 'verified', text: `DSH ${version}（已验证）` }
  return {
    version,
    status: 'unverified',
    text: `DSH ${version} 还没经过本插件验证（已验证：${VERIFIED.versions.join('、')}）。用着有问题请点「反馈问题」`,
  }
}

// —————————————————————— 错误记录 ——————————————————————

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function logDir(env) {
  return join(paths(env).base, 'logs')
}

/** 记一条错误到本地（打码后）。一次启动最多记 50 条，免得出错循环把磁盘写满 */
export async function recordError(source, error, env = process.env) {
  if (state.errorsThisBoot >= MAX_ERRORS_PER_BOOT) return
  state.errorsThisBoot += 1
  const message = maskSecrets(String(error?.message ?? error ?? '')).slice(0, 500)
  const line = { at: new Date().toISOString(), source: String(source).slice(0, 60), message }
  try {
    await ensureDirs(env)
    await mkdir(logDir(env), { recursive: true, mode: 0o700 })
    await appendFile(join(logDir(env), `errors-${monthKey()}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 })
  } catch {
    // 记不下来也不能影响插件本身
  }
}

/** 最近的错误（新的在前） */
export async function recentErrors(limit = 10, env = process.env) {
  let files = []
  try {
    files = (await readdir(logDir(env))).filter((f) => /^errors-\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse()
  } catch {
    return []
  }
  const out = []
  for (const file of files) {
    const text = await readFile(join(logDir(env), file), 'utf8').catch(() => '')
    for (const raw of text.split('\n').filter(Boolean).reverse()) {
      try {
        out.push(JSON.parse(raw))
      } catch {
        // 坏行跳过
      }
      if (out.length >= limit) return out
    }
  }
  return out
}

/** 只留最近 3 个月的错误记录 */
export async function pruneErrors(env = process.env) {
  let files = []
  try {
    files = (await readdir(logDir(env))).filter((f) => /^errors-\d{4}-\d{2}\.jsonl$/.test(f))
  } catch {
    return 0
  }
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - KEEP_MONTHS)
  const key = monthKey(cutoff)
  let removed = 0
  for (const f of files) {
    if (f.slice(7, 14) < key) {
      await unlink(join(logDir(env), f)).catch(() => {})
      removed += 1
    }
  }
  return removed
}

// —————————————————————— 汇总与反馈链接 ——————————————————————

const PART_LABEL = {
  tools: 'AI 工具',
  commands: '/vps- 命令',
  skill: '操作规则（skill）',
  vpsMode: 'VPS 模式',
  guard: '本机 bash 守卫',
  routes: '设置页接口',
  terminal: '对话里的终端',
}

export function partLabel(name) {
  return PART_LABEL[name] ?? name
}

/** 插件体检汇总：/vps-doctor、设置页、兼容性检查共用 */
export async function diagnostics(env = process.env) {
  const pkg = require('../package.json')
  const dsh = await dshStatus()
  const errors = await recentErrors(10, env)
  const failed = Object.entries(state.parts).filter(([, p]) => !p.ok).map(([name]) => name)
  const doc = await import('./config.js').then((c) => c.readHosts(env)).catch(() => null)
  const diag = {
    plugin: pkg.version,
    dsh,
    form: state.form,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    startedAt: state.startedAt,
    parts: Object.fromEntries(Object.entries(state.parts).map(([n, p]) => [n, { ...p, label: partLabel(n) }])),
    failedParts: failed,
    machines: doc ? Object.keys(doc.hosts).length : null,
    errors,
  }
  diag.feedbackUrl = feedbackUrl(diag)
  diag.suggestUrl = `${REPO_URL}/issues/new?template=feature_request.yml`
  return diag
}

const FORM_LABEL = { desktop: 'DSH Desktop', web: 'dsh web', unknown: '未知' }

/** 给问题单用的诊断文字：版本、注册情况、最近错误。不含机器地址，错误先打码 */
export function diagnosticsText(diag) {
  const lines = [
    `插件 ${diag.plugin} · DSH ${diag.dsh.version || '未知'}（${diag.dsh.status}）· ${FORM_LABEL[diag.form] ?? diag.form}`,
    `系统 ${diag.platform} · Node ${diag.node} · 机器 ${diag.machines ?? '?'} 台`,
    `注册：${Object.entries(diag.parts).map(([n, p]) => `${partLabel(n)} ${p.ok ? '✓' : `✗ ${p.detail}`}`).join('；') || '（没有记录）'}`,
  ]
  if (diag.errors.length) {
    lines.push('最近错误：')
    for (const e of diag.errors.slice(0, 5)) lines.push(`- ${e.at.slice(0, 16).replace('T', ' ')} [${e.source}] ${e.message.slice(0, 160)}`)
  }
  return maskSecrets(lines.join('\n'))
}

/** 预填好的问题单链接（用户打开后自己看、自己提交） */
export function feedbackUrl(diag) {
  const q = new URLSearchParams({
    template: 'bug_report.yml',
    'dsh-version': diag.dsh.version || '',
    'plugin-version': diag.plugin,
    os: diag.platform,
    diagnostics: diagnosticsText(diag).slice(0, 2500),
  })
  return `${REPO_URL}/issues/new?${q}`
}
