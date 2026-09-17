// lib/reboot.js — /vps-reboot：重启服务器，并等它回来
//
// 为什么不直接 /vps-sh --yes reboot：连接一断，引擎只能判成「转后台 / 还在跑」——
// 这句话是错的；它也不等机器回来，更不告诉你回来后好不好。这里分三步：
//   1. 检查：为什么该重启（内核 / libc 待生效）、现在能不能重启（包管理器在装、本插件
//      有任务在跑）、会停哪些容器、它们会不会自己起来
//   2. 发出：远端 setsid 延迟 3 秒再重启，让这次 ssh 先干净地返回
//   3. 等回来：用**全新连接**探测 boot_id（复用连接此刻指着一条死 TCP，会挂住），
//      boot_id 变了才算重启完成；再等原先在跑、且会自动启动的容器起来，
//      最后报告内核、容器、失败的服务

import { STATUS } from './engine.js'

const AUTO_RESTART = new Set(['always', 'unless-stopped'])

// 脚本用 String.raw：里面的 \n 要原样交给远端 tr，不能被 JS 提前换成换行
export const SCRIPTS = {
  check: String.raw`# dsh-vps:reboot-check
echo "boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
echo "kernel=$(uname -r)"
echo "latest_kernel=$(ls /boot/vmlinuz-* 2>/dev/null | sed 's#.*/vmlinuz-##' | sort -V | tail -1)"
echo "uptime=$(uptime -p 2>/dev/null | sed 's/^up //')"
req=0
[ -f /var/run/reboot-required ] && req=1
if has_cmd needs-restarting; then needs-restarting -r >/dev/null 2>&1; [ $? = 1 ] && req=1; fi
echo "required=$req"
[ -f /var/run/reboot-required.pkgs ] && echo "pkgs=$(sort -u /var/run/reboot-required.pkgs | tr '\n' ' ')"
# 包管理器正在工作就别重启：apt / dnf 被拦腰打断，系统可能起不来
# unattended-upgrade-shutdown 只是常驻等关机信号，不算在装
busy=$(ps -eo pid=,args= 2>/dev/null | grep -E '(^|[ /])(apt|apt-get|aptitude|dpkg|unattended-upgrade|dnf|yum|zypper|pacman|apk)( |$)' | grep -v -e unattended-upgrade-shutdown -e 'grep -E' | head -2 | tr '\n' ';')
echo "pkg_busy=$busy"
L="$HOME/.cache/dsh-vps/lock"
if [ -d "$L" ]; then
  p=$(cat "$L/pid" 2>/dev/null)
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
    echo "task_busy=$(sed -n 's/.*"taskId": *"\([^"]*\)".*/\1/p' "$L/owner.json" 2>/dev/null | head -1)"
  fi
fi
if has_cmd docker && [ "$SUDO" != "__NO_PRIV__" ]; then
  for n in $($SUDO docker ps --format '{{.Names}}' 2>/dev/null); do
    echo "container=$n|$($SUDO docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$n" 2>/dev/null)"
  done
  [ "$INIT" = systemd ] && echo "docker_enabled=$(systemctl is-enabled docker 2>/dev/null)"
fi
`,

  trigger: String.raw`# dsh-vps:reboot-trigger
need_root
if has_cmd setsid; then LAUNCH=setsid; else LAUNCH=nohup; fi
if [ "$INIT" = systemd ]; then CMD="systemctl reboot"; else CMD="reboot"; fi
$LAUNCH $SUDO sh -c "sleep 3; $CMD || reboot" </dev/null >/dev/null 2>&1 &
echo "boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
echo "scheduled=1"
`,

  probe: String.raw`# dsh-vps:reboot-probe
echo "boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
`,

  after: String.raw`# dsh-vps:reboot-after
echo "kernel=$(uname -r)"
echo "uptime=$(uptime -p 2>/dev/null | sed 's/^up //')"
[ -f /var/run/reboot-required ] && echo required=1 || echo required=0
if [ "$INIT" = systemd ]; then
  echo "system=$(systemctl is-system-running 2>/dev/null)"
  echo "failed=$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
fi
if has_cmd docker && [ "$SUDO" != "__NO_PRIV__" ]; then
  for n in $($SUDO docker ps --format '{{.Names}}' 2>/dev/null); do echo "up=$n"; done
fi
`,
}

