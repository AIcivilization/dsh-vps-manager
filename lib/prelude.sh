# dsh-vps 前导脚本（设计 8.5）
# 由插件在每次远端执行前注入到脚本最前面。POSIX sh，不用 bash 专有语法。
# 提供：OS_ID / OS_LIKE / OS_VER / OS_FAMILY / PKG / INIT / SUDO 与一组辅助函数。

OS_ID=unknown
OS_LIKE=""
OS_VER=""
if [ -r /etc/os-release ]; then
  . /etc/os-release 2>/dev/null
  OS_ID="${ID:-unknown}"
  OS_LIKE="${ID_LIKE:-}"
  OS_VER="${VERSION_ID:-}"
fi

# 发行版家族：debian | rhel | alpine | arch | suse | unknown
case " $OS_ID $OS_LIKE " in
  *" debian "*|*" ubuntu "*) OS_FAMILY=debian ;;
  *" rhel "*|*" fedora "*|*" centos "*) OS_FAMILY=rhel ;;
  *" alpine "*) OS_FAMILY=alpine ;;
  *" arch "*) OS_FAMILY=arch ;;
  *" suse "*|*" opensuse "*) OS_FAMILY=suse ;;
  *) OS_FAMILY=unknown ;;
esac

# 必须归一成 0 / 1：dash 的 `command -v` 找不到命令时返回 127，
# 直接透出去会让 detect 的结果变成「说不清」（实测 Ubuntu 的 /bin/sh 是 dash）
has_cmd() { command -v "$1" >/dev/null 2>&1 && return 0 || return 1; }

# 包管理器
if   has_cmd apt-get; then PKG=apt
elif has_cmd dnf;     then PKG=dnf
elif has_cmd yum;     then PKG=yum
elif has_cmd apk;     then PKG=apk
elif has_cmd pacman;  then PKG=pacman
elif has_cmd zypper;  then PKG=zypper
else PKG=unknown
fi

# init 系统
if [ -d /run/systemd/system ]; then INIT=systemd
elif has_cmd rc-service; then INIT=openrc
elif [ -d /etc/init.d ]; then INIT=sysvinit
else INIT=other
fi

# 提权：root 直接用；否则必须是免密 sudo（交互式 sudo 在非 TTY 下会读走脚本的 stdin）
if [ "$(id -u)" = 0 ]; then
  SUDO=""
elif has_cmd sudo && sudo -n true 2>/dev/null; then
  SUDO="sudo -n"
else
  SUDO="__NO_PRIV__"
fi

# 需要 root 的地方先调它：没有权限就以 96 退出，插件据此返回 no_privilege
need_root() {
  if [ "$SUDO" = "__NO_PRIV__" ]; then
    echo "dsh-vps: 需要 root 权限，但当前用户不是 root，也没有免密 sudo" >&2
    exit 96
  fi
  return 0
}

# 不适用当前系统时以 95 退出，插件据此返回 requires_unmet
not_supported() {
  echo "dsh-vps: ${1:-当前系统不受支持} (os=$OS_ID $OS_VER, pkg=$PKG, init=$INIT)" >&2
  exit 95
}

pkg_update() {
  need_root
  case "$PKG" in
    apt) $SUDO apt-get update -qq ;;
    dnf) $SUDO dnf -q makecache ;;
    yum) $SUDO yum -q makecache ;;
    apk) $SUDO apk update -q ;;
    pacman) $SUDO pacman -Sy --noconfirm ;;
    zypper) $SUDO zypper -q refresh ;;
    *) not_supported "没有可用的包管理器" ;;
  esac
}

pkg_install() {
  need_root
  [ $# -gt 0 ] || return 0
  case "$PKG" in
    apt)
      [ -d /var/lib/apt/lists ] && [ -z "$(ls -A /var/lib/apt/lists 2>/dev/null)" ] && pkg_update
      # env 传变量：root 登录时 $SUDO 为空，`$SUDO VAR=值 命令` 会把 VAR=值 当命令名
      # Dpkg::Use-Pty=0：关掉 "(Reading database ... 5%" 这类进度刷屏，否则日志被它占满
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Use-Pty=0 -o Dpkg::Options::=--force-confold "$@"
      ;;
    dnf) $SUDO dnf install -y -q "$@" ;;
    yum) $SUDO yum install -y -q "$@" ;;
    apk) $SUDO apk add --no-cache -q "$@" ;;
    pacman) $SUDO pacman -S --noconfirm --needed "$@" ;;
    zypper) $SUDO zypper -q install -y "$@" ;;
    *) not_supported "没有可用的包管理器" ;;
  esac
}

# 同样归一成 0 / 1
pkg_installed() {
  case "$PKG" in
    apt) dpkg -s "$1" >/dev/null 2>&1 && return 0 || return 1 ;;
    dnf|yum) rpm -q "$1" >/dev/null 2>&1 && return 0 || return 1 ;;
    apk) apk info -e "$1" >/dev/null 2>&1 && return 0 || return 1 ;;
    pacman) pacman -Q "$1" >/dev/null 2>&1 && return 0 || return 1 ;;
    zypper) rpm -q "$1" >/dev/null 2>&1 && return 0 || return 1 ;;
    *) return 1 ;;
  esac
}

svc_enable_start() {
  need_root
  case "$INIT" in
    systemd) $SUDO systemctl enable --now "$1" ;;
    openrc) $SUDO rc-update add "$1" default >/dev/null 2>&1; $SUDO rc-service "$1" start ;;
    sysvinit) $SUDO service "$1" start ;;
    *) not_supported "无法管理服务" ;;
  esac
}

# 注意：一律归一成 0 / 1。systemctl is-active 对「未运行」返回 3，
# 直接透出去会破坏 detect 的「0=已装 1=未装」约定，让插件判成「说不清」。
svc_active() {
  case "$INIT" in
    systemd) systemctl is-active --quiet "$1" && return 0 || return 1 ;;
    openrc) rc-service "$1" status >/dev/null 2>&1 && return 0 || return 1 ;;
    sysvinit) service "$1" status >/dev/null 2>&1 && return 0 || return 1 ;;
    *) return 1 ;;
  esac
}

svc_reload() {
  need_root
  case "$INIT" in
    systemd) $SUDO systemctl reload-or-restart "$1" ;;
    openrc) $SUDO rc-service "$1" restart ;;
    sysvinit) $SUDO service "$1" restart ;;
    *) not_supported "无法管理服务" ;;
  esac
}

# 端口是否被监听（给 detect / verify 用）
port_listening() {
  if has_cmd ss; then
    ss -lnt 2>/dev/null | grep -qE "[:.]$1[[:space:]]" && return 0 || return 1
  elif has_cmd netstat; then
    netstat -lnt 2>/dev/null | grep -qE "[:.]$1[[:space:]]" && return 0 || return 1
  fi
  return 1
}

# 只读查询想尽量用 sudo，但没权限时也不该报错：用 $SUDO_OPT
if [ "$SUDO" = "__NO_PRIV__" ]; then SUDO_OPT=""; else SUDO_OPT="$SUDO"; fi
