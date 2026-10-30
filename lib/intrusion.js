// lib/intrusion.js — 状态页的「入侵排查」卡片：这台有没有被人控制（俗称肉鸡）
//
// 设计见 工作流/dsh-vps-manager-入侵排查设计.md。现有的「安全」卡只管预防（门锁好没有），
// 这里查的是「有没有人已经进来了」。两层：
//   1. 轻量检查（IOC_SCAN）：进状态采集脚本，每次刷新都跑，不到 1 秒，只查几乎不会误报的进程迹象
//      和 /etc/ld.so.preload。发现了进「需注意」、机器编号亮红点
//   2. 完整排查（INTRUSION_SCRIPT）：用户点了才跑，10～30 秒。可疑进程、对外乱连、后门、系统命令
//      被替换、登录记录、IP 在不在被黑主机黑名单上、常见入口
// 全部只读，不装东西，零 token。判断全用规则；存本机的是原始结果，结论按界面语言现拼。
//
// 最容易误报的地方：用户都在跑代理。sing-box、xray、tor 本来就会连成百上千个地址，所以对外连接
// 按「是哪个程序」来判断，代理、tor、P2P 这类不算。钥匙和密码登录的 IP 插件没法知道是不是用户的，
// 列出来让用户点「是我的」，记在本机（不记服务器上：黑客改一下就能把自己的后门变成「认得的」）。

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, dshHome, readHosts } from './config.js'
import { runRemote } from './engine.js'
import { L, currentLang } from './i18n.js'

// —————————————————————— 轻量检查（状态采集脚本里也用） ——————————————————————
// 用到 prelude 里的 $SUDO_OPT。别人的进程的程序文件要 root 才看得到；ps 的命令行谁都能看。
// 一行：ioc=原因|PID|程序文件|命令行。原因：
//   miner   挖矿：程序名是常见挖矿程序，或命令行里有矿池参数
//   shm/tmp 程序文件在 /dev/shm、/tmp、/var/tmp（go run 的临时文件、AppImage 不算）
//   kthread 冒充内核线程：命令行写成 [kworker/0:1] 却有程序文件（真的内核线程没有）
//   memfd   从内存直接运行、没有程序文件（Docker 的 runc 不算）
//   deleted 程序文件已删、进程还在跑（系统目录里的是升级后没重启，不算）
// 挖矿程序名都写成 [x]mrig 这样：awk 自己的命令行里有这段程序，写成原样会把自己当成挖矿程序。
// 注意：这是 JS 模板字符串，脚本里不能出现「美元符 + 左花括号」和反引号
export const IOC_SCAN = String.raw`
{
  $SUDO_OPT ls -l /proc/[0-9]*/exe 2>/dev/null | awk '{ i = index($0, " -> "); if (!i) next; n = split(substr($0, 1, i - 1), a, " "); split(a[n], q, "/"); print "E " q[3] " " substr($0, i + 4) }'
  ps -eo pid=,args= 2>/dev/null | awk '{ print "P " $0 }'
} | awk '
  $1 == "E" { p = $2; s = $0; sub(/^E [0-9]+ /, "", s); exe[p] = s; next }
  $1 == "P" { p = $2; s = $0; sub(/^P +[0-9]+ ?/, "", s); args[p] = s; next }
  END {
    n = 0
    for (p in args) {
      e = (p in exe) ? exe[p] : ""; a = args[p]; del = 0
      if (e ~ / \(deleted\)$/) { del = 1; sub(/ \(deleted\)$/, "", e) }
      b = e; if (b == "") { split(a, w, " "); b = w[1] }
      sub(/.*\//, "", b); lb = tolower(b); la = tolower(a)
      r = ""
      if (lb ~ /([x]mrig|[x]mr-stak|[m]inerd|[c]puminer|[k]devtmpfsi|[k]insing|[e]thminer|[n]bminer|[l]olminer|[p]hoenixminer|[n]anominer|[s]rbminer|[t]eamredminer|[c]cminer|[c]gminer|[b]fgminer|[p]wnrig)/ || lb ~ /^([k]threaddi|[s]ysupdate|[n]etworkservice|[s]ysguard|[t]-rex|[g]miner)$/ || la ~ /([s]tratum2?\+(tcp|ssl|tls)|[-][-]donate-level|[n]icehash|[s]upportxmr|[m]oneroocean|[c]3pool|[n]anopool|[h]ashvault|[u]nmineable|[h]erominers)/) r = "miner"
      else if (e ~ /^\/dev\/shm\//) r = "shm"
      else if (e ~ /^\/(tmp|var\/tmp)\// && e !~ /^\/tmp\/(go-build|\.mount_)/) r = "tmp"
      else if (e != "" && a ~ /^\[/) r = "kthread"
      else if (e ~ /^\/memfd:/ && e !~ /runc/) r = "memfd"
      else if (del && e !~ /^\/(usr|bin|sbin|lib|lib32|lib64|libx32|opt|snap|nix)\//) r = "deleted"
      if (r == "") continue
      gsub(/\|/, "/", a); gsub(/\|/, "/", e)
      printf "ioc=%s|%s|%s%s|%s\n", r, p, e, (del ? " (deleted)" : ""), substr(a, 1, 160)
      if (++n >= 20) break
    }
  }'
pl=$(grep -v '^[[:space:]]*#' /etc/ld.so.preload 2>/dev/null | tr -s ' \n' '  ' | cut -c1-300)
[ -n "$(printf '%s' "$pl" | tr -d ' ')" ] && printf 'preload=%s\n' "$pl"
`

// 定时任务、自启服务、登录脚本里的可疑写法：服务器上先用宽的规则筛一遍（少传点），
// 准不准由下面 suspicious() 再判一次
const SUS_GREP = String.raw`(curl|wget|fetch)[^#]*[|][[:space:]]*(sudo[[:space:]]+)?(ba|da|z)?sh|/dev/(tcp|udp)/|base64[[:space:]]+(-d|--decode)|/(tmp|var/tmp|dev/shm)/|mkfifo|socket[.]socket|nc(at)?[[:space:]].*-[a-z]*e[[:space:]]`

