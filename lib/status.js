// lib/status.js — 终端面板的「状态」页签：一次 SSH 把这台机器看一遍，规则判出「需注意」，点了才让 AI 解读
//
// 设计见 工作流/dsh-vps-manager-状态页签设计.md。三条硬约束：
//   1. 只读，一次 SSH 采完（Windows 不能复用连接，分次采会慢）。走引擎的只读通道，不弹审批
//   2. 采集只输出「键=值」和记录行，不输出句子：句子由界面按语言拼（中英文跟 DSH 走）
//   3. 采不到的只这一项「取不到」；没有 root 看不了的标出来，不当成异常
//
// 判断全用规则，零 token。AI 解读是用户点了才调（插件直接调 DSH 的默认模型），结果存本机，
// 重新打开面板时马上有东西看；不做任何「较上次」的对比（用户定的）。

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, dshHome, readState, writeState } from './config.js'
import { runRemote } from './engine.js'
import { L, currentLang } from './i18n.js'
import { noteReach } from './reach.js'

// —————————————————————— 采集脚本 ——————————————————————
// 用到 prelude 里的 has_cmd、svc_active、$SUDO / $SUDO_OPT、$INIT、$PKG、$OS_ID / $OS_VER

export const STATUS_SCRIPT = String.raw`
T() { if has_cmd timeout; then timeout 8 "$@"; else "$@"; fi; }
if [ "$SUDO" = "__NO_PRIV__" ]; then printf 'priv=none\n'; elif [ -z "$SUDO" ]; then printf 'priv=root\n'; else printf 'priv=sudo\n'; fi
printf 'host=%s\n' "$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null)"
printf 'os=%s\n' "$( (. /etc/os-release 2>/dev/null; printf '%s' "$PRETTY_NAME") )"
printf 'os_id=%s\nos_ver=%s\ninit=%s\npkg=%s\n' "$OS_ID" "$OS_VER" "$INIT" "$PKG"
printf 'kernel=%s\narch=%s\n' "$(uname -r 2>/dev/null)" "$(uname -m 2>/dev/null)"
printf 'uptime=%s\n' "$(cut -d. -f1 /proc/uptime 2>/dev/null)"
printf 'cores=%s\n' "$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
printf 'load=%s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"

# —— CPU：整机和每个进程，同一个 1 秒窗口里采两次 /proc ——
cpu_now() { awk '/^cpu /{t=0; for (i=2; i<=9; i++) t+=$i; print t, $5+$6}' /proc/stat 2>/dev/null; }
pa=$(cat /proc/[0-9]*/stat 2>/dev/null); ca=$(cpu_now)
sleep 1
pb=$(cat /proc/[0-9]*/stat 2>/dev/null); cb=$(cpu_now)
printf 'cpu=%s\n' "$(echo "$ca $cb" | awk 'NF==4 {t=$3-$1; i=$4-$2; if (t>0) printf "%.0f", (t-i)*100/t}')"
{ printf '%s\n' "$pa" | sed 's/^/A /'; printf '%s\n' "$pb" | sed 's/^/B /'; } | awk -v hz="$(getconf CLK_TCK 2>/dev/null || echo 100)" '
  { tag=$1; line=substr($0, 3); p=index(line, " ("); q=0
    for (i=length(line); i>p; i--) if (substr(line, i, 2) == ") ") { q=i; break }
    if (!p || !q) next
    pid=substr(line, 1, p-1); comm=substr(line, p+2, q-p-2); n=split(substr(line, q+2), f, " ")
    t=f[12]+f[13]
    if (tag=="A") a[pid]=t; else if (pid in a && t>a[pid]) c[comm]+=t-a[pid] }
  END { for (k in c) printf "proc_cpu=%s|%.1f\n", k, c[k]*100/hz }' | sort -t'|' -k2 -rn | head -5
ps -eo comm=,rss= 2>/dev/null | awk '{m[$1]+=$2} END {for (k in m) printf "proc_mem=%s|%d\n", k, m[k]}' | sort -t'|' -k2 -rn | head -5

awk '/^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):/ {k=$1; sub(":", "", k); printf "%s=%s\n", tolower(k), $2}' /proc/meminfo 2>/dev/null

# —— 磁盘：真实的挂载点（跳过 tmpfs、overlay、snap 这类） ——
if df -PkT >/dev/null 2>&1; then
  df -PkT 2>/dev/null | awk 'NR>1 && $2 !~ /^(tmpfs|devtmpfs|overlay|squashfs|ramfs|efivarfs|nsfs|autofs|fuse\..*)$/ && $7 !~ /^\/(snap|run|sys|proc|dev)(\/|$)/ && $1 !~ /^\/dev\/loop/ {sub("%", "", $6); printf "disk=%s|%s|%s|%s|%s\n", $7, $3, $4, $5, $6}' | head -8
else
  df -Pk 2>/dev/null | awk 'NR>1 && $1 !~ /^(tmpfs|devtmpfs|overlay|none|udev)$/ && $6 !~ /^\/(snap|run|sys|proc|dev)(\/|$)/ {sub("%", "", $5); printf "disk=%s|%s|%s|%s|%s\n", $6, $2, $3, $4, $5}' | head -8
fi
df -Pi 2>/dev/null | awk 'NR>1 && $5 ~ /%$/ {sub("%", "", $5); printf "inode=%s|%s\n", $6, $5}' | head -20

# —— 网络：默认路由那块网卡，开机以来的收发量 ——
dev=$(ip route show default 2>/dev/null | awk '{for (i=1; i<NF; i++) if ($i=="dev") {print $(i+1); exit}}')
[ -n "$dev" ] && sed 's/:/ /' /proc/net/dev 2>/dev/null | awk -v d="$dev" '$1==d {printf "net=%s|%s|%s\n", d, $2, $10}'

# —— 服务 ——
if [ "$INIT" = systemd ]; then
  printf 'svc_running=%s\n' "$(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | wc -l | tr -d ' ')"
  systemctl list-units --type=service --state=failed --no-legend --plain 2>/dev/null | awk '{print "svc_failed=" $1}' | head -20
  # 设了开机自启却没在跑。跳过：一次性的、按需拉起的（socket / timer 触发）、条件不满足的、模板。
  # 开机跑一次就正常退出的（dmesg、ubuntu-advantage 这类，真机上实测会误报）也不算：
  # 只报「常驻型（notify / forking / dbus）却没在跑」「这次开机根本没启动过」「退出时返回了出错码」
  en=$(systemctl list-unit-files --type=service --state=enabled --no-legend --plain 2>/dev/null | awk '{print $1}' | grep -v '@' | head -100)
  if [ -n "$en" ]; then
    systemctl show -p Id -p Type -p ActiveState -p TriggeredBy -p ConditionResult -p ExecMainStartTimestampMonotonic -p ExecMainStatus $en 2>/dev/null | awk -F= '
      function out() {
        if (id != "" && ty != "oneshot" && tb == "" && cr != "no" && as != "active" && as != "activating" && as != "reloading" && as != "failed") {
          if (ty == "notify" || ty == "forking" || ty == "dbus" || st == "0" || (es != "" && es != "0")) print "svc_down=" id
        }
        id=ty=as=tb=cr=st=es=""
      }
      /^Id=/ {id=$2} /^Type=/ {ty=$2} /^ActiveState=/ {as=$2} /^TriggeredBy=/ {tb=$2} /^ConditionResult=/ {cr=$2}
      /^ExecMainStartTimestampMonotonic=/ {st=$2} /^ExecMainStatus=/ {es=$2}
      /^$/ {out()} END {out()}' | head -20
  fi
  systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}' | sed 's/[.]service$//' \
    | grep -vE '^(systemd-|dbus|getty@|serial-getty@|user@|polkit|rsyslog|cron|atd|irqbalance|multipathd|ModemManager|networkd-dispatcher|unattended-upgrades|packagekit|udisks2|upower|snapd|accounts-daemon|chrony|ntp|qemu-guest-agent|cloud-|lxcfs|haveged|rngd|acpid|smartd|thermald|wpa_supplicant|NetworkManager|avahi|cups|containerd|ssh|sshd|getty)' \
    | head -20 | awk '{print "svc_name=" $1}'
  systemctl list-timers --all --no-legend --plain 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i ~ /\.timer$/) {print "timer=" $i "|" $(i+1); break}}' | head -40
elif has_cmd rc-status; then
  printf 'svc_running=%s\n' "$(rc-status -s 2>/dev/null | grep -c started)"
  rc-status -s 2>/dev/null | awk '/crashed|stopped/ && /default/ {print "svc_failed=" $1}' | head -20
fi

# —— 容器 ——
if has_cmd docker; then
  printf 'docker=1\n'
  if $SUDO_OPT docker info >/dev/null 2>&1; then
    $SUDO_OPT docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}' 2>/dev/null | head -40 | sed 's/^/ctr=/'
    ids=$($SUDO_OPT docker ps -aq 2>/dev/null | head -40)
    [ -n "$ids" ] && $SUDO_OPT docker inspect -f '{{.Name}}|{{.HostConfig.RestartPolicy.Name}}' $ids 2>/dev/null | sed 's#^/##; s/^/ctr_policy=/'
  else
    printf 'ctr_noaccess=1\n'
  fi
fi

# —— 端口 ——
if has_cmd ss; then
  $SUDO_OPT ss -ltnpH 2>/dev/null | awk '{p=""; for (i=6; i<=NF; i++) p=p $i; print "port=" $4 "|" p}' | head -40
elif has_cmd netstat; then
  $SUDO_OPT netstat -ltnp 2>/dev/null | awk 'NR>2 {print "port=" $4 "|" $7}' | head -40
fi

# —— 防火墙（只看，不改） ——
if has_cmd ufw && s=$($SUDO_OPT ufw status 2>/dev/null) && [ -n "$s" ]; then
  if printf '%s' "$s" | head -1 | grep -qi 'inactive'; then printf 'fw=ufw|0\n'; else printf 'fw=ufw|1\n'; fi
  printf '%s\n' "$s" | awk '/ALLOW/ && !/\(v6\)/ {print "fw_allow=" $1}' | head -20
elif has_cmd firewall-cmd && [ "$($SUDO_OPT firewall-cmd --state 2>/dev/null)" = running ]; then
  printf 'fw=firewalld|1\n'
  for x in $($SUDO_OPT firewall-cmd --list-services 2>/dev/null) $($SUDO_OPT firewall-cmd --list-ports 2>/dev/null); do printf 'fw_allow=%s\n' "$x"; done | head -20
elif has_cmd nft && r=$($SUDO_OPT nft list ruleset 2>/dev/null) && [ -n "$r" ]; then
  printf 'fw=nftables|1\n'
  printf '%s\n' "$r" | grep -oE 'dport (\{ [0-9, ]+ \}|[0-9]+) [^;]*accept' | grep -oE '[0-9]+' | sort -un | head -20 | sed 's/^/fw_allow=/'
elif has_cmd iptables && r=$($SUDO_OPT iptables -S INPUT 2>/dev/null) && [ -n "$r" ]; then
  if printf '%s' "$r" | grep -q '^-P INPUT DROP' || printf '%s' "$r" | grep -q -- '-j DROP\|-j REJECT'; then printf 'fw=iptables|1\n'; else printf 'fw=iptables|0\n'; fi
  printf '%s\n' "$r" | grep -- '-j ACCEPT' | grep -oE -- '--dport [0-9:]+' | awk '{print "fw_allow=" $2}' | sort -u | head -20
elif [ "$SUDO" = "__NO_PRIV__" ]; then
  printf 'fw=unknown|0\n'
else
  printf 'fw=none|0\n'
fi

# —— 计划任务 ——
printf 'cron_lines=%s\n' "$($SUDO_OPT crontab -l 2>/dev/null | grep -cvE '^[[:space:]]*(#|$)')"
printf 'cron_files=%s\n' "$(ls -1 /etc/cron.d 2>/dev/null | grep -cv '^\.')"

# —— 证书：Let's Encrypt 与 Caddy ——
# 一行：名字|到期|来源|签发|Caddy 配置里还有没有它（1 有 / 0 没有 / 空 不知道）
cert_dates() { $SUDO_OPT openssl x509 -startdate -enddate -noout -in "$1" 2>/dev/null; }
for f in /etc/letsencrypt/live/*/cert.pem; do
  [ -e "$f" ] || continue
  d=$(cert_dates "$f")
  printf 'cert=%s|%s|letsencrypt|%s|\n' "$(basename "$(dirname "$f")")" "$(printf '%s\n' "$d" | sed -n 's/^notAfter=//p')" "$(printf '%s\n' "$d" | sed -n 's/^notBefore=//p')"
done 2>/dev/null | head -20
for d in /var/lib/caddy/.local/share/caddy/certificates /root/.local/share/caddy/certificates "$HOME/.local/share/caddy/certificates" /data/caddy/certificates; do
  $SUDO_OPT test -d "$d" 2>/dev/null || continue
  $SUDO_OPT find "$d" -maxdepth 3 -name '*.crt' 2>/dev/null | head -20 | while read -r f; do
    d2=$(cert_dates "$f")
    n=$(basename "$f" .crt)
    # Caddy 只续还在用的；过期了还躺在存储里的，多半是配置里已经删掉的站点
    case "$n" in wildcard_*) pat="*$(printf '%s' "$n" | sed 's/^wildcard_//')" ;; *) pat=$n ;; esac
    u=
    if [ -d /etc/caddy ]; then if $SUDO_OPT grep -rqsF -- "$pat" /etc/caddy 2>/dev/null; then u=1; else u=0; fi; fi
    printf 'cert=%s|%s|caddy|%s|%s\n' "$n" "$(printf '%s\n' "$d2" | sed -n 's/^notAfter=//p')" "$(printf '%s\n' "$d2" | sed -n 's/^notBefore=//p')" "$u"
  done
done
[ -d /etc/letsencrypt/live ] && ! $SUDO_OPT test -r /etc/letsencrypt/live 2>/dev/null && printf 'cert_noaccess=1\n'

# —— 安全 ——
case "$PKG" in
  apt) l=$(T apt list --upgradable 2>/dev/null | tail -n +2); printf 'updates=%s\nupdates_sec=%s\n' "$(printf '%s' "$l" | grep -c .)" "$(printf '%s' "$l" | grep -ci security)" ;;
  dnf|yum) printf 'updates_sec=%s\n' "$(T $PKG -q -C updateinfo list --security 2>/dev/null | grep -c .)" ;;
  apk) printf 'updates=%s\n' "$(T apk version -l '<' 2>/dev/null | tail -n +2 | grep -c .)" ;;
esac
if [ -f /var/run/reboot-required ]; then printf 'reboot=1\n'
elif has_cmd needs-restarting && $SUDO_OPT needs-restarting -r >/dev/null 2>&1; then printf 'reboot=0\n'
elif has_cmd needs-restarting; then printf 'reboot=1\n'
else printf 'reboot=0\n'; fi
if [ "$SUDO" != "__NO_PRIV__" ] && has_cmd journalctl; then
  printf 'login_fail=%s\n' "$(T $SUDO_OPT journalctl -q --since '24 hours ago' -u ssh -u sshd --no-pager 2>/dev/null | grep -cE 'Failed password|Invalid user|authentication failure')"
fi
if has_cmd fail2ban-client && svc_active fail2ban; then printf 'f2b=1\n'; else printf 'f2b=0\n'; fi

# —— 插件自己在服务器上的东西 ——
D="$HOME/.cache/dsh-vps"
[ -d "$D/trash" ] && printf 'plugin_trash=%s\n' "$(du -sk "$D/trash" 2>/dev/null | cut -f1)"
[ -d "$D/backups" ] && printf 'plugin_backups=%s\n' "$(du -sk "$D/backups" 2>/dev/null | cut -f1)"
if [ -d "$D/lock" ]; then
  p=$(cat "$D/lock/pid" 2>/dev/null)
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
    o="$D/lock/owner.json"
    printf 'task=%s|%s|%s\n' "$(sed -n 's/.*"taskId": *"\([^"]*\)".*/\1/p' "$o" 2>/dev/null | head -1)" "$(sed -n 's/.*"device": *"\([^"]*\)".*/\1/p' "$o" 2>/dev/null | head -1)" "$(sed -n 's/.*"action": *"\([^"]*\)".*/\1/p' "$o" 2>/dev/null | head -1)"
  fi
fi
`

