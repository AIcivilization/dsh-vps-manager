// lib/filemgr.js — 对话里的文件管理器（终端面板的「文件」页）
//
// 为什么不走 runRemote：那条通道是给命令结果用的，输出会截断、清洗控制字符，
// 装不下文件内容和上千项的目录。这里直接起 ssh，自己收原始字节；仍然复用同一条
// ControlMaster 连接（终端连着就不用再验证一次）。
//
// 安全边界（和终端一样，路由那边再把一道关）：
//   - 没有自由命令：只有列目录、读、存、新建文件夹、改名、移到回收站 / 还原 / 彻底删除、
//     上传、下载。路径和名字逐个校验，拼进脚本时一律 shellQuote
//   - 删除 = 移到服务器上的回收站（~/.cache/dsh-vps/trash），能还原；系统顶层目录直接拒绝
//   - 覆盖已有文件先备份到 ~/.cache/dsh-vps/backups/（和 AI 改文件同一个地方），
//     并保留原来的权限和属主
//   - 新建的文件、文件夹按 644 / 755（umask 022）：网站文件要让 nginx 之类读得到。
//     runRemote 的脚本是 umask 077，那是给插件自己的临时文件用的
//   - 以登录用户的身份操作，不提权：改不了的地方如实说「没有权限」

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { shellQuote } from './payload.js'
import { classifySshFailure, sshArgs } from './ssh.js'
import { noteReach } from './reach.js'

export const LIST_LIMIT = 3000
export const EDIT_LIMIT = 1024 * 1024 // 和 vps_write_file 的上限一致
export const SHARE_LIMIT = 48 * 1024 // 交给 AI 的上限：大文件（日志）取最后这么多
const TRASH = '$HOME/.cache/dsh-vps/trash'
const MAX_BATCH = 200

export class FileError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FileError'
    this.code = code
  }
}

// —————————————————————— 路径与名字 ——————————————————————

/** 绝对路径，规整掉 //、.、..；末尾不带 / （根目录除外） */
export function normalizePath(path) {
  const s = String(path ?? '')
  if (!s.startsWith('/')) throw new FileError('path_invalid', '路径必须以 / 开头')
  if (/[\0\n\r]/.test(s)) throw new FileError('path_invalid', '路径里有不能用的字符')
  if (Buffer.byteLength(s) > 4096) throw new FileError('path_invalid', '路径太长')
  const n = posix.normalize(s)
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n
}

/** 文件或文件夹的名字（不能带 /） */
export function assertName(name) {
  const s = String(name ?? '')
  if (!s || s === '.' || s === '..') throw new FileError('name_invalid', '名字不能为空，也不能是 . 或 ..')
  if (s.includes('/')) throw new FileError('name_invalid', '名字里不能有 /')
  if (/[\0\n\r]/.test(s)) throw new FileError('name_invalid', '名字里有不能用的字符')
  if (Buffer.byteLength(s) > 255) throw new FileError('name_invalid', '名字太长')
  return s
}

export function joinPath(dir, name) {
  return normalizePath(`${normalizePath(dir)}/${assertName(name)}`)
}

// 这些删了系统就起不来或者没法登录：连回收站都不让进
const PROTECTED = new Set([
  '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32', '/media', '/mnt',
  '/opt', '/proc', '/root', '/run', '/sbin', '/snap', '/srv', '/sys', '/tmp', '/usr', '/var',
  '/etc/ssh', '/usr/bin', '/usr/lib', '/usr/local', '/usr/sbin', '/var/lib', '/var/log', '/var/www',
])

export function protectedPath(path) {
  return PROTECTED.has(normalizePath(path))
}

// —————————————————————— 执行 ——————————————————————

/** 在远端用 sh 跑一段脚本（复用连接）。测试时换成本机 sh */
export function defaultSpawnSsh(alias, script) {
  return spawn('ssh', sshArgs(alias, { command: `sh -c ${shellQuote(script)}` }), { stdio: ['pipe', 'pipe', 'pipe'] })
}