// —————————————————————— 完整排查的脚本 ——————————————————————
// 用到 prelude 里的 has_cmd、$SUDO / $SUDO_OPT、$PKG、$INIT。只输出「键=值」：句子由界面按语言拼。
// 自由文本（命令行、定时任务那一行）都放在一行的最后一段，解析时只按前几个 | 切
export const INTRUSION_SCRIPT = String.raw`
T() { if has_cmd timeout; then timeout 20 "$@"; else "$@"; fi; }
if [ "$SUDO" = "__NO_PRIV__" ]; then printf 'priv=none\n'; elif [ -z "$SUDO" ]; then printf 'priv=root\n'; else printf 'priv=sudo\n'; fi
SUS='` + SUS_GREP + String.raw`'

# —— 一、可疑进程 ——
` + IOC_SCAN + String.raw`

# —— 二、对外连接：按程序汇总。本机在监听的端口上进来的连接不算（那是别人连我们） ——
if has_cmd ss; then
  printf 'ss=1\n'
  $SUDO_OPT ss -tanpH 2>/dev/null | awk '
    function hp(s,  i) { i = match(s, /:[0-9*]+$/); return i ? substr(s, i + 1) : "" }
    function hh(s,  i, h) { i = match(s, /:[0-9*]+$/); h = i ? substr(s, 1, i - 1) : s; gsub(/^\[|\]$/, "", h); sub(/^::ffff:/, "", h); return h }
    $1 == "LISTEN" { lp[hp($4)] = 1; next }
    $1 == "ESTAB" || $1 == "SYN-SENT" {
      nm = "?"; if (match($0, /users:\(\("[^"]+"/)) nm = substr($0, RSTART + 9, RLENGTH - 10)
      n++; S[n] = $1; LP[n] = hp($4); PH[n] = hh($5); PP[n] = hp($5); NM[n] = nm
    }
    END {
      for (i = 1; i <= n; i++) {
        if (LP[i] in lp) continue
        h = PH[i]; if (h ~ /^(127\.|::1$)/) continue
        k = NM[i]; names[k] = 1
        if (!((k SUBSEP h) in seen)) { seen[k SUBSEP h] = 1; out[k]++ }
        if (S[i] == "SYN-SENT" && !((k SUBSEP h) in sseen)) { sseen[k SUBSEP h] = 1; syn[k]++ }
        if (PP[i] == "22" && !((k SUBSEP h) in hseen)) { hseen[k SUBSEP h] = 1; ssh[k]++ }
        if (PP[i] ~ /^(3333|4444|5555|7777|14433|14444|45560|45700)$/) { pool[k]++; pe[k] = h ":" PP[i] }
      }
      for (k in names) printf "conn=%s|%d|%d|%d|%d|%s\n", k, out[k], syn[k], ssh[k], pool[k], pe[k]
    }' | sort -t'|' -k2 -rn | head -25
  $SUDO_OPT ss -ltnpH 2>/dev/null | awk '{ p = ""; if (match($0, /users:\(\("[^"]+"/)) p = substr($0, RSTART + 9, RLENGTH - 10); print "listen=" $4 "|" p }' | head -60
fi
if has_cmd redis-cli; then printf 'redis_ping=%s\n' "$(T redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | head -n 1)"; fi

# —— 三、后门：账号、钥匙、定时任务、自启服务、登录时自动执行的脚本、免密 sudo ——
awk -F: '$3 == 0 && $1 != "root" { print "uid0=" $1 } $7 !~ /(nologin|false|sync|shutdown|halt)$/ { print "acct=" $1 "|" $3 "|" $7 }' /etc/passwd 2>/dev/null | head -60
homes=$(awk -F: '$7 !~ /(nologin|false|sync|shutdown|halt)$/ || $1 == "root" { print $1 ":" $6 }' /etc/passwd 2>/dev/null | head -60)
printf '%s\n' "$homes" | while IFS=: read -r u h; do
  [ -n "$h" ] || continue
  for f in "$h/.ssh/authorized_keys" "$h/.ssh/authorized_keys2"; do
    # 几个账号共用一个家目录（比如第二个 root）：同一个文件只看一次
    case " $seen " in *" $f "*) continue ;; esac
    seen="$seen $f"
    $SUDO_OPT test -s "$f" 2>/dev/null || continue
    m=$($SUDO_OPT stat -c %Y "$f" 2>/dev/null)
    if has_cmd ssh-keygen; then
      $SUDO_OPT ssh-keygen -lf "$f" 2>/dev/null | head -40 | while read -r bits fp rest; do
        printf 'key=%s|%s|%s|%s|%s|%s\n' "$u" "$f" "$m" "$fp" "$bits" "$rest"
      done
    else
      printf 'key_notool=%s|%s\n' "$u" "$f"
    fi
  done
done
for f in /etc/crontab /etc/cron.d/* $($SUDO_OPT find /var/spool/cron -type f 2>/dev/null | head -50); do
  $SUDO_OPT test -f "$f" 2>/dev/null || continue
  case "$f" in *.dpkg-*|*.rpm*|*~) continue ;; esac
  $SUDO_OPT cat "$f" 2>/dev/null | grep -v '^[[:space:]]*#' | grep -v '^[[:space:]]*$' | grep -vE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' | head -60 | cut -c1-400 | while IFS= read -r l; do
    printf 'cron=%s|%s\n' "$f" "$l"
  done
done
for f in /etc/cron.hourly/* /etc/cron.daily/* /etc/cron.weekly/* /etc/cron.monthly/*; do
  [ -f "$f" ] && printf 'cronjob=%s\n' "$f"
done | head -80
if [ -d /etc/systemd/system ]; then
  for f in /etc/systemd/system/*.service; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    printf 'unit=%s|%s\n' "$(basename "$f")" "$(grep -E '^[[:space:]]*Exec(Start|StartPre|StartPost)=' "$f" 2>/dev/null | head -3 | tr '\n' ';' | cut -c1-400)"
  done | head -60
  grep -HE "^[[:space:]]*Exec(Start|StartPre|StartPost)=.*($SUS)" /lib/systemd/system/*.service /usr/lib/systemd/system/*.service 2>/dev/null | head -20 | cut -c1-400 | sed 's/^/susunit=/'
fi
rcfiles=$(printf '%s\n' "$homes" | while IFS=: read -r u h; do
  [ -n "$h" ] && for x in .bashrc .profile .bash_profile .bash_login .zshrc; do printf '%s\n' "$h/$x"; done
done | sort -u)
for f in /etc/rc.local /etc/profile /etc/profile.d/* /etc/bash.bashrc /etc/environment /etc/cron.hourly/* /etc/cron.daily/* /etc/cron.weekly/* /etc/cron.monthly/* $rcfiles; do
  $SUDO_OPT test -f "$f" 2>/dev/null || continue
  $SUDO_OPT grep -HnE "$SUS" "$f" 2>/dev/null | head -10 | cut -c1-400 | sed 's/^/sus=/'
done | head -40
for f in /etc/sudoers $($SUDO_OPT find /etc/sudoers.d -type f 2>/dev/null | head -30); do
  $SUDO_OPT grep -HE '^[^#]*NOPASSWD' "$f" 2>/dev/null | head -10 | cut -c1-300 | sed 's/^/sudo=/'
done

# —— 四、系统命令有没有被替换：和软件包安装时的校验值比（配置文件改过是正常的，解析时去掉） ——
case "$PKG" in
  apt)
    printf 'vtool=dpkg\n'
    for p in coreutils procps openssh-server openssh-client iproute2 net-tools util-linux login passwd sudo findutils grep sed bash libc-bin libpam-modules systemd lsof psmisc cron; do
      dpkg -s "$p" >/dev/null 2>&1 || continue
      printf 'vpkg=%s\n' "$p"
      T $SUDO_OPT dpkg -V "$p" 2>/dev/null | grep -v '^missing' | head -20 | sed "s|^|vbad=$p\||"
    done ;;
  dnf|yum)
    printf 'vtool=rpm\n'
    for p in coreutils procps-ng openssh-server openssh-clients iproute net-tools util-linux shadow-utils sudo findutils grep sed bash glibc-common pam systemd lsof psmisc cronie; do
      rpm -q "$p" >/dev/null 2>&1 || continue
      printf 'vpkg=%s\n' "$p"
      T $SUDO_OPT rpm -V "$p" 2>/dev/null | grep -v '^missing' | head -20 | sed "s|^|vbad=$p\||"
    done ;;
  *) printf 'vtool=none\n' ;;
esac

# —— 五、近 7 天的 SSH 登录：成功的按（方式、账号、来源、钥匙指纹）汇总；失败的只算数 ——
src=none
if [ "$SUDO" != "__NO_PRIV__" ] && [ "$INIT" = systemd ] && has_cmd journalctl; then src=journal
elif $SUDO_OPT test -r /var/log/auth.log 2>/dev/null; then src=auth
elif $SUDO_OPT test -r /var/log/secure 2>/dev/null; then src=secure
fi
printf 'logsrc=%s\n' "$src"
login_log() {
  case "$src" in
    journal) T $SUDO_OPT journalctl -q --since '7 days ago' -u ssh -u sshd -o short-unix --no-pager 2>/dev/null ;;
    auth) $SUDO_OPT cat /var/log/auth.log 2>/dev/null ;;
    secure) $SUDO_OPT cat /var/log/secure 2>/dev/null ;;
  esac
}
[ "$src" != none ] && login_log | awk '
  { t = ($1 ~ /^[0-9]+\.[0-9]+$/) ? int($1) : "" }
  / Accepted [a-z\/-]+ for / {
    m = $0; sub(/.* Accepted /, "", m); split(m, w, " ")
    fp = ""; if (match(m, /SHA256:[A-Za-z0-9+\/=]+/)) fp = substr(m, RSTART, RLENGTH)
    k = w[1] "|" w[3] "|" w[5] "|" fp; c[k]++; if (t != "") last[k] = t; acc[w[5]] = 1; next }
  / Failed (password|keyboard-interactive)/ {
    if (match($0, / from [0-9a-fA-F:.]+/)) { ip = substr($0, RSTART + 6, RLENGTH - 6); f[ip]++; tot++ } }
  END {
    for (k in c) printf "login=%s|%d|%s\n", k, c[k], last[k]
    for (ip in acc) if (f[ip]) printf "fail=%s|%d\n", ip, f[ip]
    n = 0; for (ip in f) n++
    printf "fail_total=%d\nfail_ips=%d\n", tot, n
  }' | head -80

# —— 六、外部名声：这台的 IP 在不在「被黑主机」黑名单上 ——
ip=""
if has_cmd curl; then ip=$(curl -s -m 8 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' | head -n 1)
elif has_cmd wget; then ip=$(wget -qO- -T 8 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' | head -n 1)
fi
printf 'ip=%s\n' "$ip"
case "$ip" in
  *.*.*.*)
    rev=$(echo "$ip" | awk -F. '{print $4"."$3"."$2"."$1}')
    for z in zen.spamhaus.org dnsbl.dronebl.org bl.blocklist.de; do
      (
        if has_cmd getent; then a=$(getent ahostsv4 "$rev.$z" 2>/dev/null | awk '{print $1; exit}')
        elif has_cmd dig; then a=$(dig +short +time=3 +tries=1 "$rev.$z" A 2>/dev/null | head -n 1)
        elif has_cmd host; then a=$(host -W 3 "$rev.$z" 2>/dev/null | awk '/has address/ {print $4; exit}')
        else a='?'
        fi
        printf 'bl=%s|%s\n' "$z" "$a"
      ) &
    done
    wait
    ;;
esac
`