// —————————————————————— 解析 ——————————————————————

/** 数字；空的、认不出的都是 null（「取不到」），不能当成 0 */
const num = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 端口记录：0.0.0.0:80 / [::]:443 / 127.0.0.1:3306 → 地址、端口、对外还是只在本机 */
function parsePort(raw) {
  const [addr = '', users = ''] = raw.split('|')
  const i = addr.lastIndexOf(':')
  const host = addr.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const port = num(addr.slice(i + 1))
  const proc = /\(\("([^"]+)"/.exec(users)?.[1] ?? (users.includes('/') ? users.split('/').pop() : '')
  const local = /^(127\.|::1$|localhost)/.test(host)
  return { host: host || '*', port, proc, local }
}

/** 采集脚本的输出 → 结构化数据（只有数字和名字） */
export function parseStatus(stdout) {
  const kv = {}
  const lists = {}
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    const [, k, v] = m
    if (['proc_cpu', 'proc_mem', 'disk', 'inode', 'svc_failed', 'svc_down', 'svc_name', 'timer', 'ctr', 'ctr_policy', 'port', 'fw_allow', 'cert'].includes(k)) {
      ;(lists[k] ??= []).push(v)
    } else {
      kv[k] = v
    }
  }
  const list = (k) => lists[k] ?? []
  const [load1, load5, load15] = String(kv.load ?? '').split(/\s+/).map(num)
  const memTotal = num(kv.memtotal)
  const memAvail = num(kv.memavailable) ?? (num(kv.memfree) ?? 0) + (num(kv.buffers) ?? 0) + (num(kv.cached) ?? 0)
  const policies = Object.fromEntries(list('ctr_policy').map((r) => r.split('|')))
  const inodes = Object.fromEntries(list('inode').map((r) => {
    const [mount, pct] = r.split('|')
    return [mount, num(pct)]
  }))
  const timers = list('timer').map((r) => {
    const [timer, unit] = r.split('|')
    return { timer, unit }
  })
  const failed = list('svc_failed')
  const timerUnits = new Set(timers.map((t) => t.unit))
  const net = kv.net ? kv.net.split('|') : null
  const task = kv.task ? kv.task.split('|') : null
  const ports = list('port').map(parsePort).filter((p) => p.port !== null)
  // 同一个端口 IPv4、IPv6 各监听一次：合并成一行
  const seen = new Map()
  for (const p of ports) {
    const key = `${p.port}|${p.local ? 'l' : 'p'}`
    if (!seen.has(key)) seen.set(key, p)
    else if (!seen.get(key).proc && p.proc) seen.get(key).proc = p.proc
  }
  return {
    priv: kv.priv ?? 'unknown',
    host: kv.host ?? '',
    os: kv.os || [kv.os_id, kv.os_ver].filter(Boolean).join(' '),
    osId: kv.os_id ?? '',
    init: kv.init ?? '',
    pkg: kv.pkg ?? '',
    kernel: kv.kernel ?? '',
    arch: kv.arch ?? '',
    uptime: num(kv.uptime),
    cores: num(kv.cores),
    load: [load1 ?? null, load5 ?? null, load15 ?? null],
    cpu: num(kv.cpu),
    mem: memTotal ? { total: memTotal * 1024, avail: Math.max(0, memAvail) * 1024 } : null,
    swap: num(kv.swaptotal) !== null ? { total: num(kv.swaptotal) * 1024, free: (num(kv.swapfree) ?? 0) * 1024 } : null,
    disks: list('disk').map((r) => {
      const [mount, size, used, avail, pct] = r.split('|')
      return { mount, size: (num(size) ?? 0) * 1024, used: (num(used) ?? 0) * 1024, avail: (num(avail) ?? 0) * 1024, pct: num(pct), inodePct: inodes[mount] ?? null }
    }),
    net: net ? { dev: net[0], rx: num(net[1]), tx: num(net[2]) } : null,
    procCpu: list('proc_cpu').map((r) => {
      const [name, pct] = r.split('|')
      return { name, pct: num(pct) }
    }),
    procMem: list('proc_mem').map((r) => {
      const [name, kb] = r.split('|')
      return { name, bytes: (num(kb) ?? 0) * 1024 }
    }),
    services: kv.svc_running === undefined ? null : {
      running: num(kv.svc_running),
      names: list('svc_name'),
      failed: failed.filter((u) => !timerUnits.has(u)),
      timerFailed: failed.filter((u) => timerUnits.has(u)),
      down: list('svc_down'),
    },
    timers: kv.svc_running === undefined ? null : timers.length,
    // 没装 docker 就是 null；装了但没权限看是 noAccess
    containers: kv.docker !== '1' ? null : kv.ctr_noaccess ? { noAccess: true, list: [] } : {
      list: list('ctr').map((r) => {
        const [name, state, status, image] = r.split('|')
        return { name, state, status, image, policy: policies[name] ?? '' }
      }),
    },
    ports: [...seen.values()].sort((a, b) => a.port - b.port),
    firewall: kv.fw ? { type: kv.fw.split('|')[0], active: kv.fw.split('|')[1] === '1', allow: list('fw_allow') } : null,
    cron: { lines: num(kv.cron_lines), files: num(kv.cron_files) },
    certs: list('cert').map((r) => {
      const [name, end, source, start, used] = r.split('|')
      const iso = (v) => (Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null)
      return { name, source, expires: iso(end), starts: start ? iso(start) : null, used: used === '1' ? true : used === '0' ? false : null }
    }).filter((c, i, all) => all.findIndex((x) => x.name === c.name) === i),
    certNoAccess: kv.cert_noaccess === '1',
    updates: num(kv.updates),
    updatesSec: num(kv.updates_sec),
    reboot: kv.reboot === '1',
    loginFail: num(kv.login_fail),
    fail2ban: kv.f2b === '1',
    plugin: { trash: num(kv.plugin_trash) === null ? null : num(kv.plugin_trash) * 1024, backups: num(kv.plugin_backups) === null ? null : num(kv.plugin_backups) * 1024 },
    task: task ? { taskId: task[0], device: task[1], action: task[2] } : null,
  }
}

