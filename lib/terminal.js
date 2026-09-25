// lib/terminal.js — 对话里的「迷你终端」（/vps-sh）
//
// 对话不是一直开着的 SSH：每条命令是一次独立执行，不能持续刷新，也不能中途输入。
// 这里补三件事，让自己敲命令更顺手：
//   1. 交互命令改成一次性输出（top → 快照、tail -f → 最后 100 行…），改不了的说清原因
//   2. 当前目录：命令结束时报告 $PWD，下一条先 cd 回去（在 actions.execAction 里包装）
//   3. 交给 AI：DSH 规定命令结果不进模型上下文。这里记下最近几条命令和输出，
//      下次用户跟 AI 说话时由 vps-mode 的 pre-step 附上（先打码；--private 不记）

export const CWD_MARK = '__DSH_VPS_CWD__='

const EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'mcedit', 'joe', 'micro'])
const PAGERS = new Set(['less', 'more', 'most'])
const MONITORS = new Set(['top', 'htop', 'btop', 'atop', 'glances'])
const REPL_EXAMPLES = {
  bash: '/vps-sh ls -la', sh: '/vps-sh ls -la', zsh: '/vps-sh ls -la', fish: '/vps-sh ls -la',
  python: "/vps-sh python3 -c 'print(1)'", python3: "/vps-sh python3 -c 'print(1)'", node: "/vps-sh node -e 'console.log(1)'",
  mysql: "/vps-sh mysql -e 'show databases'", mariadb: "/vps-sh mariadb -e 'show databases'",
  psql: "/vps-sh psql -c '\\l'", 'redis-cli': '/vps-sh redis-cli info', sqlite3: "/vps-sh sqlite3 db.sqlite '.tables'",
  mongosh: "/vps-sh mongosh --eval 'db.version()'", su: '/vps-sh whoami（插件已经按 root / 免密 sudo 执行）',
}

/** 第一个不在引号里的 `|`，没有返回 -1 */
function topLevelPipe(text) {
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === "'" || c === '"') {
      quote = c
    } else if (c === '|' && text[i + 1] !== '|' && text[i - 1] !== '|') {
      return i
    }
  }
  return -1
}

const hasFlag = (args, re) => re.test(` ${args} `)
const dropFlags = (args, re) => ` ${args} `.replace(re, ' ').replace(/\s+/g, ' ').trim()

/**
 * 把交互式命令改成一次性输出。
 * @returns {{ command: string, note?: string } | { refuse: string }}
 */
/** 对话里做不了的交互操作，都能去真终端里做 */
export const TERMINAL_HINT = '要像在 ssh 里一样操作，点对话头部「VPS」后面的 >_ 打开终端'

