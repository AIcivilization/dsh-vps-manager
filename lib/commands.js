// lib/commands.js — /vps-* 宿主命令（设计第七节）
//
// 查询类命令不走模型、不花 token；它们只是内置 query 菜谱的薄包装。
//
// 安装类 /vps-install 是两段式：**宿主命令执行时没有轮次包裹**（dsh-commands 原文：
// 「没有轮次包裹它们」），而 ctx.approval.request() 在轮次外调用会直接抛异常 ——
// 所以命令里弹不出审批框，改由「先出计划，加 --yes 再执行」来确认。

import { bindSession, effectiveConfirm, paths, readHosts, resolveTarget, sessionBinding, sessionCwd, setSessionCwd, writeHosts } from './config.js'
import { execAction, hostContext, probeHost, probeIfUnknown, recipeAction, taskAction } from './actions.js'
import { classifyScript } from './risk.js'
import { loadRecipes, recipeText } from './recipes.js'
import { L } from './i18n.js'
import { runRemote } from './engine.js'
import { appendAudit } from './audit.js'
import { formatPlan, formatResult, rebootCheck, rebootNow } from './reboot.js'
import { sshCloseMaster } from './ssh.js'
import { adaptInteractive, extractCwd, recordTerminal } from './terminal.js'

const LOADED_AT = Date.now()

// 命令分组：名字是内部归类用的键（/vps-help 按它排），显示时再按语言翻
const GROUP_LABEL = {
  入口: () => L('入口', 'Start here'),
  看信息: () => L('看信息', 'Look things up'),
  机器: () => L('机器', 'Machines'),
  安装与任务: () => L('安装与任务', 'Installs and tasks'),
  排查: () => L('排查', 'Troubleshooting'),
  其他: () => L('其他', 'Other'),
}
const groupLabel = (group) => GROUP_LABEL[group]?.() ?? group

const CONFIRM_LABEL = { careful: () => L('谨慎', 'Careful'), relaxed: () => L('放手', 'Relaxed'), auto: () => L('全自动', 'Fully automatic') }