// —————————————————————— 判断（规则，零 token） ——————————————————————

export const LIMITS = {
  disk: { warn: 85, danger: 95 },
  memAvail: { warn: 10, danger: 5 },
  swapUsed: { warn: 50 },
  certDays: { warn: 14, danger: 3 },
  loginFail: { warn: 100 },
}

const level = (value, { warn, danger }) => (danger !== undefined && value >= danger ? 'danger' : value >= warn ? 'warn' : 'ok')

/** 按天数算证书还剩多久（负数是已过期） */
export function certDays(cert, now = Date.now()) {
  if (!cert.expires) return null
  return Math.floor((Date.parse(cert.expires) - now) / 86_400_000)
}

/**
 * 一张证书算哪一级。阈值按证书本身的有效期缩放：90 天的证书剩 14 天提醒、3 天告急；
 * 只有 6 天左右的 IP 证书平时就只剩几天，不能照 90 天的算。
 * Caddy 存储里已过期、配置里也找不到名字的，是删掉的站点留下的旧文件，算 stale，不报。
 */
export function certLevel(cert, now = Date.now()) {
  const days = certDays(cert, now)
  if (days === null) return { days, level: 'na' }
  if (days < 0 && cert.source === 'caddy' && cert.used === false) return { days, level: 'stale' }
  const start = cert.starts ? Date.parse(cert.starts) : NaN
  const life = Number.isFinite(start) ? (Date.parse(cert.expires) - start) / 86_400_000 : 90
  const warn = Math.min(LIMITS.certDays.warn, Math.floor(life / 4))
  const danger = Math.min(LIMITS.certDays.danger, Math.floor(life / 10))
  return { days, level: days <= danger ? 'danger' : days <= warn ? 'warn' : 'ok' }
}

