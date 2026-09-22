// lib/routes.js — 设置页路由 /api-vps/*（设计第三节「界面 ↔ host 通信」）
//
// 界面没有 Session 绑定，调 host 只能走 HTTP。而 dsh-host-webserver 本身没有任何
// 鉴权代码，且允许绑定 0.0.0.0 —— 所以这里必须自己做三件事：
//   1. 每次启动生成随机 token，经 tapIndex 注入页面；所有路由校验 x-dsh-vps-token
//      （跨站网页读不到它）
//   2. 只收 application/json（强制浏览器预检）+ 同源校验（Origin 的 host 必须等于
//      请求的 Host）
//   3. **路由永远不提供自由命令执行和改文件**；绑定在 0.0.0.0 时，会改东西的路由
//      默认关闭（页面降级为只读），设置里可以手动打开
//
// 用户在设置页里按下「保存」本身就是同意，所以走 preApproved（界面弹不出审批框：
// 审批要求处于未结束的轮次中）。

import { randomBytes } from 'node:crypto'
import { hostsAction, probeHost, probeIfUnknown, recipeAction, taskAction } from './actions.js'
import {
  importCandidates,
  paths,
  readHosts,
  readState,
  removeDropinHost,
  writeHosts,
} from './config.js'
import {
  authorizedKeysCommand,
  ensureKey,
  openInTerminal,
  resetHostKey,
  saveHost,
  scanFingerprint,
  sshCopyIdCommand,
} from './onboarding.js'
import { loadRecipes } from './recipes.js'
import { sshCloseMaster, sshResolve } from './ssh.js'

const MAX_BODY = 2 * 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 同源校验：Origin 的 host 必须等于请求自己的 Host */
export function sameOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return true // 非浏览器发起（没有 Origin 头）
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export function checkRequest(req, token) {
  if (req.method !== 'POST') return { ok: false, code: 405, error: '只接受 POST' }
  const ctype = String(req.headers['content-type'] ?? '')
  if (!ctype.includes('application/json')) return { ok: false, code: 415, error: '只接受 application/json' }
  if (!sameOrigin(req)) return { ok: false, code: 403, error: '跨站请求被拒绝' }
  if (String(req.headers['x-dsh-vps-token'] ?? '') !== token) return { ok: false, code: 403, error: 'token 不对' }
  return { ok: true }
}

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