const QUERY_COMMANDS = [
  ['sysinfo', 'sysinfo', () => L('系统信息：CPU、内存、磁盘、系统版本、公网 IP', 'System info: CPU, memory, disk, OS version, public IP')],
  ['disk', 'disk', () => L('磁盘占用：挂载点、inode、最大的几个目录', 'Disk usage: mounts, inodes, the largest directories')],
  ['ports', 'ports', () => L('端口监听与对应进程', 'Listening ports and their processes')],
  ['services', 'services', () => L('服务状态：失败的与正在运行的', 'Services: failed and running')],
  ['net', 'net', () => L('网卡、累计流量、连接数', 'Network interfaces, cumulative traffic, connection count')],
  ['docker', 'docker-ps', () => L('Docker 容器列表与磁盘占用', 'Docker containers and disk usage')],
  ['ping', 'health', () => L('快速看一眼这台机器是否正常', 'A quick look at whether this machine is healthy')],
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
          L(`未开 VPS 开关：点对话头部「VPS」，或发 /vps-use ${first}`, `The VPS switch is off: click "VPS" in the conversation header, or send /vps-use ${first}`),
          L(`可用机器：${aliases.join('、')}（关闭：/vps-use off）`, `Machines: ${aliases.join(', ')} (turn off: /vps-use off)`),
        ].join('\n')
      : L('还没有添加机器：DSH 设置 → VPS 管理 →「+ 添加机器」', 'No machines yet: DSH Settings → VPS Manager → "+ Add machine"'),
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
  return L(`${head}\n\n…（输出过长，中间省略 ${s.length - limit + 100} 字）…\n\n${tail}`, `${head}\n\n… (output too long, ${s.length - limit + 100} characters left out) …\n\n${tail}`)
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

  // —— 两段式确认 ——
  // 宿主规则（dsh-client-ui-commands 的 matchEnter，源码核对）：没声明 input 的命令只认光秃秃的
  // `/名字`；后面带任何字，整句就当普通提示词交给模型。实测 `/vps-reboot -h vps-dsh --yes`
  // 根本没到插件，模型还自己 ssh 上去把机器重启了。所以「确认」做成一条不带参数的 /vps-yes：
  // 计划页登记这个对话里「等你确认的那一件事」，/vps-yes 只执行它，5 分钟后作废。
  const CONFIRM_TTL_MS = 5 * 60_000
  const clock = deps.now ?? (() => Date.now())
  const pending = deps.pendingConfirms ?? (deps.pendingConfirms = new Map())
  const sessionKey = (invocation) => String(invocation?.agent?.session?.id ?? invocation?.sessionId ?? '')
  const arm = (invocation, entry) => pending.set(sessionKey(invocation), { ...entry, at: clock() })

  // —— 查询类：直接出结果 ——
  for (const [name, recipeId, descOf] of QUERY_COMMANDS) {
    const desc = descOf()
    reg({
      name: `vps-${name}`,
      // 不声明 input：声明了 DSH 就当成「等你输参数」，回车不执行（实测）。
      // 代价是后面带任何字都到不了插件（整句交给模型），所以机器只能靠对话绑定来定
      description: L(`${desc}（不经过模型，不花 token）。操作这个对话绑定的机器`, `${desc} (skips the model, costs no tokens). Acts on the machine bound to this conversation`),
      async handler(invocation) {
        try {
          const args = parseArgs(invocation.rawInput)
          const alias = await resolveAlias(args.host, env, invocation)
          const res = await recipeAction({ action: 'run', id: recipeId, alias, env, runner, source: 'command', ctx })
          const info = await hostContext(alias, { env })
          if (!res.ok) {
            return { kind: 'error', text: capText(L(`[${alias}] ${res.hint ?? '执行失败'}\n${info.address}\n\n${res.output ?? ''}`, `[${alias}] ${res.hint ?? 'Failed'}\n${info.address}\n\n${res.output ?? ''}`).trim()) }
          }
          return { kind: 'success', text: layout(alias, info, res.output, res.hint) }
        } catch (error) {
          return { kind: 'error', text: error.message }
        }
      },
    }, { group: '看信息', usage: `/vps-${name}`, short: desc })
  }

  // —— 日志（带一个位置参数）——
  reg({
    name: 'vps-logs',
    description: L('某个服务最近 100 行日志。用法：/vps-logs <服务名>', 'The last 100 log lines of a service. Usage: /vps-logs <service>'),
    input: { hint: L('<服务名>', '<service>') },
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const service = args.rest[0]
        if (!service) return { kind: 'error', text: L('用法：/vps-logs <服务名>，例如 /vps-logs nginx', 'Usage: /vps-logs <service>, e.g. /vps-logs nginx') }
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
  }, { group: '看信息', usage: L('/vps-logs <服务名>', '/vps-logs <service>'), short: L('某个服务最近 100 行日志', 'The last 100 log lines of a service') })


  // —— 总入口：大家会下意识打 /vps-help ——
  reg({
    name: 'vps-help',
    description: L('这个插件怎么用：命令清单、怎么指定机器、面板在哪。用法：/vps-help', 'How to use this plugin: the command list, choosing a machine, where the panels are. Usage: /vps-help'),
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
        L(`[VPS 管理${version ? ` ${version}` : ''}] ${catalog.length} 条命令 · ${aliases.length} 台机器 · 当前 ${doc.current || '未设置'} · 菜谱 ${list.length} 条`, `[VPS Manager${version ? ` ${version}` : ''}] ${catalog.length} commands · ${aliases.length} machines · current ${doc.current || 'not set'} · ${list.length} recipes`),
      ]
      for (const group of order) {
        const items = catalog.filter((c) => c.group === group)
        if (!items.length) continue
        lines.push('', group === '看信息' ? L('看信息（不走模型、不花 token）', 'Look things up (skips the model, costs no tokens)') : groupLabel(group))
        for (const item of items) lines.push(`  ${item.usage.padEnd(pad)}${item.short}`)
      }
      lines.push(
        '',
        L('指定机器', 'Choosing a machine'),
        L('  命令操作「这个对话绑定的那台」：点对话头部 VPS 后面的方块，或发 /vps-use <别名>', '  Commands act on the machine bound to this conversation: click a square after VPS in the conversation header, or send /vps-use <alias>'),
        L('  换一台就点另一个方块；没绑定时命令不执行，不会猜一台', '  Click another square to switch; with nothing bound, commands do not run and never guess a machine'),
        L('  方块颜色是测出来的连接状态：灰 没选 · 黄 连接中 · 绿 已连上 · 红 选了但连不上（输入框下方写原因，可重试）', '  A square\'s colour is the tested connection state: grey not selected · yellow connecting · green connected · red selected but unreachable (the reason is shown below the input box, with a retry)'),
        L('  要确认的操作（重启、安装、高危命令）都是先出计划，再发 /vps-yes', '  Anything that needs confirmation (reboot, install, dangerous commands) shows a plan first; then send /vps-yes'),
        '',
        L('终端（跟 ssh 里一样操作）', 'Terminal (works just like ssh)'),
        L('  绑定机器后，点对话头部「VPS」后面的 >_，输入框下方出现终端；再点最小化，再点恢复', '  With a machine bound, click >_ after "VPS" in the conversation header and a terminal opens below the input box; click again to minimize, again to restore'),
        L('  菜单脚本、top、vim、进容器都能用；右上角红 × 结束 · 黄 − 最小化 · 绿 最大化', '  Menu scripts, top, vim and container shells all work; top right: red × ends · yellow − minimizes · green maximizes'),
        L('  最小化、切走对话、刷新页面都不会丢，服务器上的 shell 一直在，点红 × 才结束', '  Minimizing, switching conversations or reloading the page loses nothing; the shell on the server stays until you click the red ×'),
        L('  这里敲的内容不经过 AI；要让 AI 看输出，用 /vps-sh；颜色和字号在 DSH 设置 → VPS 管理 → 终端', '  What you type there does not go to the AI; use /vps-sh when you want the AI to see output. Colours and font size are under DSH Settings → VPS Manager → Terminal'),
        '',
        L('跟 AI 说话（另外五个工具，直接用自然语言）', 'Talking to the AI (five more tools, just use plain language)'),
        L('  「看看 X 的磁盘」            只读，自动执行，不打扰你', '  "check the disk on X"            read-only, runs automatically without asking'),
        L('  「给 X 装个 nginx」          有现成菜谱就用菜谱，没有就现写脚本', '  "install nginx on X"            uses a recipe if there is one, otherwise writes a script'),
        L('  「把 a.com 反代到 3000」     改配置文件会自动备份，校验不过自动还原', '  "reverse-proxy a.com to 3000"   config files are backed up first and restored if validation fails'),
        L('  「刚才这套存成菜谱」          下次 /vps-install 一句话重来', '  "save that as a recipe"         next time /vps-install repeats it in one line'),
        L(`  当前确认档位：${CONFIRM_LABEL[doc.settings.confirm]?.() ?? doc.settings.confirm}（只读自动 / 改动问你 / 高危标红再问）`, `  Current confirmation level: ${CONFIRM_LABEL[doc.settings.confirm]?.() ?? doc.settings.confirm} (read-only automatic / changes ask you / dangerous ones flagged and asked again)`),
        '',
        L('设置（DSH 设置 → VPS 管理）', 'Settings (DSH Settings → VPS Manager)'),
        L('  添加 / 编辑 / 删除机器、编号、每台的确认档位与基础配置（时区、swap、BBR…）', '  Add / edit / remove machines, numbering, each machine\'s confirmation level and basics (timezone, swap, BBR…)'),
        L(`  装软件与系统维护都在菜谱里（现有 ${list.length} 条）：/vps-recipes 看清单，/vps-install 装`, `  Installs and system maintenance are recipes (${list.length} so far): see the list with /vps-recipes; install with /vps-install`),
        '',
        L(`配置与记录：${paths(env).base}`, `Configuration and records: ${paths(env).base}`),
      )
      if (!aliases.length) {
        lines.push('', L('现在还没有机器：DSH 设置 → VPS 管理 →「+ 添加机器」，向导会带你接上第一台。', 'No machines yet: DSH Settings → VPS Manager → "+ Add machine" walks you through the first one.'))
      }
      return { kind: 'success', text: capText(lines.join('\n')) }
    },
  }, { group: '入口', usage: '/vps-help', short: L('全部命令与用法（就是这一页）', 'Every command and how to use it (this page)') })

  reg({
    name: 'vps-yes',
    description:
      L('确认刚才那一步：/vps-reboot、/vps-install <菜谱id>、被拦下的高危 /vps-sh 出完计划后，', 'Confirms the step just planned: after /vps-reboot, /vps-install <recipe id> or a held dangerous /vps-sh shows its plan, ') +
      L('发它才真正执行。只对这个对话、5 分钟内有效。用法：/vps-yes', 'sending this actually runs it. Only for this conversation, valid for 5 minutes. Usage: /vps-yes'),
    async handler(invocation) {
      const key = sessionKey(invocation)
      const armed = pending.get(key)
      if (!armed) {
        return { kind: 'error', text: L('没有等你确认的操作：先发 /vps-reboot 或 /vps-install 看计划', 'Nothing is waiting for your confirmation. To see a plan first, send /vps-reboot, or /vps-install with a recipe id') }
      }
      pending.delete(key) // 一次确认只执行一次
      if (clock() - armed.at > CONFIRM_TTL_MS) {
        return { kind: 'error', text: L(`[${armed.alias}] 确认已过期（超过 5 分钟）：重新发 ${armed.again} 看最新情况`, `[${armed.alias}] The confirmation expired (over 5 minutes): send ${armed.again} again to see the latest`) }
      }
      try {
        return await armed.execute(invocation)
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '入口', usage: '/vps-yes', short: L('确认刚才的计划：重启、安装、被拦下的高危命令', 'Confirm the plan just shown: reboot, install, or a held dangerous command') })


  // —— 把对话框当成这台机器的命令行 ——
  reg({
    name: 'vps-sh',
    description:
      L('在当前机器上执行一条命令，输出直接进对话（不走模型、不花 token）。同一个对话里会记住 cd 到的目录；', 'Runs a command on the current machine with the output right in the conversation (skips the model, costs no tokens). The directory you cd into is remembered within the conversation; ') +
      L('top、tail -f 这类会一直刷新的命令自动改成一次性输出；危险命令先拦下，发 /vps-yes 确认才执行。', 'commands that keep refreshing, like top or tail -f, become one-shot output; dangerous commands are held until you confirm with /vps-yes. ') +
      L('前面可加 --bg（放到后台）、--private（这条输出不附给 AI）。用法：/vps-sh <命令>', 'Prefix --bg (run in the background) or --private (keep this output away from the AI). Usage: /vps-sh <command>'),
    input: { hint: L('[--bg] [--private] <命令>', '[--bg] [--private] <command>') },
    async handler(invocation) {
      let raw = String(invocation.rawInput ?? '').trim()
      // 开关只认最前面的，后面出现的原样交给远端（比如 apt-get -y、grep --private 之类）
      const flags = new Set()
      for (;;) {
        const m = /^--(yes|bg|private)(\s+|$)/.exec(raw)
        if (!m) break
        flags.add(m[1])
        raw = raw.slice(m[0].length)
      }
      if (!raw) {
        return { kind: 'error', text: L('用法：/vps-sh <命令>，例如 /vps-sh df -h\n前面可加 --bg（放到后台）、--private（输出不附给 AI）', 'Usage: /vps-sh <command>, e.g. /vps-sh df -h\nPrefix --bg (run in the background) or --private (keep the output away from the AI)') }
      }
      const adapted = adaptInteractive(raw)
      if (adapted.refuse) return { kind: 'error', text: L(`没执行：${adapted.refuse}`, `Not run: ${adapted.refuse}`) }
      const command = adapted.command
      try {
        const alias = await resolveAlias('', env, invocation)
        const sessionId = sessionKey(invocation)
        const classification = classifyScript(command)
        const tier = classification.tier
        const job = { alias, sessionId, command, typed: raw, note: adapted.note, tier, flags }

        if (tier === 'danger' && !flags.has('yes')) {
          const firstWhy = classification.dangers[0]
          const why = classification.dangers.map((d) => L(`${d.why}（命中：${d.match}）`, `${d.why} (matched: ${d.match})`)).join(L('；', '; '))
          arm(invocation, { alias, again: `/vps-sh ${raw}`, execute: () => execSh(job) })
          return {
            kind: 'error',
            text: [
              L(`[${alias}] ⚠ 高危已拦下，未执行：${firstWhy?.why ?? '高危操作'}（命中 ${firstWhy?.match ?? ''}）`, `[${alias}] ⚠ Dangerous command held, not run: ${firstWhy?.why ?? 'dangerous operation'} (matched ${firstWhy?.match ?? ''})`),
              L('确认要跑就发 /vps-yes（5 分钟内有效）', 'To run it anyway, send /vps-yes (valid for 5 minutes)'),
              why && classification.dangers.length > 1 ? L(`全部命中：${why}`, `All matches: ${why}`) : '',
            ].filter(Boolean).join('\n'),
          }
        }
        return await execSh(job)
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '看信息', usage: L('/vps-sh <命令>', '/vps-sh <command>'), short: L('在当前机器上直接执行命令，记住目录，输出进对话', 'Run a command on the current machine, remember the directory, output in the conversation') })

  async function execSh({ alias, sessionId, command, typed, note, tier, flags }) {
    const cwd = await sessionCwd(sessionId, alias, env)
    const res = await execAction({
      ctx,
      alias,
      script: command,
      intent: tier,
      reason: L(`命令行：${command.slice(0, 60)}`, `command line: ${command.slice(0, 60)}`),
      source: 'command',
      preApproved: true, // 你自己敲的就是同意；高危另外要 /vps-yes
      env,
      runner,
      timeoutSeconds: tier === 'read' ? (deps.shReadTimeoutSeconds ?? 30) : 120,
      cwd,
      runAsTask: flags.has('bg'),
    })
    const { output, cwd: newCwd } = extractCwd(res.output)
    if (newCwd && newCwd !== cwd) await setSessionCwd(sessionId, alias, newCwd, env)
    const here = newCwd ?? cwd

    const body = [output, res.stderr].filter(Boolean).join('\n').trim()
    // 折叠后只看得到第一行：像终端提示符一样写清机器和目录，短输出直接跟在后面
    const firstOut = body.split('\n')[0]?.trim() ?? ''
    const prompt = `[${alias}${here ? `:${here}` : ''}] $ ${typed}`
    const lines = [`${prompt}${firstOut ? `　${firstOut.slice(0, 80)}` : ''}`]
    if (note) lines.push(L(`（${note}）`, `(${note})`))
    lines.push(body || (res.ok && /^\s*(cd|pushd|popd)\b/.test(command) ? L(`（当前目录：${here ?? '家目录'}）`, `(current directory: ${here ?? 'home'})`) : L('（没有输出）', '(no output)')))

    const tail = []
    if (res.status === 'detached') tail.push(L(`（在后台跑，任务 ${res.taskId}，用 /vps-task ${res.taskId} 看进度）`, `(running in the background as task ${res.taskId}; check it with /vps-task ${res.taskId})`))
    else if (res.status === 'timeout') tail.push(L(`超过 ${deps.shReadTimeoutSeconds ?? 30} 秒还没结束，已停止等待。跑得久的命令在前面加 --bg 放到后台`, `Not finished after ${deps.shReadTimeoutSeconds ?? 30} seconds, stopped waiting. Prefix long-running commands with --bg to run them in the background`))
    else if (res.exitCode !== null && res.exitCode !== 0) tail.push(L(`退出码 ${res.exitCode}`, `exit code ${res.exitCode}`))
    if (tier === 'danger') tail.push(L('已按高危执行', 'ran as dangerous'))

    // 光是换目录的命令不附给 AI：目录在后面每条记录里都写着，单独一条只是噪音
    const onlyCd = /^\s*(cd|pushd|popd)\b[^;&|]*$/.test(command)
    if (!flags.has('private') && !onlyCd) {
      const { firstTime } = recordTerminal(sessionId, {
        alias, cwd: here, command: typed, exitCode: res.exitCode, status: res.status, output: body,
      })
      if (firstTime) tail.push(L('（下次问 AI 时会附上这段输出，方便它帮你分析；不想附上就在命令前加 --private）', '(This output will be attached the next time you ask the AI, so it can help; prefix the command with --private to keep it out)'))
    }
    lines.push(tail.join('　'))
    return {
      kind: res.ok || res.status === 'detached' ? 'success' : 'error',
      text: capText(lines.filter(Boolean).join('\n')),
    }
  }


  reg({
    name: 'vps-q',
    description: L('在当前机器上跑一条查询菜谱，输出进对话（不走模型）。用法：/vps-q <菜谱id>', 'Runs a query recipe on the current machine with the output in the conversation (skips the model). Usage: /vps-q <recipe id>'),
    input: { hint: L('<菜谱id>', '<recipe id>') },
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const id = args.rest[0]
        if (!id) {
          const { list } = await loadRecipes({ env })
          const ids = list.filter((r) => r.kind === 'query' && r.id !== 'probe').map((r) => r.id)
          return { kind: 'error', text: L(`用法：/vps-q <菜谱id>\n可用：${ids.join('、')}`, `Usage: /vps-q <recipe id>\nAvailable: ${ids.join(', ')}`) }
        }
        const { byId } = await loadRecipes({ env })
        const recipe = byId.get(id)
        if (!recipe) return { kind: 'error', text: L(`没有这条菜谱：${id}`, `No such recipe: ${id}`) }
        if (recipe.kind !== 'query') {
          return { kind: 'error', text: L(`${id} 不是查询类。安装用 /vps-install ${id}`, `${id} is not a query. To install, use /vps-install ${id}`) }
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
  }, { group: '看信息', usage: L('/vps-q <菜谱id>', '/vps-q <recipe id>'), short: L('跑任意一条查询菜谱（没有专属命令的那些）', 'Run any query recipe (those without a command of their own)') })

  // —— 机器清单与当前机器 ——
  reg({
    name: 'vps-list',
    description: L('列出已登记的 VPS 与状态。用法：/vps-list', 'Lists registered VPSes and their state. Usage: /vps-list'),
    async handler(invocation) {
      const doc = await readHosts(env)
      const bound = await sessionBinding(sessionKey(invocation), env)
      const entries = Object.entries(doc.hosts)
      if (!entries.length) {
        return { kind: 'success', text: L('还没有添加机器：在「设置 → VPS 管理」里添加第一台。', 'No machines yet: add the first one under Settings → VPS Manager.') }
      }
      const { readState } = await import('./config.js')
      const state = await readState(env)
      const lines = entries.map(([alias, host]) => {
        const st = state.hosts?.[alias] ?? {}
        const mark = alias === bound ? '★' : ' '
        const reach = st.reachable === true ? '🟢' : st.reachable === false ? '🔴' : '⚪'
        const priv = st.facts?.privilege ? L(`权限:${st.facts.privilege}`, `privilege:${st.facts.privilege}`) : ''
        return L(`${mark} ${reach} ${alias.padEnd(12)} ${(st.address ?? '').padEnd(21)} ${host.group ? `[${host.group}] ` : ''}${host.note ?? ''} ${priv} 确认:${effectiveConfirm(doc, alias)}`, `${mark} ${reach} ${alias.padEnd(12)} ${(st.address ?? '').padEnd(21)} ${host.group ? `[${host.group}] ` : ''}${host.note ?? ''} ${priv} confirm:${effectiveConfirm(doc, alias)}`)
      })
      const first = L(`${entries.length} 台机器 · ${bound ? `这个对话绑定 ${bound}（★）` : '这个对话没有绑定机器'}`, `${entries.length} machines · ${bound ? `this conversation is bound to ${bound} (★)` : 'this conversation is not bound to a machine'}`)
      return { kind: 'success', text: [first, ...lines].join('\n') }
    },
  }, { group: '机器', usage: '/vps-list', short: L('已登记的机器和状态（★ 是这个对话绑定的）', 'Registered machines and their state (★ is the one bound to this conversation)') })

  reg({
    name: 'vps-use',
    description: L('把这个对话绑定到一台机器（等同对话头部的 VPS 开关）。用法：/vps-use <别名> | /vps-use off', 'Binds this conversation to a machine (same as the VPS switch in the conversation header). Usage: /vps-use <alias> | /vps-use off'),
    input: { hint: L('<别名> 或 off', '<alias> or off') },
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
              ? L(`这个对话绑定着 ${bound}　换一台：/vps-use <别名>　关闭：/vps-use off`, `This conversation is bound to ${bound}. Switch: /vps-use <alias>  Turn off: /vps-use off`)
              : L(`这个对话没绑定机器　绑定：/vps-use <别名>（已登记：${Object.keys(doc.hosts).join('、') || '无'}）`, `This conversation is not bound to a machine. Bind: /vps-use <alias> (registered: ${Object.keys(doc.hosts).join(', ') || 'none'})`),
          ].join('\n'),
        }
      }
      if (!sessionId) {
        return { kind: 'error', text: L('这个环境认不出当前会话，请改用对话头部的 VPS 开关', 'The current conversation cannot be identified here; use the VPS switch in the conversation header instead') }
      }
      if (arg === 'off' || arg === 'none') {
        await bindSession(sessionId, null, env)
        deps.terminals?.endFor(sessionId, '') // 关了开关，对话里的终端一并结束
        return { kind: 'success', text: L('已关闭 VPS 模式：这个对话的 /vps- 命令不再执行，AI 也不再默认操作任何机器', 'VPS mode is off: /vps- commands no longer run in this conversation, and the AI no longer operates any machine by default') }
      }
      if (!doc.hosts[arg]) {
        return { kind: 'error', text: L(`没有登记过这台机器：${arg}（已登记：${Object.keys(doc.hosts).join('、') || '无'}）`, `This machine is not registered: ${arg} (registered: ${Object.keys(doc.hosts).join(', ') || 'none'})`) }
      }
      await bindSession(sessionId, arg, env)
      deps.terminals?.endFor(sessionId, arg) // 换了机器，连着旧机器的终端结束
      probeIfUnknown(arg, { env, runner }) // 没体检过就后台体检，给模型的说明里才有系统信息
      await writeHosts({ ...doc, current: arg }, env) // 下次打开开关时预选它
      return {
        kind: 'success',
        text: [
          L(`已绑定 ${arg}：这个对话的 /vps- 命令都作用在它上面，AI 也默认操作它`, `Bound to ${arg}: /vps- commands in this conversation act on it, and the AI operates it by default`),
          L('只影响这个对话；关闭用 /vps-use off', 'Only this conversation is affected; turn it off with /vps-use off'),
        ].join('\n'),
      }
    },
  }, { group: '机器', usage: L('/vps-use <别名>|off', '/vps-use <alias>|off'), short: L('把这个对话绑到一台机器（和头部开关同一件事）', 'Bind this conversation to a machine (same as the header switch)') })

  reg({
    name: 'vps-probe',
    description: L('重新体检这个对话绑定的机器（系统、init、权限、资源）', 'Runs the health check again on the machine bound to this conversation (OS, init, privilege, resources)'),
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const alias = await resolveAlias(args.host, env, invocation)
        const res = await probeHost({ alias, env, runner })
        if (!res.ok) return { kind: 'error', text: L(`[${alias}] 体检失败：${res.hint}`, `[${alias}] Health check failed: ${res.hint}`) }
        const f = res.facts
        return {
          kind: 'success',
          text: [
            L(`[${alias}] 体检完成：${f.os_id} ${f.os_ver} · ${f.privilege === 'root' ? 'root' : f.privilege === 'sudo' ? '免密 sudo' : '仅只读'} · 磁盘 ${f.disk_pct}`, `[${alias}] Health check done: ${f.os_id} ${f.os_ver} · ${f.privilege === 'root' ? 'root' : f.privilege === 'sudo' ? 'passwordless sudo' : 'read-only'} · disk ${f.disk_pct}`),
            res.address,
            L(`系统 ${f.os_id} ${f.os_ver}（${f.os_family}）  init ${f.init}  包管理 ${f.pkg}`, `OS ${f.os_id} ${f.os_ver} (${f.os_family})  init ${f.init}  packages ${f.pkg}`),
            L(`权限 ${f.privilege === 'root' ? 'root' : f.privilege === 'sudo' ? '免密 sudo' : '仅只读'}`, `privilege ${f.privilege === 'root' ? 'root' : f.privilege === 'sudo' ? 'passwordless sudo' : 'read-only'}`),
            L(`CPU ${f.cpu} 核  内存 ${f.mem_used_mb}/${f.mem_total_mb} MB  磁盘 ${f.disk_used_mb}/${f.disk_total_mb} MB (${f.disk_pct})`, `CPU ${f.cpu} cores  memory ${f.mem_used_mb}/${f.mem_total_mb} MB  disk ${f.disk_used_mb}/${f.disk_total_mb} MB (${f.disk_pct})`),
          ].join('\n'),
        }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '机器', usage: '/vps-probe', short: L('重新体检：系统、init、权限、资源', 'Health check again: OS, init, privilege, resources') })

  // —— 重启：两段式，并且等机器回来 ——
  reg({
    name: 'vps-reboot',
    description:
      L('重启服务器。先检查为什么该重启、现在能不能重启、会停哪些容器；确认要重启再发 /vps-yes，', 'Reboots the server. First checks why a reboot is needed, whether now is a good time and which containers will stop; to reboot, send /vps-yes; ') +
      L('之后会一直等它回来，报告内核、容器和失败的服务。用法：/vps-reboot', 'then it waits for the machine to come back and reports the kernel, containers and failed services. Usage: /vps-reboot'),
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const alias = await resolveAlias(args.host, env, invocation)
        const info = await hostContext(alias, { env })
        const head = `${info.label}${info.host.note ? ` ${info.host.note}` : ''}`
        const check = await rebootCheck({ run: remoteRun(alias) })
        if (check.ok && !check.assessment.blockers.length) {
          arm(invocation, { alias, again: '/vps-reboot', execute: (inv) => execReboot({ alias, info, head, invocation: inv }) })
        }
        const out = formatPlan({ alias, head, check })
        return { kind: out.kind, text: capText(out.text) }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '机器', usage: '/vps-reboot', short: L('重启并等它回来：先检查，发 /vps-yes 才重启', 'Reboot and wait for it: checks first, reboots on /vps-yes') })

  function remoteRun(alias) {
    return (body, o = {}) => runRemote({ alias, body, env, runner, ...o })
  }

  async function execReboot({ alias, info, head, invocation }) {
    const result = await rebootNow({
      run: remoteRun(alias),
      closeMaster: deps.rebootCloseMaster ?? (() => sshCloseMaster(alias)),
      sleep: deps.rebootSleep,
      now: deps.rebootNow,
      signal: invocation?.signal,
    })
    // 重启不走 gate（/vps-yes 就是同意），审计要自己记
    await appendAudit({
      source: 'command',
      alias,
      address: info.address,
      action: 'reboot',
      finalTier: 'danger',
      confirmLevel: info.confirmLevel,
      decision: 'preapproved',
      status: result.phase,
      durationMs: result.tookMs,
    }, env).catch(() => {})
    const out = formatResult({ alias, head, result })
    return { kind: out.kind, text: capText(out.text) }
  }

  // —— 菜谱与安装 ——
  reg({
    name: 'vps-recipes',
    description: L('列出可用的菜谱（内置 + 我的）。装哪条就发 /vps-install <菜谱id>', 'Lists the available recipes (built-in + mine). To install one, send /vps-install <recipe id>'),
    async handler() {
      // 不收关键词：这条命令没声明 input，DSH 不会把后面的字交给插件
      const { list, errors, conflicts } = await loadRecipes({ env })
      const count = (kind) => list.filter((r) => r.kind === kind).length
      const mine = list.filter((r) => r.source !== 'builtin').length
      const first = L(`${list.length} 条菜谱：查询 ${count('query')} · 安装 ${count('install')} · 配置 ${count('config')}`, `${list.length} recipes: ${count('query')} queries · ${count('install')} installs · ${count('config')} configuration`) +
        L(`${mine ? ` · 我的 ${mine}` : ''} · 装哪条发 /vps-install <菜谱id>`, `${mine ? ` · ${mine} mine` : ''} · to install one, send /vps-install <recipe id>`)
      const section = (title, kind) => {
        const items = list.filter((r) => r.kind === kind)
        if (!items.length) return []
        return ['', title, ...items.map((r) => L(`  ${r.id.padEnd(26)} ${r.source === 'builtin' ? '' : '［我的］'}${r.name} —— ${r.desc}`, `  ${r.id.padEnd(26)} ${r.source === 'builtin' ? '' : '[mine] '}${recipeText(r, 'name')} — ${recipeText(r, 'desc')}`))]
      }
      const tail = []
      if (errors.length) tail.push('', L(`有 ${errors.length} 个菜谱文件解析失败：`, `${errors.length} recipe files could not be parsed:`), ...errors.map((e) => `  ${e.file}: ${e.message}`))
      if (conflicts.length) tail.push('', L(`${conflicts.length} 个自定义菜谱与内置重名未加载：`, `${conflicts.length} custom recipes share an id with a built-in one and were not loaded:`) + conflicts.map((c) => c.id).join(L('、', ', ')))
      return {
        kind: 'success',
        text: capText([
          first,
          ...section(L('安装软件（/vps-install）', 'Install software (/vps-install)'), 'install'),
          ...section(L('改系统设置（/vps-install）', 'Change system settings (/vps-install)'), 'config'),
          ...section(L('查询（/vps-q，不改任何东西）', 'Queries (/vps-q, change nothing)'), 'query'),
          ...tail,
        ].join('\n'), 6000),
      }
    },
  }, { group: '安装与任务', usage: '/vps-recipes', short: L('菜谱清单', 'Recipe list') })

  reg({
    name: 'vps-install',
    description:
      L('按菜谱安装 / 配置。先看计划，确认无误再发 /vps-yes 执行。菜谱参数写成 key=value 跟在 id 后面。', 'Installs or configures by recipe. Read the plan first; to run it, send /vps-yes. Recipe parameters go after the id as key=value. ') +
      L('用法：/vps-install <菜谱id> [key=value ...]', 'Usage: /vps-install <recipe id> [key=value ...]'),
    input: { hint: L('<菜谱id> [key=value ...]', '<recipe id> [key=value ...]') },
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const id = args.rest[0]
        if (!id) return { kind: 'error', text: L('用法：/vps-install <菜谱id> [key=value ...]；用 /vps-recipes 看有哪些', 'Usage: /vps-install <recipe id> [key=value ...]; for what there is, see /vps-recipes') }

        const { byId } = await loadRecipes({ env })
        const recipe = byId.get(id)
        if (!recipe) return { kind: 'error', text: L(`没有这条菜谱：${id}\n用 /vps-recipes 看清单`, `No such recipe: ${id}\nFor the list, see /vps-recipes`) }

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
          const wrong = [...malformed, ...unknown].join(L('、', ', '))
          return {
            kind: 'error',
            text: [
              L(`[${id}] 参数不对：${wrong}（要写成 key=value）`, `[${id}] Invalid parameters: ${wrong} (write them as key=value)`),
              recipe.params.length
                ? L(`这条菜谱收：${recipe.params.map((p) => `${p.name}=${p.default ?? (p.required ? '必填' : '')}`).join('　')}`, `This recipe takes: ${recipe.params.map((p) => `${p.name}=${p.default ?? (p.required ? 'required' : '')}`).join('  ')}`)
                : L('这条菜谱不收参数', 'This recipe takes no parameters'),
            ].join('\n'),
          }
        }
        const paramText = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ')
        const alias = await resolveAlias(args.host, env, invocation)

        // 声明了 input 的命令能收到后面的字，所以 --yes 仍然有效；日常用 /vps-yes
        if (args.flags.has('yes')) return execInstall({ alias, id, recipe, params, paramText })

        const shown = await recipeAction({ action: 'show', id, alias, env, runner, source: 'command', ctx })
        const r = shown.recipe
        // 安装类说「装没装」；配置类（系统更新、时区、swap…）没有「装」这回事，说「是不是目标状态」
        const words = r.kind === 'config'
          ? { yes: L('已是目标状态', 'already in the target state'), no: L('有变更可做', 'changes to make'), yesLong: L('已是目标状态（执行会跳过，直接验证）', 'already in the target state (running it skips ahead to verification)'), noLong: L('当前不是目标状态，执行会做出改动', 'not in the target state yet; running it will make changes') }
          : { yes: L('已经装了', 'already installed'), no: L('还没装', 'not installed yet'), yesLong: L('已经装了（执行会跳过安装，直接验证）', 'already installed (running it skips the install and goes to verification)'), noLong: L('没装', 'not installed') }
        const detect = shown.detect === 'installed'
          ? L(`检测结果：${words.yesLong}`, `Detection: ${words.yesLong}`)
          : shown.detect === 'absent'
            ? L(`检测结果：${words.noLong}`, `Detection: ${words.noLong}`)
            : L(`检测结果：说不清 —— ${shown.detectHint ?? ''}`, `Detection: unclear — ${shown.detectHint ?? ''}`)
        const detectShort = shown.detect === 'installed' ? words.yes : shown.detect === 'absent' ? words.no : L('检测说不清', 'detection unclear')
        const paramLines = r.params.length
          ? ['', L('参数（可改：重新发 /vps-install 并在 id 后面写 key=value）：', 'Parameters (to change one, send /vps-install again with key=value after the id):'),
             ...r.params.map((p) => {
               const used = params[p.name]
               const value = used ?? p.default ?? (p.required ? L('（必填，还没给）', '(required, not given yet)') : L('（不填）', '(empty)'))
               return L(`  ${p.name} = ${value}${used ? ' ←本次指定' : ''}　${p.desc}`, `  ${p.name} = ${value}${used ? ' ← given this time' : ''}  ${recipeText(p, 'desc')}`)
             })]
          : []
        const again = `/vps-install ${id}${paramText ? ` ${paramText}` : ''}`
        arm(invocation, { alias, again, execute: () => execInstall({ alias, id, recipe, params, paramText }) })
        return {
          kind: 'success',
          text: capText([
            L(`[${alias}] ${r.name}：${detectShort}，尚未执行 · 确认发 /vps-yes`, `[${alias}] ${recipeText(r, 'name')}: ${detectShort}, not run yet · to confirm, send /vps-yes`),
            r.desc,
            detect,
            ...paramLines,
            '',
            L('计划：', 'Plan:'),
            recipeText(r, 'plan') || L('（这条菜谱没写 plan）', '(this recipe has no plan)'),
            '',
            L('脚本：', 'Script:'),
            r.run.trim(),
          ].join('\n')),
        }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '安装与任务', usage: L('/vps-install <菜谱id> [key=value]', '/vps-install <recipe id> [key=value]'), short: L('先出计划，发 /vps-yes 才执行', 'Plan first, runs on /vps-yes') })

  async function execInstall({ alias, id, recipe, params, paramText }) {
    const head = await header(alias, env)
    const res = await recipeAction({
      action: 'run',
      id,
      alias,
      params,
      env,
      runner,
      source: 'command',
      ctx,
      preApproved: true, // /vps-yes 或 --yes 就是用户的同意；命令没有轮次，弹不出审批框
    })
    return {
      kind: res.ok ? 'success' : 'error',
      text: capText([
        L(`[${alias}] ${recipe.name}：${res.ok ? '完成' : res.hint ?? '失败'}${paramText ? `　${paramText}` : ''}`, `[${alias}] ${recipeText(recipe, 'name')}: ${res.ok ? 'done' : res.hint ?? 'failed'}${paramText ? `  ${paramText}` : ''}`),
        head,
        res.ok ? res.hint : '',
        res.output,
        res.taskId ? L(`任务号 ${res.taskId}（/vps-task ${res.taskId} 看进度，加 --stop 终止）`, `Task ${res.taskId} (/vps-task ${res.taskId} shows progress, add --stop to terminate)`) : '',
      ].filter(Boolean).join('\n')),
    }
  }


  // —— 自查：装好了没、指向哪台、最近跑过什么 ——
  reg({
    name: 'vps-doctor',
    description: L('自查：插件与 DSH 版本、各部分注册情况、本对话绑定的机器、连通测试、最近的错误与执行，末尾附反馈链接。用法：/vps-doctor', 'Self-check: plugin and DSH versions, registration of each part, the machine bound to this conversation, a connectivity test, recent errors and runs, with a feedback link at the end. Usage: /vps-doctor'),
    async handler(invocation) {
      const lines = []
      let diag = null
      try {
        const { createRequire } = await import('node:module')
        const pkg = createRequire(import.meta.url)('../package.json')
        const { diagnostics, partLabel } = await import('./health.js')
        diag = await diagnostics(env)
        const failed = diag.failedParts.length
        lines.unshift(failed
          ? L(`⚠ 有 ${failed} 部分没注册成功：${diag.failedParts.map(partLabel).join('、')}`, `⚠ ${failed} parts failed to register: ${diag.failedParts.map(partLabel).join(', ')}`)
          : diag.dsh.status === 'unverified' ? `⚠ ${diag.dsh.text}` : L('一切正常', 'all good'))
        lines.push(L(`插件 ${pkg.name} ${pkg.version}　已加载 ${new Date(LOADED_AT).toLocaleString()}`, `Plugin ${pkg.name} ${pkg.version}  loaded ${new Date(LOADED_AT).toLocaleString()}`))
        lines.push(diag.dsh.text)
        lines.push(L(`注册情况：${Object.entries(diag.parts).map(([n, p]) => `${partLabel(n)} ${p.ok ? `✓${p.detail ? ` ${p.detail}` : ''}` : `✗ ${p.detail}`}`).join('　') || '（还没有记录）'}`, `Registration: ${Object.entries(diag.parts).map(([n, p]) => `${partLabel(n)} ${p.ok ? `✓${p.detail ? ` ${p.detail}` : ''}` : `✗ ${p.detail}`}`).join('  ') || '(nothing recorded yet)'}`))
      } catch {
        lines.push(L('插件已加载', 'plugin loaded'))
      }
      try {
        const doc = await readHosts(env)
        const aliases = Object.keys(doc.hosts)
        const sessionId = String(invocation?.agent?.session?.id ?? '')
        const bound = sessionId ? await sessionBinding(sessionId, env) : ''
        lines.push(L(`机器：${aliases.join('、') || '（一台都没有）'}`, `Machines: ${aliases.join(', ') || '(none)'}`))
        lines.push(bound
          ? L(`这个对话已绑定：${bound}（VPS 开关是开的）`, `This conversation is bound to: ${bound} (the VPS switch is on)`)
          : L('这个对话没有绑定机器（VPS 开关关着，/vps- 命令不会执行）', 'This conversation is not bound to a machine (the VPS switch is off, /vps- commands will not run)'))
        lines.push(L(`确认档位：${doc.settings.confirm}`, `Confirmation level: ${doc.settings.confirm}`))
        const probeTarget = bound || doc.current
        if (probeTarget) {
          const info = await hostContext(probeTarget, { env })
          lines.push(L(`当前机器解析地址：${info.address || '（ssh -G 解析失败）'}`, `Current machine resolves to: ${info.address || '(ssh -G could not resolve it)'}`))
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
          lines.push(L(`连通测试：${probe.ok ? `成功（${Date.now() - t0}ms）` : `失败 —— ${probe.status}：${probe.hint}`}`, `Connectivity test: ${probe.ok ? `ok (${Date.now() - t0}ms)` : `failed — ${probe.status}: ${probe.hint}`}`))
        }
      } catch (error) {
        lines.push(L(`读取配置出错：${error.message}`, `Reading the configuration failed: ${error.message}`))
      }
      try {
        const { readAudit } = await import('./audit.js')
        const rows = await readAudit({ limit: 5, env })
        lines.push('', L('最近 5 次执行：', 'Last 5 runs:'))
        for (const r of rows) {
          lines.push(`  ${r.at?.slice(11, 19)} ${r.source ?? '?'} ${r.recipeId ?? r.action ?? ''} → ${r.status ?? r.decision ?? '?'}`)
        }
        if (!rows.length) lines.push(L('  （还没有记录）', '  (nothing recorded yet)'))
      } catch {
        lines.push(L('（读不到审计日志）', '(cannot read the audit log)'))
      }
      if (diag) {
        lines.push('', diag.errors.length ? L(`最近的错误（共 ${diag.errors.length} 条，已打码）：`, `Recent errors (${diag.errors.length}, masked):`) : L('最近没有错误记录', 'No recent errors'))
        for (const e of diag.errors.slice(0, 3)) {
          lines.push(`  ${e.at.slice(5, 16).replace('T', ' ')} [${e.source}] ${e.message.slice(0, 120)}`)
        }
        lines.push('', L('反馈问题（打开后会预填版本和上面的诊断信息，你看过再提交）：', 'Report a problem (opens pre-filled with the versions and the diagnostics above; review before submitting):'), diag.feedbackUrl)
        lines.push(L('提建议：', 'Suggest something:'), diag.suggestUrl)
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  }, { group: '排查', usage: '/vps-doctor', short: L('插件与 DSH 版本、注册情况、连通测试、最近错误，附反馈链接', 'Plugin and DSH versions, registration, a connectivity test, recent errors, with a feedback link') })

  // —— 任务 ——
  reg({
    name: 'vps-tasks',
    description: L('列出这台机器上的远端任务（断线后仍在跑的那些）。看某一个用 /vps-task <任务号>', 'Lists remote tasks on this machine (the ones that keep running after a disconnect). To see one, use /vps-task <task id>'),
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const alias = await resolveAlias(args.host, env, invocation)
        const head = await header(alias, env)
        const res = await taskAction({ ctx, alias, action: 'list', env, runner, source: 'command' })
        if (!res.ok) return { kind: 'error', text: `[${alias}] ${res.hint}\n${head}` }
        const tasks = res.tasks ?? []
        const running = tasks.filter((t) => t.state === 'running').length
        const lines = tasks.map((t) => `${t.taskId}  ${t.state}${t.exitCode === null ? '' : `(${t.exitCode})`}  ${t.meta?.recipeId ?? t.meta?.action ?? ''}  ${t.meta?.source ?? ''}`)
        return {
          kind: 'success',
          text: capText([
            L(`[${alias}] ${tasks.length ? `${tasks.length} 个任务${running ? `，${running} 个还在跑` : '，都已结束'}` : '没有任务记录'}`, `[${alias}] ${tasks.length ? `${tasks.length} tasks${running ? `, ${running} still running` : ', all finished'}` : 'no tasks recorded'}`),
            head,
            '',
            lines.join('\n'),
            tasks.length ? L('看日志：/vps-task <任务号>　终止：/vps-task <任务号> --stop', 'Log: /vps-task <task id>  Terminate: /vps-task <task id> --stop') : '',
          ].filter(Boolean).join('\n')),
        }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '安装与任务', usage: '/vps-tasks', short: L('远端任务列表（断线后仍在跑的那些）', 'Remote tasks (the ones that keep running after a disconnect)') })

  // 带参数的放一条单独命令：/vps-tasks 要回车就列，就不能声明 input（见上面两段式确认的说明）
  reg({
    name: 'vps-task',
    description: L('看一个远端任务的状态和日志；加 --stop 终止它。用法：/vps-task <任务号> [--stop]', 'Shows a remote task\'s state and log; add --stop to terminate it. Usage: /vps-task <task id> [--stop]'),
    input: { hint: L('<任务号> [--stop]', '<task id> [--stop]') },
    async handler(invocation) {
      try {
        const args = parseArgs(invocation.rawInput)
        const taskId = args.rest[0]
        if (!taskId) return { kind: 'error', text: L('用法：/vps-task <任务号> [--stop]；任务号用 /vps-tasks 看', 'Usage: /vps-task <task id> [--stop]; see task ids with /vps-tasks') }
        const alias = await resolveAlias(args.host, env, invocation)
        const head = await header(alias, env)

        if (args.flags.has('stop')) {
          const res = await taskAction({
            ctx,
            alias,
            action: 'cancel',
            taskId,
            env,
            runner,
            source: 'command',
            preApproved: true, // 你自己敲的 --stop 就是同意
          })
          return {
            kind: res.ok ? 'success' : 'error',
            text: capText([
              L(`[${alias}] 任务 ${taskId}：${res.hint || (res.ok ? '已终止' : '终止失败')}`, `[${alias}] Task ${taskId}: ${res.hint || (res.ok ? 'terminated' : 'termination failed')}`),
              head,
              res.ok && res.outcome !== 'already_stopped' ? L('中途终止可能留下装了一半的状态，建议跟一条检查命令', 'Stopping midway may leave things half installed; follow up with a check command') : '',
              res.output,
            ].filter(Boolean).join('\n')),
          }
        }

        const res = await taskAction({ ctx, alias, action: 'log', taskId, env, runner, source: 'command' })
        if (!res.ok) return { kind: 'error', text: `[${alias}] ${res.hint}\n${head}` }
        const t = res.task
        const state = t?.state ?? '?'
        return {
          kind: 'success',
          text: capText([
            L(`[${alias}] 任务 ${taskId}：${state}${t?.exitCode === null || t?.exitCode === undefined ? '' : `（退出码 ${t.exitCode}）`}`, `[${alias}] Task ${taskId}: ${state}${t?.exitCode === null || t?.exitCode === undefined ? '' : ` (exit code ${t.exitCode})`}`),
            head,
            state === 'running' ? L(`还在跑，要停发 /vps-task ${taskId} --stop`, `Still running; to stop it send /vps-task ${taskId} --stop`) : '',
            '',
            res.log,
          ].filter(Boolean).join('\n')),
        }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }, { group: '安装与任务', usage: L('/vps-task <任务号> [--stop]', '/vps-task <task id> [--stop]'), short: L('一个任务的日志；加 --stop 终止', 'A task\'s log; add --stop to terminate') })

  const disposeAll = () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // 反注册失败不影响卸载
      }
    }
  }
  disposeAll.count = catalog.length // 注册了几条：插件体检（/vps-doctor、兼容性检查）要看
  return disposeAll
}
