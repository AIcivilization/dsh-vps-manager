// lib/index.js — 插件入口（设计第十二节）
//
// 挂载要点：
//   - tools 是硬依赖（inject），没有它这个插件没有意义
//   - commands / webServer / skills / agents 都是**可选**宿主服务，一律经 ctx.inject 延迟注册：
//     cordis 里没声明就直接读 ctx.skills 会抛 “cannot get property without inject”（实测），
//     服务缺席时回调不执行，插件照常激活
//   - 任何一处注册失败只降级，绝不阻断插件加载——但一定要写进宿主日志
//     （DSH Desktop：~/Library/Application Support/DSH Desktop/logs/host/）

import { readFile } from 'node:fs/promises'
import { registerCommands } from './commands.js'
import { loadBindingCache } from './config.js'
import { registerTools } from './tools.js'
import { localShellGuard, registerVpsMode } from './vps-mode.js'

export const name = 'vps-manager'
export const inject = ['tools']

const SKILL_NAME = 'vps-operator'

function warn(ctx, message, error) {
  const text = `[dsh-vps-manager] ${message}${error ? `：${error.message ?? error}` : ''}`
  if (ctx?.logger?.warn) ctx.logger.warn(text)
  else console.warn(text)
}

export async function registerSkill(skillCtx) {
  const content = await readFile(new URL('./skills/vps-operator.md', import.meta.url), 'utf8')
  return skillCtx.skills.register({
    name: SKILL_NAME,
    description: '操作用户的 VPS：查看状态、装软件、配服务时读它，里面有必须遵守的操作规则',
    content,
    invocation: { modelInvocable: true, userInvocable: false },
  })
}

export function apply(ctx, config = {}) {
  const deps = { env: process.env, ...config }

  // 审计日志保留 6 个月，启动时清一次旧的（失败不影响插件）
  import('./audit.js')
    .then(({ pruneAudit }) => pruneAudit(deps.env))
    .catch((error) => warn(ctx, '清理旧审计日志失败', error))

  // 已有的对话绑定读进内存：工具守卫是同步的，靠这份副本判断
  loadBindingCache(deps.env).catch((error) => warn(ctx, '读取对话绑定失败', error))

  // AI 工具（硬依赖 tools）
  registerTools(ctx, deps).catch((error) => warn(ctx, '工具注册失败', error))

  // VPS 模式：绑定期间拦下本机 bash
  try {
    if (typeof ctx.tools?.guard === 'function') ctx.tools.guard(localShellGuard)
  } catch (error) {
    warn(ctx, '本机 bash 守卫注册失败', error)
  }

  if (typeof ctx.inject !== 'function') return

  // skill：可选服务
  ctx.inject(['skills'], (skillCtx) => {
    registerSkill(skillCtx).catch((error) => warn(ctx, 'skill 注册失败', error))
  })

  // VPS 模式：绑定状态变化时告诉模型（可选服务 agents）
  ctx.inject(['agents'], (agentCtx) => {
    try {
      registerVpsMode(agentCtx, { env: deps.env, warn: (message, error) => warn(ctx, message, error) })
    } catch (error) {
      warn(ctx, 'VPS 模式注册失败', error)
    }
  })

  // /vps-* 命令：可选服务，headless 下不挂载
  ctx.inject(['commands'], (cmdCtx) => {
    try {
      registerCommands(cmdCtx, deps)
    } catch (error) {
      warn(ctx, '命令注册失败', error)
    }
  })

  // 设置页路由：可选且晚挂载
  ctx.inject(['webServer'], async (webCtx) => {
    try {
      const { registerRoutes } = await import('./routes.js')
      registerRoutes(webCtx, deps)
    } catch (error) {
      warn(ctx, '设置页路由注册失败（设置页不可用，命令与工具不受影响）', error)
    }
  })
}

export default { name, inject, apply }