/**
 * 判出「需注意」和「正常」两组。每一项只有类型和字段，句子由界面拼：
 *   { id, area, level: 'danger' | 'warn' | 'ok' | 'na', type, ...字段 }
 * 'na' 是取不到（没装、没权限），不算异常也不算正常
 */
export function judge(s, now = Date.now()) {
  const items = []
  const push = (item) => items.push(item)

  if (s.mem) {
    const pct = Math.round((s.mem.avail / s.mem.total) * 100)
    const lv = pct < LIMITS.memAvail.danger ? 'danger' : pct < LIMITS.memAvail.warn ? 'warn' : 'ok'
    push({ id: 'mem', area: 'resource', level: lv, type: 'mem', availPct: pct, avail: s.mem.avail, total: s.mem.total })
  }
  if (s.swap && s.swap.total > 0) {
    const pct = Math.round(((s.swap.total - s.swap.free) / s.swap.total) * 100)
    push({ id: 'swap', area: 'resource', level: pct > LIMITS.swapUsed.warn ? 'warn' : 'ok', type: 'swap', usedPct: pct })
  }
  if (s.cores && s.load[0] !== null) {
    const ratio = s.load[0] / s.cores
    push({ id: 'load', area: 'resource', level: ratio > 2 ? 'danger' : ratio > 1 ? 'warn' : 'ok', type: 'load', load: s.load[0], cores: s.cores })
  }
  const disksBad = []
  for (const d of s.disks) {
    if (d.pct !== null && level(d.pct, LIMITS.disk) !== 'ok') disksBad.push({ id: `disk:${d.mount}`, area: 'disk', level: level(d.pct, LIMITS.disk), type: 'disk', mount: d.mount, pct: d.pct, avail: d.avail })
    if (d.inodePct !== null && level(d.inodePct, LIMITS.disk) !== 'ok') disksBad.push({ id: `inode:${d.mount}`, area: 'disk', level: level(d.inodePct, LIMITS.disk), type: 'inode', mount: d.mount, pct: d.inodePct })
  }
  if (disksBad.length) disksBad.forEach(push)
  else if (s.disks.length) push({ id: 'disk', area: 'disk', level: 'ok', type: 'disks', count: s.disks.length, maxPct: Math.max(...s.disks.map((d) => d.pct ?? 0)) })

  if (s.services) {
    for (const unit of s.services.failed) push({ id: `svc:${unit}`, area: 'service', level: 'danger', type: 'svc_failed', name: unit.replace(/\.service$/, '') })
    for (const unit of s.services.down) push({ id: `svcdown:${unit}`, area: 'service', level: 'danger', type: 'svc_down', name: unit.replace(/\.service$/, '') })
    for (const unit of s.services.timerFailed) push({ id: `timer:${unit}`, area: 'cron', level: 'warn', type: 'timer_failed', name: unit.replace(/\.service$/, '') })
    if (!s.services.failed.length && !s.services.down.length) push({ id: 'services', area: 'service', level: 'ok', type: 'services', running: s.services.running })
  } else {
    push({ id: 'services', area: 'service', level: 'na', type: 'services' })
  }

  if (s.containers?.noAccess) push({ id: 'containers', area: 'container', level: 'na', type: 'containers', reason: 'root' })
  else if (s.containers) {
    const bad = s.containers.list.filter((c) => c.state === 'restarting' || ((c.state === 'exited' || c.state === 'dead') && (!c.policy || c.policy === 'no')))
    for (const c of bad) push({ id: `ctr:${c.name}`, area: 'container', level: c.state === 'restarting' ? 'danger' : 'warn', type: c.state === 'restarting' ? 'ctr_restarting' : 'ctr_exited', name: c.name, status: c.status })
    if (!bad.length) push({ id: 'containers', area: 'container', level: 'ok', type: 'containers', running: s.containers.list.filter((c) => c.state === 'running').length, total: s.containers.list.length })
  }

  const certs = s.certs.map((c) => ({ name: c.name, source: c.source, ...certLevel(c, now) }))
  const certBad = certs.filter((c) => c.level === 'warn' || c.level === 'danger')
  for (const c of certBad) push({ id: `cert:${c.name}`, area: 'cert', level: c.level, type: 'cert', name: c.name, days: c.days })
  const live = certs.filter((c) => c.level === 'ok')
  if (live.length && !certBad.length) push({ id: 'certs', area: 'cert', level: 'ok', type: 'certs', count: live.length, minDays: Math.min(...live.map((c) => c.days)) })

  if (s.reboot) push({ id: 'reboot', area: 'security', level: 'warn', type: 'reboot' })
  if (s.updatesSec !== null) push({ id: 'updates', area: 'security', level: s.updatesSec > 0 ? 'warn' : 'ok', type: 'updates_sec', count: s.updatesSec })
  if (s.loginFail !== null) {
    push({ id: 'login', area: 'security', level: s.loginFail >= LIMITS.loginFail.warn && !s.fail2ban ? 'warn' : 'ok', type: 'login_fail', count: s.loginFail, fail2ban: s.fail2ban })
  } else if (s.priv === 'none') {
    push({ id: 'login', area: 'security', level: 'na', type: 'login_fail', reason: 'root' })
  }
  if (s.firewall) push({ id: 'firewall', area: 'firewall', level: s.firewall.type === 'unknown' ? 'na' : 'ok', type: 'firewall', fwType: s.firewall.type, active: s.firewall.active, reason: s.firewall.type === 'unknown' ? 'root' : undefined })

  const rank = { danger: 0, warn: 1, ok: 2, na: 3 }
  items.sort((a, b) => rank[a.level] - rank[b.level])
  return {
    attention: items.filter((i) => i.level === 'danger' || i.level === 'warn'),
    ok: items.filter((i) => i.level === 'ok'),
    na: items.filter((i) => i.level === 'na'),
    // 每张证书的级别，证书卡片照这个上色（阈值只在这里算一次）
    certs,
  }
}

