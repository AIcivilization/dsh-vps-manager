// 插件自己的更新：GitHub 上发了新版本就在设置页提示；点「更新」交给 DSH 自己的插件管理器
// （和 DSH「插件」页同一套：带锁跑 pnpm、失败自动还原）去装 npm 上的那个版本，装好后重启 DSH 生效。
//
// 版本从两处看：GitHub 的最新发布（发版先发这里，提示以它为准）和 npm（真正能装的）。
// npm 还没同步到新版时只提示、不让点，免得装失败。查询结果存本机 6 小时，点「检查更新」才马上重查。
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { atomicWrite, dshHome, dshPluginCommand } from './config.js'
import { L } from './i18n.js'

const require = createRequire(import.meta.url)
// 启动时加载的版本；磁盘上的可能更新（装了新版还没重启）
const LOADED_VERSION = require('../package.json').version

export const PACKAGE = 'dsh-vps-manager'
export const RELEASES_URL = 'https://github.com/AIcivilization/dsh-vps-manager/releases'
const GITHUB_LATEST = 'https://api.github.com/repos/AIcivilization/dsh-vps-manager/releases/latest'
// npm 官方源连不上（国内常见）就问镜像
const NPM_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 6000
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 比较两个 x.y.z(-pre) 版本：a 新返回正数，a 旧返回负数；同一个 x.y.z 时正式版比预发布版新 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v ?? '').replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return d
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

const newest = (...versions) => versions.filter(Boolean).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b), '')

async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': `${PACKAGE}/${LOADED_VERSION}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** GitHub 上最新的正式发布 */
async function latestOnGithub(fetchImpl) {
  const data = await fetchJson(fetchImpl, GITHUB_LATEST)
  const version = String(data?.tag_name ?? '').replace(/^v/, '')
  if (!VERSION_RE.test(version)) throw new Error('no version')
  return { version, title: String(data?.name ?? ''), url: String(data?.html_url ?? `${RELEASES_URL}/tag/v${version}`), publishedAt: data?.published_at ?? null }
}

/** npm 上 latest 是哪个版本（能装的就是它） */
async function latestOnNpm(fetchImpl) {
  let last
  for (const registry of NPM_REGISTRIES) {
    try {
      const data = await fetchJson(fetchImpl, `${registry}/${PACKAGE}/latest`)
      if (VERSION_RE.test(String(data?.version ?? ''))) return { version: data.version, registry }
    } catch (error) {
      last = error
    }
  }
  throw last ?? new Error('no registry answered')
}

/** 磁盘上现在装的版本（不走 require 缓存） */
async function installedVersion() {
  try {
    return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version ?? ''
  } catch {
    return ''
  }
}

const cacheFile = (env) => join(dshHome(env), 'vps-manager', 'update.json')

async function readCache(env) {
  try {
    return JSON.parse(await readFile(cacheFile(env), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 有没有新版本。默认用 6 小时内查过的结果；force 时马上重查。网络不通不报错，只是标出查不到。
 * profile 是当前 DSH profile 的名字，只用来拼给用户自己执行的命令（见 dshPluginCommand）
 * @returns {{ running, installed, restartPending, latest, github, npm, available, installable, checkedAt, offline }}
 */
export async function checkUpdate({ env = process.env, force = false, fetchImpl = globalThis.fetch, now = Date.now, running = LOADED_VERSION, installed, profile } = {}) {
  let cache = await readCache(env)
  const fresh = cache && now() - Date.parse(cache.checkedAt ?? '') < CHECK_EVERY_MS
  let offline = false
  if (force || !fresh) {
    const [github, npm] = await Promise.allSettled([latestOnGithub(fetchImpl), latestOnNpm(fetchImpl)])
    if (github.status === 'fulfilled' || npm.status === 'fulfilled') {
      // 一边查不到就沿用上次那一边的结果
      cache = {
        checkedAt: new Date(now()).toISOString(),
        github: github.status === 'fulfilled' ? github.value : cache?.github ?? null,
        npm: npm.status === 'fulfilled' ? npm.value : cache?.npm ?? null,
      }
      try {
        await mkdir(dirname(cacheFile(env)), { recursive: true })
        await atomicWrite(cacheFile(env), `${JSON.stringify(cache, null, 2)}\n`)
      } catch {
        // 存不下就下次再查
      }
    } else {
      offline = true
    }
  }
  const disk = installed ?? (await installedVersion())
  // 装了新版还没重启：跑着的是老版本，磁盘上已经是新的
  const restartPending = disk && compareVersions(disk, running) > 0 ? disk : ''
  const current = newest(running, disk)
  const latest = newest(cache?.github?.version, cache?.npm?.version)
  const available = Boolean(latest) && compareVersions(latest, current) > 0
  // 能装的是 npm 上那个，并且得比现在的新
  const installable = cache?.npm?.version && compareVersions(cache.npm.version, current) > 0 ? cache.npm.version : ''
  return {
    running,
    installed: disk,
    restartPending,
    latest,
    github: cache?.github ?? null,
    npm: cache?.npm ?? null,
    available,
    installable,
    checkedAt: cache?.checkedAt ?? null,
    offline,
    releasesUrl: RELEASES_URL,
    command: dshPluginCommand(`add ${PACKAGE}@${installable || latest || 'latest'}`, profile),
  }
}

/**
 * 装新版：交给 DSH 的插件管理器（pluginManager 服务）。它带锁跑 pnpm，失败会把 profile 还原；
 * 已经装着的包换了版本要重启 DSH 才生效（它会答复 restart-required）。
 */
export async function runUpdate({ pluginManager, version, running = LOADED_VERSION, requestId, profile }) {
  if (!VERSION_RE.test(String(version ?? ''))) throw new Error(L('版本号不对', 'Invalid version'))
  if (compareVersions(version, running) <= 0) throw new Error(L(`v${version} 不比现在的 v${running} 新`, `v${version} is not newer than the current v${running}`))
  const command = dshPluginCommand(`add ${PACKAGE}@${version}`, profile)
  if (typeof pluginManager?.installBundle !== 'function') {
    return { ok: false, code: 'no-manager', command }
  }
  const result = await pluginManager.installBundle(`${PACKAGE}@${version}`, { enabled: true, ...(requestId ? { requestId } : {}) })
  if (result?.application === 'failed' || result?.application === 'cancelled' || result?.error) {
    const code = result?.error?.code ?? result?.application ?? 'failed'
    const detail = String(result?.error?.diagnostic ?? result?.packageResult?.output ?? '').trim().split('\n').slice(-6).join('\n').slice(-800)
    return { ok: false, code, detail, command }
  }
  // 换的是已经装着的包：新代码要重启 DSH 才会加载
  return { ok: true, version, restart: true }
}
