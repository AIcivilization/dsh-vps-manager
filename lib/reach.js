// lib/reach.js — 连得上吗：顶部方块的颜色就看这里
//
// 为什么单独做（实测的教训）：方块原来只表示「这个对话选了这台」，绿色却被自然地读成
// 「已连上」。SSH 配置被卸载移走后，方块照样是绿的，命令和终端却全部失败。
// 所以「连得上」必须是真测出来的，而且要及时：
//   - 打开开关、打开这个对话、切回 DSH 窗口时现测一次（ssh 跑一个 true，走复用连接时几十毫秒）
//   - 命令、AI 工具、终端每次连服务器，成败都顺手记下
// 结果写进 state.json 的 hosts.<别名>：reachable / lastError / lastCheck，设置页、/vps-list 同一份。

import { readState, writeState } from './config.js'
import { runProcess } from './spawn.js'
import { classifySshFailure, sshArgs } from './ssh.js'

const inflight = new Map() // 别名 → 正在进行的检测（同时点好几下只测一次）

/** 记一次连接结果；和上次一样就不写盘 */
export async function noteReach(alias, ok, hint = '', env = process.env) {
  if (!alias) return
  const state = await readState(env)
  state.hosts = state.hosts ?? {}
  const prev = state.hosts[alias] ?? {}
  const now = new Date().toISOString()
  const lastError = ok ? null : String(hint || '连不上')
  const recent = prev.lastCheck && Date.now() - Date.parse(prev.lastCheck) < 5_000
  if (prev.reachable === ok && (prev.lastError ?? null) === lastError && recent) return
  state.hosts[alias] = {
    ...prev,
    reachable: ok,
    lastError,
    lastCheck: now,
    ...(ok ? { lastSeen: now } : {}),
  }
  await writeState(state, env)
}

async function sshTrue(alias, env) {
  try {
    const res = await runProcess('ssh', sshArgs(alias, { command: 'true', connectTimeout: 8 }), {
      env,
      timeoutMs: 15_000,
    })
    if (res.exitCode === 0) return { ok: true }
    if (res.timedOut) return { ok: false, hint: '连接超时：机器可能关机了，或者被防火墙挡住了' }
    return { ok: false, hint: classifySshFailure(res.stderr, res.exitCode).hint }
  } catch (error) {
    return { ok: false, hint: error.message ?? String(error) }
  }
}

/**
 * 测一下连不连得上。
 * @param opts.force  不看缓存，一定现测（打开开关、点重试时）
 * @param opts.maxAgeMs  最近一次结果在这个时间内就直接用（打开对话时）
 * @param opts.run  测试用：替换真正的 ssh
 */
export function checkReach(alias, { env = process.env, force = false, maxAgeMs = 30_000, run = sshTrue } = {}) {
  if (inflight.has(alias)) return inflight.get(alias)
  const job = (async () => {
    if (!force) {
      const state = await readState(env)
      const h = state.hosts?.[alias]
      if (h?.lastCheck && typeof h.reachable === 'boolean' && Date.now() - Date.parse(h.lastCheck) < maxAgeMs) {
        return { alias, reachable: h.reachable, hint: h.lastError ?? '', checkedAt: h.lastCheck, cached: true }
      }
    }
    const res = await run(alias, env)
    await noteReach(alias, res.ok, res.hint, env)
    return { alias, reachable: res.ok, hint: res.ok ? '' : res.hint ?? '', checkedAt: new Date().toISOString(), cached: false }
  })().finally(() => inflight.delete(alias))
  inflight.set(alias, job)
  return job
}