// coreutils 的英文报错（脚本里设了 LC_ALL=C）翻成人话
const EXPLAIN = [
  [/Permission denied|Operation not permitted/i, '没有权限（这台机器用的账号改不了这里）'],
  [/No such file or directory/i, '文件或文件夹不存在（可能刚被别处删了，刷新一下）'],
  [/Directory not empty/i, '文件夹不是空的'],
  [/File exists/i, '已经有同名的文件或文件夹'],
  [/No space left on device/i, '服务器磁盘满了'],
  [/Read-only file system/i, '这里是只读的'],
  [/Not a directory/i, '路径里有一段不是文件夹'],
]

function explain(stderr) {
  const text = String(stderr ?? '').trim()
  for (const [re, hint] of EXPLAIN) if (re.test(text)) return hint
  return text.split('\n').filter(Boolean).at(-1) ?? ''
}

/**
 * @param {object} o
 * @param {Buffer|string|import('node:stream').Readable} [o.input]  写进 stdin 的内容（上传时是请求体）
 * @param {number} [o.maxBytes] stdout 超过就停
 * @param {number} [o.timeoutMs] 0 = 不限（上传）
 */
export function runScript(alias, script, { spawnSsh = defaultSpawnSsh, input, maxBytes = 8 * 1024 * 1024, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnSsh(alias, script)
    } catch (error) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: error.message, spawnError: true })
      return
    }
    const out = []
    let size = 0
    let stderr = ''
    let over = false
    let timedOut = false
    let settled = false
    child.stdout.on('data', (d) => {
      size += d.length
      if (size > maxBytes) {
        if (!over) child.kill('SIGTERM')
        over = true
        return
      }
      out.push(d)
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < 16_000) stderr += d
    })
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs) : null
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    child.on('error', (error) => done({ code: null, stdout: Buffer.alloc(0), stderr: error.message, spawnError: error.code === 'ENOENT' }))
    child.on('close', (code) => done({ code, stdout: Buffer.concat(out), stderr, over, timedOut }))
    child.stdin.on('error', () => {}) // 远端提前退出（目录不存在之类）时写入会 EPIPE：看退出码就够了
    if (input && typeof input.pipe === 'function') {
      // 浏览器那边取消或断线：停掉 ssh，远端的 trap 清掉临时文件，原文件不动
      const stop = () => child.kill('SIGTERM')
      input.on('error', stop)
      input.on('close', () => {
        if (input.complete === false) stop()
      })
      input.pipe(child.stdin)
    } else {
      child.stdin.end(input ?? '')
    }
  })
}

/** 统一把失败翻译成 FileError；ssh 层的失败顺手记下「连不上」 */
async function check(alias, res, env) {
  if (res.spawnError) throw new FileError('no_ssh', '本机找不到 ssh 命令')
  if (res.timedOut) throw new FileError('timeout', '服务器太久没回应，稍后再试')
  if (res.over) throw new FileError('too_large', '内容太多，超出了一次能显示的范围')
  if (res.code === 255) {
    const { hint } = classifySshFailure(res.stderr, 255)
    if (env) noteReach(alias, false, hint, env).catch(() => {})
    throw new FileError('ssh', hint)
  }
  if (res.code === null) throw new FileError('interrupted', '连接中断了，操作可能没做完：刷新看一下现在的样子')
  if (res.code !== 0) throw new FileError('remote', explain(res.stderr) || `操作没成功（退出码 ${res.code}）`)
  return res
}

const PRE = 'export LC_ALL=C; set -u'

// —————————————————————— 浏览 ——————————————————————

function parseType(c) {
  return { d: 'dir', f: 'file', l: 'link' }[c] ?? 'other'
}

function parseTarget(c) {
  return { d: 'dir', f: 'file', N: 'broken' }[c] ?? 'other'
}

