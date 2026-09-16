// lib/commands.js — /vps-* 宿主命令（设计第七节）
//
// 查询类命令不走模型、不花 token；它们只是内置 query 菜谱的薄包装。
//
// 安装类 /vps-install 是两段式：**宿主命令执行时没有轮次包裹**（dsh-commands 原文：
// 「没有轮次包裹它们」），而 ctx.approval.request() 在轮次外调用会直接抛异常 ——
// 所以命令里弹不出审批框，改由「先出计划，加 --yes 再执行」来确认。

import { effectiveConfirm, readHosts, writeHosts } from './config.js'
import { hostContext, probeHost, recipeAction, taskAction } from './actions.js'
import { loadRecipes } from './recipes.js'
import { runRemote } from './engine.js'

const LOADED_AT = Date.now()

const QUERY_COMMANDS = [
  ['sysinfo', 'sysinfo', '系统信息：CPU、内存、磁盘、系统版本、公网 IP'],
  ['disk', 'disk', '磁盘占用：挂载点、inode、最大的几个目录'],
  ['ports', 'ports', '端口监听与对应进程'],
  ['services', 'services', '服务状态：失败的与正在运行的'],
  ['net', 'net', '网卡、累计流量、连接数'],
  ['docker', 'docker-ps', 'Docker 容器列表与磁盘占用'],
  ['ping', 'health', '快速看一眼这台机器是否正常'],
]

function parseArgs(raw) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(Boolean)
  const out = { host: '', flags: new Set(), rest: [] }
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t === '-h' || t === '--host') {
      out.host = tokens[i + 1] ?? ''
      i += 1
    } else if (t.startsWith('--')) {
      out.flags.add(t.slice(2))
    } else {
      out.rest.push(t)
    }
  }
  return out
}

async function resolveAlias(host, env) {
  const doc = await readHosts(env)
  const alias = host || doc.current
  if (!alias) {
    throw new Error(
      Object.keys(doc.hosts).length
        ? `没有指定机器。已登记的有：${Object.keys(doc.hosts).join('、')}。用 -h <别名>，或先 /vps-use <别名> 设为当前机器`
        : '还没有添加机器：点左边栏的「VPS 管理」→「+ 添加机器」，向导会带你接上第一台',
    )
  }
  if (!doc.hosts[alias]) {
    throw new Error(`没有登记过这台机器：${alias}（已登记：${Object.keys(doc.hosts).join('、') || '无'}）`)
  }
  return alias
}

/** 折叠后只看得到第一行，所以第一行要写成「[机器] 一句话摘要」 */
function layout(alias, info, output, hint) {
  const lines = String(output ?? '').split('\n')
  const summary = lines[0]?.trim() ?? ''
  const rest = lines.slice(1).join('\n').replace(/^\n+/, '')
  const sub = [info.address, info.host?.note, info.host?.group].filter(Boolean).join(' · ')
  return capText([`[${alias}] ${summary || hint || ''}`.trim(), sub, '', rest].filter((x) => x !== undefined).join('\n').trim())
}

/** 命令结果进会话日志前截断（设计第二节）：超长文本既撑大日志，也可能拖垮渲染 */
function capText(text, limit = 4000) {
  const s = String(text ?? '')
  if (s.length <= limit) return s
  const head = s.slice(0, limit - 900)
  const tail = s.slice(-800)
  return `${head}\n\n…（输出过长，中间省略 ${s.length - limit + 100} 字）…\n\n${tail}`
}

/** 每条输出的抬头，永远写清楚是哪台机器 */
async function header(alias, env) {
  const info = await hostContext(alias, { env })
  return `${info.label}${info.host.note ? ` ${info.host.note}` : ''}`
}

