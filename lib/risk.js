// lib/risk.js — 静态档位判定（设计 9.2）
//
// 最终档位 = max(AI 声明的 intent, 这里的静态判定)。AI 只能把档位往高了报。
//
// 判定原则：宁严勿松。把只读误判成改动，只多点一次确认；反过来会出事。
// 所以「只读」是白名单 + 全部条件满足才成立，其余一律「改动」，命中高危规则就是「高危」。
//
// 这不是安全沙箱：脚本可以用变形写法躲过静态判定，AI 也能用 DSH 自带的 bash 工具
// 直接 ssh。它防的是手滑，真正的兜底是确认档位 + 自动备份 + 连通性保险 + 审计。

export const TIERS = ['read', 'change', 'danger']

export function maxTier(a = 'read', b = 'read') {
  const ia = TIERS.indexOf(a)
  const ib = TIERS.indexOf(b)
  return TIERS[Math.max(ia === -1 ? 1 : ia, ib === -1 ? 1 : ib)]
}

const FIREWALL_TOOLS = new Set(['ufw', 'iptables', 'ip6tables', 'nft', 'firewall-cmd', 'iptables-restore', 'nft-restore'])
const FIREWALL_READONLY = /(^|\s)(status|list|show|-L|-S|-n|--list|--list-all|--state|--get-\w+|-V|--version)(\s|$)/

const POWER_COMMANDS = new Set(['reboot', 'shutdown', 'poweroff', 'halt', 'telinit'])

const KILL_COMMANDS = new Set(['kill', 'pkill', 'killall'])

