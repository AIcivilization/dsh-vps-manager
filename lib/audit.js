// lib/audit.js — 本地审计日志（设计 9.8）
//
// 每次远端执行记一行：谁、哪台、干了什么、档位、确认结果、退出码、耗时。
// 不记完整输出（在远端任务目录和 spill 文件里）。按月分文件，保留 6 个月。

import { appendFile, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDirs, paths, sha256 } from './config.js'

const KEEP_MONTHS = 6

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * @param entry {{ source, alias, address, action, recipeId, script, declaredTier,
 *   finalTier, confirmLevel, decision, taskId, status, exitCode, durationMs, note }}
 */
export async function appendAudit(entry, env = process.env) {
  const p = await ensureDirs(env)
  const { script, ...rest } = entry
  const line = {
    at: new Date().toISOString(),
    ...rest,
    scriptSha256: script ? sha256(script) : undefined,
    scriptHead: script ? String(script).replace(/\s+/g, ' ').slice(0, 200) : undefined,
  }
  await appendFile(join(p.auditDir, `${monthKey()}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 })
  return line
}

export async function readAudit({ limit = 50, env = process.env } = {}) {
  const p = paths(env)
  let files
  try {
    files = (await readdir(p.auditDir)).filter((f) => f.endsWith('.jsonl')).sort().reverse()
  } catch {
    return []
  }
  const out = []
  for (const file of files) {
    const text = await readFile(join(p.auditDir, file), 'utf8').catch(() => '')
    const lines = text.split('\n').filter(Boolean).reverse()
    for (const line of lines) {
      try {
        out.push(JSON.parse(line))
      } catch {
        // 半行 / 坏行跳过
      }
      if (out.length >= limit) return out
    }
  }
  return out
}

export async function pruneAudit(env = process.env) {
  const p = paths(env)
  let files
  try {
    files = (await readdir(p.auditDir)).filter((f) => f.endsWith('.jsonl')).sort()
  } catch {
    return 0
  }
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - KEEP_MONTHS)
  const cutoffKey = monthKey(cutoff)
  let removed = 0
  for (const file of files) {
    if (file.replace('.jsonl', '') < cutoffKey) {
      await unlink(join(p.auditDir, file)).catch(() => {})
      removed += 1
    }
  }
  return removed
}