/** 列目录：GNU find 一次拿全；没有 GNU find（BusyBox、BSD）就逐个 stat，两种 stat 写法都试 */
export function listScript(path) {
  const p = shellQuote(normalizePath(path))
  return [
    PRE,
    `P=${p}`,
    '[ -e "$P" ] || { echo "目录不存在：$P" >&2; exit 3; }',
    '[ -d "$P" ] || { echo "这不是文件夹：$P" >&2; exit 3; }',
    '[ -r "$P" ] && [ -x "$P" ] || { echo "没有权限打开这个文件夹" >&2; exit 4; }',
    'W=0; [ -w "$P" ] && W=1',
    `F=$(df -Pk "$P" 2>/dev/null | awk 'NR==2{print $4}')`,
    `printf 'DSHVPS\\t%s\\t%s\\t%s\\n' "$HOME" "$W" "\${F:-}"`,
    'if find "$P" -maxdepth 0 -printf "" >/dev/null 2>&1; then',
    `  find "$P" -mindepth 1 -maxdepth 1 -printf '%y\\t%Y\\t%s\\t%T@\\t%m\\t%u\\t%f\\0' 2>/dev/null | { head -z -n ${LIST_LIMIT + 1} 2>/dev/null || cat; }`,
    'else',
    '  n=0',
    '  for f in "$P"/* "$P"/.[!.]* "$P"/..?*; do',
    '    [ -e "$f" ] || [ -L "$f" ] || continue',
    `    n=$((n+1)); [ "$n" -gt ${LIST_LIMIT + 1} ] && break`,
    '    if [ -L "$f" ]; then y=l; elif [ -d "$f" ]; then y=d; elif [ -f "$f" ]; then y=f; else y=o; fi',
    '    if [ -d "$f" ]; then Y=d; elif [ -f "$f" ]; then Y=f; elif [ -e "$f" ]; then Y=o; else Y=N; fi',
    `    s=$(stat -c '%s %Y %a %U' "$f" 2>/dev/null || stat -f '%z %m %Lp %Su' "$f" 2>/dev/null || echo '0 0 0 ?')`,
    '    set -- $s',
    `    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\000' "$y" "$Y" "$1" "$2" "$3" "$4" "\${f##*/}"`,
    '  done',
    'fi',
  ].join('\n')
}

export function parseList(buffer) {
  const text = buffer.toString('utf8')
  const nl = text.indexOf('\n')
  const meta = (nl >= 0 ? text.slice(0, nl) : text).split('\t')
  if (meta[0] !== 'DSHVPS') throw new FileError('protocol', '服务器返回的内容看不懂')
  const records = (nl >= 0 ? text.slice(nl + 1) : '').split('\0').filter(Boolean)
  const truncated = records.length > LIST_LIMIT
  const entries = records.slice(0, LIST_LIMIT).map((r) => {
    const [y, t, size, mtime, mode, owner, ...rest] = r.split('\t')
    const name = rest.join('\t')
    return {
      name,
      type: parseType(y),
      target: parseTarget(t),
      size: Number(size) || 0,
      mtime: Math.floor(Number(mtime) || 0),
      mode: String(mode ?? ''),
      owner: String(owner ?? ''),
      // 名字不是 UTF-8：显示出来的和磁盘上的不一样，按名字操作会找不到它
      lossy: name.includes('\uFFFD'),
    }
  }).filter((e) => e.name)
  return {
    home: meta[1] ?? '',
    writable: meta[2] === '1',
    freeBytes: meta[3] ? Number(meta[3]) * 1024 : null,
    entries,
    truncated,
  }
}

export async function listDir({ alias, path, env, spawnSsh }) {
  const dir = normalizePath(path)
  const res = await check(alias, await runScript(alias, listScript(dir), { spawnSsh }), env)
  return { path: dir, ...parseList(res.stdout) }
}

// 网站目录按常见布局找第一个存在的：Debian/Ubuntu、宝塔、CentOS 的 nginx 默认目录、Arch
const WEB_DIRS = ['/var/www', '/www/wwwroot', '/usr/share/nginx/html', '/srv/www', '/srv/http']

export async function places({ alias, env, spawnSsh }) {
  const script = [
    PRE,
    `printf 'HOME\\t%s\\n' "$HOME"`,
    `for d in ${WEB_DIRS.map(shellQuote).join(' ')}; do [ -d "$d" ] && { printf 'WEB\\t%s\\n' "$d"; break; }; done`,
    `R="${TRASH}"; n=0; [ -d "$R" ] && n=$(ls -1A "$R" 2>/dev/null | wc -l | tr -d ' ')`,
    `printf 'TRASH\\t%s\\n' "$n"`,
  ].join('\n')
  const res = await check(alias, await runScript(alias, script, { spawnSsh }), env)
  const out = { home: '', web: '', trash: 0 }
  for (const line of res.stdout.toString('utf8').split('\n')) {
    const [k, v = ''] = line.split('\t')
    if (k === 'HOME') out.home = v
    if (k === 'WEB') out.web = v
    if (k === 'TRASH') out.trash = Number(v) || 0
  }
  return out
}

