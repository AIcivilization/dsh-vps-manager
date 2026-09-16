// lib/commands.js — /vps-* 宿主命令（设计第七节）
//
// 查询类命令不走模型、不花 token；它们只是内置 query 菜谱的薄包装。
//
// 安装类 /vps-install 是两段式：**宿主命令执行时没有轮次包裹**（dsh-commands 原文：
// 「没有轮次包裹它们」），而 ctx.approval.request() 在轮次外调用会直接抛异常 ——
// 所以命令里弹不出审批框，改由「先出计划，加 --yes 再执行」来确认。

import { bindSession, effectiveConfirm, paths, readHosts, resolveTarget, sessionBinding, writeHosts } from './config.js'
import { execAction, hostContext, probeHost, recipeAction, taskAction } from './actions.js'
import { classifyScript } from './risk.js'
import { loadRecipes } from './recipes.js'
import { runRemote } from './engine.js'

const LOADED_AT = Date.now()

const CONFIRM_LABEL = { careful: '谨慎', relaxed: '放手', auto: '全自动' }

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

/**
 * 目标机器：-h 指定 > 这个对话绑定的机器 > 全局当前机器。
 * 会话绑定来自对话里的 VPS 开关；host 侧从 invocation.agent.session.id 认出是哪个会话。
 */
