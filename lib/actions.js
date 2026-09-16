// lib/actions.js — 三个入口共用的业务动作（设计第二节「一个引擎，三个入口」）
//
// AI 工具、/vps-* 命令、面板路由都调这里；它们只在「谁来确认」上不同：
//   AI      → 按确认档位走 ctx.approval
//   命令    → 用户自己敲的就是同意（安装类要 --yes）
//   面板    → 按钮就是同意
// 执行、锁、备份、审计只实现一次。

import { appendAudit } from './audit.js'
import {
  effectiveConfirm,
  getHost,
  readHosts,
  readState,
  writeState,
} from './config.js'
import { STATUS, runRemote } from './engine.js'
import { writeRemoteFile } from './files.js'
import { makeTaskId } from './payload.js'
import { getRecipe, loadRecipes, runRecipe } from './recipes.js'
import { classifyScript, classifyWritePath, maxTier, needsSafetyNet, resolveTier } from './risk.js'
import { buildSummary, gate, runWithSafetyNet } from './safety.js'
import { describeTarget, sshResolve } from './ssh.js'
import { cancelTask, getTask, listTasks } from './task.js'

const firstLine = (s) => String(s ?? '').split('\n').find((l) => l.trim()) ?? ''

/** 机器上下文：登记信息 + 解析出的真实地址 + 确认档位 + 已知体检结果 */
export async function hostContext(alias, { env = process.env, sshOptions } = {}) {
  const hostsDoc = await readHosts(env)
  const host = getHost(hostsDoc, alias) // 未登记的机器在这里就被挡住
  let resolved = null
  try {
    resolved = await sshResolve(alias, sshOptions ?? {})
  } catch {
    resolved = null
  }
  const state = await readState(env)
  const facts = state.hosts?.[alias]?.facts ?? {}
  const group = host.group ? ` · ${host.group}` : ''
  return {
    hostsDoc,
    host,
    resolved,
    facts,
    confirmLevel: effectiveConfirm(hostsDoc, alias),
    address: resolved ? `${resolved.hostname}:${resolved.port}` : '',
    label: `[${resolved ? describeTarget(alias, resolved) : alias}${group}]`,
  }
}

function shape(alias, ctxInfo, result, extra = {}) {
  return {
    ok: Boolean(result.ok),
    host: alias,
    address: ctxInfo.address,
    status: result.status,
    exitCode: result.exitCode ?? null,
    taskId: result.taskId ?? null,
    output: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spillPath: result.spillPath ?? null,
    hint: result.hint ?? '',
    ...extra,
  }
}

/**
 * 在一台机器上执行一段脚本（功能 ②）。
 */
export async function execAction({
  ctx,
  alias,
  script,
  intent,
  reason,
  background = false,
  timeoutSeconds,
  safetyNet,
  source = 'ai',
  preApproved = false,
  agent,
  callId,
  signal,
  env = process.env,
  runner,
  sshOptions,
}) {
  const info = await hostContext(alias, { env, sshOptions })
  const classification = classifyScript(script)
  const tier = resolveTier(intent, classification)
  const wantsNet = needsSafetyNet(classification) || Boolean(safetyNet?.restore)

  const summary = buildSummary({
    label: info.label,
    tier,
    action: reason || firstLine(script),
    detail: wantsNet
      ? safetyNet?.restore
        ? `连通性保险 ${safetyNet.seconds ?? 120} 秒`
        : '⚠ 未设置自动恢复'
      : '',
  })

  const audit = {
    source,
    alias,
    address: info.address,
    action: 'exec',
    declaredTier: intent ?? null,
    classifiedTier: classification.tier,
    dangers: classification.dangers.map((d) => d.category),
    script,
  }

  const decision = await gate({
    ctx,
    tier,
    confirmLevel: info.confirmLevel,
    summary,
    agent,
    tool: 'vps_exec',
    callId,
    signal,
    audit,
    env,
    preApproved,
  })
  if (!decision.allowed) {
    return {
      ok: false,
      host: alias,
      address: info.address,
      status: STATUS.denied,
      tier,
      hint: decision.hint ?? '操作未获确认',
      summary,
    }
  }

  const taskId = makeTaskId()
  const common = {
    alias,
    body: script,
    signal,
    env,
    runner,
    taskId,
    meta: { source, action: 'exec', tier, reason: reason ?? '' },
    ...(sshOptions ?? {}),
  }

  const execute = () =>
    tier === 'read'
      ? runRemote({ ...common, mode: 'read', timeoutMs: (timeoutSeconds ?? 30) * 1000 })
      : runRemote({
          ...common,
          mode: 'task',
          waitSeconds: background ? 0 : (timeoutSeconds ?? 300),
        })

  const result = wantsNet && safetyNet?.restore
    ? await runWithSafetyNet({
        restore: safetyNet.restore,
        seconds: safetyNet.seconds ?? 120,
        execute,
        alias,
        env,
        runner,
        signal,
      })
    : await execute()

  await appendAudit({ ...audit, finalTier: tier, decision: decision.decision, status: result.status, exitCode: result.exitCode, taskId: result.taskId, durationMs: result.durationMs }, env).catch(() => {})

  return shape(alias, info, result, {
    tier,
    summary,
    safetyNet: result.safetyNet ?? (wantsNet ? { armed: false, reason: '没有提供恢复脚本' } : undefined),
    dangers: classification.dangers,
  })
}