// —————————————————————— 新建、改名 ——————————————————————

export async function makeDir({ alias, dir, name, env, spawnSsh }) {
  const path = joinPath(dir, name)
  const script = [
    PRE,
    'umask 022',
    `T=${shellQuote(path)}`,
    '[ -e "$T" ] || [ -L "$T" ] && { echo "已经有同名的文件或文件夹" >&2; exit 3; }',
    'mkdir -- "$T"',
  ].join('\n')
  await check(alias, await runScript(alias, script, { spawnSsh }), env)
  return { path }
}

export async function renameEntry({ alias, dir, from, to, env, spawnSsh }) {
  const src = joinPath(dir, from)
  const dst = joinPath(dir, to)
  if (src === dst) return { path: dst }
  if (protectedPath(src)) throw new FileError('protected', '系统目录不能改名')
  const script = [
    PRE,
    `S=${shellQuote(src)}; T=${shellQuote(dst)}`,
    '[ -e "$S" ] || [ -L "$S" ] || { echo "原来的文件已经不在了" >&2; exit 3; }',
    '[ -e "$T" ] || [ -L "$T" ] && { echo "已经有同名的文件或文件夹" >&2; exit 3; }',
    'mv -- "$S" "$T"',
  ].join('\n')
  await check(alias, await runScript(alias, script, { spawnSsh }), env)
  return { path: dst }
}

// —————————————————————— 回收站 ——————————————————————
//
// 每删一样东西，回收站里建一个 <时间>-<进程>-<序号> 目录，里面放它本身和一个
// .dsh-trash-info（第一行原路径，第二行删除时间）。还原就是按原路径搬回去。

const TRASH_ID = /^\d{8}-\d{6}-\d+-\d+$/

export async function trashEntries({ alias, paths, env, spawnSsh }) {
  const list = [...new Set((paths ?? []).map(normalizePath))]
  if (!list.length) throw new FileError('empty', '没有选中要删除的东西')
  if (list.length > MAX_BATCH) throw new FileError('too_many', `一次最多删 ${MAX_BATCH} 项`)
  const blocked = list.filter(protectedPath)
  if (blocked.length) throw new FileError('protected', `系统目录不能删：${blocked.join('、')}`)
  const script = [
    PRE,
    `R="${TRASH}"`,
    'mkdir -p "$R" && chmod 700 "$HOME/.cache/dsh-vps" "$R" 2>/dev/null',
    'STAMP=$(date +%Y%m%d-%H%M%S); NOW=$(date +%s); i=0',
    `for P in ${list.map(shellQuote).join(' ')}; do`,
    '  i=$((i+1))',
    '  case "$P" in "$HOME"|"$HOME/.cache"|"$HOME/.cache/dsh-vps"|"$HOME/.cache/dsh-vps/"*|"$HOME/.ssh") printf \'DENY\\t%s\\n\' "$P"; continue;; esac',
    '  if [ ! -e "$P" ] && [ ! -L "$P" ]; then printf \'MISS\\t%s\\n\' "$P"; continue; fi',
    '  ID="$STAMP-$$-$i"',
    '  if mkdir "$R/$ID" && printf \'%s\\n%s\\n\' "$P" "$NOW" > "$R/$ID/.dsh-trash-info" && mv -- "$P" "$R/$ID/" 2>"$R/$ID/.err"; then',
    '    rm -f "$R/$ID/.err"; printf \'OK\\t%s\\t%s\\n\' "$ID" "$P"',
    '  else',
    '    E=$(cat "$R/$ID/.err" 2>/dev/null | tail -1); rm -rf "$R/$ID"; printf \'FAIL\\t%s\\t%s\\n\' "$P" "$E"',
    '  fi',
    'done',
  ].join('\n')
  const res = await check(alias, await runScript(alias, script, { spawnSsh, timeoutMs: 10 * 60_000 }), env)
  const moved = []
  const failed = []
  for (const line of res.stdout.toString('utf8').split('\n')) {
    const [k, a = '', b = ''] = line.split('\t')
    if (k === 'OK') moved.push({ id: a, path: b })
    else if (k === 'MISS') failed.push({ path: a, reason: '已经不在了' })
    else if (k === 'DENY') failed.push({ path: a, reason: '插件自己的目录和家目录不能删' })
    else if (k === 'FAIL') failed.push({ path: a, reason: explain(b) || '移动失败' })
  }
  return { moved, failed }
}

