// lib/routes.js — 设置页路由 /api-vps/*（设计第三节「界面 ↔ host 通信」）
//
// 界面没有 Session 绑定，调 host 只能走 HTTP。而 dsh-host-webserver 本身没有任何
// 鉴权代码，且允许绑定 0.0.0.0 —— 所以这里必须自己做三件事：
//   1. 每次启动生成随机 token，经 tapIndex 注入页面；所有路由校验 x-dsh-vps-token
//      （跨站网页读不到它）
//   2. 只收 application/json（强制浏览器预检）+ 同源校验（Origin 的 host 必须等于
//      请求的 Host）
//   3. **路由永远不提供自由命令执行**；绑定在 0.0.0.0 时，会改东西的路由
//      默认关闭（页面降级为只读），设置里可以手动打开
//   4. 文件管理器（files/*）能改服务器上的文件，所以再加两道：只能操作「这个对话绑定的
//      那台机器」（服务端按对话查，不信界面传来的机器名）；和终端一样默认只允许本机打开
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
  autoAlias,
  ensureKey,
  installKeyWithPassword,
  openInTerminal,
  resetHostKey,
  saveHost,
  scanFingerprint,
  sshCopyIdCommand,
} from './onboarding.js'
import { loadRecipes } from './recipes.js'
import { sshCloseMaster, sshResolve } from './ssh.js'
import { appendAudit } from './audit.js'
import * as files from './filemgr.js'
import { isLoopbackRequest } from './terminal-server.js'

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
          // 记进本地错误记录（先打码）：反馈时附上，/vps-doctor 能看到
          import('./health.js').then(({ recordError }) => recordError(`接口 ${path}`, error, env)).catch(() => {})
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

  // 添加机器（一页表单）：填了密码就用它放一次公钥，然后保存、用钥匙连一次。
  // 密码只在这个请求里用一次：不保存、不写日志和审计；带密码的请求只收本机发来的
  // （从局域网发，密码会明文走一段网络），设置里放开「其他设备」后例外
  route('onboarding/connect', async ({ hostname, port = 22, user = 'root', password = '', alias, note = '', group = '' }, req) => {
    const { validateConnection } = await import('./config.js')
    if (password && !isLoopbackRequest(req)) {
      const doc = await readHosts(env)
      if (doc.settings.allowTerminalRemote !== true) {
        throw new Error('带密码添加机器只能在运行 DSH 的这台电脑上操作（从别的设备发，密码会经过网络）。要放开，到 DSH 设置 → VPS 管理 → 终端 里勾选「允许从其他设备打开 VPS 终端」')
      }
    }
    const name = String(alias ?? '').trim() || autoAlias(hostname)
    const target = validateConnection({ alias: name, hostname: String(hostname ?? '').trim(), port, user: String(user ?? '').trim() || 'root' })
    const doc = await readHosts(env)
    if (doc.hosts[name]) throw new Error(`别名「${name}」已经有一台机器在用了，换一个别名`)

    const key = await ensureKey({ env, create: true })
    let keyInstalled = false
    if (password) {
      const install = deps.installKey ?? installKeyWithPassword
      const res = await install({ hostname: target.hostname, port: target.port, user: target.user, password, pubkey: key.pubkey, env })
      if (!res.ok) return { connected: false, stage: 'password', reason: res.reason, hint: res.hint }
      keyInstalled = true
    }
    const saved = await saveHost({
      alias: name, hostname: target.hostname, port: target.port, user: target.user, identityFile: key.path,
      note: String(note ?? ''), group: String(group ?? ''), managed: true, env, runner,
    })
    const fp = await (deps.scanFingerprint ?? scanFingerprint)({ hostname: target.hostname, port: target.port }).catch(() => null)
    await appendAudit({
      source: 'panel', alias: name, address: `${target.hostname}:${target.port}`, action: 'add_host',
      note: keyInstalled ? '用密码登录一次放了插件公钥（密码没有保存）' : '没填密码，直接用钥匙连',
      status: saved.probe?.ok ? 'done' : 'failed',
    }, env).catch(() => {})
    return {
      connected: Boolean(saved.probe?.ok),
      alias: name,
      keyInstalled,
      probe: saved.probe,
      hint: saved.probe?.ok ? '' : saved.probe?.hint ?? '',
      fingerprints: fp?.fingerprints ?? [],
      keyPath: key.path,
    }
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

  // —— 插件体检与反馈 ——
  // 汇总：版本、DSH 验证状态、各部分注册结果、最近错误、预填好的反馈链接
  route('diag/status', async () => {
    const { diagnostics } = await import('./health.js')
    return await diagnostics(env)
  })

  // 界面自己出的错（插槽注册失败之类）也记下来。一次最多收 1 KB，只记不回显
  route('diag/client-error', async ({ where, message }) => {
    const { recordError } = await import('./health.js')
    await recordError(`界面 ${String(where ?? '').slice(0, 40)}`, String(message ?? '').slice(0, 1000), env)
    return {}
  })

  // —— 文件管理器（终端面板的「文件」页）——
  // 机器由对话的绑定决定；从别的设备打开要先在设置里放开（和终端同一个开关）
  const REMOTE_HINT = '文件管理和终端一样，默认只能在运行 DSH 的这台电脑上打开。要从局域网或反向代理使用，到 DSH 设置 → VPS 管理 → 终端 里勾选「允许从其他设备打开 VPS 终端」'
  async function assertLocal(req) {
    if (isLoopbackRequest(req)) return
    const doc = await readHosts(env)
    if (doc.settings.allowTerminalRemote !== true) throw new Error(REMOTE_HINT)
  }
  async function boundAlias(sessionId) {
    const { sessionBinding } = await import('./config.js')
    const alias = await sessionBinding(String(sessionId ?? ''), env)
    if (!alias) throw new Error('这个对话还没打开 VPS 开关')
    return alias
  }
  const spawnSsh = deps.spawnSsh // 测试用：换成本机 sh
  const audit = (entry) => appendAudit({ source: 'files', ...entry }, env).catch(() => {})

  const filesRoute = (path, handler, opts) => route(`files/${path}`, async (body, req) => {
    await assertLocal(req)
    const alias = await boundAlias(body.sessionId)
    try {
      return await handler({ ...body, alias }, req)
    } catch (error) {
      // 服务器上的「没权限」「不存在」之类是给用户看的提示，不是插件的错，不记错误日志
      if (error instanceof files.FileError) return { ok: false, error: error.message, code: error.code }
      throw error
    }
  }, opts)

  filesRoute('places', async ({ alias }) => ({ alias, ...(await files.places({ alias, env, spawnSsh })) }))

  filesRoute('list', async ({ alias, path }) => files.listDir({ alias, path, env, spawnSsh }))

  filesRoute('mkdir', async ({ alias, dir, name }) => {
    const res = await files.makeDir({ alias, dir, name, env, spawnSsh })
    await audit({ alias, action: 'mkdir', path: res.path, status: 'done' })
    return res
  }, { write: true })

  filesRoute('rename', async ({ alias, dir, from, to }) => {
    const res = await files.renameEntry({ alias, dir, from, to, env, spawnSsh })
    await audit({ alias, action: 'rename', path: files.joinPath(dir, from), note: `→ ${res.path}`, status: 'done' })
    return res
  }, { write: true })

  filesRoute('trash', async ({ alias, paths: list }) => {
    const res = await files.trashEntries({ alias, paths: list, env, spawnSsh })
    for (const m of res.moved) await audit({ alias, action: 'trash', path: m.path, note: `回收站 ${m.id}`, status: 'done' })
    return res
  }, { write: true })

  filesRoute('trash-list', async ({ alias }) => files.listTrash({ alias, env, spawnSsh }))

  filesRoute('restore', async ({ alias, ids }) => {
    const res = await files.restoreTrash({ alias, ids, env, spawnSsh })
    for (const r of res.restored) await audit({ alias, action: 'restore', path: r.path, note: `回收站 ${r.id}`, status: 'done' })
    return res
  }, { write: true })

  filesRoute('purge', async ({ alias, ids, all }) => {
    const res = await files.purgeTrash({ alias, ids, all: all === true, env, spawnSsh })
    await audit({ alias, action: 'purge', note: all === true ? '清空回收站' : `彻底删除 ${ids?.length ?? 0} 项`, status: 'done' })
    return res
  }, { write: true })

  // 编辑：打开（整个文件，1 MB 以内）和保存（先对指纹，再走 vps_write_file 同一套：备份、保留权限、原子替换）
  filesRoute('read', async ({ alias, path }) => files.readText({ alias, path, env, spawnSsh }))

  filesRoute('save', async ({ alias, path, content, expectSha, force }) => {
    const p = files.normalizePath(path)
    if (typeof content !== 'string') throw new files.FileError('content_invalid', '内容不对')
    if (Buffer.byteLength(content) > files.EDIT_LIMIT) throw new files.FileError('too_large', '内容超过 1 MB，不能在这里保存')
    if (!force && expectSha) {
      const now = await files.currentSha({ alias, path: p, env, spawnSsh })
      if (now && now !== expectSha) {
        return { conflict: true, error: '这个文件在你打开之后被改过（可能是 AI 或别人改的）。可以重新加载看最新内容，或者仍然用你的版本覆盖' }
      }
    }
    const { writeRemoteFile } = await import('./files.js')
    const res = await writeRemoteFile({
      alias, path: p, content, taskId: files.newTaskId(), env, runner, meta: { source: 'files', reason: '文件管理器里编辑' },
    })
    await audit({ alias, action: 'edit', path: p, status: res.status, exitCode: res.exitCode, taskId: res.taskId })
    if (res.status !== 'done') throw new files.FileError('save_failed', res.hint || '保存没成功')
    const after = await files.currentSha({ alias, path: p, env, spawnSsh }).catch(() => '')
    return { path: p, backupPath: res.backupPath ?? null, sha: after }
  }, { write: true })

  // 让 AI 看看这个文件：读出来（大文件取结尾）、打码，等用户下次跟 AI 说话时附上
  filesRoute('share', async ({ alias, path, sessionId }) => {
    const res = await files.readText({ alias, path, limit: files.SHARE_LIMIT, mode: 'tail', env, spawnSsh })
    const { shareFile } = await import('./terminal.js')
    const queued = shareFile(String(sessionId), { alias, path: res.path, content: res.content, size: res.size, truncated: res.truncated })
    await audit({ alias, action: 'share', path: res.path, note: `${Buffer.byteLength(res.content)} 字节交给 AI`, status: 'done' })
    return { path: res.path, size: res.size, bytes: Buffer.byteLength(res.content), truncated: res.truncated, queued }
  })

  // 下载：先查一下、发一张 2 分钟内有效的一次性票，浏览器拿票直接下（大文件不经过页面内存）
  const tickets = new Map()
  filesRoute('download', async ({ alias, path }) => {
    const info = await files.statPath({ alias, path, env, spawnSsh })
    for (const [t, v] of tickets) if (v.expires < Date.now()) tickets.delete(t)
    const ticket = randomBytes(24).toString('hex')
    tickets.set(ticket, { alias, ...info, expires: Date.now() + 120_000 })
    const name = info.type === 'dir' ? `${info.name}.tar.gz` : info.name
    return { url: `/api-vps/files/fetch?t=${ticket}`, name, type: info.type, size: info.size }
  })

  const connection = () => {
    try {
      return ctx.get?.('connection')
    } catch {
      return undefined
    }
  }
  const plain = (res, code, text) => {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }

  disposers.push(ws.register({
    kind: 'exact',
    path: '/api-vps/files/fetch',
    handler: async (req, res) => {
      const rejection = connection()?.requestRejection?.(req)
      if (rejection !== undefined) return plain(res, rejection, '')
      if (req.method !== 'GET') return plain(res, 405, '')
      const t = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams.get('t') ?? ''
      const ticket = tickets.get(t)
      tickets.delete(t) // 一次性
      if (!ticket || ticket.expires < Date.now()) return plain(res, 403, '下载链接过期了，回到文件列表再点一次下载')
      try {
        await assertLocal(req)
      } catch (error) {
        return plain(res, 403, error.message)
      }
      const name = ticket.type === 'dir' ? `${ticket.name}.tar.gz` : ticket.name
      const child = (spawnSsh ?? files.defaultSpawnSsh)(ticket.alias, files.downloadScript(ticket))
      child.stdin.end()
      res.writeHead(200, {
        'content-type': ticket.type === 'dir' ? 'application/gzip' : 'application/octet-stream',
        'content-disposition': files.attachmentHeader(name),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(ticket.type === 'file' ? { 'content-length': ticket.size } : {}),
      })
      child.stdout.pipe(res)
      res.on('close', () => {
        if (!res.writableFinished) child.kill('SIGTERM') // 浏览器取消了下载
      })
      child.on('close', (code) => {
        audit({ alias: ticket.alias, action: 'download', path: ticket.path, status: code === 0 ? 'done' : 'failed', exitCode: code })
      })
    },
  }))

  // 上传：请求体就是文件本身（不是 JSON）。和其他路由一样校验 token 与同源，外加本机限制和写开关
  disposers.push(ws.register({
    kind: 'exact',
    path: '/api-vps/files/upload',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
      if (!String(req.headers['content-type'] ?? '').includes('application/octet-stream')) {
        return json(res, 415, { ok: false, error: '只接受 application/octet-stream' })
      }
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: '跨站请求被拒绝' })
      if (String(req.headers['x-dsh-vps-token'] ?? '') !== token) return json(res, 403, { ok: false, error: 'token 不对' })
      try {
        await assertLocal(req)
        if (!(await writeAllowed())) throw new Error('DSH 的 Web 服务绑定在 0.0.0.0（局域网可见），会改东西的面板操作已默认关闭。要打开请到设置页勾选。')
        const q = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams
        const alias = await boundAlias(q.get('sessionId'))
        const size = Number(q.get('size'))
        const result = await files.uploadFile({ alias, path: q.get('path'), size, stream: req, env, spawnSsh })
        await audit({ alias, action: 'upload', path: result.path, note: `${size} 字节${result.backupPath ? '，原文件已备份' : ''}`, status: 'done', taskId: result.taskId })
        return json(res, 200, { ok: true, ...result })
      } catch (error) {
        if (!req.complete) req.resume() // 没读完的请求体要读掉，连接才能正常结束
        return json(res, 200, { ok: false, error: error.message ?? String(error) })
      }
    },
  }))

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