/** 取一段里的首个命令名（跳过关键字、变量赋值、提权前缀） */
function leadingCommand(segment) {
  const tokens = tokenize(segment)
  if (!tokens) return null
  let i = 0
  while (i < tokens.length && (KEYWORDS.has(tokens[i]) || tokens[i].includes('=') || tokens[i].startsWith('$'))) {
    // sudo 自己的选项一起跳过：`sudo -n pkill x` 的命令是 pkill，不是 -n
    if (tokens[i] === 'sudo') {
      i += 1
      while (i < tokens.length && flag(tokens[i])) i += ['-u', '-g', '--user', '--group'].includes(tokens[i]) ? 2 : 1
      continue
    }
    i += 1
  }
  if (i >= tokens.length) return null
  return { name: tokens[i].replace(/^.*\//, ''), rest: tokens.slice(i + 1).join(' ') }
}

/** 直接杀进程。kill -0（探活）、kill -l（列信号）不算 */
function killCommand(text) {
  for (const segment of splitSegments(text)) {
    const cmd = leadingCommand(segment)
    if (!cmd || !KILL_COMMANDS.has(cmd.name)) continue
    if (cmd.name === 'kill' && /^(-0|-l|-L|--list)(\s|$)/.test(cmd.rest)) continue
    return `${cmd.name} ${cmd.rest}`.trim()
  }
  return null
}

/** 真的在执行关机 / 重启命令 */
function powerCommand(text) {
  for (const segment of splitSegments(text)) {
    const cmd = leadingCommand(segment)
    if (!cmd) continue
    if (POWER_COMMANDS.has(cmd.name)) return `${cmd.name} ${cmd.rest}`.trim()
    if (cmd.name === 'init' && /^[06]\b/.test(cmd.rest)) return `init ${cmd.rest}`.trim()
  }
  return null
}

/** 防火墙命令是否出现在命令位置，且不是查看类用法 */
function firewallChange(text) {
  for (const segment of splitSegments(text)) {
    const cmd = leadingCommand(segment)
    if (!cmd || !FIREWALL_TOOLS.has(cmd.name)) continue
    if (FIREWALL_READONLY.test(cmd.rest)) continue
    return `${cmd.name} ${cmd.rest}`.trim()
  }
  return null
}

// —— 高危规则：命中任一条就是高危 ——
const DANGER_RULES = [
  { category: 'delete', why: '删除文件', re: /\brm\s+(-\S*\s+)*-\S*[rf]/ },
  { category: 'delete', why: '抹除或截断文件', re: /\bshred\b|\btruncate\b|\bfind\b[^\n]*\s-delete\b/ },
  { category: 'disk', why: '磁盘 / 分区操作', re: /\bmkfs(\.\w+)?\b|\bdd\b[^\n]*\bof=|\bfdisk\b|\bparted\b|\bwipefs\b|\b(lv|vg|pv)remove\b/ },
  {
    category: 'network_lockout',
    why: '改防火墙，可能把自己锁在门外',
    // 用函数而不是正则：光是 `has_cmd iptables`（检查装没装）不该算改防火墙，
    // 必须是防火墙命令真的出现在命令位置，且不是查看类用法
    match: (text) => firewallChange(text),
  },
  { category: 'network_lockout', why: '关网卡或重配网络', re: /\bip\s+link\s+set\b[^\n]*\bdown\b|\bifdown\b|\bnetplan\s+apply\b/ },
  { category: 'network_lockout', why: '动 SSH 服务或配置', re: /\bsystemctl\s+(stop|disable|mask)\s+ssh|\bsshd_config\b|\bservice\s+ssh\w*\s+stop\b/ },
  { category: 'account', why: '改账户或登录方式', re: /\bpasswd\b|\buserdel\b|\busermod\b[^\n]*\s-L\b|\bchsh\b|authorized_keys/ },
  { category: 'permission', why: '大面积改权限', re: /\bch(mod|own)\b[^\n]*\s-R\b[^\n]*\s\/(etc|usr|var|bin|sbin|lib|boot|root)?(\/\S*)?(\s|$)/ },
  // 同样要在命令位置：配置里写 Automatic-Reboot "false"、grep 模式里出现 reboot
  // 这两种都不该被判成重启
  { category: 'power', why: '重启或关机', match: (text) => powerCommand(text) },
  // 实测：小模型查不到日志，就想 pkill 掉 systemd 管着的 DSH 再手动起一个——会绕开服务管理、打断正在用的人
  {
    category: 'process',
    why: '直接杀进程：systemd 管着的服务要用 systemctl restart / stop，杀掉再手动启动会绕开服务管理',
    match: (text) => killCommand(text),
  },
  { category: 'package_remove', why: '卸载软件包', re: /\bapt(-get)?\s+(remove|purge|autoremove)\b|\b(dnf|yum)\s+remove\b|\bapk\s+del\b|\bpacman\s+-R/ },
  { category: 'upgrade', why: '系统大版本升级', re: /\bdo-release-upgrade\b|\bapt(-get)?\s+(full-upgrade|dist-upgrade)\b/ },
  {
    category: 'data',
    why: '可能丢数据',
    re: /\bdrop\s+(database|table)\b|\btruncate\s+table\b|\bflushall\b|\bflushdb\b|\bdocker\s+volume\s+rm\b|\bdocker\s+system\s+prune\b|\bdocker\s+compose\s+down\b[^\n]*(-v\b|--volumes)|\bcrontab\s+-r\b/i,
  },
  { category: 'remote_script', why: '把网上下载的脚本直接交给 shell 执行', re: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+(-\S+\s+)*)?(sh|bash|zsh|python\d?)\b/ },
]

// —— 改文件时按路径判定：这些文件改坏了会连不上或起不来 ——
const SENSITIVE_PATHS = [
  /^\/etc\/ssh\/sshd_config/,
  /^\/etc\/fstab$/,
  /^\/etc\/sudoers/,
  /^\/etc\/(passwd|shadow|group|gshadow)$/,
  /authorized_keys$/,
  /^\/etc\/ufw\//,
  /^\/etc\/nftables/,
  /^\/etc\/sysconfig\/(iptables|network)/,
  /^\/etc\/iptables\//,
  /^\/etc\/netplan\//,
  /^\/etc\/network\//,
  /^\/etc\/systemd\/(system|network)\//,
  /^\/boot\//,
  /^\/etc\/(hosts|resolv\.conf)$/,
]

// 结构关键字：跳过后按后面的命令继续判断
const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'time', 'sudo', '!', '{', '}', '(', ')',
])