export async function listTrash({ alias, env, spawnSsh }) {
  const script = [
    PRE,
    `R="${TRASH}"`,
    '[ -d "$R" ] || exit 0',
    'for d in "$R"/*; do',
    '  [ -f "$d/.dsh-trash-info" ] || continue',
    '  ID=${d##*/}; O=$(sed -n 1p "$d/.dsh-trash-info"); T=$(sed -n 2p "$d/.dsh-trash-info")',
    '  for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do',
    '    [ -e "$f" ] || [ -L "$f" ] || continue',
    '    [ "${f##*/}" = .dsh-trash-info ] && continue',
    '    if [ -L "$f" ]; then y=l; elif [ -d "$f" ]; then y=d; else y=f; fi',
    '    s=0; [ "$y" = f ] && s=$(wc -c < "$f" 2>/dev/null | tr -d \' \')',
    `    printf '%s\\t%s\\t%s\\t%s\\t%s\\000' "$ID" "$y" "\${s:-0}" "\${T:-0}" "$O"`,
    '  done',
    'done',
  ].join('\n')
  const res = await check(alias, await runScript(alias, script, { spawnSsh }), env)
  const items = res.stdout.toString('utf8').split('\0').filter(Boolean).map((r) => {
    const [id, y, size, at, ...rest] = r.split('\t')
    const origin = rest.join('\t')
    return { id, type: parseType(y), size: Number(size) || 0, deletedAt: Number(at) || 0, origin, name: posix.basename(origin) }
  })
  items.sort((a, b) => b.deletedAt - a.deletedAt)
  return { items }
}

function trashIds(ids) {
  const list = [...new Set((ids ?? []).map(String))]
  if (!list.length) throw new FileError('empty', '没有选中回收站里的东西')
  if (list.length > MAX_BATCH) throw new FileError('too_many', `一次最多处理 ${MAX_BATCH} 项`)
  for (const id of list) if (!TRASH_ID.test(id)) throw new FileError('id_invalid', '回收站条目编号不对')
  return list
}

export async function restoreTrash({ alias, ids, env, spawnSsh }) {
  const list = trashIds(ids)
  const script = [
    PRE,
    `R="${TRASH}"`,
    `for ID in ${list.map(shellQuote).join(' ')}; do`,
    '  d="$R/$ID"; I="$d/.dsh-trash-info"',
    '  [ -f "$I" ] || { printf \'MISS\\t%s\\n\' "$ID"; continue; }',
    '  O=$(sed -n 1p "$I"); N=${O##*/}',
    '  if [ -e "$O" ] || [ -L "$O" ]; then printf \'TAKEN\\t%s\\t%s\\n\' "$ID" "$O"; continue; fi',
    '  mkdir -p -- "${O%/*}" 2>/dev/null',
    '  if mv -- "$d/$N" "$O" 2>/dev/null; then rm -rf -- "$d"; printf \'OK\\t%s\\t%s\\n\' "$ID" "$O"; else printf \'FAIL\\t%s\\t%s\\n\' "$ID" "$O"; fi',
    'done',
  ].join('\n')
  const res = await check(alias, await runScript(alias, script, { spawnSsh, timeoutMs: 10 * 60_000 }), env)
  const restored = []
  const failed = []
  for (const line of res.stdout.toString('utf8').split('\n')) {
    const [k, id = '', path = ''] = line.split('\t')
    if (k === 'OK') restored.push({ id, path })
    else if (k === 'TAKEN') failed.push({ id, path, reason: '原来的位置已经有同名的东西，先把它改个名再还原' })
    else if (k === 'MISS') failed.push({ id, path: '', reason: '回收站里已经没有这一项' })
    else if (k === 'FAIL') failed.push({ id, path, reason: '搬回去没成功（可能没有权限）' })
  }
  return { restored, failed }
}

/** 彻底删除：只删回收站里面的东西。all = 清空回收站 */
export async function purgeTrash({ alias, ids, all = false, env, spawnSsh }) {
  const list = all ? [] : trashIds(ids)
  const script = [
    PRE,
    `R="${TRASH}"`,
    '[ -d "$R" ] || exit 0',
    all
      ? 'find "$R" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || { for d in "$R"/* "$R"/.[!.]*; do [ -e "$d" ] && rm -rf -- "$d"; done; }'
      : `for ID in ${list.map(shellQuote).join(' ')}; do rm -rf -- "$R/$ID"; done`,
  ].join('\n')
  await check(alias, await runScript(alias, script, { spawnSsh, timeoutMs: 10 * 60_000 }), env)
  return { purged: all ? 'all' : list.length }
}

