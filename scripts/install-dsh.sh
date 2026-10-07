#!/usr/bin/env bash
# scripts/install-dsh.sh — 兼容性检查里装指定版本的 DSH；npm 上暂时缺包就等一会儿再试
#
# 为什么要重试：DSH 发版时主包先上 npm，它依赖的子包可能晚几十分钟才传完
# （2026-10-03 的 0.2.1-alpha.1，子包晚了 25 分钟）。定时检查碰巧在这段空当里跑，
# npm 报 ETARGET，就会误报成「插件和这个 DSH 不兼容」。所以：
#   - npm 上缺包（ETARGET / E404）或网络错误：等 DSH_INSTALL_WAIT 秒（默认 10 分钟）再装，
#     最多装 DSH_INSTALL_TRIES 次（默认 4 次）
#   - 别的错误：直接失败，不白等
#   - 试满了还是缺包：在 $GITHUB_OUTPUT 写 upstream=true，问题单里写明是 DSH 自己装不上
#
# 用法：scripts/install-dsh.sh <版本> <安装目录> [日志文件]
# 每次 npm 的输出都追加到日志文件（失败时工作流把它贴进问题单）。
set -uo pipefail

usage='用法: scripts/install-dsh.sh <版本> <安装目录> [日志文件]'
version="${1:?$usage}"
dir="${2:?$usage}"
log="${3:-/dev/null}"
tries="${DSH_INSTALL_TRIES:-4}"
wait="${DSH_INSTALL_WAIT:-600}"
# npm 的错误码（npm 10 起写 "npm error code"，之前是 "npm ERR! code"）：
# 前两个是 npm 上还没有这个包或这个版本，后面是网络和 npm 服务端的错
retryable='npm (error|ERR!) code (ETARGET|E404|ECONNRESET|ETIMEDOUT|EAI_AGAIN|E5[0-9][0-9])'

mkdir -p "$dir" && cd "$dir" || exit 1
echo '{"private":true}' > package.json

for ((i = 1; i <= tries; i++)); do
  # 上一次装了一半的不要留着
  rm -rf node_modules package-lock.json
  out="$(npm install --no-audit --no-fund "@deepseek-ai/dsh@$version" 2>&1)"
  rc=$?
  printf '%s\n' "$out" | tee -a "$log"
  if [[ $rc -eq 0 ]]; then
    (( i > 1 )) && echo "DSH $version 第 $i 次才装上（前面 npm 上还缺包或网络不通）" | tee -a "$log"
    exit 0
  fi
  if ! grep -qE "$retryable" <<<"$out"; then
    exit "$rc"
  fi
  if (( i < tries )); then
    echo "第 $i 次装 DSH $version 失败：npm 上还缺包或网络不通，${wait} 秒后重试（共 $tries 次）" | tee -a "$log"
    sleep "$wait"
  fi
done

echo "装了 $tries 次，DSH $version 还是装不上：npm 上缺它依赖的包，或网络一直不通" | tee -a "$log"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo 'upstream=true' >> "$GITHUB_OUTPUT"
fi
exit 1