// —————————————————————— 采集、缓存 ——————————————————————

function cacheFile(alias, env) {
  return join(dshHome(env), 'vps-manager', 'status', `${alias}.json`)
}

export async function readStatusCache(alias, env = process.env) {
  try {
    return JSON.parse(await readFile(cacheFile(alias, env), 'utf8'))
  } catch {
    return null
  }
}

async function writeStatusCache(alias, patch, env) {
  const prev = (await readStatusCache(alias, env)) ?? {}
  const next = { ...prev, ...patch }
  await mkdir(join(dshHome(env), 'vps-manager', 'status'), { recursive: true })
  await atomicWrite(cacheFile(alias, env), JSON.stringify(next, null, 2))
  return next
}

/** 看一遍这台机器：采集 → 判断 → 存本机 → 顺手更新 VPS 模式给 AI 的机器信息 */
/** 没采到时说给用户听的原因：这是只读的查看，不提「改动类操作」那套 */
function collectHint(res) {
  if (res.status === 'disconnected') return L('连接中途断了，这次没看完，点刷新再试一次', 'The connection dropped partway, so this look did not finish; refresh to try again')
  if (res.status === 'timeout') return L('45 秒内没看完（机器可能很忙），稍后点刷新再试', 'The look did not finish within 45 seconds (the machine may be busy); refresh to try again later')
  return res.hint
}

