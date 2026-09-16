// lib/tools.js — AI 的 5 个工具（设计 9.1）
//
// 工具描述保持短：工作流写在 skill 正文里（lib/skills/vps-operator.md）。
// 每个工具都接 exec.signal —— 忽略取消的工具无法被超时策略切断。
//
// 关键约定：host 必填，且必须是已登记的机器。绝不从「当前机器」里猜：多个对话窗口
// 共享 current，猜出来的目标会把东西装到别的机器上。

import { execAction, hostsAction, recipeAction, taskAction, writeFileAction } from './actions.js'

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    return mod.defineTool ?? ((d) => d)
  } catch {
    return (d) => d // 宿主没提供这个包时退化为原样定义
  }
}

const TIER_LABEL = { read: '只读', change: '改动', danger: '高危' }

function renderResult(value) {
  const bits = []
  if (value.host) bits.push(`[${value.host}${value.address ? ` · ${value.address}` : ''}]`)
  if (value.tier) bits.push(TIER_LABEL[value.tier] ?? value.tier)
  if (value.status) bits.push(value.status)
  if (value.taskId) bits.push(`任务 ${value.taskId}`)
  const head = bits.join(' · ')
  const parts = [head]
  if (value.hint) parts.push(value.hint)
  if (value.output) parts.push(value.output)
  if (value.backupPath) parts.push(`备份：${value.backupPath}`)
  if (value.spillPath) parts.push(`完整输出：${value.spillPath}`)
  return [{ type: 'text', text: parts.filter(Boolean).join('\n') }]
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', required: true },
    host: { type: 'string' },
    address: { type: 'string' },
    status: { type: 'string', required: true },
    tier: { type: 'string' },
    exitCode: { type: 'integer' },
    taskId: { type: 'string' },
    output: { type: 'string' },
    stderr: { type: 'string' },
    hint: { type: 'string' },
    spillPath: { type: 'string' },
    backupPath: { type: 'string' },
    restoreCommand: { type: 'string' },
    summary: { type: 'string' },
  },
}