// —————————————————————— 解析 ——————————————————————

/** 按前 n 个 | 切开，剩下的整段（可能自己带 |）放最后一格 */
function cut(value, n) {
  const out = []
  let rest = String(value ?? '')
  for (let i = 0; i < n; i++) {
    const at = rest.indexOf('|')
    if (at < 0) {
      out.push(rest)
      rest = ''
      continue
    }
    out.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  out.push(rest)
  return out
}
const int = (v) => {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : 0
}

/** 轻量检查那几行（状态采集也用）→ [{ reason, pid, path, args }] */
export function parseIoc(lines) {
  return lines.map((v) => {
    const [reason, pid, path, args] = cut(v, 3)
    return { reason, pid: int(pid), path, args }
  }).filter((p) => p.reason)
}

const LISTS = ['ioc', 'conn', 'listen', 'uid0', 'acct', 'key', 'key_notool', 'cron', 'cronjob', 'unit', 'susunit', 'sus', 'sudo', 'vpkg', 'vbad', 'login', 'fail', 'bl']

/** 完整排查的输出 → 结构化的数据（只有原始信号，不带结论） */
export function parseIntrusion(stdout) {
  const kv = {}
  const lists = Object.fromEntries(LISTS.map((k) => [k, []]))
  for (const raw of String(stdout ?? '').split('\n')) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(raw.replace(/\r$/, ''))
    if (!m) continue
    if (lists[m[1]]) lists[m[1]].push(m[2])
    else kv[m[1]] = m[2]
  }
  const susLine = (v) => {
    // grep -Hn 的格式：文件:行号:内容
    const m = /^([^:]+):(\d+):(.*)$/.exec(v)
    return m ? { file: m[1], lineNo: int(m[2]), line: m[3] } : null
  }
  return {
    priv: kv.priv ?? 'unknown',
    procs: parseIoc(lists.ioc),
    preload: kv.preload?.trim() || null,
    ss: kv.ss === '1',
    conns: lists.conn.map((v) => {
      const [name, out, syn, ssh, pool, poolPeer] = cut(v, 5)
      return { name, out: int(out), syn: int(syn), ssh: int(ssh), pool: int(pool), poolPeer }
    }),
    listen: lists.listen.map((v) => {
      const [addr, proc] = cut(v, 1)
      const i = addr.lastIndexOf(':')
      const host = addr.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '')
      return { host, port: int(addr.slice(i + 1)), proc, local: /^(127\.|::1$|localhost)/.test(host) }
    }),
    redisPing: kv.redis_ping === undefined ? null : kv.redis_ping.trim(),
    uid0: lists.uid0,
    accounts: lists.acct.map((v) => {
      const [name, uid, shell] = cut(v, 2)
      return { name, uid: int(uid), shell }
    }),
    keys: lists.key.map((v) => {
      const [user, file, mtime, fp, bits, rest] = cut(v, 5)
      const m = /^(.*?)\s*\(([A-Z0-9-]+)\)\s*$/.exec(rest)
      return { user, file, mtime: int(mtime) || null, fp, bits: int(bits), comment: (m ? m[1] : rest).trim(), type: m ? m[2] : '' }
    }).filter((k) => /^(SHA256|MD5):/.test(k.fp)),
    keyNoTool: lists.key_notool.length > 0,
    cron: lists.cron.map((v) => {
      const [file, line] = cut(v, 1)
      return { file, line }
    }),
    cronJobs: lists.cronjob,
    units: lists.unit.map((v) => {
      const [name, exec] = cut(v, 1)
      return { name, exec, where: 'etc' }
    }),
    libUnits: lists.susunit.map((v) => {
      // grep -H：文件:Exec 那一行
      const i = v.indexOf(':')
      const file = v.slice(0, i)
      return { name: file.split('/').pop(), file, exec: v.slice(i + 1), where: 'lib' }
    }),
    sus: lists.sus.map(susLine).filter(Boolean),
    sudo: lists.sudo.map((v) => {
      const i = v.indexOf(':')
      return { file: v.slice(0, i), line: v.slice(i + 1).trim() }
    }),
    verify: {
      tool: kv.vtool && kv.vtool !== 'none' ? kv.vtool : null,
      pkgs: lists.vpkg,
      bad: lists.vbad.map((v) => {
        const [pkg, line] = cut(v, 1)
        const m = /^(\S{8,9})\s+(c\s+)?(\/.*)$/.exec(line)
        return m ? { pkg, flags: m[1], conf: Boolean(m[2]), path: m[3].trim() } : { pkg, flags: '', conf: false, path: '', missing: /^missing/.test(line) }
      }),
    },
    logSource: kv.logsrc ?? 'none',
    logins: lists.login.map((v) => {
      const [method, user, ip, fp, count, last] = cut(v, 5)
      return { method, user, ip, fp, count: int(count), last: int(last) || null }
    }),
    fails: Object.fromEntries(lists.fail.map((v) => {
      const [ip, n] = cut(v, 1)
      return [ip, int(n)]
    })),
    failTotal: kv.fail_total === undefined ? null : int(kv.fail_total),
    failIps: kv.fail_ips === undefined ? null : int(kv.fail_ips),
    ip: kv.ip?.trim() || null,
    blocklists: lists.bl.map((v) => {
      const [zone, answer] = cut(v, 1)
      return { zone, answer: answer.trim().replace(/^::ffff:/i, '') }
    }),
  }
}