// —————————————————————— 读文件（编辑、交给 AI） ——————————————————————

function encodeCmd() {
  return 'if command -v base64 >/dev/null 2>&1; then ENC="base64"; else ENC="openssl base64"; fi'
}

function shaCmd(varName) {
  return `{ sha256sum "$${varName}" 2>/dev/null || shasum -a 256 "$${varName}" 2>/dev/null; } | cut -c1-64`
}

/**
 * @param {'full'|'tail'} mode full：超过 limit 就拒绝（编辑）；tail：超过就只取最后 limit 字节（交给 AI）
 * @returns {{ content: string, size: number, sha: string, truncated: boolean }}
 */
export async function readText({ alias, path, limit = EDIT_LIMIT, mode = 'full', env, spawnSsh }) {
  const p = normalizePath(path)
  const script = [
    PRE,
    `P=${shellQuote(p)}`,
    '[ -f "$P" ] || { echo "这不是一个普通文件" >&2; exit 3; }',
    '[ -r "$P" ] || { echo "没有权限读这个文件" >&2; exit 4; }',
    encodeCmd(),
    'S=$(wc -c < "$P" | tr -d \' \')',
    `L=${Number(limit)}`,
    'if [ "$S" -le "$L" ]; then',
    `  printf 'FULL\\t%s\\t%s\\n' "$S" "$(${shaCmd('P')})"`,
    '  $ENC < "$P"',
    mode === 'tail'
      ? `else printf 'TAIL\\t%s\\t\\n' "$S"; tail -c "$L" "$P" | $ENC`
      : `else echo "文件有 $S 字节，超过了 ${Math.round(limit / 1024)} KB，不能在这里打开" >&2; exit 5`,
    'fi',
  ].join('\n')
  const res = await check(alias, await runScript(alias, script, { spawnSsh, maxBytes: limit * 2 + 4096 }), env)
  const text = res.stdout.toString('utf8')
  const nl = text.indexOf('\n')
  const [kind, size, sha = ''] = text.slice(0, nl).split('\t')
  let bytes = Buffer.from(text.slice(nl + 1).replace(/\s+/g, ''), 'base64')
  const truncated = kind === 'TAIL'
  // 从中间截开的 UTF-8：丢掉开头不完整的那几个字节
  if (truncated) {
    let start = 0
    while (start < 4 && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
    bytes = bytes.subarray(start)
  }
  if (bytes.subarray(0, 8000).includes(0)) throw new FileError('binary', '这是二进制文件，不能当文本打开')
  let content
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new FileError('encoding', '这个文件不是 UTF-8 文本（可能是 GBK 之类的编码），不能在这里打开')
  }
  return { path: p, content, size: Number(size) || 0, sha: truncated ? '' : sha, truncated }
}

/** 现在文件的指纹：保存前对一下，防止覆盖掉别人（或 AI）刚改的内容 */
export async function currentSha({ alias, path, env, spawnSsh }) {
  const script = [PRE, `P=${shellQuote(normalizePath(path))}`, '[ -f "$P" ] || exit 0', shaCmd('P')].join('\n')
  const res = await check(alias, await runScript(alias, script, { spawnSsh }), env)
  return res.stdout.toString('utf8').trim()
}

// —————————————————————— 上传、下载 ——————————————————————

/**
 * 上传一个文件：先写到同目录的临时文件，收完、字节数对上了才换过去。
 * 覆盖已有文件：原文件先备份，新文件沿用原来的权限和属主。
 * 请求中断时临时文件由 trap 清掉，原文件不受影响。
 */
