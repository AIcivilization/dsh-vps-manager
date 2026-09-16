// lib/safety.js — 分级确认、审批接入、连通性保险（设计 9.3 / 9.4 / 9.6）
//
// 确认档位（机器 > 组 > 全局）：
//   谨慎 careful  只读自动、改动问、高危问
//   放手 relaxed  只读与改动自动、高危问
//   全自动 auto   全部自动（高危仍标红并写审计）
// 宿主 policy: never / 没有应答者 → 改动与高危一律拒绝（失败关闭）。

import { appendAudit } from './audit.js'
import { STATUS, runRemote } from './engine.js'

export const DECISION = { allow: 'allow', deny: 'deny', unavailable: 'unavailable', auto: 'auto' }

/** 这个档位下，这个级别要不要问 */
export function needsApproval(tier, confirmLevel) {
  if (tier === 'read') return false
  if (confirmLevel === 'auto') return false
  if (confirmLevel === 'relaxed') return tier === 'danger'
  return true // careful
}

/** 确认框里的一句话摘要。完整脚本是工具调用参数，界面上可展开看 */
export function buildSummary({ label, tier, action, detail, hash }) {
  const mark = tier === 'danger' ? '⚠ 高危' : tier === 'change' ? '改动' : '只读'
  const parts = [`${label} ${mark}：${action}`]
  if (detail) parts.push(detail)
  if (hash) parts.push(`脚本 sha256 ${String(hash).slice(0, 8)}`)
  return parts.join(' · ').slice(0, 300)
}

/**
 * 走一次审批。ctx.approval 是可选服务，没有应答者时它自己会以拒绝关闭 ——
 * 我们要把这个结果翻译成模型能解释的话，而不是一个神秘的失败。
 */
export async function requestApproval(ctx, req) {
  const approval = ctx?.approval ?? ctx?.get?.('approval')
  if (!approval || typeof approval.request !== 'function') {
    return { decision: DECISION.unavailable, hint: '当前环境没有审批界面（无头或自动化会话），改动与高危操作一律拒绝' }
  }
  try {
    const outcome = await approval.request({
      agent: req.agent,
      tool: req.tool,
      callId: req.callId,
      reason: req.reason,
      signal: req.signal,
    })
    if (outcome === 'allow') return { decision: DECISION.allow }
    if (outcome === 'deny') return { decision: DECISION.deny, hint: '用户拒绝了这次操作' }
    return { decision: DECISION.unavailable, hint: '拿不到用户确认（无人值守或审批不可用），按拒绝处理' }
  } catch (error) {
    return { decision: DECISION.unavailable, hint: `审批不可用：${error.message}` }
  }
}

/**
 * 统一入口：判档位 → 该问就问 → 记审计。
 * @returns {{ allowed: boolean, decision: string, hint?: string }}
 */
export async function gate({ ctx, tier, confirmLevel, summary, agent, tool, callId, signal, audit, env, preApproved = false }) {
  let decision = preApproved ? 'preapproved' : DECISION.auto
  let hint
  // 面板按钮、命令里的 --yes 本身就是用户的同意，不再走审批（面板也弹不出审批：
  // 它没有 Session 绑定，审批要求处于未结束的轮次中）
  if (!preApproved && needsApproval(tier, confirmLevel)) {
    const res = await requestApproval(ctx, { agent, tool, callId, reason: summary, signal })
    decision = res.decision
    hint = res.hint
  }
  const allowed = decision === DECISION.allow || decision === DECISION.auto || decision === 'preapproved'
  if (audit) {
    await appendAudit({ ...audit, finalTier: tier, confirmLevel, decision }, env).catch(() => {})
  }
  return { allowed, decision, hint }
}

/**
 * 连通性保险（设计 9.6）：改防火墙 / SSH 之前，先在远端埋一个「N 秒后自动恢复」的
 * 任务；改完用**全新连接**测试（必须绕开连接复用，否则复用的是改动之前就建好的
 * 连接，测出来的是假的“能连”）；连得上就取消恢复，连不上就等它自己恢复。
 */
export async function armSafetyNet({ restore, seconds = 120, ...options }) {
  const body = [
    'D="$HOME/.cache/dsh-vps"',
    'mkdir -p "$D"',
    'if command -v setsid >/dev/null 2>&1; then LAUNCH=setsid; else LAUNCH=""; fi',
    `$LAUNCH sh -c 'echo $$ > "$1/safetynet.pid"; sleep ${Number(seconds) || 120}; { ${restore}; } >> "$1/safetynet.log" 2>&1; rm -f "$1/safetynet.pid"' _ "$D" </dev/null >/dev/null 2>&1 &`,
    'sleep 1',
    'cat "$D/safetynet.pid" 2>/dev/null | sed "s/^/safetynet_pid=/"',
  ].join('\n')
  const res = await runRemote({ ...options, body, mode: 'read', timeoutMs: 30_000 })
  const pid = /safetynet_pid=(\d+)/.exec(res.stdout ?? '')?.[1] ?? null
  return { ...res, pid, seconds }
}

export async function disarmSafetyNet({ pid, ...options }) {
  const body = [
    'D="$HOME/.cache/dsh-vps"',
    `pid=${Number(pid) || 0}`,
    '[ "$pid" -gt 0 ] || { echo "no-pid"; exit 0; }',
    'kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
    'rm -f "$D/safetynet.pid"',
    'echo disarmed',
  ].join('\n')
  return runRemote({ ...options, body, mode: 'read', timeoutMs: 30_000 })
}

/** 用一条全新连接验证「改完还连得上」 */
export async function testFreshConnection({ attempts = 3, delayMs = 2000, ...options }) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await runRemote({
      ...options,
      body: 'echo alive',
      mode: 'read',
      withPrelude: false,
      freshConnection: true,
      timeoutMs: 20_000,
    })
    if (res.status === STATUS.done) return { ok: true, attempts: i + 1 }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs))
  }
  return { ok: false, attempts }
}

/**
 * 包着一次「可能把自己锁在门外」的改动：埋保险 → 执行 → 新连接验证 → 取消或等待恢复。
 */
export async function runWithSafetyNet({ restore, seconds, execute, ...options }) {
  const armed = restore ? await armSafetyNet({ restore, seconds, ...options }) : null
  const safetyNet = armed?.pid
    ? { armed: true, pid: armed.pid, seconds: armed.seconds }
    : { armed: false, reason: restore ? '没能在远端埋下自动恢复任务' : '没有提供恢复脚本' }

  const result = await execute()

  const probe = await testFreshConnection(options)
  if (probe.ok) {
    if (armed?.pid) await disarmSafetyNet({ pid: armed.pid, ...options }).catch(() => {})
    return { ...result, safetyNet: { ...safetyNet, verified: true } }
  }

  if (!armed?.pid) {
    return {
      ...result,
      ok: false,
      safetyNet: { ...safetyNet, verified: false },
      hint: `${result.hint ?? ''}｜改动后新连接失败，而且没有自动恢复兜底，请到服务商控制台检查`.trim(),
    }
  }

  // 等自动恢复触发，再试一次
  await new Promise((r) => setTimeout(r, (armed.seconds + 5) * 1000))
  const after = await testFreshConnection(options)
  return {
    ...result,
    ok: false,
    safetyNet: { ...safetyNet, verified: false, reverted: true, recovered: after.ok },
    hint: after.ok
      ? '改动后无法建立新连接，已按连通性保险自动恢复，现在可以正常连接'
      : '改动后无法建立新连接，自动恢复也没能救回来，请到服务商控制台检查',
  }
}