export function registerCommands(ctx, deps = {}) {
  const env = deps.env ?? process.env
  const runner = deps.runner
  const disposers = []
  const reg = (def) => disposers.push(ctx.commands.register(def))

  // —— 查询类：直接出结果 ——
  for (const [name, recipeId, desc] of QUERY_COMMANDS) {
    reg({
      name: `vps-${name}`,
      // 不声明 input：声明了 DSH 就当成「等你输参数」，回车不执行（实测）。
      // 想指定机器仍可手打 /vps-xxx -h 别名，rawInput 照样解析
      description: `${desc}（不经过模型，不花 token）。默认当前机器，可加 -h 别名`,
      async handler(invocation) {
        try {
          const args = parseArgs(invocation.rawInput)
          const alias = await resolveAlias(args.host, env)
          const res = await recipeAction({ action: 'run', id: recipeId, alias, env, runner, source: 'command', ctx })
          const info = await hostContext(alias, { env })
          if (!res.ok) {
            return { kind: 'error', text: capText(`[${alias}] ${res.hint ?? '执行失败'}\n${info.address}\n\n${res.output ?? ''}`.trim()) }
          }
          return { kind: 'success', text: layout(alias, info, res.output, res.hint) }
        } catch (error) {
          return { kind: 'error', text: error.message }
        }
      },
    })
  }

  // —— 日志（带一个位置参数）——
  reg({
    name: 'vps-logs',
    description: '某个服务最近 100 行日志。用法：/vps-logs <服务名> [-h 别名]',
    input: { hint: '<服务名> [-h 别名]' },
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const service = args.rest[0]
        if (!service) return { kind: 'error', text: '用法：/vps-logs <服务名> [-h 别名]' }
        const alias = await resolveAlias(args.host, env)
        const res = await recipeAction({
          action: 'run',
          id: 'logs',
          alias,
          params: { service },
          env,
          runner,
          source: 'command',
          ctx,
        })
        const info = await hostContext(alias, { env })
        return res.ok
          ? { kind: 'success', text: layout(alias, info, res.output, res.hint) }
          : { kind: 'error', text: capText(`[${alias}] ${res.hint}\n${info.address}\n\n${res.output ?? ''}`.trim()) }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  })


  // —— 总入口：大家会下意识打 /vps-help ——
  reg({
    name: 'vps-help',
    description: '这个插件怎么用：命令清单、怎么指定机器、面板在哪。用法：/vps-help',
    async handler() {
      const doc = await readHosts(env)
      const aliases = Object.keys(doc.hosts)
      const { list } = await loadRecipes({ env })
      let version = ''
      try {
        const { createRequire } = await import('node:module')
        version = createRequire(import.meta.url)('../package.json').version
      } catch {
        version = ''
      }
      const lines = [
        `[VPS 管理${version ? ` ${version}` : ''}] ${aliases.length} 台机器 · 当前 ${doc.current || '未设置'} · 菜谱 ${list.length} 条 · 打 /vps 看全部命令`,
        '',
        '看信息（不走模型、不花 token）',
        '  /vps-sysinfo    系统、CPU、内存、磁盘、公网 IP',
        '  /vps-disk       磁盘占用与最大的几个目录',
        '  /vps-ports      端口监听与对应进程',
        '  /vps-services   失败的和正在运行的服务',
        '  /vps-net        网卡、累计流量、连接数',
        '  /vps-docker     容器与磁盘占用',
        '  /vps-ping       一行健康状态',
        '  /vps-logs <服务名>   最近 100 行日志',
        '',
        '机器',
        '  /vps-list       已登记的机器和状态（★ 是当前机器）',
        '  /vps-use <别名>  切换当前机器',
        '  /vps-probe      重新体检（系统、权限、资源）',
        '',
        '安装与任务',
        '  /vps-recipes [关键词]      菜谱清单（查询 + 安装，共 ' + list.length + ' 条）',
        '  /vps-install <菜谱id>      先出计划；确认后加 --yes 执行',
        '  /vps-tasks [任务号]        远端任务与日志（断线后仍在跑的那些）',
        '',
        '排查',
        '  /vps-doctor     插件状态、当前机器、连通测试、最近执行',
        '',
        '指定机器：所有命令默认操作当前机器，加 -h <别名> 指定别的，例如 /vps-disk -h jp',
        '',
        '更省事的两个入口：',
        '  · 左边栏「VPS 管理」面板：机器列表、应用商店、任务、机器设置',
        '  · 直接跟 AI 说话：「看看 ' + (doc.current || '某台机器') + ' 的磁盘」「给它装个 nginx」',
        '    AI 会按只读 / 改动 / 高危分级，改东西之前问你（当前档位：' + doc.settings.confirm + '）',
      ]
      if (!aliases.length) {
        lines.push('', '现在还没有机器：点左边栏「VPS 管理」→「+ 添加机器」，向导会带你接上第一台。')
      }
      return { kind: 'success', text: capText(lines.join('\n')) }
    },
  })

  // —— 机器清单与当前机器 ——
  reg({
    name: 'vps-list',
    description: '列出已登记的 VPS 与状态。用法：/vps-list',
    async handler() {
      const doc = await readHosts(env)
      const entries = Object.entries(doc.hosts)
      if (!entries.length) {
        return { kind: 'success', text: '还没有添加机器：在「设置 → VPS 管理」里添加第一台。' }
      }
      const { readState } = await import('./config.js')
      const state = await readState(env)
      const lines = entries.map(([alias, host]) => {
        const st = state.hosts?.[alias] ?? {}
        const mark = alias === doc.current ? '★' : ' '
        const reach = st.reachable === true ? '🟢' : st.reachable === false ? '🔴' : '⚪'
        const priv = st.facts?.privilege ? `权限:${st.facts.privilege}` : ''
        return `${mark} ${reach} ${alias.padEnd(12)} ${(st.address ?? '').padEnd(21)} ${host.group ? `[${host.group}] ` : ''}${host.note ?? ''} ${priv} 确认:${effectiveConfirm(doc, alias)}`
      })
      return { kind: 'success', text: ['★ = 当前机器', ...lines].join('\n') }
    },
  })

  reg({
    name: 'vps-use',
    description: '把某台机器设为当前机器（之后不带 -h 的命令都指向它）。用法：/vps-use <别名>',
    input: { hint: '<别名>' },
    async handler(invocation) {
      const alias = String(invocation.rawInput ?? '').trim().split(/\s+/)[0]
      if (!alias) return { kind: 'error', text: '用法：/vps-use <别名>' }
      const doc = await readHosts(env)
      if (!doc.hosts[alias]) {
        return { kind: 'error', text: `没有登记过这台机器：${alias}（已登记：${Object.keys(doc.hosts).join('、') || '无'}）` }
      }
      await writeHosts({ ...doc, current: alias }, env)
      return { kind: 'success', text: `当前机器已切换到 ${alias}。注意：AI 操作仍然需要显式指定机器。` }
    },
  })

  reg({
    name: 'vps-probe',
    description: '重新体检一台机器（系统、init、权限、资源）。默认当前机器，可加 -h 别名',
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const alias = await resolveAlias(args.host, env)
        const res = await probeHost({ alias, env, runner })
        if (!res.ok) return { kind: 'error', text: `[${alias}] 体检失败：${res.hint}` }
        const f = res.facts
        return {
          kind: 'success',
          text: [
            `[${alias} · ${res.address}]`,
            `系统 ${f.os_id} ${f.os_ver}（${f.os_family}）  init ${f.init}  包管理 ${f.pkg}`,
            `权限 ${f.privilege === 'root' ? 'root' : f.privilege === 'sudo' ? '免密 sudo' : '仅只读'}`,
            `CPU ${f.cpu} 核  内存 ${f.mem_used_mb}/${f.mem_total_mb} MB  磁盘 ${f.disk_used_mb}/${f.disk_total_mb} MB (${f.disk_pct})`,
          ].join('\n'),
        }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  })

  // —— 菜谱与安装 ——
  reg({
    name: 'vps-recipes',
    description: '列出可用的菜谱（内置 + 我的）。可加关键词过滤',
    async handler(invocation) {
      const keyword = String(invocation.rawInput ?? '').trim().toLowerCase()
      const { list, errors, conflicts } = await loadRecipes({ env })
      const matched = keyword
        ? list.filter((r) => [r.id, r.name, r.desc, ...r.tags].join(' ').toLowerCase().includes(keyword))
        : list
      const lines = matched.map((r) => `${r.id.padEnd(18)} ${r.kind.padEnd(8)} ${r.source === 'builtin' ? '内置' : '我的'}  ${r.name} —— ${r.desc}`)
      const tail = []
      if (errors.length) tail.push(`\n有 ${errors.length} 个菜谱文件解析失败：\n` + errors.map((e) => `  ${e.file}: ${e.message}`).join('\n'))
      if (conflicts.length) tail.push(`\n${conflicts.length} 个自定义菜谱与内置重名未加载：` + conflicts.map((c) => c.id).join('、'))
      return { kind: 'success', text: [lines.join('\n') || '没有匹配的菜谱', ...tail].join('\n') }
    },
  })

  reg({
    name: 'vps-install',
    description:
      '按菜谱安装 / 配置。两段式：先看计划，确认无误再加 --yes 执行。用法：/vps-install <菜谱id> [-h 别名] [--yes]',
    input: { hint: '<菜谱id> [-h 别名] [--yes]' },
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const id = args.rest[0]
        if (!id) return { kind: 'error', text: '用法：/vps-install <菜谱id> [-h 别名] [--yes]；用 /vps-recipes 看有哪些' }
        const alias = await resolveAlias(args.host, env)
        const head = await header(alias, env)

        if (!args.flags.has('yes')) {
          const shown = await recipeAction({ action: 'show', id, alias, env, runner, source: 'command', ctx })
          const r = shown.recipe
          const detect = shown.detect === 'installed'
            ? '检测结果：已经装了（执行会跳过安装，直接验证）'
            : shown.detect === 'absent'
              ? '检测结果：没装'
              : `检测结果：说不清 —— ${shown.detectHint ?? ''}`
          return {
            kind: 'success',
            text: [
              head,
              `菜谱：${r.name}（${r.id}，${r.source === 'builtin' ? '内置' : '我的'}，级别 ${r.tier}）`,
              r.desc,
              detect,
              '',
              '计划：',
              r.plan || '（这条菜谱没写 plan）',
              '',
              '脚本：',
              r.run.trim(),
              '',
              `确认无误后执行：/vps-install ${id} -h ${alias} --yes`,
            ].join('\n'),
          }
        }

        const res = await recipeAction({ action: 'run', id, alias, params: {}, env, runner, source: 'command', ctx })
        return {
          kind: res.ok ? 'success' : 'error',
          text: [head, res.hint, res.output, res.taskId ? `任务号 ${res.taskId}（可用 /vps-tasks 查看）` : ''].filter(Boolean).join('\n'),
        }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  })


  // —— 自查：装好了没、指向哪台、最近跑过什么 ——
  reg({
    name: 'vps-doctor',
    description: '自查：插件状态、当前机器、最近几次执行、一次最小连通测试。用法：/vps-doctor',
    async handler() {
      const lines = []
      try {
        const { createRequire } = await import('node:module')
        const pkg = createRequire(import.meta.url)('../package.json')
        lines.push(`插件 ${pkg.name} ${pkg.version}　已加载 ${new Date(LOADED_AT).toLocaleString()}`)
      } catch {
        lines.push('插件已加载')
      }
      try {
        const doc = await readHosts(env)
        const aliases = Object.keys(doc.hosts)
        lines.push(`机器：${aliases.join('、') || '（一台都没有）'}　当前：${doc.current || '（未设置）'}`)
        lines.push(`确认档位：${doc.settings.confirm}`)
        if (doc.current) {
          const info = await hostContext(doc.current, { env })
          lines.push(`当前机器解析地址：${info.address || '（ssh -G 解析失败）'}`)
          const t0 = Date.now()
          const probe = await runRemote({
            alias: doc.current,
            body: 'echo doctor-ok',
            mode: 'read',
            withPrelude: false,
            timeoutMs: 20_000,
            env,
            runner,
          })
          lines.push(`连通测试：${probe.ok ? `成功（${Date.now() - t0}ms）` : `失败 —— ${probe.status}：${probe.hint}`}`)
        }
      } catch (error) {
        lines.push(`读取配置出错：${error.message}`)
      }
      try {
        const { readAudit } = await import('./audit.js')
        const rows = await readAudit({ limit: 5, env })
        lines.push('', '最近 5 次执行：')
        for (const r of rows) {
          lines.push(`  ${r.at?.slice(11, 19)} ${r.source ?? '?'} ${r.recipeId ?? r.action ?? ''} → ${r.status ?? r.decision ?? '?'}`)
        }
        if (!rows.length) lines.push('  （还没有记录）')
      } catch {
        lines.push('（读不到审计日志）')
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  // —— 任务 ——
  reg({
    name: 'vps-tasks',
    description: '查看远端任务（断线后仍在跑的那些）。可加任务号看日志，可加 -h 别名',
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const alias = await resolveAlias(args.host, env)
        const head = await header(alias, env)
        const taskId = args.rest[0]
        const res = await taskAction({
          ctx,
          alias,
          action: taskId ? 'log' : 'list',
          taskId,
          env,
          runner,
          source: 'command',
        })
        if (!res.ok) return { kind: 'error', text: `${head}\n${res.hint}` }
        if (taskId) {
          const t = res.task
          return {
            kind: 'success',
            text: [head, `任务 ${taskId}：${t?.state ?? '?'}${t?.exitCode === null || t?.exitCode === undefined ? '' : `（退出码 ${t.exitCode}）`}`, '', res.log].join('\n'),
          }
        }
        const lines = (res.tasks ?? []).map((t) => `${t.taskId}  ${t.state}${t.exitCode === null ? '' : `(${t.exitCode})`}  ${t.meta?.recipeId ?? t.meta?.action ?? ''}  ${t.meta?.source ?? ''}`)
        return { kind: 'success', text: [head, lines.join('\n') || '这台机器上没有任务记录'].join('\n') }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // 反注册失败不影响卸载
      }
    }
  }
}