export function registerRoutes(ctx, deps = {}) {
  const ws = ctx.webServer
  if (!ws || typeof ws.register !== 'function') throw new Error('webServer 服务不可用')
  const env = deps.env ?? process.env
  const runner = deps.runner
  const token = deps.token ?? randomBytes(24).toString('hex')
  const lanBound = ws.config?.host === '0.0.0.0'
  const disposers = []

  if (typeof ws.tapIndex === 'function') {
    disposers.push(ws.tapIndex((html) =>
      html.replace('</head>', `<script>window.__DSH_VPS_TOKEN__=${JSON.stringify(token)}</script></head>`)))
  }

  // 会改东西的路由在局域网暴露时默认关闭
  async function writeAllowed() {
    if (!lanBound) return true
    const doc = await readHosts(env)
    return doc.settings.allowPanelExecOnLan === true
  }

  const route = (path, handler, { write = false } = {}) => {
    disposers.push(ws.register({
      kind: 'exact',
      path: `/api-vps/${path}`,
      handler: async (req, res) => {
        const check = checkRequest(req, token)
        if (!check.ok) return json(res, check.code, { ok: false, error: check.error })
        if (write && !(await writeAllowed())) {
          return json(res, 403, {
            ok: false,
            error: 'DSH 的 Web 服务绑定在 0.0.0.0（局域网可见），会改东西的面板操作已默认关闭。要打开请到设置页勾选。',
          })
        }
        try {
          const body = await readBody(req)
          const data = await handler(body, req)
          return json(res, 200, { ok: true, ...data })
        } catch (error) {
          return json(res, 200, { ok: false, error: error.message ?? String(error) })
        }
      },
    }))
  }

  // —— 总览 ——
  route('overview', async () => {
    const [hosts, { list, errors, conflicts }] = await Promise.all([
      hostsAction({ env }),
      loadRecipes({ env }),
    ])
    return {
      ...hosts,
      lanBound,
      recipes: list.map((r) => ({
        id: r.id, kind: r.kind, name: r.name, desc: r.desc, tags: r.tags,
        source: r.source, tier: r.tier, requires: r.requires,
        params: r.params, incomplete: r.incomplete,
      })),
      recipeErrors: errors,
      recipeConflicts: conflicts,
      paths: paths(env),
    }
  })

  // —— 机器 ——
  route('host/detail', async ({ alias }) => {
    const doc = await readHosts(env)
    const host = doc.hosts[alias]
    if (!host) throw new Error(`没有登记过这台机器：${alias}`)
    const state = await readState(env)
    let resolved = null
    try {
      resolved = await sshResolve(alias)
    } catch {
      resolved = null
    }
    const p = paths(env)
    return {
      alias,
      host,
      resolved,
      state: state.hosts?.[alias] ?? {},
      managed: host.managed !== false,
      dropinPath: p.sshDropin,
      sshConfigPath: p.sshConfig,
    }
  })

  route('host/save', async (body) => {
    const saved = await saveHost({ ...body, env, runner })
    await sshCloseMaster(body.previousAlias ?? body.alias).catch(() => {})
    return saved
  }, { write: true })

  route('host/remove', async ({ alias, removeSshBlock = false, removeKnownHost = false }) => {
    const doc = await readHosts(env)
    if (!doc.hosts[alias]) throw new Error(`没有登记过这台机器：${alias}`)
    let resolved = null
    try {
      resolved = await sshResolve(alias)
    } catch {
      resolved = null
    }
    const hosts = { ...doc.hosts }
    delete hosts[alias]
    const current = doc.current === alias ? (Object.keys(hosts)[0] ?? '') : doc.current
    await writeHosts({ ...doc, hosts, current }, env)
    if (removeSshBlock) await removeDropinHost(alias, env)
    if (removeKnownHost && resolved) await resetHostKey({ hostname: resolved.hostname, port: resolved.port })
    const state = await readState(env)
    if (state.hosts?.[alias]) {
      delete state.hosts[alias]
      const { writeState } = await import('./config.js')
      await writeState(state, env)
    }
    return { alias, removedSshBlock: removeSshBlock, removedKnownHost: removeKnownHost }
  }, { write: true })

  route('host/test', async ({ alias }) => probeHost({ alias, env, runner }))

  route('host/fingerprint', async ({ hostname, port }) => scanFingerprint({ hostname, port }))

  route('host/reset-key', async ({ hostname, port }) => resetHostKey({ hostname, port }), { write: true })

  // —— 导入已有的 ~/.ssh/config 条目 ——
  route('import/candidates', async () => {
    const candidates = await importCandidates(env)
    const out = []
    for (const c of candidates) {
      let resolved = null
      try {
        resolved = await sshResolve(c.alias)
      } catch {
        resolved = null
      }
      out.push({ ...c, hostname: resolved?.hostname ?? '', port: resolved?.port ?? 22, user: resolved?.user ?? '' })
    }
    return { candidates: out }
  })

  route('import/adopt', async ({ aliases = [], group = '' }) => {
    const doc = await readHosts(env)
    const hosts = { ...doc.hosts }
    for (const alias of aliases) {
      hosts[alias] = { note: hosts[alias]?.note ?? '', group, managed: false }
    }
    await writeHosts({ ...doc, hosts, current: doc.current || aliases[0] || '' }, env)
    return { imported: aliases }
  }, { write: true })

  // —— 添加向导 ——
  route('onboarding/key', async ({ create = false, keyPath, passphrase }) =>
    ensureKey({ env, create, keyPath, passphrase }), { write: true })

  route('onboarding/commands', async ({ hostname, port, user, keyPath }) => {
    const key = await ensureKey({ env, keyPath })
    return {
      pubkey: key.pubkey,
      fingerprint: key.fingerprint,
      authorizedKeys: key.pubkey ? authorizedKeysCommand(key.pubkey) : '',
      sshCopyId: sshCopyIdCommand({ identityFile: key.path, user, hostname, port }),
    }
  })

  route('onboarding/open-terminal', async ({ hostname, port, user, keyPath }) => {
    const key = await ensureKey({ env, keyPath })
    return openInTerminal({ command: sshCopyIdCommand({ identityFile: key.path, user, hostname, port }) })
  }, { write: true })

  route('recipes/run', async ({ id, alias, params, force, waitSeconds = 8 }) =>
    recipeAction({
      ctx,
      action: 'run',
      id,
      alias,
      params,
      force,
      waitSeconds,
      env,
      runner,
      source: 'panel',
      preApproved: true, // 机器设置页「基础配置」里按的保存就是同意
    }), { write: true })

  route('recipes/verify', async ({ id, alias }) =>
    recipeAction({ ctx, action: 'verify', id, alias, env, runner, source: 'panel' }))



  // —— 任务 ——
  route('tasks/list', async ({ alias }) => taskAction({ ctx, alias, action: 'list', env, runner, source: 'panel' }))

  route('tasks/status', async ({ alias, taskId, tailBytes }) =>
    taskAction({ ctx, alias, action: 'log', taskId, tailBytes, env, runner, source: 'panel' }))


  // —— 会话绑定：对话头部的 VPS 开关 ——
  route('session/bind', async ({ sessionId, alias }) => {
    const { bindSession } = await import('./config.js')
    if (alias) {
      const doc = await readHosts(env)
      if (!doc.hosts[alias]) throw new Error(`没有登记过这台机器：${alias}`)
    }
    const bound = await bindSession(String(sessionId ?? ''), alias || null, env)
    deps.terminals?.endFor(String(sessionId ?? ''), bound || '') // 换机器或关开关：连着旧机器的终端结束
    if (bound) probeIfUnknown(bound, { env, runner }) // 没体检过就后台体检，给模型的说明里才有系统信息
    return { sessionId, alias: bound }
  })

  // 所有对话的绑定：界面在页面打开时读一次，本地没有记录的对话以服务器为准
  route('session/bindings', async () => {
    const { allSessionBindings } = await import('./config.js')
    return { bindings: await allSessionBindings(env) }
  })

  // —— 卸载 ——
  // 模块先加载好再开始：卸载最后一步会把插件文件从磁盘上删掉，之后再 import 会失败
  route('uninstall/preview', async () => {
    const { uninstallPreview } = await import('./uninstall.js')
    return uninstallPreview({ env, desktop: deps.desktop })
  })

  route('uninstall/run', async ({ choices }) => {
    const { runUninstall } = await import('./uninstall.js')
    return runUninstall({ choices: choices ?? {}, env, runner, desktop: deps.desktop })
  }, { write: true })

  // DSH Desktop 的 desktopActions：卸载完一键重启
  route('desktop/restart', async () => {
    const actions = deps.desktop?.actions
    if (!actions) throw new Error('这里没法自动重启，请手动重启 DSH')
    await actions.requestRestart()
    return { restarting: true }
  }, { write: true })

  // check：顺带测一下连不连得上（true = 30 秒内测过就用上次的；'force' = 一定现测）
  route('session/status', async ({ sessionId, check }) => {
    const { sessionBinding } = await import('./config.js')
    const alias = await sessionBinding(String(sessionId ?? ''), env)
    if (!alias) return { alias: '' }
    let reach = null
    if (check) {
      const { checkReach } = await import('./reach.js')
      reach = await checkReach(alias, { env, force: check === 'force', ...(deps.reachRun ? { run: deps.reachRun } : {}) })
    }
    const state = await readState(env)
    const st = state.hosts?.[alias] ?? {}
    return {
      alias,
      address: st.address ?? '',
      reachable: reach ? reach.reachable : st.reachable ?? null,
      hint: reach ? reach.hint : st.lastError ?? '',
      checkedAt: reach ? reach.checkedAt : st.lastCheck ?? st.lastSeen ?? null,
      facts: st.facts ?? {},
    }
  })

  // —— 终端的显示设置：界面第一次打开终端时读一次，之后用本地缓存 ——
  route('terminal/prefs', async () => {
    const doc = await readHosts(env)
    return { terminal: doc.settings.terminal }
  })

  // —— 设置与审计 ——
  route('settings/save', async ({ settings, groups }) => {
    const doc = await readHosts(env)
    const next = await writeHosts({
      ...doc,
      settings: { ...doc.settings, ...(settings ?? {}) },
      groups: groups ?? doc.groups,
    }, env)
    return { settings: next.settings, groups: next.groups }
  }, { write: true })


  return {
    token,
    dispose: () => {
      for (const d of disposers) {
        try {
          d?.()
        } catch {
          // 反注册失败不影响卸载
        }
      }
    },
  }
}