export async function collectStatus({ alias, env = process.env, runner, signal, now = Date.now }) {
  // 整份输出都要：按「键=值」逐行解析，中间省略一段会把跨在切口上的那一行切坏
  const res = await runRemote({ alias, body: STATUS_SCRIPT, mode: 'read', withPrelude: true, timeoutMs: 45_000, head: 512_000, env, runner, signal })
  if (!res.ok && res.status !== 'failed') {
    // 连不上的情况 runRemote 自己会记到连接状态里；超时、中途断开不等于机器连不上，不去动它
    return { ok: false, alias, status: res.status, hint: collectHint(res) }
  }
  const data = parseStatus(res.stdout)
  const collectedAt = new Date(now()).toISOString()
  await noteReach(alias, true, '', env).catch(() => {})
  await writeStatusCache(alias, { collectedAt, data }, env)
  // VPS 模式的说明里有「在跑的服务、容器、80/443 被谁占」：用这次看到的刷新一下
  try {
    const state = await readState(env)
    const host = state.hosts?.[alias]
    if (host) {
      host.facts = {
        ...(host.facts ?? {}),
        ...(data.services ? { services: data.services.names.join(' ') } : {}),
        ...(data.containers?.list ? { containers: data.containers.list.filter((c) => c.state === 'running').map((c) => c.name).slice(0, 8).join(' ') } : {}),
        web_listeners: [...new Set(data.ports.filter((p) => (p.port === 80 || p.port === 443) && p.proc).map((p) => p.proc))].join(' '),
        ...(data.disks.find((d) => d.mount === '/') ? { disk_pct: `${data.disks.find((d) => d.mount === '/').pct}%` } : {}),
      }
      await writeState(state, env)
    }
  } catch {
    // 只是锦上添花
  }
  return { ok: true, alias, collectedAt, data, judged: judge(data, Date.parse(collectedAt)) }
}