export function adaptInteractive(raw) {
  const text = String(raw ?? '').trim()
  const m = /^((?:sudo(?:\s+-\S+)*\s+|\$SUDO\s+)?)(\S+)([\s\S]*)$/.exec(text)
  if (!m) return { command: text }
  const [, prefix, token, rest] = m
  const name = token.replace(/^.*\//, '')
  const pipe = topLevelPipe(rest)
  const args = (pipe === -1 ? rest : rest.slice(0, pipe)).trim()
  const after = pipe === -1 ? '' : ` ${rest.slice(pipe).trim()}`
  const build = (cmd, note) => ({ command: `${prefix}${cmd}${after}`.trim(), note })

  if (EDITORS.has(name)) {
    return {
      refuse: `${name} 是交互式编辑器，对话里没法用。看内容：/vps-sh cat ${args || '<文件>'}；要修改就跟 AI 说，它会用 vps_write_file 改（自动备份，改坏自动还原）。${TERMINAL_HINT}`,
    }
  }
  if (REPL_EXAMPLES[name] && args === '' && !after) {
    return { refuse: `${name} 会进入交互界面，对话里没法用。把要做的事写成一条命令，比如 ${REPL_EXAMPLES[name]}。${TERMINAL_HINT}` }
  }
  if (name === 'ssh' && args.split(/\s+/).filter((a) => !a.startsWith('-')).length <= 1) {
    return { refuse: 'ssh 登录会进入交互界面，对话里没法用。你已经在这台服务器上了，直接 /vps-sh 命令 即可' }
  }
  if (name === 'docker' && /^exec\b/.test(args) && /(^|\s)-(it|ti|t|i)(\s|$)/.test(args) && /(^|\s)(bash|sh|ash|zsh)$/.test(args)) {
    return { refuse: `进容器的交互 shell 对话里没法用。把命令直接写在后面，比如 /vps-sh docker exec <容器> ls /。${TERMINAL_HINT}` }
  }

  if (MONITORS.has(name)) {
    if (name === 'top' && hasFlag(args, /\s-\S*b\S*\s/)) return { command: text }
    return build(`top -bn1${pipe === -1 ? ' | head -n 40' : ''}`, `${name} 会一直刷新，改成打印一次快照：top -bn1`)
  }
  if (PAGERS.has(name)) {
    return build(`cat${args ? ` ${args}` : ''}`, `${name} 要翻页，改成直接输出：cat`)
  }
  if (name === 'tail' && hasFlag(args, /\s(-f|-F|--follow(=\S+)?)\s/)) {
    let next = dropFlags(args, /\s(-f|-F|--follow(=\S+)?)(?=\s)/g)
    if (!hasFlag(next, /\s(-n\s*\d+|--lines(=|\s)\S+|-\d+)\s/)) next = `-n 100 ${next}`.trim()
    return build(`tail ${next}`, 'tail -f 会一直等新内容，改成最后 100 行')
  }
  if (name === 'journalctl' && hasFlag(args, /\s(-f|--follow)\s/)) {
    let next = dropFlags(args, /\s(-f|--follow)(?=\s)/g)
    if (!hasFlag(next, /\s(-n\s*\d+|--lines(=|\s)\S+)\s/)) next = `${next} -n 100`.trim()
    if (!hasFlag(next, /\s--no-pager\s/)) next = `${next} --no-pager`
    return build(`journalctl ${next}`, 'journalctl -f 会一直等新日志，改成最后 100 行')
  }
  if (name === 'docker' && /^(logs|compose\s+logs)\b/.test(args) && hasFlag(args, /\s(-f|--follow)\s/)) {
    let next = dropFlags(args, /\s(-f|--follow)(?=\s)/g)
    if (!hasFlag(next, /\s--tail(=|\s)\S+\s/)) next = next.replace(/^(compose\s+logs|logs)\b/, '$1 --tail 100')
    return build(`docker ${next}`, 'docker logs -f 会一直等新日志，改成最后 100 行')
  }
  if (name === 'watch') {
    // watch 的选项：-n 秒、-d、-t、-g、-e、-c、-x、-p，以及 --interval=…
    const tokens = args.split(/\s+/).filter(Boolean)
    let i = 0
    while (i < tokens.length && tokens[i].startsWith('-')) i += ['-n', '--interval'].includes(tokens[i]) ? 2 : 1
    const inner = tokens.slice(i).join(' ').replace(/^(['"])([\s\S]*)\1$/, '$2')
    if (!inner) return { refuse: 'watch 后面要跟命令' }
    return build(inner, 'watch 会一直刷新，改成只执行一次')
  }
  if (name === 'docker' && /^exec\b/.test(args) && /(^|\s)-(it|ti)(\s|$)/.test(args)) {
    return build(`docker ${args.replace(/(^|\s)-(it|ti)(?=\s|$)/, '')}`.replace(/\s+/g, ' '), '对话里没有终端，去掉了 -it')
  }
  return { command: text }
}

/** 从输出里取出命令结束时的目录，并把标记行去掉 */
export function extractCwd(output) {
  const text = String(output ?? '')
  const at = text.lastIndexOf(CWD_MARK)
  if (at === -1) return { output: text, cwd: null }
  const lineEnd = text.indexOf('\n', at)
  const cwd = text.slice(at + CWD_MARK.length, lineEnd === -1 ? undefined : lineEnd).trim()
  const cleaned = (text.slice(0, at) + (lineEnd === -1 ? '' : text.slice(lineEnd + 1))).replace(/\n+$/, '')
  return { output: cleaned, cwd: cwd.startsWith('/') ? cwd : null }
}

// —— 交给 AI 之前打码 ——
const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[私钥已隐去]'],
  [/([?&#](?:token|access_token|auth|key|sig|signature)=)[^\s&"']+/gi, '$1***'],
  // 不用 \b：DB_PASSWORD、MYSQL_ROOT_PASSWORD 里 _ 算单词字符，\b 匹配不上（测试抓到的）
  [/([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1***'],
  [/\b(Authorization:\s*(?:Bearer|Basic|Token)\s+)\S+/gi, '$1***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh***'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, 'sk-***'],
  [/\b(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-\S+)\s+[A-Za-z0-9+/=]{40,}/g, '$1 ***'],
]

export function maskSecrets(text) {
  let out = String(text ?? '')
  for (const [re, replacement] of SECRET_RULES) out = out.replace(re, replacement)
  return out
}

// —— 每个对话最近几条命令，等用户下次跟 AI 说话时附上 ——
const MAX_ENTRIES = 6
const OUTPUT_TAIL = 1500
const TOTAL_LIMIT = 6000
const logs = new Map()
const told = new Set()

export function recordTerminal(sessionId, entry) {
  if (!sessionId) return { firstTime: false }
  const list = logs.get(sessionId) ?? []
  list.push({ ...entry, shared: false, at: Date.now() })
  while (list.length > MAX_ENTRIES) list.shift()
  logs.set(sessionId, list)
  const firstTime = !told.has(sessionId)
  told.add(sessionId)
  return { firstTime }
}

/** 取出还没交给 AI 的记录，并标记为已交出 */
export function takeUnshared(sessionId) {
  const list = logs.get(String(sessionId ?? '')) ?? []
  const pending = list.filter((e) => !e.shared)
  for (const e of pending) e.shared = true
  return pending
}

export function terminalText(entries) {
  const header = '[VPS 终端] 用户在对话里自己执行了下面这些命令（从早到晚）。用户接下来的话可能就是在问这些输出；敏感内容已打码。'
  const blocks = entries.map((e) => {
    const where = `${e.alias}${e.cwd ? `:${e.cwd}` : ''}`
    const status = e.status === 'detached' ? '转后台' : e.exitCode === null || e.exitCode === undefined ? e.status : `退出码 ${e.exitCode}`
    let out = maskSecrets(String(e.output ?? '').trim())
    if (out.length > OUTPUT_TAIL) out = `…（前面省略 ${out.length - OUTPUT_TAIL} 字）\n${out.slice(-OUTPUT_TAIL)}`
    return `$ ${maskSecrets(e.command)}　（${where}，${status}）\n${out || '（没有输出）'}`
  })
  let text = [header, ...blocks].join('\n\n')
  if (text.length > TOTAL_LIMIT) text = `${header}\n\n…（更早的省略）\n\n${text.slice(-(TOTAL_LIMIT - header.length - 20))}`
  return text
}

// —— 文件管理器里点「让 AI 看看这个文件」：同样等用户下次跟 AI 说话时附上 ——
// 一次最多攒 3 个文件，每个已经在读取时限制了大小（lib/filemgr.js SHARE_LIMIT）
const MAX_FILES = 3
const files = new Map()

/** @param {{ alias: string, path: string, content: string, size: number, truncated: boolean }} item */
export function shareFile(sessionId, item) {
  if (!sessionId) return 0
  const list = (files.get(sessionId) ?? []).filter((f) => !(f.alias === item.alias && f.path === item.path))
  list.push({ ...item, at: Date.now() })
  while (list.length > MAX_FILES) list.shift()
  files.set(sessionId, list)
  return list.length
}

export function takeSharedFiles(sessionId) {
  const list = files.get(String(sessionId ?? '')) ?? []
  files.delete(String(sessionId ?? ''))
  return list
}

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function sharedFilesText(items) {
  const header = '[VPS 文件] 用户在文件管理器里把下面的文件交给你看。用户接下来的话多半就是在问它；敏感内容已打码。要改这个文件请用 vps_write_file（会自动备份），不要用 echo 或 sed -i。'
  const blocks = items.map((f) => {
    const note = f.truncated ? `，文件共 ${sizeText(f.size)}，这里是最后 ${sizeText(Buffer.byteLength(f.content))}` : `，${sizeText(f.size)}`
    return `── ${f.alias}:${f.path}（${note.slice(1)}）──\n${maskSecrets(f.content)}`
  })
  return [header, ...blocks].join('\n\n')
}

/** 测试用：清空记录 */
export function _resetTerminalLog() {
  logs.clear()
  told.clear()
  files.clear()
}