// —————————————————————— 规则 ——————————————————————

/** 本来就会连很多地址的程序：代理、tor、P2P、DNS、发邮件、反向代理（进程名最长 15 个字符，按前缀认） */
export const FANOUT_OK = /^(sing-box|xray|v2ray|trojan|hysteria|hy2|tuic|naive|juicity|shadow-tls|caddy|ss-|ssserver|sslocal|shadowsocks|snell|brook|gost|mihomo|clash|realm|haproxy|nginx|envoy|traefik|tor$|i2pd|yggdrasil|squid|3proxy|tinyproxy|privoxy|danted|sockd|wireproxy|warp|cloudflared|frp|nps$|npc$|socat|docker-proxy|openvpn|ocserv|x-ui|sshd|unbound|named|dnsmasq|coredns|smartdns|adguardhome|dnsproxy|smtp|postfix|exim|sendmail|master$|qbittorrent|transmission|aria2c|deluged|rtorrent|ipfs|kubo|syncthing|bitcoind|monerod|geth|nezha)/i
/** 本来就是连别人 22 端口的程序 */
const SSH_CLIENT = /^(ssh|scp|sftp|rsync|autossh|mosh|git|ansible|sshpass)/i
const LIMIT = { scanSyn: 20, sshOut: 5, bruteFail: 10 }

/**
 * 一段命令里的可疑写法。只认几乎不会出现在正常配置里的：
 *   revshell 反弹 shell（/dev/tcp、nc -e、bash -i >&、python socket）
 *   b64      base64 解出来直接执行
 *   tmpexec  执行临时目录里的程序（只是写日志到 /tmp 不算）
 *   dlip     从裸 IP 地址下载脚本直接执行（正常的安装脚本都用域名）
 *   dl       从网上下载脚本直接执行
 * @returns {{ kind, level } | null}
 */
