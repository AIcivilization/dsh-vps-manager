// lib/index.js — 插件入口（设计第十二节）
//
// 挂载要点：
//   - tools 是硬依赖（inject），没有它这个插件没有意义
//   - commands / webServer / skills / agents 都是**可选**宿主服务，一律经 ctx.inject 延迟注册：
//     cordis 里没声明就直接读 ctx.skills 会抛 “cannot get property without inject”（实测），
//     服务缺席时回调不执行，插件照常激活
//   - 任何一处注册失败只降级，绝不阻断插件加载——但一定要写进宿主日志
//     （DSH Desktop：~/Library/Application Support/DSH Desktop/logs/host/）

import { randomBytes } from 'node:crypto'
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

/** 交给宿主在卸载 / 重载时反注册；宿主不支持就算了，重启 DSH 一样会清掉 */
function track(scopedCtx, dispose, label) {
  try {
    scopedCtx.effect?.(() => dispose, label)
  } catch {
    // 老版本 cordis 没有 effect
  }
}

export async function registerSkill(skillCtx) {
  const content = await readFile(new URL('./skills/vps-operator.md', import.meta.url), 'utf8')
  // source / provider / content 在「加载」时还会再校验一遍（注册时不查 source）：
  // 漏了 source，注册成功、模型一读就报 “source must be a string”（实测）
  return skillCtx.skills.register({
    name: SKILL_NAME,
    source: 'runtime',
    description: '操作用户的 VPS：查看状态、装软件、配服务时读它，里面有必须遵守的操作规则',
    whenToUse: '对话处于 VPS 模式（收到「[VPS 模式] 已绑定」说明），或要用 vps_exec、vps_write_file、vps_recipe 在服务器上做任何改动之前',
    content,
    invocation: { modelInvocable: true, userInvocable: false },
  })
}

export function apply(ctx, config = {}) {
  // desktop：DSH Desktop 宿主开放给插件的服务（卸载插件、重启）。普通 dsh 下一直是空的
  const deps = { env: process.env, desktop: {}, ...config }
  // 设置页路由和终端连接共用一个 token：每次启动随机生成，经页面注入给界面
  deps.token = deps.token ?? randomBytes(24).toString('hex')

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

  // DSH Desktop 专有服务：desktopPnpm 执行 `dsh plugin remove`，desktopActions 负责重启。
  // 插件市场（dshmarket）也是这么用的；普通 dsh 下这两个服务不存在，回调不执行
  ctx.inject(['desktopPnpm'], (desktopCtx) => {
    deps.desktop.pnpm = desktopCtx.desktopPnpm
    try {
      deps.desktop.profileDir = ctx.get?.('desktopProfiles')?.current?.dir
    } catch {
      deps.desktop.profileDir = undefined
    }
  })
  ctx.inject(['desktopActions'], (desktopCtx) => {
    deps.desktop.actions = desktopCtx.desktopActions
  })

  // 设置页路由 + 对话里的终端：可选且晚挂载。插件卸载或重载时一并反注册，
  // 否则同一路径再注册会报重复
  ctx.inject(['webServer'], async (webCtx) => {
    try {
      const { registerRoutes } = await import('./routes.js')
      const routes = registerRoutes(webCtx, deps)
      track(webCtx, routes.dispose, 'vps-manager: settings routes')
    } catch (error) {
      warn(ctx, '设置页路由注册失败（设置页不可用，命令与工具不受影响）', error)
    }
    try {
      const { registerTerminal } = await import('./terminal-server.js')
      const terminal = registerTerminal(webCtx, deps)
      track(webCtx, terminal.dispose, 'vps-manager: terminal')
    } catch (error) {
      warn(ctx, '终端连接注册失败（对话里的终端不可用，其他功能不受影响）', error)
    }
  })
}

export default { name, inject, apply }