async function resolveAlias(host, env, invocation) {
  const sessionId = invocation?.agent?.session?.id ?? invocation?.sessionId ?? ''
  const { alias } = await resolveTarget({ explicit: host, sessionId: String(sessionId || ''), env })
  if (alias) return alias
  const doc = await readHosts(env)
  const aliases = Object.keys(doc.hosts)
  const first = aliases[0]
  throw new Error(
    aliases.length
      ? [
          `未开 VPS 开关：点对话头部「VPS」选一台，或本条加 -h ${first}`,
          `可用机器：${aliases.join('、')}　键盘版：/vps-use ${first}（关闭：/vps-use off）`,
        ].join('\n')
      : '还没有添加机器：DSH 设置 → VPS 管理 →「+ 添加机器」',
  )
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
  // 命令目录：/vps-help 从这里生成，避免手写清单和实际命令对不上
  const catalog = []
  const reg = (def, meta = {}) => {
    catalog.push({
      name: def.name,
      usage: meta.usage ?? `/${def.name}`,
      group: meta.group ?? '其他',
      short: meta.short ?? def.description,
    })
    disposers.push(ctx.commands.register(def))
  }

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
          const alias = await resolveAlias(args.host, env, invocation)
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
    }, { group: '看信息', usage: `/vps-${name} [-h 别名]`, short: desc })
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
        const alias = await resolveAlias(args.host, env, invocation)
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
  }, { group: '看信息', usage: '/vps-logs <服务名> [-h 别名]', short: '某个服务最近 100 行日志' })


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
      // 从 catalog 生成，新增命令自动出现在这里（有测试盯着不许漏）
      const order = ['入口', '看信息', '机器', '安装与任务', '排查', '其他']
      const pad = Math.max(...catalog.map((c) => c.usage.length)) + 2
      const lines = [
        `[VPS 管理${version ? ` ${version}` : ''}] ${catalog.length} 条命令 · ${aliases.length} 台机器 · 当前 ${doc.current || '未设置'} · 菜谱 ${list.length} 条`,
      ]
      for (const group of order) {
        const items = catalog.filter((c) => c.group === group)
        if (!items.length) continue
        lines.push('', group === '看信息' ? '看信息（不走模型、不花 token）' : group)
        for (const item of items) lines.push(`  ${item.usage.padEnd(pad)}${item.short}`)
      }
      lines.push(
        '',
        '指定机器',
        '  命令操作「这个对话绑定的那台」（对话头部的 VPS 开关）；没绑就必须写 -h <别名>',
        '  临时换一台：加 -h <别名>，例如 /vps-disk -h jp',
        '  /vps-use <别名> 绑定这个对话；对话头部的 VPS 开关是同一件事',
        '',
        '跟 AI 说话（另外五个工具，直接用自然语言）',
        '  「看看 X 的磁盘」            只读，自动执行，不打扰你',
        '  「给 X 装个 nginx」          有现成菜谱就用菜谱，没有就现写脚本',
        '  「把 a.com 反代到 3000」     改配置文件会自动备份，校验不过自动还原',
        '  「刚才这套存成菜谱」          下次 /vps-install 一句话重来',
        `  当前确认档位：${CONFIRM_LABEL[doc.settings.confirm] ?? doc.settings.confirm}（只读自动 / 改动问你 / 高危标红再问）`,
        '',
        '设置（DSH 设置 → VPS 管理）',
        '  添加 / 编辑 / 删除机器、编号、每台的确认档位与基础配置（时区、swap、BBR…）',
        `  装软件与系统维护都在菜谱里（现有 ${list.length} 条）：/vps-recipes 看清单，/vps-install 装`,
        '',
        `配置与记录：${paths(env).base}`,
      )
      if (!aliases.length) {
        lines.push('', '现在还没有机器：DSH 设置 → VPS 管理 →「+ 添加机器」，向导会带你接上第一台。')
      }
      return { kind: 'success', text: capText(lines.join('\n')) }
    },
  }, { group: '入口', usage: '/vps-help', short: '全部命令与用法（就是这一页）' })


  // —— 把对话框当成这台机器的命令行 ——
  reg({
    name: 'vps-sh',
    description:
      '在当前机器上执行一条命令，输出直接进对话（不走模型、不花 token）。' +
      '危险命令要在最前面加 --yes。用法：/vps-sh [--yes] <命令>',
    input: { hint: '[--yes] <命令>' },
    async handler(invocation) {
      let raw = String(invocation.rawInput ?? '').trim()
      if (!raw) {
        return { kind: 'error', text: '用法：/vps-sh <命令>，例如 /vps-sh df -h\n换机器用 /vps-use <别名>' }
      }
      // --yes 只在最前面才当成开关，后面出现的原样交给远端（比如 apt-get -y 里的参数）
      let confirmed = false
      if (raw.startsWith('--yes ')) {
        confirmed = true
        raw = raw.slice(6).trim()
      }
      try {
        const alias = await resolveAlias('', env, invocation)
        const info = await hostContext(alias, { env })
        const classification = classifyScript(raw)
        const tier = classification.tier

        if (tier === 'danger' && !confirmed) {
          const why = classification.dangers.map((d) => `${d.why}（命中：${d.match}）`).join('；')
          const firstWhy = classification.dangers[0]
          return {
            kind: 'error',
            text: [
              `[${alias}] ⚠ 高危已拦下，未执行：${firstWhy?.why ?? '高危操作'}（命中 ${firstWhy?.match ?? ''}）`,
              `确认要跑就重发：/vps-sh --yes ${raw}`,
              why && classification.dangers.length > 1 ? `全部命中：${why}` : '',
            ].filter(Boolean).join('\n'),
          }
        }

        const res = await execAction({
          ctx,
          alias,
          script: raw,
          intent: tier,
          reason: `命令行：${raw.slice(0, 60)}`,
          source: 'command',
          preApproved: true, // 你自己敲的就是同意；高危另外要 --yes
          env,
          runner,
          timeoutSeconds: tier === 'read' ? 30 : 120,
        })

        const head = `[${alias}] $ ${raw}`
        const body = [res.output, res.stderr].filter(Boolean).join('\n').trim()
        const tail = []
        if (res.status === 'detached') tail.push(`（还在跑，任务 ${res.taskId}，用 /vps-tasks 查看）`)
        else if (res.exitCode !== null && res.exitCode !== 0) tail.push(`退出码 ${res.exitCode}`)
        if (tier === 'danger') tail.push('已按高危执行')

        return {
          kind: res.ok || res.status === 'detached' ? 'success' : 'error',
          text: capText([head, body || '（没有输出）', tail.join('　')].filter(Boolean).join('\n')),
        }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '看信息', usage: '/vps-sh [--yes] <命令>', short: '在当前机器上直接执行一条命令，输出进对话' })


  reg({
    name: 'vps-q',
    description: '在当前机器上跑一条查询菜谱，输出进对话（不走模型）。用法：/vps-q <菜谱id>',
    input: { hint: '<菜谱id>' },
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const id = args.rest[0]
        if (!id) {
          const { list } = await loadRecipes({ env })
          const ids = list.filter((r) => r.kind === 'query' && r.id !== 'probe').map((r) => r.id)
          return { kind: 'error', text: `用法：/vps-q <菜谱id>\n可用：${ids.join('、')}` }
        }
        const { byId } = await loadRecipes({ env })
        const recipe = byId.get(id)
        if (!recipe) return { kind: 'error', text: `没有这条菜谱：${id}` }
        if (recipe.kind !== 'query') {
          return { kind: 'error', text: `${id} 不是查询类。安装用 /vps-install ${id}` }
        }
        const alias = await resolveAlias(args.host, env, invocation)
        const info = await hostContext(alias, { env })
        const params = {}
        for (const spec of recipe.params) {
          const value = args.rest[recipe.params.indexOf(spec) + 1]
          if (value) params[spec.name] = value
        }
        const res = await recipeAction({ action: 'run', id, alias, params, env, runner, source: 'command', ctx })
        return res.ok
          ? { kind: 'success', text: layout(alias, info, res.output, res.hint) }
          : { kind: 'error', text: capText(`[${alias}] ${res.hint}\n${res.output ?? ''}`.trim()) }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '看信息', usage: '/vps-q <菜谱id>', short: '跑任意一条查询菜谱（没有专属命令的那些）' })

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
  }, { group: '机器', usage: '/vps-list', short: '已登记的机器和状态（★ 是这个对话绑定的）' })

  reg({
    name: 'vps-use',
    description: '把这个对话绑定到一台机器（等同对话头部的 VPS 开关）。用法：/vps-use <别名> | /vps-use off',
    input: { hint: '<别名> 或 off' },
    async handler(invocation) {
      const arg = String(invocation.rawInput ?? '').trim().split(/\s+/)[0]
      const sessionId = String(invocation?.agent?.session?.id ?? '')
      const doc = await readHosts(env)
      if (!arg) {
        const bound = sessionId ? await sessionBinding(sessionId, env) : ''
        return {
          kind: 'error',
          text: [
            bound
              ? `这个对话绑定着 ${bound}　换一台：/vps-use <别名>　关闭：/vps-use off`
              : `这个对话没绑定机器　绑定：/vps-use <别名>（已登记：${Object.keys(doc.hosts).join('、') || '无'}）`,
          ].join('\n'),
        }
      }
      if (!sessionId) {
        return { kind: 'error', text: '这个环境认不出当前会话，请改用对话头部的 VPS 开关' }
      }
      if (arg === 'off' || arg === 'none') {
        await bindSession(sessionId, null, env)
        return { kind: 'success', text: '已关闭 VPS 模式：这个对话的命令需要 -h，AI 也不再默认操作任何机器' }
      }
      if (!doc.hosts[arg]) {
        return { kind: 'error', text: `没有登记过这台机器：${arg}（已登记：${Object.keys(doc.hosts).join('、') || '无'}）` }
      }
      await bindSession(sessionId, arg, env)
      await writeHosts({ ...doc, current: arg }, env) // 下次打开开关时预选它
      return {
        kind: 'success',
        text: [
          `已绑定 ${arg}：这个对话的命令免写 -h，AI 也默认操作它`,
          '只影响这个对话；关闭用 /vps-use off',
        ].join('\n'),
      }
    },
  }, { group: '机器', usage: '/vps-use <别名>|off', short: '把这个对话绑到一台机器（和头部开关同一件事）' })

  reg({
    name: 'vps-probe',
    description: '重新体检一台机器（系统、init、权限、资源）。默认当前机器，可加 -h 别名',
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const alias = await resolveAlias(args.host, env, invocation)
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
  }, { group: '机器', usage: '/vps-probe [-h 别名]', short: '重新体检：系统、init、权限、资源' })

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
  }, { group: '安装与任务', usage: '/vps-recipes [关键词]', short: '菜谱清单，可按关键词过滤' })

  reg({
    name: 'vps-install',
    description:
      '按菜谱安装 / 配置。两段式：先看计划，确认无误再加 --yes 执行。菜谱参数写成 key=value 跟在 id 后面。' +
      '用法：/vps-install <菜谱id> [key=value ...] [-h 别名] [--yes]',
    input: { hint: '<菜谱id> [key=value ...] [-h 别名] [--yes]' },
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const id = args.rest[0]
        if (!id) return { kind: 'error', text: '用法：/vps-install <菜谱id> [key=value ...] [-h 别名] [--yes]；用 /vps-recipes 看有哪些' }

        const { byId } = await loadRecipes({ env })
        const recipe = byId.get(id)
        if (!recipe) return { kind: 'error', text: `没有这条菜谱：${id}\n用 /vps-recipes 看清单` }

        // 参数：key=value。名字先在本地对一遍，错了直接告诉用户这条菜谱收什么
        const params = {}
        const malformed = []
        for (const token of args.rest.slice(1)) {
          const eq = token.indexOf('=')
          if (eq <= 0) malformed.push(token)
          else params[token.slice(0, eq)] = token.slice(eq + 1)
        }
        const declared = new Set(recipe.params.map((p) => p.name))
        const unknown = Object.keys(params).filter((k) => !declared.has(k))
        if (malformed.length || unknown.length) {
          const wrong = [...malformed, ...unknown].join('、')
          return {
            kind: 'error',
            text: [
              `[${id}] 参数不对：${wrong}（要写成 key=value）`,
              recipe.params.length
                ? `这条菜谱收：${recipe.params.map((p) => `${p.name}=${p.default ?? (p.required ? '必填' : '')}`).join('　')}`
                : '这条菜谱不收参数',
            ].join('\n'),
          }
        }
        const paramText = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ')

        const alias = await resolveAlias(args.host, env, invocation)
        const head = await header(alias, env)

        if (!args.flags.has('yes')) {
          const shown = await recipeAction({ action: 'show', id, alias, env, runner, source: 'command', ctx })
          const r = shown.recipe
          const detect = shown.detect === 'installed'
            ? '检测结果：已经装了（执行会跳过安装，直接验证）'
            : shown.detect === 'absent'
              ? '检测结果：没装'
              : `检测结果：说不清 —— ${shown.detectHint ?? ''}`
          const detectShort = shown.detect === 'installed' ? '已经装了' : shown.detect === 'absent' ? '还没装' : '检测说不清'
          const paramLines = r.params.length
            ? ['', '参数（可改，写成 key=value 跟在 id 后面）：',
               ...r.params.map((p) => {
                 const used = params[p.name]
                 const value = used ?? p.default ?? (p.required ? '（必填，还没给）' : '（不填）')
                 return `  ${p.name} = ${value}${used ? ' ←本次指定' : ''}　${p.desc}`
               })]
            : []
          return {
            kind: 'success',
            text: capText([
              `[${alias}] ${r.name}：${detectShort}，尚未执行 · 确认执行发 /vps-install ${id}${paramText ? ` ${paramText}` : ''} -h ${alias} --yes`,
              r.desc,
              detect,
              ...paramLines,
              '',
              '计划：',
              r.plan || '（这条菜谱没写 plan）',
              '',
              '脚本：',
              r.run.trim(),
            ].join('\n')),
          }
        }

        const res = await recipeAction({
          action: 'run',
          id,
          alias,
          params,
          env,
          runner,
          source: 'command',
          ctx,
          preApproved: true, // --yes 就是用户的同意；命令没有轮次，弹不出审批框
        })
        return {
          kind: res.ok ? 'success' : 'error',
          text: capText([
            `[${alias}] ${recipe.name}：${res.ok ? '完成' : res.hint ?? '失败'}${paramText ? `　${paramText}` : ''}`,
            head,
            res.ok ? res.hint : '',
            res.output,
            res.taskId ? `任务号 ${res.taskId}（/vps-tasks ${res.taskId} 看进度，/vps-tasks ${res.taskId} --stop 终止）` : '',
          ].filter(Boolean).join('\n')),
        }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '安装与任务', usage: '/vps-install <菜谱id> [key=value] [--yes]', short: '先出计划，确认后加 --yes 才执行' })


  // —— 自查：装好了没、指向哪台、最近跑过什么 ——
  reg({
    name: 'vps-doctor',
    description: '自查：插件状态、本对话绑定的机器、最近几次执行、一次最小连通测试。用法：/vps-doctor',
    async handler(invocation) {
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
        const sessionId = String(invocation?.agent?.session?.id ?? '')
        const bound = sessionId ? await sessionBinding(sessionId, env) : ''
        lines.push(`机器：${aliases.join('、') || '（一台都没有）'}`)
        lines.push(bound
          ? `这个对话已绑定：${bound}（VPS 开关是开的）`
          : '这个对话没有绑定机器（VPS 开关关着，命令需要 -h）')
        lines.push(`确认档位：${doc.settings.confirm}`)
        const probeTarget = bound || doc.current
        if (probeTarget) {
          const info = await hostContext(probeTarget, { env })
          lines.push(`当前机器解析地址：${info.address || '（ssh -G 解析失败）'}`)
          const t0 = Date.now()
          const probe = await runRemote({
            alias: probeTarget,
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
  }, { group: '排查', usage: '/vps-doctor', short: '插件状态、当前机器、连通测试、最近执行' })

  // —— 任务 ——
  reg({
    name: 'vps-tasks',
    description: '查看远端任务（断线后仍在跑的那些）。加任务号看日志，再加 --stop 终止它，可加 -h 别名',
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const alias = await resolveAlias(args.host, env, invocation)
        const head = await header(alias, env)
        const taskId = args.rest[0]
        const stop = args.flags.has('stop')

        if (stop && !taskId) {
          return { kind: 'error', text: `[${alias}] --stop 要跟任务号：/vps-tasks <任务号> --stop\n先发 /vps-tasks 看有哪些任务` }
        }
        if (stop) {
          const res = await taskAction({
            ctx,
            alias,
            action: 'cancel',
            taskId,
            env,
            runner,
            source: 'command',
            preApproved: true, // 你自己敲的 --stop 就是同意；命令没有轮次，弹不出审批框
          })
          return {
            kind: res.ok ? 'success' : 'error',
            text: capText([
              `[${alias}] 任务 ${taskId}：${res.hint || (res.ok ? '已终止' : '终止失败')}`,
              head,
              res.ok && res.outcome !== 'already_stopped' ? '中途终止可能留下装了一半的状态，建议跟一条检查命令' : '',
              res.output,
            ].filter(Boolean).join('\n')),
          }
        }

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
          const state = t?.state ?? '?'
          return {
            kind: 'success',
            text: capText([
              `[${alias}] 任务 ${taskId}：${state}${t?.exitCode === null || t?.exitCode === undefined ? '' : `（退出码 ${t.exitCode}）`}`,
              head,
              state === 'running' ? `还在跑，要停发 /vps-tasks ${taskId} --stop` : '',
              '',
              res.log,
            ].filter(Boolean).join('\n')),
          }
        }
        const tasks = res.tasks ?? []
        const running = tasks.filter((t) => t.state === 'running').length
        const lines = tasks.map((t) => `${t.taskId}  ${t.state}${t.exitCode === null ? '' : `(${t.exitCode})`}  ${t.meta?.recipeId ?? t.meta?.action ?? ''}  ${t.meta?.source ?? ''}`)
        return {
          kind: 'success',
          text: capText([
            `[${alias}] ${tasks.length ? `${tasks.length} 个任务${running ? `，${running} 个还在跑` : '，都已结束'}` : '没有任务记录'}`,
            head,
            '',
            lines.join('\n'),
            tasks.length ? '看日志：/vps-tasks <任务号>　终止：/vps-tasks <任务号> --stop' : '',
          ].filter(Boolean).join('\n')),
        }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '安装与任务', usage: '/vps-tasks [任务号] [--stop]', short: '远端任务、日志、终止（断线后仍在跑的那些）' })

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
