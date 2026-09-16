// lib/engine.js — 三个入口（面板 / 命令 / AI）共用的执行引擎（设计 8.6 / 8.7）
//
// 只读档直接执行；改动、高危、安装一律走「远端任务」：断线后继续跑，可以接回来。
// 结果是结构化的，绝不把「ssh 没连上」「远端失败」「还在跑」压成一个字符串。

import { createWriteStream } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDirs } from './config.js'
import {
  REMOTE_EXIT,
  buildReadPayload,
  buildRemoteScript,
  buildTaskPayload,
  makeNonce,
  makeTaskId,
  parseOutput,
} from './payload.js'
import { SshError, classifySshFailure, sshRun } from './ssh.js'

let preludeCache = null
export async function loadPrelude() {
  if (preludeCache === null) {
    preludeCache = await readFile(new URL('./prelude.sh', import.meta.url), 'utf8')
  }
  return preludeCache
}

/** 结果状态：见设计 8.7 */
export const STATUS = {
  done: 'done',
  failed: 'failed',
  sshError: 'ssh_error',
  disconnected: 'disconnected',
  detached: 'detached',
  interrupted: 'interrupted',
  locked: 'locked',
  denied: 'denied',
  noPrivilege: 'no_privilege',
  requiresUnmet: 'requires_unmet',
  remoteSetup: 'remote_setup',
  cancelled: 'cancelled',
  timeout: 'timeout',
  invalid: 'invalid',
}

const HINTS = {
  [STATUS.done]: '执行完成',
  [STATUS.failed]: '远端命令以非零退出码结束',
  [STATUS.disconnected]: '脚本跑起来了但连接中断，结果未知；如果是改动类操作，请重新检查远端状态',
  [STATUS.detached]: '已停止等待，任务仍在远端后台运行。用任务查询接回来看进度，需要时可以手动终止',
  [STATUS.interrupted]: '远端任务异常终止（没有退出码，进程也不在了），可能被重启打断',
  [STATUS.locked]: '这台机器上正有另一个改动任务在跑，等它结束再试',
  [STATUS.noPrivilege]: '需要 root 权限：当前用户不是 root，也没有免密 sudo。可以改用 root 登录，或给这个用户加免密 sudo',
  [STATUS.requiresUnmet]: '这台机器的系统或 init 不适用这条菜谱',
  [STATUS.remoteSetup]: '远端缺少基本条件（无法创建工作目录，或没有 base64）',
  [STATUS.cancelled]: '已取消：本地连接已断开',
  [STATUS.timeout]: '本地等待超时',
}

function spillWriter(file) {
  let stream = null
  let bytes = 0
  return {
    write(chunk) {
      if (!stream) stream = createWriteStream(file, { mode: 0o600 })
      bytes += chunk.length
      stream.write(chunk)
    },
    async finish(keep) {
      if (!stream) return null
      await new Promise((resolve) => stream.end(resolve))
      if (keep) return file
      await unlink(file).catch(() => {})
      return null
    },
    get bytes() {
      return bytes
    },
  }
}

/**
 * 跑一段脚本。
 *
 * @param {object} o
 * @param {string} o.alias        机器别名（必须已登记，调用方先校验）
 * @param {string} o.body         脚本正文
 * @param {'read'|'task'} o.mode
 * @param {object} [o.params]     参数值
 * @param {Array}  [o.specs]      参数声明
 * @param {'sh'|'bash'} [o.shell]
 * @param {number} [o.timeoutMs]  本地等待上限
 * @param {number} [o.waitSeconds] 任务模式下远端跟随日志的秒数
 * @param {AbortSignal} [o.signal]
 * @param {boolean} [o.freshConnection] 连通性保险要用全新连接，绕开复用
 * @param {Function} [o.runner]   便于测试的执行器 seam，默认 sshRun
 */