const flag = (t) => t.startsWith('-')
const firstArg = (args) => args.find((a) => !flag(a))
const hasAny = (args, set) => args.some((a) => set.has(a))
const noneOf = (args, res) => !args.some((a) => res.some((re) => re.test(a)))

const sub = (args, allowed) => {
  const s = firstArg(args)
  return s !== undefined && allowed.has(s)
}

// 只读白名单：true 表示命令本身只读，函数表示要看参数
const READ_COMMANDS = {
  cat: true, head: true, tail: true, ls: true, ll: true, stat: true, file: true, wc: true,
  du: true, basename: true, dirname: true, readlink: true, realpath: true, md5sum: true,
  sha256sum: true, sha1sum: true, cmp: true, diff: true, zcat: true, gunzip: (a) => a.includes('-c'),
  grep: true, egrep: true, fgrep: true, zgrep: true, sort: true, uniq: true, cut: true, tr: true,
  rev: true, column: true, jq: true, xxd: true, strings: true, seq: true, expr: true,
  awk: (a) => noneOf(a, [/system\s*\(/, /print\s*>/, /\|&/, /printf\s*>/]),
  gawk: (a) => noneOf(a, [/system\s*\(/, /print\s*>/, /\|&/]),
  sed: (a) => !a.some((x) => x === '-i' || x.startsWith('-i') || x === '--in-place'),
  uname: true, hostname: true, uptime: true, whoami: true, id: true, groups: true, w: true,
  last: true, lastlog: true, getent: true, nproc: true, arch: true, lscpu: true, lsmem: true,
  free: true, df: true, lsblk: true, findmnt: true, blkid: true, vmstat: true, iostat: true,
  // find 只在带 -exec / -delete / -fprint 这类参数时才会改东西，平时只是查找（-delete 另有高危规则）
  find: (a) => noneOf(a, [/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/]),
  ps: true, pgrep: true, top: true, htop: true, pidof: true, lsof: true, ulimit: true,
  echo: true, printf: true, true: true, false: true, test: true, '[': true, sleep: true,
  cd: true, pushd: true, popd: true, // 只换当前目录，不改任何东西（/vps-sh 会记住目录）
  which: true, type: true, printenv: true, locale: true, tty: true, pwd: true, hostnamectl: (a) => sub(a, new Set(['status'])) || a.length === 0,
  date: (a) => noneOf(a, [/^-s$/, /^--set/]),
  env: (a) => a.every((x) => x.includes('=') || flag(x)),
  command: (a) => a.includes('-v') || a.includes('-V'),
  ss: true, netstat: true, dig: true, nslookup: true, host: true, traceroute: true, arp: true,
  ping: true, ping6: true, mtr: (a) => a.includes('-r') || a.includes('--report'),
  ip: (a) => sub(a, new Set(['addr', 'a', 'address', 'link', 'l', 'route', 'r', 'neigh', 'n', 'rule', 'maddr']))
    && noneOf(a, [/^(add|del|delete|set|flush|change|replace)$/]),
  curl: (a) => noneOf(a, [/^-X$/, /^--request$/, /^-d$/, /^--data/, /^-T$/, /^--upload-file$/, /^-F$/, /^--form/, /^-O$/, /^--remote-name$/, /^--create-dirs$/])
    && (!a.includes('-o') || a[a.indexOf('-o') + 1] === '/dev/null'),
  wget: (a) => a.includes('--spider') || (a.includes('-O') && a[a.indexOf('-O') + 1] === '/dev/null'),
  openssl: true,
  systemctl: (a) => sub(a, new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'show', 'cat', 'get-default'])),
  journalctl: (a) => noneOf(a, [/^--vacuum/, /^--rotate$/, /^--flush$/]),
  service: (a) => a.includes('status') || a.includes('--status-all'),
  'rc-service': (a) => a.includes('status'),
  'rc-status': true,
  timedatectl: (a) => a.length === 0 || sub(a, new Set(['status', 'show'])),
  swapon: (a) => a.includes('--show') || a.includes('-s'),
  sysctl: (a) => noneOf(a, [/^-w$/, /^-p$/, /=/]),
  dpkg: (a) => a.some((x) => ['-l', '-s', '-L', '-S', '--list', '--status', '--print-architecture'].includes(x)),
  apt: (a) => sub(a, new Set(['list', 'policy', 'show', 'search', 'depends', 'rdepends'])),
  'apt-cache': true,
  rpm: (a) => a.some((x) => x.startsWith('-q') || x === '-V'),
  dnf: (a) => sub(a, new Set(['list', 'info', 'search', 'repolist', 'provides', 'check-update'])),
  yum: (a) => sub(a, new Set(['list', 'info', 'search', 'repolist', 'provides', 'check-update'])),
  apk: (a) => sub(a, new Set(['info', 'list', 'version', 'policy', 'search', 'stats'])),
  pacman: (a) => a.some((x) => x.startsWith('-Q')),
  docker: (a) => {
    const s = firstArg(a)
    if (s === 'compose') {
      const rest = a.slice(a.indexOf('compose') + 1)
      return sub(rest, new Set(['ps', 'logs', 'config', 'top', 'images', 'version']))
    }
    if (s === 'image' || s === 'container' || s === 'volume' || s === 'network' || s === 'system') {
      const rest = a.slice(a.indexOf(s) + 1)
      return sub(rest, new Set(['ls', 'inspect', 'df', 'events', 'list']))
    }
    return sub(a, new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'port', 'top', 'history', 'diff', 'events']))
  },
  podman: (a) => sub(a, new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info'])),
  nginx: (a) => a.every((x) => ['-t', '-T', '-v', '-V'].includes(x)),
  caddy: (a) => sub(a, new Set(['validate', 'version'])),
  apache2ctl: (a) => a.includes('-t') || a.includes('configtest'),
  httpd: (a) => a.includes('-t'),
  crontab: (a) => a.includes('-l'),
  ufw: (a) => a.includes('status'),
  iptables: (a) => hasAny(a, new Set(['-L', '-S', '--list', '--list-rules'])),
  ip6tables: (a) => hasAny(a, new Set(['-L', '-S', '--list', '--list-rules'])),
  nft: (a) => a.includes('list'),
  'firewall-cmd': (a) => a.some((x) => x.startsWith('--list') || x === '--state' || x === '--get-active-zones'),
  fail2ban_client: (a) => a.includes('status'),
  supervisorctl: (a) => a.includes('status'),
  'has_cmd': true, // 前导提供的辅助函数
  'svc_active': true,
  'pkg_installed': true,
  'port_listening': true,
}