/**
 * 改远端文件：自动备份 + 校验失败自动还原（功能 ②）。
 */
export async function writeFileAction({
  ctx,
  alias,
  path,
  content,
  mode,
  owner,
  validate,
  after,
  reason,
  safetyNet,
  source = 'ai',
  preApproved = false,
  agent,
  callId,
  signal,
  env = process.env,
  runner,
  sshOptions,
}) {
  const info = await hostContext(alias, { env, sshOptions })
  const pathClass = classifyWritePath(path)
  const contentClass = classifyScript([validate, after].filter(Boolean).join('\n'))
  const tier = maxTier(pathClass.tier, contentClass.tier)

  const summary = buildSummary({
    label: info.label,
    tier,
    action: `写入 ${path}`,
    detail: [
      '会自动备份',
      validate ? `校验：${firstLine(validate)}` : '没有校验命令',
      pathClass.lockout ? `连通性保险 ${safetyNet?.seconds ?? 120} 秒` : '',
    ].filter(Boolean).join('，'),
  })

  const audit = { source, alias, address: info.address, action: 'write_file', path, script: content }
  const decision = await gate({ ctx, tier, confirmLevel: info.confirmLevel, summary, agent, tool: 'vps_write_file', callId, signal, audit, env, preApproved })
  if (!decision.allowed) {
    return { ok: false, host: alias, status: STATUS.denied, tier, hint: decision.hint ?? '操作未获确认', summary }
  }

  const taskId = makeTaskId()
  const execute = () =>
    writeRemoteFile({
      alias,
      path,
      content,
      mode,
      owner,
      validate,
      after,
      taskId,
      signal,
      env,
      runner,
      meta: { source, tier, reason: reason ?? '' },
      ...(sshOptions ?? {}),
    })

  // 改 SSH / 防火墙 / 网络配置：默认用「还原备份 + 重新生效」当恢复脚本
  const restore = safetyNet?.restore ?? (pathClass.lockout
    ? `cp -p "$HOME/.cache/dsh-vps/backups/${taskId}${path}" ${path} 2>/dev/null; ${after ?? 'true'}`
    : null)

  const result = pathClass.lockout && restore
    ? await runWithSafetyNet({ restore, seconds: safetyNet?.seconds ?? 120, execute, alias, env, runner, signal })
    : await execute()

  await appendAudit({ ...audit, finalTier: tier, decision: decision.decision, status: result.status, exitCode: result.exitCode, taskId: result.taskId }, env).catch(() => {})

  return shape(alias, info, result, {
    tier,
    summary,
    backupPath: result.backupPath ?? null,
    restoreCommand: result.restoreCommand ?? null,
    safetyNet: result.safetyNet,
  })
}