export async function buildToolDefinitions(ctx, deps = {}) {
  const defineTool = await loadDefineTool()
  const env = deps.env ?? process.env
  const runner = deps.runner
  const base = (args, exec) => ({
    ctx,
    env,
    runner,
    agent: exec?.agent,
    callId: exec?.callId,
    signal: exec?.signal,
    source: 'ai',
  })

  return [
    defineTool({
      name: 'vps_hosts',
      description:
        '列出用户登记的 VPS：别名、地址、备注、分组、系统、权限、确认档位。操作任何机器前先用它确认别名。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', required: true },
            current: { type: 'string' },
            hosts: { type: 'array', required: true, items: { type: 'object' } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.hosts?.length
            ? value.hosts.map((h) => `${h.alias}${h.address ? ` (${h.address})` : ''}${h.group ? ` [${h.group}]` : ''} ${h.note ?? ''} 权限:${h.privilege} 确认:${h.confirmLevel}`).join('\n')
            : '还没有添加任何机器，请用户在「设置 → VPS 管理」里添加',
        }],
      },
      async execute() {
        return hostsAction({ env })
      },
    }),

    defineTool({
      name: 'vps_exec',
      description:
        '在一台已登记的 VPS 上执行 shell 脚本。host 必填。intent 如实声明（read 只看 / change 会改 / danger 可能出大事）—— 插件会自己判定，声明低了不管用。' +
        '改配置文件请用 vps_write_file（那条有自动备份）。改防火墙或 SSH 时必须带 safety_net.restore。',
      parameters: {
        host: { type: 'string', required: true, description: '机器别名（vps_hosts 里的 alias）' },
        script: { type: 'string', required: true, description: 'POSIX sh 脚本；前导已提供 $SUDO / $PKG / $INIT / pkg_install 等' },
        intent: { type: 'string', enum: ['read', 'change', 'danger'], description: '这段脚本会做什么级别的事' },
        reason: { type: 'string', description: '一句话说明目的，会显示在确认框里' },
        background: { type: 'boolean', description: '长任务：true 表示不等结果，立刻返回任务号' },
        timeout_seconds: { type: 'integer', description: '等待上限，超过转后台' },
        safety_net_restore: { type: 'string', description: '连通性保险：改砸了用来恢复的脚本，例如 ufw disable' },
        safety_net_seconds: { type: 'integer', description: '多少秒后自动恢复（默认 120）' },
      },
      output: { schema: RESULT_SCHEMA, render: (_a, v) => renderResult(v) },
      async execute(args, exec) {
        return execAction({
          ...base(args, exec),
          alias: args.host,
          script: args.script,
          intent: args.intent,
          reason: args.reason,
          background: args.background === true,
          timeoutSeconds: args.timeout_seconds,
          safetyNet: args.safety_net_restore
            ? { restore: args.safety_net_restore, seconds: args.safety_net_seconds }
            : undefined,
        })
      },
    }),

    defineTool({
      name: 'vps_write_file',
      description:
        '写远端文件：自动备份原文件，校验不通过自动还原。改 nginx / 服务配置一律用它，不要用 echo > 或 sed -i。' +
        'validate 填能验证配置的命令（如 nginx -t），after 填生效命令（如 systemctl reload nginx）。',
      parameters: {
        host: { type: 'string', required: true },
        path: { type: 'string', required: true, description: '绝对路径' },
        content: { type: 'string', required: true, description: '完整文件内容（不是补丁）' },
        mode: { type: 'string', description: '权限位，如 644' },
        owner: { type: 'string', description: '属主，如 root:root' },
        validate: { type: 'string', description: '校验命令；失败会自动还原' },
        after: { type: 'string', description: '生效命令；失败也会自动还原' },
        reason: { type: 'string', description: '一句话说明目的' },
        safety_net_seconds: { type: 'integer', description: 'SSH / 防火墙类配置的自动恢复秒数' },
      },
      output: { schema: RESULT_SCHEMA, render: (_a, v) => renderResult(v) },
      async execute(args, exec) {
        return writeFileAction({
          ...base(args, exec),
          alias: args.host,
          path: args.path,
          content: args.content,
          mode: args.mode,
          owner: args.owner,
          validate: args.validate,
          after: args.after,
          reason: args.reason,
          safetyNet: args.safety_net_seconds ? { seconds: args.safety_net_seconds } : undefined,
        })
      },
    }),

    defineTool({
      name: 'vps_task',
      description:
        '远端任务：list 列出、status 看状态、log 取日志、cancel 终止。任务在断线后仍会继续跑，用它接回来。',
      parameters: {
        host: { type: 'string', required: true },
        action: { type: 'string', enum: ['list', 'status', 'log', 'cancel'], required: true },
        task_id: { type: 'string', description: 'status / log / cancel 时必填' },
        tail_bytes: { type: 'integer', description: '取日志的字节数' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', required: true },
            status: { type: 'string', required: true },
            host: { type: 'string' },
            hint: { type: 'string' },
            outcome: { type: 'string' },
            log: { type: 'string' },
            tasks: { type: 'array', items: { type: 'object' } },
            task: { type: 'object' },
          },
        },
        render: (_a, v) => [{
          type: 'text',
          text: v.tasks
            ? (v.tasks.length
              ? v.tasks.map((t) => `${t.taskId} ${t.state}${t.exitCode === null ? '' : ` (退出码 ${t.exitCode})`} ${t.meta?.recipeId ?? t.meta?.action ?? ''}`).join('\n')
              : '这台机器上没有任务记录')
            : [v.hint, v.log].filter(Boolean).join('\n'),
        }],
      },
      async execute(args, exec) {
        return taskAction({
          ...base(args, exec),
          alias: args.host,
          action: args.action,
          taskId: args.task_id,
          tailBytes: args.tail_bytes,
        })
      },
    }),

    defineTool({
      name: 'vps_recipe',
      description:
        '菜谱库：list 找现成的、show 看脚本原文与检测结果、run 执行、save 把这次做成的事存成菜谱。' +
        '装常见软件先查 list，有现成的就别自己写脚本。',
      parameters: {
        action: { type: 'string', enum: ['list', 'show', 'run', 'save'], required: true },
        id: { type: 'string', description: '菜谱 id（show / run 必填）' },
        host: { type: 'string', description: '机器别名（run 必填；show 时可选，用来顺带检测装没装）' },
        params: { type: 'object', description: 'run 时的菜谱参数；save 时是菜谱草稿（id/kind/name/desc/detect/run/verify/plan/params）' },
        kind: { type: 'string', enum: ['query', 'install', 'config'], description: 'list 的筛选' },
        tag: { type: 'string', description: 'list 的筛选' },
        force: { type: 'boolean', description: '已装也强制重跑（菜谱是幂等的）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', required: true },
            status: { type: 'string' },
            host: { type: 'string' },
            hint: { type: 'string' },
            detect: { type: 'string' },
            phase: { type: 'string' },
            output: { type: 'string' },
            recipes: { type: 'array', items: { type: 'object' } },
            recipe: { type: 'object' },
            id: { type: 'string' },
            file: { type: 'string' },
          },
        },
        render: (_a, v) => [{
          type: 'text',
          text: v.recipes
            ? v.recipes.map((r) => `${r.id}  ${r.name}（${r.kind}/${r.source}）${r.desc}`).join('\n')
            : v.recipe
              ? [`${v.recipe.id} ${v.recipe.name}`, v.recipe.desc, v.detect ? `检测：${v.detect}` : '', '', '--- 计划 ---', v.recipe.plan, '--- 脚本 ---', v.recipe.run].filter(Boolean).join('\n')
              : [v.hint, v.output].filter(Boolean).join('\n'),
        }],
      },
      async execute(args, exec) {
        return recipeAction({
          ...base(args, exec),
          action: args.action,
          id: args.id,
          alias: args.host,
          params: args.params,
          kind: args.kind,
          tag: args.tag,
          force: args.force === true,
        })
      },
    }),
  ]
}

/** 注册工具；返回反注册函数数组 */
export async function registerTools(ctx, deps = {}) {
  const defs = await buildToolDefinitions(ctx, deps)
  return defs.map((def) => ctx.tools.register(def))
}
