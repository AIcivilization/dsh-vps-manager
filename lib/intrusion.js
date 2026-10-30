// lib/intrusion.js — 状态页的「入侵排查」卡片：这台有没有被人控制（俗称肉鸡）
//
// 设计见 工作流/dsh-vps-manager-入侵排查设计.md。现有的「安全」卡只管预防（门锁好没有），
// 这里查的是「有没有人已经进来了」。两层：
//   1. 轻量检查（IOC_SCAN）：进状态采集脚本，每次刷新都跑，不到 1 秒，只查几乎不会误报的进程迹象
//      和 /etc/ld.so.preload。发现了进「需注意」、机器编号亮红点
//   2. 完整排查（INTRUSION_SCRIPT）：用户点了才跑，10～40 秒。可疑进程（含长时间占满 CPU 的）、
//      对外乱连（含发垃圾邮件、连恶意 IP 名单上的地址）、后门（钥匙、定时任务、自启服务、PAM、新开的端口、
//      防清理和抹痕迹）、系统命令被替换和藏起来的内核模块、登录记录（含此刻谁在线）、IP 名声、常见入口
// 全部只读，不装东西，零 token（恶意 IP 名单由服务器自己下载、用完就删）。判断全用规则；
// 存本机的是原始结果，结论按界面语言现拼。
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
// 自由文本（命令行、定时任务那一行）都放在一行的最后一段，解析时只按前几个 | 切。
// 临时目录 $IT 只放下载的恶意 IP 名单和要对照的地址，退出时删掉
export const INTRUSION_SCRIPT = String.raw`
T() { if has_cmd timeout; then timeout 20 "$@"; else "$@"; fi; }
if [ "$SUDO" = "__NO_PRIV__" ]; then printf 'priv=none\n'; elif [ -z "$SUDO" ]; then printf 'priv=root\n'; else printf 'priv=sudo\n'; fi
SUS='` + SUS_GREP + String.raw`'

# —— 恶意 IP 名单：一开头就在后台下载，和下面的检查同时进行，最后拿来对照这台在连的地址、登录来源 ——
#   feodo    abuse.ch Feodo Tracker：僵尸网络控制服务器
#   c2intel  C2IntelFeeds：近 30 天发现的控制服务器
#   ipsum    IPsum：至少 3 份公开黑名单都记过的地址（扫描、爆破、攻击别人）
IT=$(mktemp -d 2>/dev/null) || IT=/tmp/dsh-vps-intr-$$
mkdir -p "$IT"
trap 'rm -rf "$IT"' EXIT
getlist() { if has_cmd curl; then curl -fsSL -m 25 -o "$IT/$1" "$2" 2>/dev/null; elif has_cmd wget; then wget -q -T 25 -O "$IT/$1" "$2" 2>/dev/null; fi; }
getlist feodo https://feodotracker.abuse.ch/downloads/ipblocklist.txt &
getlist c2intel https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv &
getlist ipsum https://raw.githubusercontent.com/stamparm/ipsum/master/levels/3.txt &

# —— 一、可疑进程 ——
` + IOC_SCAN + String.raw`
# 长时间占满 CPU 的程序：改了名的挖矿程序靠名字认不出来，但它一直占着 CPU。
# 跑了半小时以上、平均占满一个核八成以上的才算。一行：cpu=PID|平均占用%|已跑秒数|程序文件|命令行
ps -eo pid=,etimes=,time=,args= 2>/dev/null | awk '
  $4 ~ /^\[/ { next }
  {
    n = split($3, a, "-"); d = (n > 1) ? a[1] : 0; split(a[n], t, ":"); s = d * 86400 + t[1] * 3600 + t[2] * 60 + t[3]
    if ($2 >= 1800 && s >= $2 * 0.8) { x = $0; sub(/^ *[0-9]+ +[0-9]+ +[^ ]+ +/, "", x); gsub(/\|/, "/", x); printf "%s|%d|%d|%s\n", $1, int(s * 100 / $2), $2, substr(x, 1, 160) }
  }' | head -10 | while IFS='|' read -r pid pct et args; do
  printf 'cpu=%s|%s|%s|%s|%s\n' "$pid" "$pct" "$et" "$($SUDO_OPT readlink "/proc/$pid/exe" 2>/dev/null | tr '|' '/')" "$args"
done

# —— 二、对外连接：按程序汇总。本机在监听的端口上进来的连接不算（那是别人连我们）。
#    对方地址同时记进 $IT/cand（P|地址|端口|程序），最后和恶意 IP 名单对照 ——
if has_cmd ss; then
  printf 'ss=1\n'
  $SUDO_OPT ss -tanpH 2>/dev/null | awk -v cand="$IT/cand" '
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
        if (!((k SUBSEP h) in seen)) { seen[k SUBSEP h] = 1; out[k]++; printf "P|%s|%s|%s\n", h, PP[i], k >> cand }
        if (S[i] == "SYN-SENT" && !((k SUBSEP h) in sseen)) { sseen[k SUBSEP h] = 1; syn[k]++ }
        if (PP[i] == "22" && !((k SUBSEP h) in hseen)) { hseen[k SUBSEP h] = 1; ssh[k]++ }
        if (PP[i] ~ /^(25|465|587)$/ && !((k SUBSEP h) in mseen)) { mseen[k SUBSEP h] = 1; smtp[k]++ }
        if (PP[i] ~ /^(3333|4444|5555|7777|14433|14444|45560|45700)$/) { pool[k]++; pe[k] = h ":" PP[i] }
      }
      for (k in names) printf "conn=%s|%d|%d|%d|%d|%d|%s\n", k, out[k], syn[k], ssh[k], smtp[k], pool[k], pe[k]
    }' | sort -t'|' -k2 -rn | head -25
  $SUDO_OPT ss -ltnpH 2>/dev/null | awk '{ p = ""; if (match($0, /users:\(\("[^"]+"/)) p = substr($0, RSTART + 9, RLENGTH - 10); print "listen=" $4 "|" p }' | head -60
fi
if has_cmd redis-cli; then printf 'redis_ping=%s\n' "$(T redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | head -n 1)"; fi

# —— 三、后门：账号、钥匙、定时任务、自启服务、登录时自动执行的脚本、免密 sudo ——
awk -F: '$3 == 0 && $1 != "root" { print "uid0=" $1 } $7 !~ /(nologin|false|sync|shutdown|halt)$/ { print "acct=" $1 "|" $3 "|" $7 }' /etc/passwd 2>/dev/null | head -60
homes=$(awk -F: '$7 !~ /(nologin|false|sync|shutdown|halt)$/ || $1 == "root" { print $1 ":" $6 }' /etc/passwd 2>/dev/null | head -60)
# sshd 去哪找钥匙：配置能指到家目录以外的文件（%h 家目录、%u 用户名），后门常藏在那里；
# 还能配成运行一个程序取钥匙（AuthorizedKeysCommand），那样的钥匙不在任何文件里
sshd_bin=$(command -v sshd 2>/dev/null); [ -n "$sshd_bin" ] || sshd_bin=/usr/sbin/sshd
sshd_t=$($SUDO_OPT "$sshd_bin" -T 2>/dev/null)
akf=$(printf '%s\n' "$sshd_t" | awk '$1 == "authorizedkeysfile" { $1 = ""; print; exit }')
printf '%s\n' "$sshd_t" | awk '$1 == "authorizedkeyscommand" && $2 != "none" { $1 = ""; sub(/^ +/, ""); print "akc=" substr($0, 1, 300); exit }'
printf '%s\n' "$homes" | while IFS=: read -r u h; do
  [ -n "$h" ] || continue
  for f in $(printf '%s\n' $akf .ssh/authorized_keys .ssh/authorized_keys2 | awk -v h="$h" -v u="$u" '$0 != "none" && $0 != "" { gsub(/%h/, h); gsub(/%u/, u); gsub(/%%/, "%"); if ($0 !~ /^\//) $0 = h "/" $0; if (!s[$0]++) print }'); do
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
for f in /etc/crontab /etc/cron.d/* $($SUDO_OPT find /var/spool/cron -type f ! -path '*/atjobs/*' ! -path '*/atspool/*' ! -name .SEQ 2>/dev/null | head -50); do
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
# 普通用户自己的自启服务（不需要 root 就能放，没有 root 的木马常用）
for f in /etc/systemd/user/*.service $(printf '%s\n' "$homes" | while IFS=: read -r u h; do [ -n "$h" ] && printf '%s\n' "$h"/.config/systemd/user/*.service; done | sort -u); do
  $SUDO_OPT test -f "$f" 2>/dev/null || continue
  $SUDO_OPT test -L "$f" 2>/dev/null && continue
  printf 'uunit=%s|%s\n' "$f" "$($SUDO_OPT grep -E '^[[:space:]]*Exec(Start|StartPre|StartPost)=' "$f" 2>/dev/null | head -3 | tr '\n' ';' | cut -c1-400)"
done | head -30
rcfiles=$(printf '%s\n' "$homes" | while IFS=: read -r u h; do
  [ -n "$h" ] && for x in .bashrc .profile .bash_profile .bash_login .zshrc; do printf '%s\n' "$h/$x"; done
done | sort -u)
# 可疑写法：登录时执行的脚本、定时脚本，再加几个木马爱藏的地方：每次 SSH 登录都以 root 运行的
# /etc/update-motd.d、自启服务的附加配置（能改掉 sshd 这类正常服务的启动命令）、一次性定时任务（at）、
# 老式开机脚本 /etc/init.d（文件多、正常内容也长，放最后）
for f in /etc/rc.local /etc/profile /etc/profile.d/* /etc/bash.bashrc /etc/environment /etc/cron.hourly/* /etc/cron.daily/* /etc/cron.weekly/* /etc/cron.monthly/* $rcfiles /etc/update-motd.d/* /etc/systemd/system/*.d/*.conf $($SUDO_OPT find /var/spool/cron/atjobs /var/spool/at -type f 2>/dev/null | head -20) /etc/init.d/*; do
  $SUDO_OPT test -f "$f" 2>/dev/null || continue
  $SUDO_OPT grep -HnE "$SUS" "$f" 2>/dev/null | head -10 | cut -c1-400 | sed 's/^/sus=/'
done | head -60
# 登录时运行的程序（pam_exec，加 expose_authtok 就能拿到明文密码）、不在系统目录里的登录模块
for f in /etc/pam.d/*; do
  [ -f "$f" ] || continue
  $SUDO_OPT grep -HnE '^[^#]*(pam_exec|[[:space:]]/[^[:space:]]*[.]so)' "$f" 2>/dev/null | head -5 | cut -c1-300 | sed 's/^/pam=/'
done | head -20
# 防清理：用 chattr +i 锁住钥匙、账号、定时任务文件（连 root 都删不掉），挖矿木马常这样
if has_cmd lsattr; then
  for f in /etc/passwd /etc/shadow /etc/group /etc/sudoers /etc/crontab /etc/ld.so.preload /etc/rc.local /etc/ssh/sshd_config /etc/cron.d/* $($SUDO_OPT find /var/spool/cron -type f ! -path '*/atjobs/*' ! -path '*/atspool/*' ! -name .SEQ 2>/dev/null | head -50) $(printf '%s\n' "$homes" | while IFS=: read -r u h; do [ -n "$h" ] && printf '%s\n' "$h/.ssh" "$h/.ssh/authorized_keys"; done | sort -u); do
    $SUDO_OPT test -e "$f" 2>/dev/null || continue
    $SUDO_OPT lsattr -d "$f" 2>/dev/null
  done | awk '$1 ~ /i/ { x = $0; sub(/^[^ ]+ +/, "", x); print "immut=" x }' | head -20
fi
# 抹掉痕迹：操作记录文件被指向 /dev/null，或登录脚本里关掉了记录
printf '%s\n' "$homes" | while IFS=: read -r u h; do
  [ -n "$h" ] || continue
  for x in .bash_history .zsh_history .sh_history .history; do
    [ "$($SUDO_OPT readlink "$h/$x" 2>/dev/null)" = /dev/null ] && printf 'histnull=%s\n' "$h/$x"
  done
done | sort -u | head -10
for f in /etc/profile /etc/profile.d/* /etc/bash.bashrc /etc/environment $rcfiles; do
  $SUDO_OPT test -f "$f" 2>/dev/null || continue
  $SUDO_OPT grep -HnE '^[^#]*(HISTFILE=/dev/null|unset[[:space:]]+HISTFILE|HISTSIZE=0|HISTFILESIZE=0)' "$f" 2>/dev/null | head -3 | cut -c1-300 | sed 's/^/hist=/'
done | head -10
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
# 内核：rootkit 模块能把自己从模块列表里删掉，但内核「加载过外来模块」的标记（taint 里的 O、E 两位）去不掉。
# 容器型 VPS（LXC、OpenVZ）看到的是宿主机的内核，这项不算
printf 'taint=%s\n' "$(cat /proc/sys/kernel/tainted 2>/dev/null)"
printf 'boot=%s\n' "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
if has_cmd systemd-detect-virt; then printf 'virt=%s\n' "$(systemd-detect-virt -c 2>/dev/null)"
elif [ -f /.dockerenv ] || [ -d /proc/vz ] || grep -qa 'container=' /proc/1/environ 2>/dev/null; then printf 'virt=container\n'
fi
for m in /sys/module/*/taint; do
  t=$(cat "$m" 2>/dev/null)
  [ -n "$t" ] && printf 'tmod=%s|%s\n' "$(basename "$(dirname "$m")")" "$t"
done | head -30

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
[ "$src" != none ] && login_log | awk -v cand="$IT/cand" '
  { t = ($1 ~ /^[0-9]+\.[0-9]+$/) ? int($1) : "" }
  / Accepted [a-z\/-]+ for / {
    m = $0; sub(/.* Accepted /, "", m); split(m, w, " ")
    fp = ""; if (match(m, /SHA256:[A-Za-z0-9+\/=]+/)) fp = substr(m, RSTART, RLENGTH)
    k = w[1] "|" w[3] "|" w[5] "|" fp; c[k]++; if (t != "") last[k] = t; acc[w[5]] = 1; next }
  / Failed (password|keyboard-interactive)/ {
    if (match($0, / from [0-9a-fA-F:.]+/)) { ip = substr($0, RSTART + 6, RLENGTH - 6); f[ip]++; tot++ } }
  END {
    for (k in c) printf "login=%s|%d|%s\n", k, c[k], last[k]
    for (ip in acc) { print "L|" ip >> cand; if (f[ip]) printf "fail=%s|%d\n", ip, f[ip] }
    n = 0; for (ip in f) n++
    printf "fail_total=%d\nfail_ips=%d\n", tot, n
  }' | head -80
# 此刻谁登录在上面（有终端的会话）。me= 是插件这次连进来用的地址，就是用户自己
if has_cmd who; then
  who 2>/dev/null | head -20 | awk -v cand="$IT/cand" '{
    h = ""; if (match($0, /\([^()]*\)[[:space:]]*$/)) { h = substr($0, RSTART + 1); sub(/\)[[:space:]]*$/, "", h) }
    print "online=" $1 "|" $2 "|" h; if (h ~ /^[0-9a-fA-F:.]+$/) print "O|" h >> cand
  }'
fi
printf '%s\n' "$SSH_CONNECTION" | awk 'NF { print "me=" $1 }'

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

# —— 七、对照恶意 IP 名单：这台正在连的地址（P）、近 7 天登录成功的来源（L）、此刻在线的来源（O）。
#    一行：intel=P/L/O|在哪几份名单上|地址|端口|名单里的说明|程序 ——
wait
set --
for x in feodo c2intel ipsum; do
  n=0; [ -s "$IT/$x" ] && n=$(grep -c '^[0-9]' "$IT/$x" 2>/dev/null)
  printf 'intel_list=%s|%s\n' "$x" "$n"
  [ "$n" -gt 0 ] 2>/dev/null && set -- "$@" "$IT/$x"
done
if [ $# -gt 0 ] && [ -s "$IT/cand" ]; then
  awk -F'|' '
    FILENAME ~ /\/(feodo|ipsum)$/ { if ($0 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/) { split($0, a, /[ \t\r]/); l = FILENAME; sub(/.*\//, "", l); b[a[1]] = b[a[1]] l "," } next }
    FILENAME ~ /\/c2intel$/ { if ($0 ~ /^[0-9]+\./) { split($0, a, ","); sub(/\r$/, "", a[2]); b[a[1]] = b[a[1]] "c2intel,"; fam[a[1]] = a[2] } next }
    ($2 in b) && !(($1 SUBSEP $2 SUBSEP $4) in seen) { seen[$1 SUBSEP $2 SUBSEP $4] = 1; printf "intel=%s|%s|%s|%s|%s|%s\n", $1, b[$2], $2, $3, substr(fam[$2], 1, 80), $4 }
  ' "$@" "$IT/cand" | head -40
fi
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

const LISTS = ['ioc', 'cpu', 'conn', 'listen', 'uid0', 'acct', 'key', 'key_notool', 'cron', 'cronjob', 'unit', 'uunit', 'susunit', 'sus', 'pam', 'immut', 'histnull', 'hist', 'sudo', 'vpkg', 'vbad', 'tmod', 'login', 'fail', 'online', 'bl', 'intel', 'intel_list']

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
    cpu: lists.cpu.map((v) => {
      const [pid, pct, secs, exe, args] = cut(v, 4)
      return { pid: int(pid), pct: int(pct), secs: int(secs), exe, args }
    }).filter((p) => p.pid),
    preload: kv.preload?.trim() || null,
    ss: kv.ss === '1',
    conns: lists.conn.map((v) => {
      const [name, out, syn, ssh, smtp, pool, poolPeer] = cut(v, 6)
      return { name, out: int(out), syn: int(syn), ssh: int(ssh), smtp: int(smtp), pool: int(pool), poolPeer }
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
    keyCommand: kv.akc?.trim() || null,
    cron: lists.cron.map((v) => {
      const [file, line] = cut(v, 1)
      return { file, line }
    }),
    cronJobs: lists.cronjob,
    units: [
      ...lists.unit.map((v) => {
        const [name, exec] = cut(v, 1)
        return { name, exec, where: 'etc' }
      }),
      // 普通用户自己的自启服务：name 用完整路径，不和系统的同名服务混
      ...lists.uunit.map((v) => {
        const [file, exec] = cut(v, 1)
        return { name: file, file, exec, where: 'user' }
      }),
    ],
    libUnits: lists.susunit.map((v) => {
      // grep -H：文件:Exec 那一行
      const i = v.indexOf(':')
      const file = v.slice(0, i)
      return { name: file.split('/').pop(), file, exec: v.slice(i + 1), where: 'lib' }
    }),
    sus: lists.sus.map(susLine).filter(Boolean),
    pam: lists.pam.map(susLine).filter(Boolean),
    immutable: lists.immut,
    histNull: lists.histnull,
    histOff: lists.hist.map(susLine).filter(Boolean),
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
    taint: kv.taint === undefined || kv.taint.trim() === '' ? null : int(kv.taint),
    bootId: kv.boot?.trim() || null,
    container: Boolean(kv.virt?.trim() && kv.virt.trim() !== 'none'),
    modules: lists.tmod.map((v) => {
      const [name, flags] = cut(v, 1)
      return { name, flags: flags.trim() }
    }),
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
    online: lists.online.map((v) => {
      const [user, tty, from] = cut(v, 2)
      return { user, tty, from: from.trim() }
    }),
    me: kv.me?.trim() || null,
    ip: kv.ip?.trim() || null,
    blocklists: lists.bl.map((v) => {
      const [zone, answer] = cut(v, 1)
      return { zone, answer: answer.trim().replace(/^::ffff:/i, '') }
    }),
    // 恶意 IP 名单：每份下载到几条（0 = 没下载成功）；对上了的地址
    intelLists: lists.intel_list.length ? Object.fromEntries(lists.intel_list.map((v) => {
      const [name, n] = cut(v, 1)
      return [name, int(n)]
    })) : null,
    intel: lists.intel.map((v) => {
      const [kind, on, ip, port, note, name] = cut(v, 5)
      return { kind: { P: 'conn', L: 'login', O: 'online' }[kind] ?? kind, lists: [...new Set(on.split(',').filter(Boolean))], ip, port: int(port) || null, note: note.trim(), name }
    }).filter((x) => x.ip),
  }
}

// —————————————————————— 规则 ——————————————————————

/** 本来就会连很多地址的程序：代理、tor、P2P、DNS、发邮件、反向代理（进程名最长 15 个字符，按前缀认） */
export const FANOUT_OK = /^(sing-box|xray|v2ray|trojan|hysteria|hy2|tuic|naive|juicity|shadow-tls|caddy|ss-|ssserver|sslocal|shadowsocks|snell|brook|gost|mihomo|clash|realm|haproxy|nginx|envoy|traefik|tor$|i2pd|yggdrasil|squid|3proxy|tinyproxy|privoxy|danted|sockd|wireproxy|warp|cloudflared|frp|nps$|npc$|socat|docker-proxy|openvpn|ocserv|x-ui|sshd|unbound|named|dnsmasq|coredns|smartdns|adguardhome|dnsproxy|smtp|postfix|exim|sendmail|master$|qbittorrent|transmission|aria2c|deluged|rtorrent|ipfs|kubo|syncthing|bitcoind|monerod|geth|nezha)/i
/** 本来就是连别人 22 端口的程序 */
const SSH_CLIENT = /^(ssh|scp|sftp|rsync|autossh|mosh|git|ansible|sshpass)/i
const LIMIT = { scanSyn: 20, sshOut: 5, smtpOut: 5, bruteFail: 10 }
/** 恶意 IP 名单：前两份是僵尸网络的控制服务器（连上了就是红），IPsum 是攻击过别人的地址（黄） */
const C2_LISTS = ['feodo', 'c2intel']
const LIST_NAME = { feodo: 'Feodo Tracker', c2intel: 'C2IntelFeeds', ipsum: 'IPsum' }
/** 已知的内核 rootkit 模块名（开源、被大量批量入侵用过的那些） */
const ROOTKIT_MODS = /^(diamorphine|reptile|reptile_module|suterusu|adore|adore_ng|kovid|rkduck|nuk3gh0st|puszek|kbeast|enyelkm|knark|sutekh|singularity|caraxes|vlany)$/i

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
  if (/(^|[;&|(]\s*|\b(?:(?:ba|da|z)?sh(?:\s+-c)?|nohup|exec|setsid|chmod\s+[+0-7a-z]+)\s+["']?)(?:\.\/)?\/(?:tmp|var\/tmp|dev\/shm)\/(?!go-build)\S+/.test(s) || /\bcd\s+\/(tmp|var\/tmp|dev\/shm)\b[^#]*(&&|;)\s*\.\//.test(s)) return { kind: 'tmpexec', level: 'danger' }
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

/** 对外开放的端口（只在本机能连的不算），同一个端口 IPv4、IPv6 各一行的合成一个 */
function publicPorts(listen) {
  const seen = new Map()
  for (const x of listen ?? []) if (!x.local && x.port && !seen.has(x.port)) seen.set(x.port, x)
  return [...seen.values()]
}

/**
 * 「认得的」的版本。2：加了端口、普通用户的自启服务。老版本排查过的机器第一次用新版排查时，
 * 新加的这两类也当成「原本就有」，不然升级后会把所有端口都报成「新开的」
 */
const BASELINE_REV = 2

/** 第一次排查时，定时任务、自启服务、账号、免密 sudo、对外端口直接当成「原本就有」；钥匙要用户自己确认 */
export function baselineFrom(data) {
  return {
    init: true,
    rev: BASELINE_REV,
    keys: [],
    ips: [],
    cron: data.cron.filter((c) => !suspicious(cronCommand(c.file, c.line))).map(cronHash),
    cronjob: [...data.cronJobs],
    units: data.units.filter((u) => !unitSuspicious(u.exec)).map(unitHash),
    accts: data.accounts.map((a) => a.name),
    sudo: data.sudo.map((x) => hash(`${x.file}\n${x.line}`)),
    ports: publicPorts(data.listen).map((x) => String(x.port)),
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
/** 跑了多久：45 分钟、3 小时、2 天 */
const span = (sec) => {
  if (sec >= 2 * 86400) return L(`${Math.floor(sec / 86400)} 天`, `${Math.floor(sec / 86400)} days`)
  if (sec >= 3600) return L(`${Math.floor(sec / 3600)} 小时`, `${Math.floor(sec / 3600)} h`)
  return L(`${Math.floor(sec / 60)} 分钟`, `${Math.floor(sec / 60)} min`)
}
const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:.]*)$/i

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

/** 可疑写法出现在哪：按文件位置说成人话 */
function susWhere(file) {
  if (/^\/etc\/cron\./.test(file)) return L(`定时脚本 ${file}`, `Scheduled script ${file}`)
  if (/^\/etc\/update-motd\.d\//.test(file)) return L(`每次 SSH 登录都以 root 运行的 ${file}`, `${file}, run as root at every SSH login`)
  if (/^\/etc\/systemd\//.test(file)) return L(`自启服务的附加配置 ${file}`, `Service override ${file}`)
  if (/^\/var\/spool\/(cron\/atjobs|at)\//.test(file)) return L(`一次性定时任务 ${file}`, `One-off scheduled job ${file}`)
  if (/^\/etc\/init\.d\//.test(file)) return L(`开机脚本 ${file}`, `Boot script ${file}`)
  return L(`登录时自动执行的 ${file}`, `${file}, run at login`)
}

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
  const k = { keys: [], ips: [], cron: [], cronjob: [], units: [], accts: [], sudo: [], sus: [], cpu: [], ...(known ?? {}) }
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
    binaries: L('系统命令和内核', 'System commands & kernel'),
    logins: L('登录记录', 'Logins'),
    reputation: L('IP 名声', 'IP reputation'),
    entry: L('常见入口', 'Common entry points'),
  }
  // 老版本存下的结果没有后来加的几项
  const d = { cpu: [], intel: [], online: [], pam: [], immutable: [], histNull: [], histOff: [], modules: [], ...(data ?? {}) }
  if (d.sshFailed) {
    for (const id of Object.keys(titles)) groups.push({ id, title: titles[id], level: 'na', text: L(`连不上服务器，这次没查：${d.sshFailed}`, `Could not reach the server, so this was not checked: ${d.sshFailed}`), items: [] })
    return summarize(groups)
  }
  const noRoot = d.priv === 'none'

  // 一、可疑进程
  {
    const items = d.procs.map((p, i) => ({ id: `proc:${p.pid}:${i}`, ...procText(p), detail: [p.path, p.args].filter(Boolean).join('\n') }))
    // 长时间占满 CPU：改了名的挖矿程序。是用户自己的程序（编译、转码、tor 中继……）点「是我的」，按程序文件记
    const flagged = new Set(d.procs.map((p) => p.pid))
    for (const p of d.cpu) {
      const exe = p.exe.replace(/ \(deleted\)$/, '')
      const id = exe || p.args.split(' ')[0]
      if (flagged.has(p.pid) || !id || has('cpu', id)) continue
      const name = base(exe) || short(p.args, 40)
      items.push({ id: `cpu:${p.pid}`, level: 'warn', text: L(`${name} 一直占满 CPU：平均 ${p.pct}%，已经跑了 ${span(p.secs)}（PID ${p.pid}）。改了名的挖矿程序就是这样`, `${name} keeps the CPU busy: ${p.pct}% on average for ${span(p.secs)} (PID ${p.pid}). Renamed miners look like this`), detail: [p.exe, p.args].filter(Boolean).join('\n'), ack: { kind: 'cpu', value: id } })
    }
    group('procs', titles.procs, items,
      noRoot ? L('没发现（没有 root，只看了自己账号的进程）', 'None found (no root, so only this account\'s processes were checked)') : L('没有挖矿、藏在临时目录、冒充系统或一直占满 CPU 的程序', 'No miners, nothing hiding in temporary directories, posing as the system or hogging the CPU'))
  }

  // 二、对外连接
  {
    const items = []
    for (const c of d.conns) {
      if (FANOUT_OK.test(c.name)) continue
      const name = c.name === '?' ? L('某个程序（没有 root 看不到名字）', 'an unknown program (needs root to see the name)') : c.name
      if (c.syn >= LIMIT.scanSyn) items.push({ id: `scan:${c.name}`, level: 'danger', text: L(`${name} 正在同时向 ${c.syn} 个地址发起连接：像在扫描别人`, `${name} is opening connections to ${c.syn} addresses at once, like a scanner`) })
      if (c.ssh >= LIMIT.sshOut && !SSH_CLIENT.test(c.name)) items.push({ id: `brute:${c.name}`, level: 'danger', text: L(`${name} 连着 ${c.ssh} 台机器的 22 端口：像在爆破别人的 SSH`, `${name} is connected to port 22 on ${c.ssh} machines, like an SSH brute-forcer`) })
      if ((c.smtp ?? 0) >= LIMIT.smtpOut) items.push({ id: `smtp:${c.name}`, level: 'danger', text: L(`${name} 正在往 ${c.smtp} 个地址的邮件端口（25、465、587）发连接：像在发垃圾邮件`, `${name} is connecting to mail ports (25, 465, 587) on ${c.smtp} addresses, like a spam bot`) })
      if (c.pool > 0) items.push({ id: `pool:${c.name}`, level: 'warn', text: L(`${name} 连着常见的矿池端口（${c.poolPeer}）`, `${name} is connected to a common mining-pool port (${c.poolPeer})`) })
    }
    // 正在连恶意 IP 名单上的地址。代理、tor 连到的多半是用它们的人自己访问的，只记在详细数据里
    const viaProxy = new Map()
    for (const x of d.intel.filter((i) => i.kind === 'conn')) {
      if (FANOUT_OK.test(x.name)) {
        viaProxy.set(x.name, (viaProxy.get(x.name) ?? 0) + 1)
        continue
      }
      const name = !x.name || x.name === '?' ? L('某个程序', 'A program') : x.name
      const where = `${x.ip}${x.port ? `:${x.port}` : ''}`
      const c2 = x.lists.filter((l) => C2_LISTS.includes(l))
      if (c2.length) items.push({ id: `c2:${x.ip}:${x.name}`, level: 'danger', text: L(`${name} 正在连一个僵尸网络控制服务器：${where}（${joinList(c2.map((l) => LIST_NAME[l]))} 名单）`, `${name} is connected to a botnet control server: ${where} (${joinList(c2.map((l) => LIST_NAME[l]))})`), detail: [where, x.note].filter(Boolean).join(' · ') })
      else items.push({ id: `bad:${x.ip}:${x.name}`, level: 'warn', text: L(`${name} 正在连一个攻击过别人的地址：${where}（至少 3 份公开黑名单记过它）`, `${name} is connected to an address known for attacking others: ${where} (on at least 3 public blocklists)`), detail: `${where} · IPsum` })
    }
    const lists = d.intelLists ? Object.entries(d.intelLists).filter(([, n]) => n > 0) : []
    const top = d.conns.filter((c) => c.out > 0).slice(0, 6).map((c) => L(`${c.name} ${c.out} 个地址`, `${c.name} ${c.out} addresses`))
    const detail = [
      top.length ? L(`对外连接最多的：${joinList(top)}`, `Most outbound connections: ${joinList(top)}`) : '',
      L('代理、tor、P2P、DNS、发邮件的程序本来就会连很多地址，不算', 'Proxies, tor, P2P, DNS and mail programs connect to many addresses by design and are not counted'),
      lists.length ? L(`对照了恶意 IP 名单：${joinList(lists.map(([l, n]) => `${LIST_NAME[l] ?? l} ${n} 条`))}`, `Checked against malicious-IP lists: ${joinList(lists.map(([l, n]) => `${LIST_NAME[l] ?? l} (${n})`))}`)
        : d.intelLists ? L('恶意 IP 名单这次没下载成功（服务器连不上 GitHub、abuse.ch）', 'The malicious-IP lists could not be downloaded this time (the server cannot reach GitHub or abuse.ch)') : '',
      viaProxy.size ? L(`代理等程序连到了名单上的地址，多半是用代理的人自己访问的：${joinList([...viaProxy].map(([n, c]) => `${n} ${c} 个`))}`, `Proxy-type programs reached listed addresses, most likely on behalf of their users: ${joinList([...viaProxy].map(([n, c]) => `${n} (${c})`))}`) : '',
      d.listen.some((x) => /docker/.test(x.proc)) ? L('Docker 容器里的连接在主机上看不到（容器里的进程上面照样查了）', 'Connections inside Docker containers are not visible from the host (their processes are still checked above)') : '',
    ].filter(Boolean).join('\n')
    const okText = lists.length
      ? L('没有扫描、爆破别人、连矿池或发垃圾邮件，也没连已知的恶意地址（代理、tor 的连接不算）', 'No scanning, brute-forcing, mining pools or spam, and no known malicious addresses (proxy and tor connections are not counted)')
      : L('没有扫描、爆破别人、连矿池或发垃圾邮件（代理、tor 的连接不算）', 'No scanning, brute-forcing, mining pools or spam (proxy and tor connections are not counted)')
    if (!d.ss) groups.push({ id: 'net', title: titles.net, level: 'na', text: L('服务器上没有 ss，看不了', 'There is no ss on the server, so this could not be checked'), items: [] })
    else group('net', titles.net, items, okText, { detail })
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
      // 不在家目录 .ssh 里的：sshd 配置指过去的地方，后门爱藏这里
      const when = (key.mtime ? L(`，文件 ${day(key.mtime)}改过`, `, file changed ${day(key.mtime)}`) : '') + (/\/\.ssh\//.test(key.file) ? '' : L(`，放在 ${key.file}`, `, stored in ${key.file}`))
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
      else if (k.init && u.where === 'user') items.push({ id: `unit:${h}`, level: 'warn', text: L(`上次排查以后新增或改过的用户自启服务：${u.file}`, `User service added or changed since the last check: ${u.file}`), detail: unitCommands(u.exec).join('\n'), ack: { kind: 'units', value: h } })
    }
    for (const x of d.sus) {
      const h = susHash(x)
      if (has('sus', h)) continue
      const hit = suspicious(x.line)
      if (!hit) continue
      items.push({ id: `sus:${h}`, level: hit.level, text: susText(hit.kind, susWhere(x.file), x.line), detail: `${x.file}:${x.lineNo}\n${x.line}`, ack: { kind: 'sus', value: h } })
    }
    // sshd 运行一个程序取钥匙：那样放的钥匙不在文件里，上面的钥匙检查看不到
    if (d.keyCommand && !has('sus', hash(`akc\n${d.keyCommand}`))) items.push({ id: 'akc', level: 'warn', text: L(`sshd 还会运行一个程序来取登录钥匙：${short(d.keyCommand, 70)}。这样放的钥匙不在文件里，这里看不到（AWS、Google Cloud 的系统镜像自带这一项）`, `sshd also runs a program to fetch login keys: ${short(d.keyCommand, 70)}. Keys supplied this way are not in any file, so they cannot be checked here (AWS and Google Cloud images set this up)`), detail: `AuthorizedKeysCommand ${d.keyCommand}`, ack: { kind: 'sus', value: hash(`akc\n${d.keyCommand}`) } })
    // 登录时运行的程序、不在系统目录里的登录模块（PAM 后门）
    for (const x of d.pam) {
      const h = hash(`pam\n${x.file}\n${x.line}`)
      if (has('sus', h)) continue
      const ack = { kind: 'sus', value: h }
      const detail = `${x.file}:${x.lineNo}\n${x.line}`
      if (/pam_exec/.test(x.line)) {
        // pam_exec.so 后面先是选项（expose_authtok、quiet、log=…），第一个 / 开头的才是程序
        const after = x.line.replace(/^.*?pam_exec\.so\s*/, '').trim()
        const prog = /(^|\s)(\/.*)$/.exec(after)?.[2] ?? after
        if (/expose_authtok/.test(x.line)) items.push({ id: `pam:${h}`, level: 'danger', text: L(`${x.file} 把登录密码明文交给一个程序：${short(prog, 70)}。偷记密码的后门就是这样`, `${x.file} hands the login password to a program: ${short(prog, 70)}. Password-stealing backdoors work like this`), detail, ack })
        else items.push({ id: `pam:${h}`, level: 'warn', text: L(`每次登录都会运行一个程序（${x.file}）：${short(prog, 70)}`, `A program runs at every login (${x.file}): ${short(prog, 70)}`), detail, ack })
      } else {
        const mod = /\s(\/\S+\.so)\b/.exec(x.line)?.[1]
        if (mod && !/^\/(usr\/)?lib(32|64|x32)?\//.test(mod)) items.push({ id: `pam:${h}`, level: 'warn', text: L(`${x.file} 加载了一个不在系统目录里的登录模块：${mod}。PAM 后门常这样`, `${x.file} loads a login module from outside the system directories: ${mod}. PAM backdoors do this`), detail, ack })
      }
    }
    // 防清理和抹痕迹
    for (const f of d.immutable) {
      const h = hash(`immut\n${f}`)
      if (!has('sus', h)) items.push({ id: `immut:${f}`, level: 'warn', text: L(`被锁住了、连 root 都改不了：${f}（chattr +i）。挖矿木马常这样防止被清理`, `Locked so that even root cannot change it: ${f} (chattr +i). Miners do this so they cannot be cleaned up`), ack: { kind: 'sus', value: h } })
    }
    for (const f of d.histNull) {
      const h = hash(`histnull\n${f}`)
      if (!has('sus', h)) items.push({ id: `histnull:${f}`, level: 'warn', text: L(`${f} 被指向 /dev/null：这个账号的操作记录不再保存，入侵者常这样抹掉痕迹`, `${f} points to /dev/null: this account's command history is no longer kept, a common way to cover tracks`), ack: { kind: 'sus', value: h } })
    }
    for (const x of d.histOff) {
      const h = hash(`hist\n${x.file}\n${x.line}`)
      if (!has('sus', h)) items.push({ id: `hist:${h}`, level: 'warn', text: L(`${x.file} 关掉了操作记录：${short(x.line, 60)}`, `${x.file} turns off command history: ${short(x.line, 60)}`), detail: `${x.file}:${x.lineNo}`, ack: { kind: 'sus', value: h } })
    }
    // 新开的对外端口：后门常开一个端口等人来连。老版本排查过的机器没有这份底，先不报
    if (k.init && Array.isArray(k.ports)) {
      for (const x of publicPorts(d.listen)) {
        if (has('ports', String(x.port))) continue
        items.push({ id: `port:${x.port}`, level: 'warn', text: L(`上次排查以后新开的对外端口：${x.port}${x.proc ? `（${x.proc}）` : ''}`, `New public port since the last check: ${x.port}${x.proc ? ` (${x.proc})` : ''}`), detail: `${x.host}:${x.port}`, ack: { kind: 'ports', value: String(x.port) } })
      }
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
      L(`定时任务 ${d.cron.length} 行，定时脚本 ${d.cronJobs.length} 个，自建的自启服务 ${d.units.length} 个，能登录的账号 ${d.accounts.length} 个，对外端口 ${publicPorts(d.listen).length} 个`, `${d.cron.length} cron lines, ${d.cronJobs.length} cron scripts, ${d.units.length} custom services, ${d.accounts.length} login accounts, ${publicPorts(d.listen).length} public ports`),
      d.keyNoTool ? L('服务器上没有 ssh-keygen，钥匙认不出来', 'There is no ssh-keygen on the server, so keys could not be identified') : '',
      noRoot ? L('没有 root：别的账号的钥匙和定时任务看不到', 'No root: other accounts\' keys and scheduled tasks are not visible') : '',
    ].filter(Boolean).join('\n')
    group('backdoor', titles.backdoor, items, L('没有陌生钥匙、第二个 root、可疑的定时任务和自启服务、新开的端口', 'No unknown keys, no second root, no suspicious scheduled tasks or services, no new ports'), { detail })
  }

  // 四、系统命令和内核
  {
    const v = d.verify
    // 内核：已知的 rootkit 模块；「加载过外来模块」的标记亮着、模块列表里却一个外来模块都没有（藏起来了，或装过又卸掉了）
    const kernel = []
    const outside = d.modules.filter((m) => /[OE]/.test(m.flags))
    if (!d.container) {
      for (const m of d.modules) if (ROOTKIT_MODS.test(m.name)) kernel.push({ id: `rk:${m.name}`, level: 'danger', text: L(`内核里加载着已知的 rootkit 模块：${m.name}`, `A known rootkit module is loaded in the kernel: ${m.name}`) })
      const h = hash(`taint\n${d.bootId}`)
      if (d.taint !== null && (d.taint & 0x3000) && !outside.length && !has('sus', h)) kernel.push({ id: 'taint', level: 'warn', text: L('内核加载过外来模块，模块列表里却找不到：可能是藏起来的 rootkit，也可能是装过又卸掉的驱动。重启以后还这样就要当心', 'The kernel has loaded an out-of-tree module that is not in the module list: possibly a hidden rootkit, or a driver that was loaded and removed. Be wary if this persists after a reboot'), detail: `tainted=${d.taint}`, ack: { kind: 'sus', value: h } })
    }
    const kernelDetail = d.container ? L('容器型 VPS（LXC、OpenVZ 等）用的是宿主机的内核，内核这项查不了', 'Container-type VPS (LXC, OpenVZ…) runs on the host\'s kernel, so the kernel was not checked')
      : outside.length ? L(`外来内核模块：${joinList(outside.map((m) => `${m.name}（${m.flags}）`))}`, `Out-of-tree kernel modules: ${joinList(outside.map((m) => `${m.name} (${m.flags})`))}`) : ''
    if (!v.tool && !kernel.length) groups.push({ id: 'binaries', title: titles.binaries, level: 'na', text: L('这个系统核对不了（只支持 Debian/Ubuntu 和 RHEL 系）', 'Cannot verify on this system (Debian/Ubuntu and RHEL-family only)'), items: [], detail: kernelDetail || undefined })
    else if (!v.tool) group('binaries', titles.binaries, kernel, '', { detail: kernelDetail })
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
      const okText = d.container ? L(`核对了 ${v.pkgs.length} 个关键软件包（ps、ss、ls、sshd 等），没有被替换`, `Verified ${v.pkgs.length} key packages (ps, ss, ls, sshd and more): nothing replaced`)
        : L(`核对了 ${v.pkgs.length} 个关键软件包（ps、ss、ls、sshd 等），没有被替换；内核没有可疑模块`, `Verified ${v.pkgs.length} key packages (ps, ss, ls, sshd and more): nothing replaced; no suspicious kernel modules`)
      group('binaries', titles.binaries, [...items, ...kernel], okText, { detail: [`${v.tool === 'dpkg' ? 'dpkg -V' : 'rpm -V'}: ${names}${v.pkgs.length > 6 ? ' …' : ''}`, kernelDetail].filter(Boolean).join('\n') })
    }
  }

  // 五、登录记录：近 7 天成功登录的、此刻在线的。来源 IP 上了恶意 IP 名单的，从黄升到红
  {
    const items = []
    const pluginFps = new Set(d.keys.filter(isPluginKey).map((x) => x.fp))
    const keyFps = new Set(d.keys.map((x) => x.fp))
    const listed = new Map(d.intel.filter((x) => x.kind !== 'conn').map((x) => [x.ip, x]))
    const onList = (ip) => (listed.has(ip) ? L('，而且这个 IP 上了恶意 IP 名单', ', and this IP is on a malicious-IP list') : '')
    let total = 0
    for (const l of d.logins) {
      total += l.count
      const bad = listed.has(l.ip)
      if (l.method === 'publickey') {
        if (!l.fp || has('keys', l.fp) || pluginFps.has(l.fp) || keyFps.has(l.fp)) continue
        items.push({ id: `lkey:${l.fp}`, level: bad ? 'danger' : 'warn', text: L(`有一把现在已经不在服务器上的钥匙登录过：${l.user} 来自 ${l.ip}，${l.count} 次${onList(l.ip)}`, `A key that is no longer on the server logged in: ${l.user} from ${l.ip}, ${l.count} times${onList(l.ip)}`), detail: l.fp, ack: { kind: 'keys', value: l.fp } })
      } else {
        if (has('ips', l.ip)) continue
        const fails = d.fails[l.ip] ?? 0
        if (fails >= LIMIT.bruteFail) items.push({ id: `brute:${l.ip}:${l.user}`, level: 'danger', text: L(`${l.ip} 先试错 ${fails} 次密码，然后用 ${l.user} 登录成功了：很可能是被爆破进来的${onList(l.ip)}`, `${l.ip} failed ${fails} password attempts, then logged in as ${l.user}: very likely a brute-force break-in${onList(l.ip)}`), ack: { kind: 'ips', value: l.ip } })
        else items.push({ id: `pw:${l.ip}:${l.user}`, level: bad ? 'danger' : 'warn', text: L(`用密码登录成功过：${l.user} 来自 ${l.ip}（${l.count} 次）${onList(l.ip)}`, `Password login succeeded: ${l.user} from ${l.ip} (${l.count} times)${onList(l.ip)}`), ack: { kind: 'ips', value: l.ip } })
      }
    }
    // 此刻在线：插件这次连进来的地址（me）、点过「是我」的 IP、用认得的钥匙登录过的 IP 都是用户自己
    const mine = new Set([d.me, ...k.ips, ...d.logins.filter((l) => l.method === 'publickey' && (pluginFps.has(l.fp) || has('keys', l.fp))).map((l) => l.ip)].filter(Boolean))
    const seen = new Set()
    for (const o of d.online) {
      if (!IP_RE.test(o.from) || mine.has(o.from) || seen.has(`${o.user}@${o.from}`)) continue
      seen.add(`${o.user}@${o.from}`)
      items.push({ id: `online:${o.user}:${o.from}`, level: listed.has(o.from) ? 'danger' : 'warn', text: L(`此刻有人登录在上面：${o.user} 来自 ${o.from}（${o.tty}）${onList(o.from)}`, `Someone is logged in right now: ${o.user} from ${o.from} (${o.tty})${onList(o.from)}`), ack: { kind: 'ips', value: o.from } })
    }
    const online = d.online.map((o) => L(`${o.user}（${o.tty}${o.from ? `，来自 ${o.from}` : ''}）`, `${o.user} (${o.tty}${o.from ? `, from ${o.from}` : ''})`))
    const detail = [
      online.length ? L(`此刻在线：${joinList(online)}`, `Online now: ${joinList(online)}`) : '',
      d.failTotal !== null && d.failTotal !== undefined ? L(`近 7 天登录失败 ${d.failTotal} 次，来自 ${d.failIps ?? 0} 个 IP`, `${d.failTotal} failed logins in 7 days from ${d.failIps ?? 0} IPs`) : '',
      ...d.logins.slice(0, 12).map((l) => `${l.method} · ${l.user} · ${l.ip} · ${l.count}${l.fp ? ` · ${l.fp.slice(0, 20)}…` : ''}`),
    ].filter(Boolean).join('\n')
    if (d.logSource === 'none' && !items.length) groups.push({ id: 'logins', title: titles.logins, level: 'na', text: noRoot ? L('看不到登录日志（需要 root）', 'Login logs are not visible (needs root)') : L('找不到登录日志', 'No login logs found'), items: [], detail: detail || undefined })
    else group('logins', titles.logins, items, total ? L(`近 7 天 ${total} 次登录都对得上你认得的钥匙和 IP`, `All ${total} logins in 7 days match keys and IPs you know`) : L('近 7 天没有登录记录', 'No logins in the last 7 days'), { detail })
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
      // 三个名单是并行查的，输出先后不定：按固定顺序说
      const order = Object.keys(ZONE_NAME)
      const checked = d.blocklists.filter((b) => !b.answer || /^127\.0\.0\.\d+$/.test(b.answer)).sort((a, b) => order.indexOf(a.zone) - order.indexOf(b.zone)).map((b) => ZONE_NAME[b.zone] ?? b.zone)
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

const ACK_KINDS = ['keys', 'ips', 'cron', 'cronjob', 'units', 'accts', 'sudo', 'sus', 'ports', 'cpu']

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

/** 排查一次：一次 SSH，只读。第一次排查时把定时任务、自启服务、账号、对外端口记成「原本就有」 */
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
    } else if ((known.rev ?? 1) < BASELINE_REV) {
      // 老版本排查过：新加的两类（对外端口、普通用户的自启服务）这次当成原本就有，别的不动
      const fresh = baselineFrom(data)
      const userUnits = data.units.filter((u) => u.where === 'user' && !unitSuspicious(u.exec)).map(unitHash)
      await writeKnown(alias, { ...known, rev: BASELINE_REV, ports: [...new Set([...(known.ports ?? []), ...fresh.ports])], units: [...new Set([...(known.units ?? []), ...userUnits])] }, env)
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