/** 任务：列表 / 查看 / 终止（功能 ②ii） */
export async function taskAction({
  ctx,
  alias,
  action = 'list',
  taskId,
  tailBytes,
  source = 'ai',
  preApproved = false,
  agent,
  callId,
  signal,
  env = process.env,
  runner,
  sshOptions,
}) {
  const info = await hostContext(alias, { env, sshOptions })
  const common = { alias, signal, env, runner, ...(sshOptions ?? {}) }

  if (action === 'list') {
    const res = await listTasks(common)
    return { ...shape(alias, info, res), tasks: res.tasks }
  }
  if (action === 'status' || action === 'log') {
    if (!taskId) return { ok: false, host: alias, status: STATUS.invalid, hint: '要指定 taskId' }
    const res = await getTask({ ...common, taskId, tailBytes: tailBytes ?? (action === 'log' ? 12_000 : 2000) })
    return { ...shape(alias, info, res), task: res.task, log: res.log }
  }
  if (action === 'cancel') {
    if (!taskId) return { ok: false, host: alias, status: STATUS.invalid, hint: '要指定 taskId' }
    const summary = buildSummary({
      label: info.label,
      tier: 'change',
      action: `终止远端任务 ${taskId}`,
      detail: '中途终止可能留下装了一半的状态',
    })
    const decision = await gate({
      ctx,
      tier: 'change',
      confirmLevel: info.confirmLevel,
      summary,
      agent,
      tool: 'vps_task',
      callId,
      signal,
      audit: { source, alias, action: 'task_cancel', taskId },
      env,
      preApproved,
    })
    if (!decision.allowed) {
      return { ok: false, host: alias, status: STATUS.denied, hint: decision.hint ?? '未获确认', summary }
    }
    const res = await cancelTask({ ...common, taskId })
    return { ...shape(alias, info, res), outcome: res.outcome }
  }
  return { ok: false, host: alias, status: STATUS.invalid, hint: `不支持的任务操作：${action}` }
}

/** 菜谱：列表 / 详情 / 运行 / 存成菜谱（功能 ③） */
export async function recipeAction({
  ctx,
  action = 'list',
  id,
  alias,
  params,
  tag,
  kind,
  force = false,
  waitSeconds,
  source = 'ai',
  preApproved = false,
  agent,
  callId,
  signal,
  env = process.env,
  runner,
  sshOptions,
}) {
  if (action === 'list') {
    const { list, errors, conflicts } = await loadRecipes({ env })
    const filtered = list.filter((r) => (kind ? r.kind === kind : true) && (tag ? r.tags.includes(tag) : true))
    return {
      ok: true,
      recipes: filtered.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        desc: r.desc,
        tags: r.tags,
        tier: r.tier,
        source: r.source,
        params: r.params.map((p) => ({ name: p.name, desc: p.desc, required: p.required })),
        requires: r.requires,
      })),
      errors,
      conflicts,
    }
  }

  if (action === 'show') {
    const recipe = await getRecipe(id, { env })
    const base = {
      ok: true,
      recipe: {
        id: recipe.id,
        kind: recipe.kind,
        name: recipe.name,
        desc: recipe.desc,
        tier: recipe.tier,
        source: recipe.source,
        requires: recipe.requires,
        params: recipe.params,
        plan: recipe.plan,
        detect: recipe.detect,
        run: recipe.run,
        verify: recipe.verify,
        hash: recipe.hash,
      },
    }
    if (!alias) return base
    const info = await hostContext(alias, { env, sshOptions })
    const { detectRecipe } = await import('./recipes.js')
    const detected = await detectRecipe({ recipe, alias, env, runner, signal, ...(sshOptions ?? {}) })
    return { ...base, host: alias, address: info.address, detect: detected.state, detectHint: detected.hint }
  }

  if (action === 'run') {
    if (!alias) return { ok: false, status: STATUS.invalid, hint: '要指定机器' }
    const recipe = await getRecipe(id, { env })
    const info = await hostContext(alias, { env, sshOptions })

    // 用户自己加的菜谱：首次运行（或内容改过）至少按「改动」档确认一次
    const { isTrusted, trustHash } = await import('./config.js')
    const trusted = recipe.source === 'builtin' || (await isTrusted(recipe.hash, env))
    const tier = trusted ? recipe.tier : maxTier(recipe.tier, 'change')

    const summary = buildSummary({
      label: info.label,
      tier,
      action: `运行菜谱「${recipe.name}」`,
      detail: [recipe.source === 'builtin' ? '内置' : '自定义', trusted ? '' : '首次运行'].filter(Boolean).join(' · '),
      hash: recipe.hash,
    })
    const audit = { source, alias, address: info.address, action: 'recipe', recipeId: recipe.id, recipeHash: recipe.hash, script: recipe.run }
    const decision = await gate({ ctx, tier, confirmLevel: info.confirmLevel, summary, agent, tool: 'vps_recipe', callId, signal, audit, env, preApproved })
    if (!decision.allowed) {
      return { ok: false, host: alias, status: STATUS.denied, tier, hint: decision.hint ?? '未获确认', summary }
    }
    if (!trusted) await trustHash(recipe.hash, { id: recipe.id, source: recipe.source }, env).catch(() => {})

    const result = await runRecipe({
      recipe,
      params,
      facts: info.facts,
      force,
      alias,
      signal,
      env,
      runner,
      waitSeconds,
      meta: { source, tier },
      ...(sshOptions ?? {}),
    })
    await appendAudit({ ...audit, finalTier: tier, decision: decision.decision, status: result.status, taskId: result.runResult?.taskId }, env).catch(() => {})
    return {
      ok: result.ok,
      host: alias,
      address: info.address,
      status: result.status,
      phase: result.phase,
      detect: result.detect,
      recipeId: recipe.id,
      tier,
      output: [result.runResult?.stdout, result.verifyResult?.stdout].filter(Boolean).join('\n\n'),
      taskId: result.runResult?.taskId ?? null,
      hint: result.hint,
      needsRepair: result.needsRepair ?? false,
      summary,
    }
  }

  if (action === 'save') {
    const { saveUserRecipe } = await import('./recipe-store.js')
    return saveUserRecipe({ ctx, recipe: params, agent, callId, signal, env, source })
  }

  return { ok: false, status: STATUS.invalid, hint: `不支持的菜谱操作：${action}` }
}