// —————————————————————— 给 AI 的摘要与解读 ——————————————————————

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

/** 给模型看的摘要：只摆事实，按当前语言写 */
export function statusBrief(alias, data, judged) {
  const lines = []
  lines.push(L(
    `机器 ${alias}：${data.os || '未知系统'}，内核 ${data.kernel}，运行 ${Math.round((data.uptime ?? 0) / 86400)} 天，权限 ${data.priv}`,
    `Machine ${alias}: ${data.os || 'unknown OS'}, kernel ${data.kernel}, up ${Math.round((data.uptime ?? 0) / 86400)} days, privilege ${data.priv}`,
  ))
  const res = [
    data.cpu !== null ? `CPU ${data.cpu}%` : '',
    data.cores ? L(`${data.cores} 核`, `${data.cores} cores`) : '',
    data.load[0] !== null ? L(`负载 ${data.load.join(' / ')}`, `load ${data.load.join(' / ')}`) : '',
    data.mem ? L(`内存可用 ${gb(data.mem.avail)} / ${gb(data.mem.total)}`, `memory available ${gb(data.mem.avail)} of ${gb(data.mem.total)}`) : '',
    data.swap?.total ? L(`swap 已用 ${gb(data.swap.total - data.swap.free)}`, `swap used ${gb(data.swap.total - data.swap.free)}`) : '',
  ].filter(Boolean)
  lines.push(L(`资源：${res.join('，')}`, `Resources: ${res.join(', ')}`))
  if (data.disks.length) lines.push(L('磁盘：', 'Disks: ') + data.disks.map((d) => `${d.mount} ${d.pct}%${d.inodePct !== null ? ` (inode ${d.inodePct}%)` : ''}`).join(', '))
  if (data.services) lines.push(L(`服务：运行 ${data.services.running}，失败 ${data.services.failed.join(' ') || '无'}，自启却没在跑 ${data.services.down.join(' ') || '无'}`, `Services: ${data.services.running} running, failed ${data.services.failed.join(' ') || 'none'}, enabled but not running ${data.services.down.join(' ') || 'none'}`))
  if (data.containers?.list.length) lines.push(L('容器：', 'Containers: ') + data.containers.list.slice(0, 12).map((c) => `${c.name}(${c.state}${c.policy ? `, restart=${c.policy}` : ''})`).join(' '))
  if (data.procCpu.length) lines.push(L('最占 CPU：', 'Top CPU: ') + data.procCpu.map((p) => `${p.name} ${p.pct}%`).join(', '))
  if (data.procMem.length) lines.push(L('最占内存：', 'Top memory: ') + data.procMem.map((p) => `${p.name} ${gb(p.bytes)}`).join(', '))
  if (data.ports.length) lines.push(L('监听端口：', 'Listening ports: ') + data.ports.slice(0, 20).map((p) => `${p.port}${p.local ? '(local)' : ''}${p.proc ? ` ${p.proc}` : ''}`).join(', '))
  if (data.firewall) lines.push(L('防火墙：', 'Firewall: ') + `${data.firewall.type} ${data.firewall.active ? 'active' : 'inactive'} ${data.firewall.allow.join(' ')}`)
  if (data.certs.length) {
    lines.push(L('证书（剩余天数）：', 'Certificates (days left): ') + data.certs.map((c) => {
      const { days, level } = certLevel(c)
      return level === 'stale' ? L(`${c.name} 已过期但 Caddy 配置里已没有它（旧文件）`, `${c.name} expired but no longer in the Caddy config (leftover)`) : `${c.name} ${days}d`
    }).join(', '))
  }
  const sec = [
    data.updatesSec !== null ? L(`待装安全更新 ${data.updatesSec}`, `${data.updatesSec} security updates pending`) : '',
    data.reboot ? L('需要重启', 'reboot required') : '',
    data.loginFail !== null ? L(`24 小时登录失败 ${data.loginFail} 次`, `${data.loginFail} failed logins in 24 h`) : '',
    data.fail2ban ? 'fail2ban on' : '',
  ].filter(Boolean)
  if (sec.length) lines.push(L(`安全：${sec.join('，')}`, `Security: ${sec.join(', ')}`))
  lines.push(L(`规则判出需注意 ${judged.attention.length} 项：`, `Rules flagged ${judged.attention.length} items: `) + judged.attention.map((a) => `${a.type}${a.name ? `:${a.name}` : ''}${a.mount ? `:${a.mount}` : ''}`).join(', '))
  return lines.join('\n')
}

