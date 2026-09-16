// lib/task.js — 远端任务的查看与终止（设计 8.6）
//
// 任务目录 ~/.cache/dsh-vps/tasks/<id>/ 里有 script.sh / meta.json / pid / log / rc。
// rc 存在 = 跑完了；pid 还活着 = 在跑；两样都没有 = 异常终止（可能被重启打断）。
//
// 终止用进程组（kill -TERM -<pgid>），这样连子进程一起收掉；以 sudo 起的子进程要用
// sudo 去杀。终止必须是显式操作：中途强杀 apt / dnf 会留下包管理器的中间状态，
// 比让它跑完更糟。

import { runRemote } from './engine.js'

const DIR = 'D="$HOME/.cache/dsh-vps"'

const TASK_LINE = [
  '  id=$(basename "$t")',
  '  rc="-"; [ -f "$t/rc" ] && rc=$(cat "$t/rc" 2>/dev/null | tr -d " \\n")',
  '  pid="-"; [ -f "$t/pid" ] && pid=$(cat "$t/pid" 2>/dev/null | tr -d " \\n")',
  '  alive=0',
  '  [ "$pid" != "-" ] && kill -0 "$pid" 2>/dev/null && alive=1',
  '  size=0; [ -f "$t/log" ] && size=$(wc -c < "$t/log" 2>/dev/null | tr -d " ")',
  '  metab64="-"',
  '  [ -f "$t/meta.json" ] && metab64=$(base64 < "$t/meta.json" 2>/dev/null | tr -d "\\n")',
  '  echo "TASK $id ${rc:--} ${pid:--} ${alive:-0} ${size:-0} ${metab64:--}"',
].join('\n')

export const listScript = () => [
  DIR,
  '[ -d "$D/tasks" ] || exit 0',
  'for t in "$D/tasks"/*; do',
  '  [ -d "$t" ] || continue',
  TASK_LINE,
  'done',
].join('\n')

export const statusScript = (taskId, tailBytes = 4000) => [
  DIR,
  `T="$D/tasks/${taskId}"`,
  '[ -d "$T" ] || { echo "NOTFOUND"; exit 1; }',
  't="$T"',
  TASK_LINE,
  'echo "---LOG---"',
  `[ -f "$T/log" ] && tail -c ${Number(tailBytes) || 4000} "$T/log"`,
  'exit 0',
].join('\n')

export const cancelScript = (taskId) => [
  DIR,
  `T="$D/tasks/${taskId}"`,
  '[ -d "$T" ] || { echo "NOTFOUND"; exit 1; }',
  'if [ "$SUDO" = "__NO_PRIV__" ]; then S=""; else S="$SUDO"; fi',
  'pid=$(cat "$T/pid" 2>/dev/null | tr -d " \\n")',
  '[ -n "$pid" ] || { echo "NOPID"; rm -rf "$D/lock"; exit 1; }',
  'if ! kill -0 "$pid" 2>/dev/null; then echo "ALREADY-STOPPED"; rm -rf "$D/lock"; exit 0; fi',
  '$S kill -TERM "-$pid" 2>/dev/null || $S kill -TERM "$pid" 2>/dev/null',
  'i=0',
  'while [ $i -lt 10 ]; do kill -0 "$pid" 2>/dev/null || break; sleep 1; i=$((i+1)); done',
  'if kill -0 "$pid" 2>/dev/null; then',
  '  $S kill -KILL "-$pid" 2>/dev/null || $S kill -KILL "$pid" 2>/dev/null',
  '  echo "KILLED"',
  'else',
  '  echo "STOPPED"',
  'fi',
  'rm -rf "$D/lock"',
  'exit 0',
].join('\n')

export const cleanupScript = (days = 7, keep = 50) => [
  DIR,
  '[ -d "$D/tasks" ] || exit 0',
  `find "$D/tasks" -maxdepth 1 -mindepth 1 -type d -mtime +${Number(days) || 7} -exec rm -rf {} + 2>/dev/null`,
  `ls -1dt "$D/tasks"/*/ 2>/dev/null | tail -n +${(Number(keep) || 50) + 1} | while read -r d; do rm -rf "$d"; done`,
  'exit 0',
].join('\n')

/** 解析远端打印的 TASK 行 */
export function parseTaskLines(text = '') {
  const tasks = []
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('TASK ')) continue
    const [, id, rc, pid, alive, size, metaB64] = line.split(' ')
    let meta = null
    if (metaB64 && metaB64 !== '-') {
      try {
        meta = JSON.parse(Buffer.from(metaB64, 'base64').toString('utf8'))
      } catch {
        meta = null
      }
    }
    const finished = rc !== '-' && rc !== ''
    tasks.push({
      taskId: id,
      exitCode: finished ? Number(rc) : null,
      pid: pid === '-' ? null : Number(pid),
      running: alive === '1',
      logBytes: Number(size) || 0,
      meta,
      state: finished ? (Number(rc) === 0 ? 'done' : 'failed') : alive === '1' ? 'running' : 'interrupted',
    })
  }
  return tasks
}

export async function listTasks(options) {
  const res = await runRemote({ ...options, body: listScript(), mode: 'read', withPrelude: false })
  return { ...res, tasks: res.ok ? parseTaskLines(res.stdout) : [] }
}

export async function getTask(options) {
  const { taskId, tailBytes = 4000 } = options
  const res = await runRemote({ ...options, body: statusScript(taskId, tailBytes), mode: 'read', withPrelude: false })
  if (!res.ok) return { ...res, task: null, log: '' }
  if (res.stdout.startsWith('NOTFOUND')) {
    return { ...res, ok: false, status: 'invalid', task: null, log: '', hint: `远端没有这个任务：${taskId}` }
  }
  const [head, ...rest] = res.stdout.split('---LOG---')
  const task = parseTaskLines(head)[0] ?? null
  return { ...res, task, log: rest.join('---LOG---').trim() }
}

/**
 * 终止任务。调用方负责先按确认档位取得同意，并提示可能留下半装状态。
 */
export async function cancelTask(options) {
  const { taskId } = options
  const res = await runRemote({ ...options, body: cancelScript(taskId), mode: 'read', withPrelude: true, timeoutMs: 30_000 })
  const out = res.stdout.trim()
  const outcome = out.includes('KILLED')
    ? 'killed'
    : out.includes('STOPPED') && !out.includes('ALREADY')
      ? 'stopped'
      : out.includes('ALREADY-STOPPED')
        ? 'already_stopped'
        : out.includes('NOPID')
          ? 'no_pid'
          : out.includes('NOTFOUND')
            ? 'not_found'
            : 'unknown'
  const hints = {
    killed: '已强制终止（先 TERM 后 KILL）。如果中途打断的是包管理器，远端可能需要修复',
    stopped: '已终止',
    already_stopped: '任务本来就已经结束了',
    no_pid: '任务没有记录进程号，无法终止',
    not_found: '远端没有这个任务',
    unknown: '终止结果未知',
  }
  return { ...res, outcome, hint: hints[outcome] }
}

export async function cleanupTasks(options) {
  return runRemote({ ...options, body: cleanupScript(options.days, options.keep), mode: 'read', withPrelude: false })
}