/** 机器清单（模型看的版本：别名、地址、备注、系统、权限、档位） */
export async function hostsAction({ env = process.env } = {}) {
  const hostsDoc = await readHosts(env)
  const state = await readState(env)
  const hosts = Object.entries(hostsDoc.hosts).map(([alias, host]) => {
    const st = state.hosts?.[alias] ?? {}
    return {
      alias,
      note: host.note,
      group: host.group,
      confirmLevel: effectiveConfirm(hostsDoc, alias),
      address: st.address ?? '',
      os: st.facts?.os_id ? `${st.facts.os_id} ${st.facts.os_ver ?? ''}`.trim() : '',
      init: st.facts?.init ?? '',
      privilege: st.facts?.privilege ?? 'unknown',
      lastSeen: st.lastSeen ?? null,
      reachable: st.reachable ?? null,
    }
  })
  return { ok: true, current: hostsDoc.current, hosts, settings: hostsDoc.settings }
}

/** 体检：跑内置 probe 菜谱，结果写进 state.json */
export async function probeHost({ alias, env = process.env, runner, signal, sshOptions }) {
  const recipe = await getRecipe('probe', { env })
  const res = await runRemote({
    alias,
    body: recipe.run,
    mode: 'read',
    timeoutMs: 30_000,
    signal,
    env,
    runner,
    ...(sshOptions ?? {}),
  })
  const facts = {}
  if (res.ok) {
    for (const line of res.stdout.split('\n')) {
      const m = /^([a-z_0-9]+)=(.*)$/.exec(line.trim())
      if (m) facts[m[1]] = m[2]
    }
  }
  let address = ''
  try {
    const resolved = await sshResolve(alias, sshOptions ?? {})
    address = `${resolved.hostname}:${resolved.port}`
  } catch {
    address = ''
  }
  const state = await readState(env)
  state.hosts = state.hosts ?? {}
  state.hosts[alias] = {
    ...(state.hosts[alias] ?? {}),
    address,
    facts,
    reachable: res.ok,
    lastSeen: new Date().toISOString(),
    lastError: res.ok ? null : res.hint,
  }
  await writeState(state, env)
  return { ok: res.ok, host: alias, address, facts, status: res.status, hint: res.hint }
}