function systemPrompt() {
  return L(
    [
      '你是服务器运维助手。下面是一台 Linux 服务器此刻的状态摘要（插件用规则采集、判断过）。',
      '用中文写 3–6 句话的解读：先一句话说整体怎么样，再按轻重说最要紧的一两件事、可能的原因和下一步该看什么。',
      '只根据给出的数据说话，没有的数据不要猜；数字照抄，不要编。',
      '不要建议删除、卸载、关机或退掉机器；不要给出要执行的命令清单。',
      '不用标题、不用列表，就是一段话。',
    ].join('\n'),
    [
      'You are a server operations assistant. Below is a snapshot of a Linux server, collected and checked by rules.',
      'Write a 3–6 sentence interpretation in English: first one sentence on overall health, then the one or two things that matter most, likely causes, and what to look at next.',
      'Only use the data given; do not guess missing data, and copy numbers exactly.',
      'Do not suggest deleting, uninstalling, shutting down or giving up the machine, and do not list commands to run.',
      'No headings and no bullet points, just one paragraph.',
    ].join('\n'),
  )
}

/**
 * 让 AI 解读：插件直接调 DSH 的默认模型（和对话用的同一个），打开面板不花 token，点了才调。
 * @param deps.llm DSH 的 llm 服务；deps.defaultModel DSH 的 agentDefaultModel 服务
 */
export async function interpretStatus({ alias, env = process.env, llm, defaultModel, signal, now = Date.now }) {
  if (!llm?.stream || !defaultModel?.currentSelection) {
    const error = new Error(L('这个版本的 DSH 不让插件直接调用模型', 'This DSH version does not let plugins call the model directly'))
    error.code = 'no_llm'
    throw error
  }
  const cache = await readStatusCache(alias, env)
  if (!cache?.data) throw new Error(L('还没有采集过这台机器的状态', 'This machine has not been checked yet'))
  const judged = judge(cache.data, Date.parse(cache.collectedAt))
  const brief = statusBrief(alias, cache.data, judged)
  const route = defaultModel.currentSelection()
  const timeout = AbortSignal.timeout(120_000)
  const options = {
    provider: route.provider,
    model: route.model,
    system: systemPrompt(),
    // 和 DSH 的 createUserMessage 一样的形状；不直接引它的包，装好的插件不一定解析得到
    messages: [{ role: 'user', id: randomUUID(), content: [{ type: 'text', text: brief }], source: { kind: 'plugin:vps-manager' } }],
    maxTokens: 1200,
    purpose: 'vps-status',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }
  let text = ''
  let finish = { kind: 'stop' }
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason ?? finish
  }
  // 和 DSH 自己起标题的写法一致：error / aborted 算失败；写到 maxTokens 截断的照样用
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    const error = new Error(finish.failure?.message ?? L('模型调用失败', 'The model call failed'))
    error.code = finish.failure?.code
    throw error
  }
  text = text.trim()
  if (!text) throw new Error(L('模型没有给出内容', 'The model returned no text'))
  const interpretation = { text, at: new Date(now()).toISOString(), basedOn: cache.collectedAt, model: route.model, lang: currentLang() }
  await writeStatusCache(alias, { interpretation }, env)
  return { interpretation, brief }
}