/** key=value 行 → 对象；container= / up= 可以有多行 */
export function parseKv(text) {
  const out = { containers: [], up: [] }
  for (const line of String(text ?? '').split('\n')) {
    const i = line.indexOf('=')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim()
    if (key === 'container') {
      const [name, policy = ''] = value.split('|')
      if (name) out.containers.push({ name, policy })
    } else if (key === 'up') {
      if (value) out.up.push(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** 「6.8.0-124-generic → 6.8.0-139-generic」只留不同的那段：「内核 124 → 139」 */
export function kernelChange(before, after) {
  if (!before || !after) return ''
  if (before === after) return `内核 ${before}（未变）`
  const a = before.split(/([.-])/)
  const b = after.split(/([.-])/)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const mid = (parts) => parts.slice(head, parts.length - tail).join('').replace(/^[.-]+|[.-]+$/g, '')
  return `内核 ${mid(a) || before} → ${mid(b) || after}`
}

/** 检查结果 → 该不该重启、能不能重启、容器会不会自己回来 */
export function assessCheck(kv) {
  const pending = String(kv.pkgs ?? '').split(/\s+/).filter(Boolean)
  const kernelPending = /^\d/.test(kv.latest_kernel ?? '') && Boolean(kv.kernel) && kv.latest_kernel !== kv.kernel
  const required = kv.required === '1' || kernelPending
  const blockers = []
  if (kv.pkg_busy) blockers.push(`包管理器正在装东西（${kv.pkg_busy.replace(/;$/, '').slice(0, 60)}）`)
  if (kv.task_busy !== undefined) blockers.push(`本插件有任务在跑（${kv.task_busy || '任务号未知'}）`)
  const dockerWontStart = Boolean(kv.docker_enabled) && kv.docker_enabled !== 'enabled'
  const containers = kv.containers ?? []
  const autoStart = dockerWontStart ? [] : containers.filter((c) => AUTO_RESTART.has(c.policy)).map((c) => c.name)
  const manual = containers.map((c) => c.name).filter((n) => !autoStart.includes(n))
  return { required, kernelPending, pending, blockers, containers, autoStart, manual, dockerWontStart }
}

function whyText(assessment, kv) {
  const parts = []
  if (assessment.kernelPending) parts.push(kernelChange(kv.kernel, kv.latest_kernel))
  const others = [...new Set(assessment.pending.filter((p) => !/^linux-(image|base|modules|headers)/.test(p)))]
  if (others.length) parts.push(`${others.slice(0, 3).join('、')}${others.length > 3 ? ` 等 ${others.length} 个` : ''} 待生效`)
  if (!parts.length) parts.push('系统标记了需要重启')
  return parts.join(' · ')
}

export async function rebootCheck({ run }) {
  const res = await run(SCRIPTS.check, { mode: 'read', timeoutMs: 30_000 })
  if (!res.ok) return { ok: false, res }
  const kv = parseKv(res.stdout)
  return { ok: true, kv, assessment: assessCheck(kv) }
}

/**
 * 发出重启并等它回来。
 * @param {object} o
 * @param {Function} o.run          (body, opts) => runRemote 结果；测试里替换
 * @param {Function} o.closeMaster  关掉指向旧连接的复用主进程
 * @param {Function} [o.sleep]
 * @param {Function} [o.now]
 * @param {number}   [o.waitMs]     最多等机器回来多久
 * @param {number}   [o.settleMs]   回来后最多等容器 / systemd 起来多久
 */
export async function rebootNow({
  run,
  closeMaster = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  waitMs = 300_000,
  settleMs = 90_000,
  signal,
}) {
  // 计划页之后可能有人开始 apt 了，发之前再查一遍
  const check = await rebootCheck({ run })
  if (!check.ok) return { phase: 'check', ok: false, res: check.res }
  const { kv, assessment } = check
  if (assessment.blockers.length) return { phase: 'blocked', ok: false, kv, assessment }

  const trigger = await run(SCRIPTS.trigger, { mode: 'read', timeoutMs: 30_000 })
  if (!trigger.ok) return { phase: 'trigger', ok: false, res: trigger, kv, assessment }
  const bootBefore = parseKv(trigger.stdout).boot_id || kv.boot_id || ''
  const sentAt = now()
  await Promise.resolve().then(() => closeMaster()).catch(() => {}) // 关不掉也不影响：后面全用新连接

  // 等 boot_id 变。拿不到 boot_id 的系统退而求其次：先断过、再连上
  await sleep(10_000)
  let backAt = null
  let sawDown = false
  while (now() - sentAt < waitMs) {
    if (signal?.aborted) return { phase: 'aborted', ok: false, kv, assessment }
    const probe = await run(SCRIPTS.probe, { mode: 'read', timeoutMs: 15_000, freshConnection: true, withPrelude: false })
    if (!probe.ok) {
      sawDown = true
    } else {
      const id = parseKv(probe.stdout).boot_id || ''
      if ((bootBefore && id && id !== bootBefore) || (!bootBefore && sawDown)) {
        backAt = now()
        break
      }
    }
    await sleep(5_000)
  }
  if (!backAt) return { phase: 'timeout', ok: false, kv, assessment, sawDown, waitedMs: now() - sentAt }

  // 回来了：等 systemd 启动完、该自己起来的容器起来
  let after = null
  const settleEnd = now() + settleMs
  for (;;) {
    const res = await run(SCRIPTS.after, { mode: 'read', timeoutMs: 30_000, freshConnection: true })
    if (res.ok) after = parseKv(res.stdout)
    const missing = after ? assessment.autoStart.filter((n) => !after.up.includes(n)) : assessment.autoStart
    const booting = after && ['starting', 'initializing'].includes(after.system)
    if (after && !missing.length && !booting) break
    if (now() >= settleEnd) break
    await sleep(5_000)
  }

  const up = after?.up ?? []
  return {
    phase: 'done',
    ok: true,
    kv,
    assessment,
    tookMs: backAt - sentAt,
    kernelBefore: kv.kernel,
    kernelAfter: after?.kernel ?? '',
    missing: assessment.autoStart.filter((n) => !up.includes(n)),
    manualDown: assessment.manual.filter((n) => !up.includes(n)),
    failed: String(after?.failed ?? '').split(/\s+/).filter(Boolean),
    stillRequired: after?.required === '1',
    uptime: after?.uptime ?? '',
    afterRead: Boolean(after),
  }
}

/**
 * 计划页：第一行就是结论。返回 { kind, text }
 * 确认命令必须是不带参数的 /vps-yes：/vps-reboot 没声明 input，DSH 不会把后面的字交给插件
 */
export function formatPlan({ alias, head, check, confirm = '/vps-yes' }) {
  if (!check.ok) return formatResult({ alias, head, result: { phase: 'check', res: check.res } })
  const { kv, assessment: a } = check
  const lines = []
  if (a.blockers.length) lines.push(`[${alias}] 现在别重启：${a.blockers[0]}`)
  else if (a.required) lines.push(`[${alias}] 该重启了：${whyText(a, kv)} · 确认发 ${confirm}`)
  else lines.push(`[${alias}] 不需要重启：没有待生效的更新 · 硬要重启发 ${confirm}`)
  lines.push(head)
  if (kv.uptime) lines.push(`已连续运行：${kv.uptime}`)
  if (a.pending.length) lines.push(`待生效的包：${[...new Set(a.pending)].join('、')}`)
  for (const b of a.blockers.slice(1)) lines.push(`另外：${b}`)
  if (a.containers.length) {
    lines.push('', '重启时会停的容器：')
    for (const c of a.containers) {
      lines.push(a.autoStart.includes(c.name)
        ? `  ${c.name}　会自己起来（重启策略 ${c.policy}）`
        : `  ${c.name}　不会自己起来（重启策略 ${c.policy || 'no'}），重启后要手动 docker start ${c.name}`)
    }
    if (a.dockerWontStart) lines.push(`  ⚠ Docker 没设开机自启（${kv.docker_enabled}），重启后所有容器都起不来`)
  }
  if (!a.blockers.length) {
    lines.push('', `重启期间机器连不上，一般一两分钟。发 ${confirm} 后会一直等它回来，再报告内核、容器和失败的服务（5 分钟内有效）`)
  }
  return { kind: a.blockers.length ? 'error' : 'success', text: lines.join('\n') }
}

/** 执行结果：{ kind, text } */
export function formatResult({ alias, head, result: r }) {
  const text = (lines) => lines.filter((x) => x !== undefined && x !== null && x !== '').join('\n')
  if (r.phase === 'blocked') {
    return { kind: 'error', text: text([`[${alias}] 没重启：${r.assessment.blockers[0]}，等它结束再试`, head]) }
  }
  if (r.phase === 'check' || r.phase === 'trigger') {
    const res = r.res ?? {}
    const why = res.status === STATUS.noPrivilege
      ? '需要 root 或免密 sudo'
      : res.status === STATUS.sshError
        ? `连不上机器（${res.hint ?? res.reason ?? ''}）`
        : res.hint || '远端执行失败'
    return { kind: 'error', text: text([`[${alias}] 没重启：${why}`, head, String(res.stderr ?? '').trim().slice(0, 500)]) }
  }
  if (r.phase === 'aborted') {
    return { kind: 'error', text: text([`[${alias}] 已停止等待：重启已经发出，用 /vps-ping 看它回来没有`, head]) }
  }
  if (r.phase === 'timeout') {
    const minutes = Math.round((r.waitedMs ?? 0) / 60_000)
    return {
      kind: 'error',
      text: text([
        `[${alias}] 发出重启 ${minutes} 分钟后仍连不上：去服务商后台看控制台`,
        head,
        r.sawDown
          ? '期间一直连不上。可能还在开机自检、卡在磁盘检查，或者网络没起来'
          : '期间一直连得上，但机器没有真正重启（boot_id 没变），重启命令可能被拦下了',
      ]),
    }
  }

  const seconds = Math.round((r.tookMs ?? 0) / 1000)
  const problems = []
  if (r.missing.length) problems.push(`${r.missing.join('、')} 没起来`)
  if (r.failed.length) problems.push(`${r.failed.length} 个服务失败`)
  if (r.manualDown.length) problems.push(`${r.manualDown.join('、')} 要手动启动`)
  if (!r.afterRead) problems.push('回来后读不到状态')

  const facts = [`用时 ${seconds} 秒`, kernelChange(r.kernelBefore, r.kernelAfter)]
  if (r.assessment.autoStart.length && !r.missing.length) {
    facts.push(`容器 ${r.assessment.autoStart.length}/${r.assessment.autoStart.length} 已起来`)
  }
  if (!r.failed.length && r.afterRead) facts.push('无失败服务')

  const first = problems.length
    ? `[${alias}] 重启完成，但${problems.join('、')} · ${facts.filter(Boolean).join(' · ')}`
    : `[${alias}] 重启完成，${facts.filter(Boolean).join(' · ')}`
  return {
    kind: problems.length ? 'error' : 'success',
    text: text([
      first,
      head,
      r.failed.length ? `失败的服务：${r.failed.join('、')}（/vps-logs ${r.failed[0].replace(/\.service$/, '')} 看原因）` : '',
      r.missing.length ? `设了自动启动却没起来的容器：${r.missing.join('、')}（/vps-sh docker logs --tail 50 ${r.missing[0]}）` : '',
      r.manualDown.length ? `没设自动启动的容器：${r.manualDown.map((n) => `docker start ${n}`).join('；')}` : '',
      r.stillRequired ? '仍有更新等着重启才生效（多半是刚又装了新的）' : '',
    ]),
  }
}