// 这些写法直接判为「不是只读」
const NOT_READ_PATTERNS = [
  { re: /\$\(/, why: '命令替换 $( )' },
  { re: /`/, why: '反引号命令替换' },
  { re: /<\(|>\(/, why: '进程替换' },
  { re: /\beval\b|\bexec\b|\bsource\b|^\s*\.\s+\S/m, why: 'eval / exec / source' },
  { re: /\bxargs\b|\btee\b/, why: 'xargs / tee 会把输出写出去' },
  { re: /<<-?\s*\w/, why: 'heredoc' },
]

/**
 * 按命令分隔符切段，**引号内不切**。
 * 之前用正则切，`grep -E '^(a|reboot )'` 会被从引号中间劈开，
 * 于是 `reboot` 变成了一段的首个命令，被误判成重启。
 * 单个 & 也不切：那会把 `2>&1` 劈成两半。
 */
function splitSegments(text) {
  const source = String(text)
  const out = []
  let cur = ''
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === '\n' || c === ';') {
      out.push(cur)
      cur = ''
      continue
    }
    if (c === '|') {
      if (source[i + 1] === '|') i += 1
      out.push(cur)
      cur = ''
      continue
    }
    if (c === '&' && source[i + 1] === '&') {
      i += 1
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

function stripComments(script) {
  return String(script)
    .split('\n')
    .map((line) => {
      let out = ''
      let quote = null
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i]
        if (quote) {
          out += c
          if (c === quote) quote = null
          continue
        }
        if (c === "'" || c === '"') {
          quote = c
          out += c
          continue
        }
        if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break
        out += c
      }
      return out
    })
    .join('\n')
}

/** 粗分词：够用即可，判不了就当作不是只读 */
function tokenize(segment) {
  const tokens = []
  let cur = ''
  let quote = null
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (cur) tokens.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (quote) return null // 引号没闭合，判不了
  if (cur) tokens.push(cur)
  return tokens
}

function redirectsAreSafe(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (/^\d*>&\d+$/.test(t)) continue // 2>&1
    const m = /^(\d*)(>>?|&>)(.*)$/.exec(t)
    if (!m) continue
    const target = m[3] || tokens[i + 1]
    if (target !== '/dev/null') return false
  }
  return true
}

function segmentIsRead(segment) {
  const tokens = tokenize(segment)
  if (tokens === null) return { ok: false, why: '引号没闭合，无法判定' }
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === 'sudo') {
      // sudo 自己的选项要一起跳过，否则 `sudo -n systemctl status` 会把 -n 当成命令名
      i += 1
      while (i < tokens.length && flag(tokens[i])) {
        i += ['-u', '-g', '--user', '--group'].includes(tokens[i]) ? 2 : 1
      }
      continue
    }
    // $SUDO / $SUDO_OPT 这类提权前缀（前导脚本提供）跳过，看后面真正的命令
    if (KEYWORDS.has(t) || t.includes('=') || t.startsWith('$')) {
      i += 1
      continue
    }
    break
  }
  if (i >= tokens.length) return { ok: true }
  const name = tokens[i].replace(/^.*\//, '') // /usr/bin/df → df
  const args = tokens.slice(i + 1).filter((t) => !/^\d*(>>?|&>|<)/.test(t) && t !== '/dev/null')
  const rule = READ_COMMANDS[name]
  if (rule === undefined) return { ok: false, why: `${name} 不在只读白名单里` }
  if (rule === true) return redirectsAreSafe(tokens) ? { ok: true } : { ok: false, why: `${name} 有写入重定向` }
  if (!rule(args)) return { ok: false, why: `${name} 的用法会改东西` }
  return redirectsAreSafe(tokens) ? { ok: true } : { ok: false, why: `${name} 有写入重定向` }
}

/**
 * 判定一段脚本的档位。
 * @returns {{ tier: 'read'|'change'|'danger', dangers: Array<{category,why,match}>, readBlockers: string[] }}
 */
export function classifyScript(script) {
  const text = stripComments(script ?? '')
  const dangers = []
  for (const rule of DANGER_RULES) {
    const hit = rule.re ? rule.re.exec(text)?.[0] : rule.match(text)
    if (hit) dangers.push({ category: rule.category, why: rule.why, match: String(hit).trim().slice(0, 80) })
  }
  if (dangers.length) return { tier: 'danger', dangers, readBlockers: [] }

  const readBlockers = []
  for (const pattern of NOT_READ_PATTERNS) {
    if (pattern.re.test(text)) readBlockers.push(pattern.why)
  }
  if (readBlockers.length === 0) {
    for (const segment of splitSegments(text)) {
      const res = segmentIsRead(segment)
      if (!res.ok) readBlockers.push(res.why)
    }
  }
  return { tier: readBlockers.length === 0 ? 'read' : 'change', dangers: [], readBlockers }
}

/** 改文件：按路径判定档位（内容另外再按脚本规则判一次） */
export function classifyWritePath(path) {
  const p = String(path ?? '')
  const sensitive = SENSITIVE_PATHS.some((re) => re.test(p))
  return {
    tier: sensitive ? 'danger' : 'change',
    sensitive,
    lockout: /sshd_config|ufw|nftables|iptables|netplan|\/etc\/network\//.test(p),
  }
}

/** 是否属于“可能把自己锁在门外”的类别 —— 决定要不要连通性保险 */
export function needsSafetyNet(classification) {
  return (classification?.dangers ?? []).some((d) => d.category === 'network_lockout' || d.category === 'account')
}

/**
 * 工具调用的最终档位：AI 声明的只能往高了报。
 */
export function resolveTier(declaredIntent, classification) {
  const declared = TIERS.includes(declaredIntent) ? declaredIntent : 'change'
  return maxTier(declared, classification.tier)
}