export function uploadScript({ path, size, taskId }) {
  const p = normalizePath(path)
  if (!Number.isSafeInteger(size) || size < 0) throw new FileError('size_invalid', '文件大小不对')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) throw new FileError('id_invalid', '任务编号不对')
  return [
    PRE,
    'umask 022',
    `T=${shellQuote(p)}; SIZE=${size}; TASK=${taskId}`,
    'D=${T%/*}; [ -n "$D" ] || D=/; N=${T##*/}',
    '[ -d "$D" ] || { echo "目标文件夹不存在：$D" >&2; exit 3; }',
    '[ -w "$D" ] || { echo "没有权限往这个文件夹里写" >&2; exit 4; }',
    'if [ -e "$T" ] && [ ! -f "$T" ]; then echo "同名的不是普通文件（是文件夹或别的），不能覆盖" >&2; exit 3; fi',
    'TMP="$D/.$N.dsh-upload-$$"',
    'trap \'rm -f "$TMP"\' HUP INT TERM PIPE',
    'BK=""',
    'if [ -f "$T" ]; then',
    '  BK="$HOME/.cache/dsh-vps/backups/$TASK$T"',
    '  mkdir -p "${BK%/*}" && cp -p "$T" "$BK" || { echo "备份原文件失败，没有覆盖" >&2; exit 4; }',
    'fi',
    'cat > "$TMP" || { rm -f "$TMP"; echo "写入失败" >&2; exit 5; }',
    'GOT=$(wc -c < "$TMP" | tr -d \' \')',
    '[ "$GOT" = "$SIZE" ] || { rm -f "$TMP"; echo "传输不完整（收到 $GOT / $SIZE 字节），没有覆盖" >&2; exit 6; }',
    'if [ -n "$BK" ]; then',
    '  M=$(stat -c %a "$T" 2>/dev/null || stat -f %Lp "$T" 2>/dev/null) && chmod "$M" "$TMP" 2>/dev/null',
    '  O=$(stat -c %u:%g "$T" 2>/dev/null || stat -f %u:%g "$T" 2>/dev/null) && chown "$O" "$TMP" 2>/dev/null',
    'fi',
    'mv -f "$TMP" "$T" || { rm -f "$TMP"; echo "替换失败" >&2; exit 7; }',
    '[ -n "$BK" ] && printf \'BACKUP\\t%s\\n\' "$BK"',
    'printf \'OK\\n\'',
  ].join('\n')
}

export async function uploadFile({ alias, path, size, stream, env, spawnSsh, taskId = newTaskId() }) {
  const script = uploadScript({ path, size, taskId })
  const res = await check(alias, await runScript(alias, script, { spawnSsh, input: stream, timeoutMs: 0, maxBytes: 64 * 1024 }), env)
  const backup = /^BACKUP\t(.+)$/m.exec(res.stdout.toString('utf8'))?.[1] ?? null
  return { path: normalizePath(path), size, backupPath: backup, taskId }
}

/** 下载前看一眼：是什么、多大、读不读得了 */
export async function statPath({ alias, path, env, spawnSsh }) {
  const p = normalizePath(path)
  const script = [
    PRE,
    `P=${shellQuote(p)}`,
    'if [ -d "$P" ]; then t=d; elif [ -f "$P" ]; then t=f; else echo "不存在，或者不是文件 / 文件夹" >&2; exit 3; fi',
    '[ -r "$P" ] || { echo "没有权限读取" >&2; exit 4; }',
    's=0; [ "$t" = f ] && s=$(wc -c < "$P" | tr -d \' \')',
    `printf '%s\\t%s\\n' "$t" "$s"`,
  ].join('\n')
  const res = await check(alias, await runScript(alias, script, { spawnSsh }), env)
  const [t, s] = res.stdout.toString('utf8').trim().split('\t')
  return { path: p, type: t === 'd' ? 'dir' : 'file', size: Number(s) || 0, name: posix.basename(p) || 'root' }
}

/** 下载的脚本：文件原样输出；文件夹打成 tar.gz 边打边传 */
export function downloadScript({ path, type }) {
  const p = normalizePath(path)
  if (type === 'dir') {
    const parent = posix.dirname(p)
    const name = posix.basename(p)
    if (!name) throw new FileError('protected', '不能下载整个根目录')
    return [PRE, `cd ${shellQuote(parent)} || exit 3`, `exec tar -czf - -- ${shellQuote(name)}`].join('\n')
  }
  return [PRE, `exec cat -- ${shellQuote(p)}`].join('\n')
}

export function newTaskId() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-files-${randomBytes(2).toString('hex')}`
}

/** Content-Disposition 里的文件名：中文走 RFC 5987 */
export function attachmentHeader(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