export async function runRemote(o) {
  const {
    alias,
    body,
    mode = 'read',
    params = {},
    specs = [],
    shell = 'sh',
    withPrelude = true,
    timeoutMs = mode === 'task' ? 0 : 30_000,
    waitSeconds = 300,
    signal,
    freshConnection = false,
    meta = {},
    taskId = makeTaskId(),
    runner = sshRun,
    env = process.env,
    onChunk,
  } = o

  const p = await ensureDirs(env)
  const nonce = makeNonce()
  const prelude = withPrelude ? await loadPrelude() : ''
  let script
  try {
    ;({ script } = buildRemoteScript({ prelude, specs, params, body }))
  } catch (error) {
    return {
      ok: false,
      alias,
      status: STATUS.invalid,
      exitCode: null,
      stdout: '',
      stderr: '',
      hint: error.message,
      errorCode: error.code,
    }
  }

  const payload =
    mode === 'task'
      ? buildTaskPayload({ script, nonce, taskId, shell, meta, waitSeconds, follow: waitSeconds > 0 })
      : buildReadPayload({ script, nonce, shell })

  const spill = spillWriter(join(p.spillDir, `${taskId}.log`))
  let res
  try {
    res = await runner(alias, payload, {
      signal,
      timeoutMs,
      controlMaster: !freshConnection,
      onStdout: (chunk) => {
        spill.write(chunk)
        if (onChunk) onChunk(chunk)
      },
      onStderr: (chunk) => spill.write(chunk),
    })
  } catch (error) {
    await spill.finish(false)
    const reason = error instanceof SshError ? error.reason : 'spawn_failed'
    return {
      ok: false,
      alias,
      status: STATUS.sshError,
      reason,
      exitCode: null,
      stdout: '',
      stderr: error.message,
      hint: error.message,
    }
  }

  const parsed = parseOutput(res.stdout, nonce)
  const base = {
    alias,
    taskId: parsed.taskId ?? (mode === 'task' ? taskId : null),
    stdout: parsed.output,
    stderr: res.stderr,
    durationMs: res.durationMs,
    truncated: res.truncated,
  }

  // 没有 BEGIN：脚本根本没跑起来 —— 是 ssh 层的问题
  if (!parsed.started) {
    const spillPath = await spill.finish(false)
    if (res.aborted) {
      return { ...base, ok: false, status: STATUS.cancelled, exitCode: null, hint: HINTS[STATUS.cancelled], spillPath }
    }
    if (res.timedOut) {
      return { ...base, ok: false, status: STATUS.timeout, exitCode: null, hint: HINTS[STATUS.timeout], spillPath }
    }
    const { reason, hint } = classifySshFailure(`${res.stderr}\n${parsed.noise}`, res.exitCode)
    return { ...base, ok: false, status: STATUS.sshError, reason, exitCode: res.exitCode, hint, spillPath }
  }

  if (parsed.locked) {
    await spill.finish(false)
    return {
      ...base,
      ok: false,
      status: STATUS.locked,
      exitCode: 98,
      lockOwner: parsed.lockOwner,
      hint: parsed.lockOwner
        ? `${HINTS[STATUS.locked]}（任务 ${parsed.lockOwner.taskId ?? '?'}，来源 ${parsed.lockOwner.source ?? '?'}）`
        : HINTS[STATUS.locked],
    }
  }

  const keepSpill = res.truncated || spill.bytes > 16_000
  const spillPath = await spill.finish(keepSpill)

  if (parsed.detached || (parsed.exitCode === null && mode === 'task')) {
    return {
      ...base,
      ok: false,
      status: STATUS.detached,
      exitCode: null,
      hint: HINTS[STATUS.detached],
      spillPath,
    }
  }

  if (parsed.exitCode === null) {
    return { ...base, ok: false, status: STATUS.disconnected, exitCode: null, hint: HINTS[STATUS.disconnected], spillPath }
  }

  const mapped = REMOTE_EXIT[parsed.exitCode]
  if (mapped) {
    const status = STATUS[mapped === 'requires_unmet' ? 'requiresUnmet' : mapped === 'no_privilege' ? 'noPrivilege' : mapped === 'remote_setup' ? 'remoteSetup' : 'locked']
    return { ...base, ok: false, status, exitCode: parsed.exitCode, hint: HINTS[status] ?? mapped, spillPath }
  }

  const ok = parsed.exitCode === 0
  return {
    ...base,
    ok,
    status: ok ? STATUS.done : STATUS.failed,
    exitCode: parsed.exitCode,
    hint: ok ? HINTS[STATUS.done] : HINTS[STATUS.failed],
    spillPath,
  }
}