export function suspicious(command) {
  const s = String(command ?? '')
  if (/\/dev\/(tcp|udp)\/|\bnc(at)?\b[^|;]*\s-[a-z]*e\s|\bbash\s+-i\s*>&|socket\.socket\(|\bmkfifo\b[^#]*\b(nc|ncat|telnet)\b/.test(s)) return { kind: 'revshell', level: 'danger' }
  if (/base64\s+(-d|--decode)\b[^#]*\|\s*(sudo\s+)?(ba|da|z)?sh\b/.test(s)) return { kind: 'b64', level: 'danger' }
  if (/(^|[;&|(]\s*|\b(?:(?:ba|da|z)?sh|nohup|exec|setsid|chmod\s+[+0-7a-z]+)\s+)(?:\.\/)?\/(?:tmp|var\/tmp|dev\/shm)\/(?!go-build)\S+/.test(s) || /\bcd\s+\/(tmp|var\/tmp|dev\/shm)\b[^#]*(&&|;)\s*\.\//.test(s)) return { kind: 'tmpexec', level: 'danger' }
  const download = /\b(curl|wget|fetch)\b[^#]*\|\s*(sudo\s+)?(ba|da|z)?sh\b/.test(s)
  if (download && /https?:\/\/\d{1,3}(\.\d{1,3}){3}\b/.test(s)) return { kind: 'dlip', level: 'danger' }
  if (download) return { kind: 'dl', level: 'warn' }
  return null
}

/** 定时任务那一行去掉时间（系统级的还要去掉用户名），剩下的才是命令 */
export function cronCommand(file, line) {
  const system = file === '/etc/crontab' || file.startsWith('/etc/cron.d/')
  let rest = String(line ?? '').trim()
  const skip = (rest.startsWith('@') ? 1 : 5) + (system ? 1 : 0)
  for (let i = 0; i < skip; i++) rest = rest.replace(/^\S+\s*/, '')
  return rest
}

/** 自启服务的 Exec 行 → 一条条命令（去掉 ExecStart= 和前面的 - @ + ! : 记号） */
function unitCommands(exec) {
  return String(exec ?? '').split(';').map((x) => x.replace(/^\s*Exec\w+=\s*[-@+!:]*/, '').trim()).filter(Boolean)
}
function unitSuspicious(exec) {
  let worst = null
  for (const cmd of unitCommands(exec)) {
    const hit = suspicious(cmd)
    if (hit && (!worst || (hit.level === 'danger' && worst.level !== 'danger'))) worst = hit
  }
  return worst
}

export const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12)
const cronHash = (c) => hash(`${c.file}\n${c.line}`)
const unitHash = (u) => hash(`${u.name}\n${u.exec}`)
const susHash = (x) => hash(`${x.file}\n${x.line}`)
/** 插件自己放的钥匙（备注 dsh-vps-manager@电脑名）：用户的哪台电脑放的都认得 */
export const isPluginKey = (k) => /^dsh-vps-manager(@|$)/.test(k.comment ?? '')

/** 第一次排查时，定时任务、自启服务、账号、免密 sudo 直接当成「原本就有」；钥匙要用户自己确认 */
export function baselineFrom(data) {
  return {
    init: true,
    keys: [],
    ips: [],
    cron: data.cron.filter((c) => !suspicious(cronCommand(c.file, c.line))).map(cronHash),
    cronjob: [...data.cronJobs],
    units: data.units.filter((u) => !unitSuspicious(u.exec)).map(unitHash),
    accts: data.accounts.map((a) => a.name),
    sudo: data.sudo.map((x) => hash(`${x.file}\n${x.line}`)),
    sus: [],
  }
}

const short = (s, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const base = (p) => String(p ?? '').replace(/ \(deleted\)$/, '').split('/').pop() || p
const day = (sec) => {
  if (!sec) return ''
  const d = new Date(sec * 1000)
  return currentLang() === 'zh' ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : d.toISOString().slice(0, 10)
}
const joinList = (list) => list.join(currentLang() === 'zh' ? '、' : ', ')

/** 一个可疑进程说成人话（轻量检查和完整排查共用） */
export function procText(p) {
  const name = base(p.path) || short(p.args, 40)
  switch (p.reason) {
    case 'miner': return { level: 'danger', text: L(`挖矿程序：${name}（PID ${p.pid}）`, `Crypto miner: ${name} (PID ${p.pid})`) }
    case 'shm':
    case 'tmp': return { level: 'danger', text: L(`从临时目录运行的程序：${p.path}（PID ${p.pid}）`, `Program running from a temporary directory: ${p.path} (PID ${p.pid})`) }
    case 'kthread': return { level: 'danger', text: L(`冒充系统内核线程：${short(p.args, 40)}，实际是 ${p.path}（PID ${p.pid}）`, `Pretends to be a kernel thread: ${short(p.args, 40)}, actually ${p.path} (PID ${p.pid})`) }
    case 'memfd': return { level: 'warn', text: L(`从内存直接运行、没有程序文件：PID ${p.pid}（${short(p.args, 50)}）`, `Runs from memory with no program file: PID ${p.pid} (${short(p.args, 50)})`) }
    case 'deleted': return { level: 'warn', text: L(`程序文件已被删掉、进程还在跑：${p.path.replace(/ \(deleted\)$/, '')}（PID ${p.pid}）`, `Program file deleted but the process still runs: ${p.path.replace(/ \(deleted\)$/, '')} (PID ${p.pid})`) }
    default: return { level: 'warn', text: `${p.reason}: ${name} (PID ${p.pid})` }
  }
}
export const preloadText = (preload) => L(
  `/etc/ld.so.preload 里有内容：${short(preload, 80)}。rootkit 常用这个藏自己，除非是你自己加的`,
  `/etc/ld.so.preload is not empty: ${short(preload, 80)}. Rootkits use it to hide themselves, unless you added it`,
)

function susText(kind, where, what) {
  const how = {
    revshell: L('反弹 shell（把这台的控制权交给别人）', 'a reverse shell (hands control of this server to someone else)'),
    b64: L('把 base64 解出来直接执行', 'decodes base64 and runs it'),
    tmpexec: L('执行临时目录里的程序', 'runs a program from a temporary directory'),
    dlip: L('从裸 IP 地址下载脚本直接执行', 'downloads a script from a bare IP address and runs it'),
    dl: L('从网上下载脚本直接执行', 'downloads a script and runs it'),
  }[kind]
  return L(`${where}：${how}——${short(what, 80)}`, `${where}: ${how}: ${short(what, 80)}`)
}

const DRONEBL = {
  3: ['danger', 'IRC 僵尸', 'IRC drone'], 5: ['danger', '僵尸程序', 'bottler'], 6: ['danger', '垃圾邮件或僵尸', 'spambot or drone'], 7: ['danger', 'DDoS 僵尸', 'DDoS drone'],
  8: ['warn', '开放的 SOCKS 代理', 'open SOCKS proxy'], 9: ['warn', '开放的 HTTP 代理', 'open HTTP proxy'], 10: ['warn', '代理链', 'proxy chain'], 11: ['warn', '网页代理', 'web page proxy'],
  12: ['warn', '开放的 DNS 解析', 'open DNS resolver'], 13: ['danger', '暴力破解别人', 'brute-force attacker'], 14: ['warn', '开放的 WinGate 代理', 'open WinGate proxy'],
  15: ['danger', '被黑的路由器', 'compromised router'], 16: ['danger', '自动入侵的蠕虫', 'autorooting worm'], 17: ['danger', '僵尸网络', 'botnet'], 19: ['warn', '被滥用的 VPN', 'abused VPN'],
}

/**
 * 原始结果 + 本机记的「认得的」→ 给人看的结论。
 * 一组一行：{ id, title, level: ok | warn | danger | na, text, items: [{ id, level, text, detail?, ack? }], detail? }
 * ack = { kind, value }：界面上显示「是我的」/「是我加的」，点了记进「认得的」，以后不再报
 */
export function judgeIntrusion(data, known = null) {
  const k = { keys: [], ips: [], cron: [], cronjob: [], units: [], accts: [], sudo: [], sus: [], ...(known ?? {}) }
  const has = (list, v) => (k[list] ?? []).includes(v)
  const groups = []
  const group = (id, title, items, okText, extra = {}) => {
    const level = items.some((i) => i.level === 'danger') ? 'danger' : items.some((i) => i.level === 'warn') ? 'warn' : 'ok'
    groups.push({ id, title, level, text: level === 'ok' ? okText : '', items, ...extra })
  }
  const titles = {
    procs: L('可疑进程', 'Suspicious processes'),
    net: L('对外连接', 'Outbound connections'),
    backdoor: L('后门', 'Backdoors'),
    binaries: L('系统命令', 'System commands'),
    logins: L('登录记录', 'Logins'),
    reputation: L('IP 名声', 'IP reputation'),
    entry: L('常见入口', 'Common entry points'),
  }
  const d = data ?? {}
  if (d.sshFailed) {
    for (const id of Object.keys(titles)) groups.push({ id, title: titles[id], level: 'na', text: L(`连不上服务器，这次没查：${d.sshFailed}`, `Could not reach the server, so this was not checked: ${d.sshFailed}`), items: [] })
    return summarize(groups)
  }
  const noRoot = d.priv === 'none'

  // 一、可疑进程
  group('procs', titles.procs,
    d.procs.map((p, i) => ({ id: `proc:${p.pid}:${i}`, ...procText(p), detail: [p.path, p.args].filter(Boolean).join('\n') })),
    noRoot ? L('没发现（没有 root，只看了自己账号的进程）', 'None found (no root, so only this account\'s processes were checked)') : L('没有挖矿、藏在临时目录、冒充系统的程序', 'No miners, nothing hiding in temporary directories or posing as the system'))

  // 二、对外连接
  {
    const items = []
    for (const c of d.conns) {
      if (FANOUT_OK.test(c.name)) continue
      const name = c.name === '?' ? L('某个程序（没有 root 看不到名字）', 'an unknown program (needs root to see the name)') : c.name
      if (c.syn >= LIMIT.scanSyn) items.push({ id: `scan:${c.name}`, level: 'danger', text: L(`${name} 正在同时向 ${c.syn} 个地址发起连接：像在扫描别人`, `${name} is opening connections to ${c.syn} addresses at once, like a scanner`) })
      if (c.ssh >= LIMIT.sshOut && !SSH_CLIENT.test(c.name)) items.push({ id: `brute:${c.name}`, level: 'danger', text: L(`${name} 连着 ${c.ssh} 台机器的 22 端口：像在爆破别人的 SSH`, `${name} is connected to port 22 on ${c.ssh} machines, like an SSH brute-forcer`) })
      if (c.pool > 0) items.push({ id: `pool:${c.name}`, level: 'warn', text: L(`${name} 连着常见的矿池端口（${c.poolPeer}）`, `${name} is connected to a common mining-pool port (${c.poolPeer})`) })
    }
    const top = d.conns.filter((c) => c.out > 0).slice(0, 6).map((c) => L(`${c.name} ${c.out} 个地址`, `${c.name} ${c.out} addresses`))
    const detail = [
      top.length ? L(`对外连接最多的：${joinList(top)}`, `Most outbound connections: ${joinList(top)}`) : '',
      L('代理、tor、P2P、DNS、发邮件的程序本来就会连很多地址，不算', 'Proxies, tor, P2P, DNS and mail programs connect to many addresses by design and are not counted'),
    ].filter(Boolean).join('\n')
    if (!d.ss) groups.push({ id: 'net', title: titles.net, level: 'na', text: L('服务器上没有 ss，看不了', 'There is no ss on the server, so this could not be checked'), items: [] })
    else group('net', titles.net, items, L('没有扫描、爆破别人或连矿池（代理、tor 的连接不算）', 'No scanning, brute-forcing or mining pools (proxy and tor connections are not counted)'), { detail })
  }

  // 三、后门
  {
    const items = []
    if (d.preload && !has('sus', hash(`preload\n${d.preload}`))) items.push({ id: 'preload', level: 'danger', text: preloadText(d.preload), ack: { kind: 'sus', value: hash(`preload\n${d.preload}`) } })
    for (const name of d.uid0) {
      if (!has('accts', `uid0:${name}`)) items.push({ id: `uid0:${name}`, level: 'danger', text: L(`除了 root 还有 UID 为 0 的账号：${name}（等于第二个 root）`, `Another account with UID 0 besides root: ${name} (a second root)`), ack: { kind: 'accts', value: `uid0:${name}` } })
    }
    const unknownKeys = d.keys.filter((key) => !isPluginKey(key) && !has('keys', key.fp))
    for (const key of unknownKeys) {
      const when = key.mtime ? L(`，文件 ${day(key.mtime)}改过`, `, file changed ${day(key.mtime)}`) : ''
      items.push({
        id: `key:${key.fp}`, level: 'warn',
        text: L(`${key.user} 有一把钥匙你还没确认：${key.comment && key.comment !== 'no comment' ? key.comment : '（没有备注）'}（${key.type}${when}）`, `${key.user} has a key you have not confirmed: ${key.comment && key.comment !== 'no comment' ? key.comment : '(no comment)'} (${key.type}${when})`),
        detail: `${key.file}\n${key.fp}`, ack: { kind: 'keys', value: key.fp },
      })
    }
    if (k.init) {
      for (const a of d.accounts) {
        if (!has('accts', a.name)) items.push({ id: `acct:${a.name}`, level: 'warn', text: L(`上次排查以后新增了能登录的账号：${a.name}`, `New login account since the last check: ${a.name}`), detail: `uid ${a.uid} · ${a.shell}`, ack: { kind: 'accts', value: a.name } })
      }
    }
    for (const c of d.cron) {
      const h = cronHash(c)
      if (has('cron', h)) continue
      const cmd = cronCommand(c.file, c.line)
      const hit = suspicious(cmd)
      if (hit) items.push({ id: `cron:${h}`, level: hit.level, text: susText(hit.kind, L('定时任务', 'Scheduled task'), cmd), detail: `${c.file}\n${c.line}`, ack: { kind: 'cron', value: h } })
      else if (k.init) items.push({ id: `cron:${h}`, level: 'warn', text: L(`上次排查以后新增的定时任务：${short(cmd, 70)}`, `New scheduled task since the last check: ${short(cmd, 70)}`), detail: `${c.file}\n${c.line}`, ack: { kind: 'cron', value: h } })
    }
    if (k.init) {
      for (const f of d.cronJobs) {
        if (!has('cronjob', f)) items.push({ id: `cronjob:${f}`, level: 'warn', text: L(`上次排查以后新增的定时脚本：${f}`, `New scheduled script since the last check: ${f}`), ack: { kind: 'cronjob', value: f } })
      }
    }
    for (const u of [...d.units, ...d.libUnits]) {
      const h = unitHash(u)
      if (has('units', h)) continue
      const hit = unitSuspicious(u.exec)
      if (hit) items.push({ id: `unit:${h}`, level: hit.level, text: susText(hit.kind, L(`自启服务 ${u.name}`, `Service ${u.name}`), unitCommands(u.exec).join('; ')), detail: u.file ?? `/etc/systemd/system/${u.name}`, ack: { kind: 'units', value: h } })
      else if (k.init && u.where === 'etc') items.push({ id: `unit:${h}`, level: 'warn', text: L(`上次排查以后新增或改过的自启服务：${u.name}`, `Service added or changed since the last check: ${u.name}`), detail: unitCommands(u.exec).join('\n'), ack: { kind: 'units', value: h } })
    }
    for (const x of d.sus) {
      const h = susHash(x)
      if (has('sus', h)) continue
      const hit = suspicious(x.line)
      if (!hit) continue
      const where = /^\/etc\/cron\./.test(x.file) ? L(`定时脚本 ${x.file}`, `Scheduled script ${x.file}`) : L(`登录时自动执行的 ${x.file}`, `${x.file}, run at login`)
      items.push({ id: `sus:${h}`, level: hit.level, text: susText(hit.kind, where, x.line), detail: `${x.file}:${x.lineNo}\n${x.line}`, ack: { kind: 'sus', value: h } })
    }
    if (k.init) {
      for (const x of d.sudo) {
        const h = hash(`${x.file}\n${x.line}`)
        if (!has('sudo', h)) items.push({ id: `sudo:${h}`, level: 'warn', text: L(`上次排查以后新增的免密 sudo：${short(x.line, 70)}`, `New passwordless sudo rule since the last check: ${short(x.line, 70)}`), detail: x.file, ack: { kind: 'sudo', value: h } })
      }
    }
    const known = d.keys.length - unknownKeys.length
    const detail = [
      d.keys.length ? L(`SSH 钥匙 ${d.keys.length} 把，认得 ${known} 把`, `${d.keys.length} SSH keys, ${known} confirmed`) : L('没找到 SSH 钥匙（或没有 root 看不到）', 'No SSH keys found (or no root to see them)'),
      L(`定时任务 ${d.cron.length} 行，定时脚本 ${d.cronJobs.length} 个，自建的自启服务 ${d.units.length} 个，能登录的账号 ${d.accounts.length} 个`, `${d.cron.length} cron lines, ${d.cronJobs.length} cron scripts, ${d.units.length} custom services, ${d.accounts.length} login accounts`),
      d.keyNoTool ? L('服务器上没有 ssh-keygen，钥匙认不出来', 'There is no ssh-keygen on the server, so keys could not be identified') : '',
      noRoot ? L('没有 root：别的账号的钥匙和定时任务看不到', 'No root: other accounts\' keys and scheduled tasks are not visible') : '',
    ].filter(Boolean).join('\n')
    group('backdoor', titles.backdoor, items, L('没有陌生钥匙、第二个 root、可疑的定时任务和自启服务', 'No unknown keys, no second root, no suspicious scheduled tasks or services'), { detail })
  }

  // 四、系统命令
  {
    const v = d.verify
    if (!v.tool) groups.push({ id: 'binaries', title: titles.binaries, level: 'na', text: L('这个系统核对不了（只支持 Debian/Ubuntu 和 RHEL 系）', 'Cannot verify on this system (Debian/Ubuntu and RHEL-family only)'), items: [] })
    else {
      const changed = v.bad.filter((b) => !b.conf && b.flags[2] === '5' && b.path)
      const items = changed.map((b) => {
        const core = /^\/(usr\/)?s?bin\//.test(b.path) || /\/security\/pam_/.test(b.path) || /\/(sshd|ld-linux[^/]*|libc\.so[^/]*)$/.test(b.path)
        return {
          id: `bin:${b.path}`, level: core ? 'danger' : 'warn',
          text: core ? L(`${base(b.path)} 和安装时不一样：系统命令可能被替换了（${b.path}）`, `${base(b.path)} differs from the installed package: a system command may have been replaced (${b.path})`)
            : L(`${b.path} 和安装时不一样`, `${b.path} differs from the installed package`),
          detail: `${b.pkg} · ${b.flags}`,
        }
      })
      const names = v.pkgs.slice(0, 6).join(' ')
      group('binaries', titles.binaries, items, L(`核对了 ${v.pkgs.length} 个关键软件包（ps、ss、ls、sshd 等），没有被替换`, `Verified ${v.pkgs.length} key packages (ps, ss, ls, sshd and more): nothing replaced`), { detail: `${v.tool === 'dpkg' ? 'dpkg -V' : 'rpm -V'}: ${names}${v.pkgs.length > 6 ? ' …' : ''}` })
    }
  }

  // 五、登录记录
  {
    if (d.logSource === 'none') groups.push({ id: 'logins', title: titles.logins, level: 'na', text: noRoot ? L('看不到登录日志（需要 root）', 'Login logs are not visible (needs root)') : L('找不到登录日志', 'No login logs found'), items: [] })
    else {
      const items = []
      const keyFps = new Set(d.keys.map((x) => x.fp))
      const pluginFps = new Set(d.keys.filter(isPluginKey).map((x) => x.fp))
      let total = 0
      for (const l of d.logins) {
        total += l.count
        if (l.method === 'publickey') {
          if (!l.fp || has('keys', l.fp) || pluginFps.has(l.fp) || keyFps.has(l.fp)) continue
          items.push({ id: `lkey:${l.fp}`, level: 'warn', text: L(`有一把现在已经不在服务器上的钥匙登录过：${l.user} 来自 ${l.ip}，${l.count} 次`, `A key that is no longer on the server logged in: ${l.user} from ${l.ip}, ${l.count} times`), detail: l.fp, ack: { kind: 'keys', value: l.fp } })
        } else {
          if (has('ips', l.ip)) continue
          const fails = d.fails[l.ip] ?? 0
          if (fails >= LIMIT.bruteFail) items.push({ id: `brute:${l.ip}:${l.user}`, level: 'danger', text: L(`${l.ip} 先试错 ${fails} 次密码，然后用 ${l.user} 登录成功了：很可能是被爆破进来的`, `${l.ip} failed ${fails} password attempts, then logged in as ${l.user}: very likely a brute-force break-in`), ack: { kind: 'ips', value: l.ip } })
          else items.push({ id: `pw:${l.ip}:${l.user}`, level: 'warn', text: L(`用密码登录成功过：${l.user} 来自 ${l.ip}（${l.count} 次）`, `Password login succeeded: ${l.user} from ${l.ip} (${l.count} times)`), ack: { kind: 'ips', value: l.ip } })
        }
      }
      const detail = [
        d.failTotal !== null ? L(`近 7 天登录失败 ${d.failTotal} 次，来自 ${d.failIps ?? 0} 个 IP`, `${d.failTotal} failed logins in 7 days from ${d.failIps ?? 0} IPs`) : '',
        ...d.logins.slice(0, 12).map((l) => `${l.method} · ${l.user} · ${l.ip} · ${l.count}${l.fp ? ` · ${l.fp.slice(0, 20)}…` : ''}`),
      ].filter(Boolean).join('\n')
      group('logins', titles.logins, items, total ? L(`近 7 天 ${total} 次登录都对得上你认得的钥匙和 IP`, `All ${total} logins in 7 days match keys and IPs you know`) : L('近 7 天没有登录记录', 'No logins in the last 7 days'), { detail })
    }
  }

  // 六、IP 名声
  {
    if (!d.ip || !d.blocklists.length) groups.push({ id: 'reputation', title: titles.reputation, level: 'na', text: d.ip ? L('这台查不了黑名单（没有 DNS 查询工具，或只有 IPv6）', 'Blocklists could not be checked (no DNS lookup tool, or IPv6 only)') : L('没查到这台的公网 IP', 'Could not find this server\'s public IP'), items: [] })
    else {
      const items = []
      let unknown = 0
      for (const b of d.blocklists) {
        const m = /^127\.0\.0\.(\d+)$/.exec(b.answer)
        if (!b.answer) continue
        if (!m) {
          unknown++
          continue
        }
        const code = Number(m[1])
        if (b.zone === 'zen.spamhaus.org') {
          if (code >= 4 && code <= 7) items.push({ id: 'xbl', level: 'danger', text: L('上了 Spamhaus XBL：这个 IP 被认定为被黑的机器（中了木马、被当成跳板）', 'Listed on Spamhaus XBL: this IP is recorded as a hijacked machine (malware, used as a relay)') })
          else if (code === 2 || code === 3 || code === 9) items.push({ id: 'sbl', level: 'warn', text: L('上了 Spamhaus SBL：这个 IP 发过垃圾邮件', 'Listed on Spamhaus SBL: this IP has sent spam') })
        } else if (b.zone === 'dnsbl.dronebl.org') {
          const [lv, zh, en] = DRONEBL[code] ?? ['warn', `类别 ${code}`, `category ${code}`]
          items.push({ id: 'dronebl', level: lv, text: L(`上了 DroneBL：被记为「${zh}」`, `Listed on DroneBL as "${en}"`) })
        } else if (b.zone === 'bl.blocklist.de') {
          items.push({ id: 'blde', level: 'danger', text: L('上了 blocklist.de：这个 IP 攻击过别人（多半是爆破 SSH）', 'Listed on blocklist.de: this IP has attacked others (usually SSH brute-forcing)') })
        }
      }
      // 只说真正查成了的名单：Spamhaus 常拒绝公共 DNS 的查询，查不了的不能算「不在上面」
      const ZONE_NAME = { 'zen.spamhaus.org': 'Spamhaus XBL', 'dnsbl.dronebl.org': 'DroneBL', 'bl.blocklist.de': 'blocklist.de' }
      const checked = d.blocklists.filter((b) => !b.answer || /^127\.0\.0\.\d+$/.test(b.answer)).map((b) => ZONE_NAME[b.zone] ?? b.zone)
      const zones = joinList(checked)
      const detail = [
        d.ip,
        items.length ? L('VPS 的 IP 会回收再分配，名声也可能是上一任用户留下的：其他几组都正常的话多半是这种情况，可以到名单网站申请移除', 'VPS IPs get reassigned, so this may be left over from a previous user: if everything else is fine that is the likely case, and you can request removal on the list\'s website') : '',
        unknown ? L(`有 ${unknown} 个名单这次查不了（这台用的 DNS 被名单拒绝了）`, `${unknown} lists could not be checked this time (the server's DNS resolver was refused)`) : '',
      ].filter(Boolean).join('\n')
      const allUnknown = unknown === d.blocklists.length
      if (allUnknown) groups.push({ id: 'reputation', title: titles.reputation, level: 'na', text: L('这次查不了黑名单（这台用的 DNS 被名单拒绝了）', 'Blocklists could not be checked this time (the server\'s DNS resolver was refused)'), items: [], detail })
      else group('reputation', titles.reputation, items, L(`不在被黑主机黑名单上（${zones}${unknown ? `；${unknown} 个名单这次查不了` : ''}）`, `Not on hijacked-host blocklists (${zones}${unknown ? `; ${unknown} could not be checked this time` : ''})`), { detail })
    }
  }

  // 七、常见入口
  {
    const items = []
    const open = (port) => d.listen.find((x) => x.port === port && !x.local)
    if (open(2375)) items.push({ id: 'docker', level: 'warn', text: L('Docker 远程接口（2375）对外开放：不加密也不要密码，谁连上谁就是 root。挖矿木马最常见的入口（服务商的防火墙挡住了就没事）', 'The Docker remote API (2375) is public: no encryption and no password, so anyone who connects is root. The most common way in for miners (fine if the provider\'s firewall blocks it)') })
    const redis = open(6379)
    if (redis && d.redisPing !== null && /NOAUTH/i.test(d.redisPing)) {
      // 设了密码：不算入口
    } else if (redis) {
      items.push({ id: 'redis', level: 'warn', text: d.redisPing === 'PONG'
        ? L('Redis（6379）对外开放且没设密码：常被用来写定时任务植入木马', 'Redis (6379) is public with no password: often used to plant malware through scheduled tasks')
        : L('Redis（6379）对外开放：确认设了密码，或只让本机访问', 'Redis (6379) is public: make sure it has a password, or only allow local access') })
    }
    group('entry', titles.entry, items, L('Docker 远程接口、Redis 没有对外开放', 'The Docker remote API and Redis are not public'))
  }
  return summarize(groups)
}

function summarize(groups) {
  const all = groups.flatMap((g) => g.items)
  const danger = all.filter((i) => i.level === 'danger').length
  const warn = all.filter((i) => i.level === 'warn').length
  const worst = danger ? 'danger' : warn ? 'warn' : groups.some((g) => g.level === 'ok') ? 'ok' : 'na'
  const headline = danger
    ? L(`发现 ${danger} 处入侵迹象`, `${danger} sign${danger > 1 ? 's' : ''} of intrusion found`)
    : warn
      ? L(`没发现明确的入侵迹象 · ${warn} 项要你确认`, `No clear signs of intrusion · ${warn} to confirm`)
      : worst === 'na' ? L('这次没查成', 'Not checked this time') : L('没发现入侵迹象', 'No signs of intrusion')
  return { groups, worst, headline, counts: { danger, warn } }
}

// —————————————————————— 跑一次、存本机 ——————————————————————

const dir = (alias, env) => join(dshHome(env), 'vps-manager', 'intrusion', alias)

export async function readIntrusionCache(alias, env = process.env) {
  try {
    return JSON.parse(await readFile(join(dir(alias, env), 'latest.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 本机记的「认得的」：钥匙指纹、IP、定时任务、自启服务、账号…… 没排查过是 null */
export async function readKnown(alias, env = process.env) {
  try {
    return JSON.parse(await readFile(join(dir(alias, env), 'known.json'), 'utf8'))
  } catch {
    return null
  }
}
async function writeKnown(alias, known, env) {
  await mkdir(dir(alias, env), { recursive: true })
  await atomicWrite(join(dir(alias, env), 'known.json'), JSON.stringify(known, null, 2))
}

const ACK_KINDS = ['keys', 'ips', 'cron', 'cronjob', 'units', 'accts', 'sudo', 'sus']

/** 用户点了「是我的」/「是我加的」：记进「认得的」 */
export async function ackIntrusion({ alias, kind, value, env = process.env }) {
  if (!ACK_KINDS.includes(kind)) throw new Error(L(`不认识的类别：${kind}`, `Unknown kind: ${kind}`))
  const v = String(value ?? '').trim()
  if (!v || v.length > 300) throw new Error(L('内容不对', 'Invalid value'))
  const known = (await readKnown(alias, env)) ?? { init: false }
  known[kind] = [...new Set([...(known[kind] ?? []), v])]
  await writeKnown(alias, known, env)
  return known
}

/** 排查一次：一次 SSH，只读。第一次排查时把定时任务、自启服务、账号记成「原本就有」 */
export async function runIntrusion({ alias, env = process.env, runner, now = Date.now }) {
  const hosts = await readHosts(env)
  if (!hosts.hosts?.[alias]) throw new Error(L(`没有登记过这台机器：${alias}`, `No such machine: ${alias}`))
  const res = await runRemote({ alias, body: INTRUSION_SCRIPT, mode: 'read', withPrelude: true, timeoutMs: 90_000, head: 512_000, env, runner })
  const data = !res.ok && res.status !== 'failed' ? { sshFailed: res.hint || res.status } : parseIntrusion(res.stdout)
  const record = { checkedAt: new Date(now()).toISOString(), data }
  await mkdir(dir(alias, env), { recursive: true })
  await atomicWrite(join(dir(alias, env), 'latest.json'), JSON.stringify(record, null, 2))
  if (!data.sshFailed) {
    const known = await readKnown(alias, env)
    if (!known?.init) {
      const first = baselineFrom(data)
      // 第一次排查之前就点过「是我的」（不太会，但别丢）：合进去
      for (const kind of ACK_KINDS) first[kind] = [...new Set([...(first[kind] ?? []), ...(known?.[kind] ?? [])])]
      await writeKnown(alias, first, env)
    }
  }
  return record
}

const MARK = { ok: '✓', warn: '!', danger: '✗', na: '?' }

/** 命令（/vps-intrusion）里给人看的纯文本：一组一行，有问题的项缩进列在下面 */
export function intrusionText(alias, record, judged) {
  const t = new Date(record.checkedAt)
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  const lines = [L(`[${alias}] 入侵排查 · ${hhmm} · ${judged.headline}`, `[${alias}] Compromise check · ${hhmm} · ${judged.headline}`), '']
  for (const g of judged.groups) {
    lines.push(`${MARK[g.level] ?? '?'} ${g.title}${L('：', ': ')}${g.text || L(`${g.items.length} 项`, `${g.items.length} items`)}`)
    for (const i of g.items.slice(0, 8)) lines.push(`    ${MARK[i.level] ?? '?'} ${i.text}`)
    if (g.items.length > 8) lines.push(L(`    还有 ${g.items.length - 8} 项`, `    ${g.items.length - 8} more`))
  }
  lines.push('', L(
    '没发现迹象不等于保证干净：内核级的 rootkit 能骗过在机器上运行的任何检查。要确认「是我的」、看细节，到状态页的「入侵排查」卡片',
    'No signs does not guarantee a clean machine: a kernel rootkit can fool any check run on the machine itself. To confirm items as yours and see details, use the Compromise check card on the Status tab',
  ))
  return lines.join('\n')
}
