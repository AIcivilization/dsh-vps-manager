// lib/index.js — 插件入口（设计第十二节）
//
// 挂载要点：
//   - tools 是硬依赖（inject），没有它这个插件没有意义
//   - commands / webServer / skills 都是**可选**宿主服务：无 UI 演示与 ACP 自动化
//     根本不提供命令适配器，headless 下也没有 webServer。全部经 ctx.inject 延迟注册，
//     服务缺席时回调不执行，插件照常激活
//   - 客户端注册失败只降级，绝不阻断插件加载

import { readFile } from 'node:fs/promises'
import { registerCommands } from './commands.js'
import { registerTools } from './tools.js'

export const name = 'vps-manager'
export const inject = ['tools']

const SKILL_NAME = 'vps-operator'

function warn(ctx, message, error) {
  const text = `[dsh-vps-manager] ${message}${error ? `：${error.message ?? error}` : ''}`
  if (ctx?.logger?.warn) ctx.logger.warn(text)
  else console.warn(text)
}

async function registerSkill(ctx) {
  const skills = ctx.skills ?? ctx.get?.('skills')
  if (!skills || typeof skills.register !== 'function') return null
  const content = await readFile(new URL('./skills/vps-operator.md', import.meta.url), 'utf8')
  return skills.register({
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

  // AI 工具（硬依赖 tools）
  registerTools(ctx, deps).catch((error) => warn(ctx, '工具注册失败', error))

  // skill：可选，注册失败不影响工具
  registerSkill(ctx).catch((error) => warn(ctx, 'skill 注册失败', error))

  // /vps-* 命令：可选服务，headless 下不挂载
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (cmdCtx) => {
      try {
        registerCommands(cmdCtx, deps)
      } catch (error) {
        warn(ctx, '命令注册失败', error)
      }
    })

    // 面板路由：可选且晚挂载
    ctx.inject(['webServer'], async (webCtx) => {
      try {
        const { registerRoutes } = await import('./routes.js')
        registerRoutes(webCtx, deps)
      } catch (error) {
        warn(ctx, '面板路由注册失败（面板不可用，命令与工具不受影响）', error)
      }
    })
  }
}

export default { name, inject, apply }
