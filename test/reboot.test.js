// /vps-reboot：不可能在测试里真重启，所以用一台「假远端」按脚本标记回话，
// 再配一个假时钟，把「连不上 → 还是旧 boot_id → 新 boot_id → 容器慢慢起来」走一遍。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { STATUS } from '../lib/engine.js'
import {
  SCRIPTS, assessCheck, formatPlan, formatResult, kernelChange, parseKv, rebootCheck, rebootNow,
} from '../lib/reboot.js'
import { runProcess } from '../lib/spawn.js'

// 用户那台机器重启前的真实样子（2026-09-16 实测）
const CHECK_OUT = [
  'boot_id=aaaa-old',
  'kernel=6.8.0-124-generic',
  'latest_kernel=6.8.0-139-generic',
  'uptime=12 weeks, 2 days',
  'required=1',
  'pkgs=libc6 linux-base linux-image-6.8.0-134-generic linux-image-6.8.0-139-generic ',
  'pkg_busy=',
  'container=mailserver|always',
  'docker_enabled=enabled',
].join('\n')

function fakeRemote({ check = CHECK_OUT, downProbes = 2, sameIdProbes = 1, containerDelay = 1, after = {}, trigger } = {}) {
  const calls = []
  let probes = 0
  let afters = 0
  const clock = { t: 0 }
  const run = async (body, opts = {}) => {
    const kind = Object.keys(SCRIPTS).find((k) => body === SCRIPTS[k])
    calls.push({ kind, opts })
    const ok = (stdout) => ({ ok: true, status: STATUS.done, exitCode: 0, stdout, stderr: '' })
    if (kind === 'check') return ok(check)
    if (kind === 'trigger') return trigger ?? ok('boot_id=aaaa-old\nscheduled=1')
    if (kind === 'probe') {
      probes += 1
      if (probes <= sameIdProbes) return ok('boot_id=aaaa-old') // 还没倒下
      if (probes <= sameIdProbes + downProbes) return { ok: false, status: STATUS.sshError, stdout: '', stderr: 'Connection refused', hint: '连不上' }
      return ok('boot_id=bbbb-new')
    }
    if (kind === 'after') {
      afters += 1
      const up = afters > containerDelay ? ['up=mailserver'] : []
      return ok([
        `kernel=${after.kernel ?? '6.8.0-139-generic'}`,
        'uptime=1 minute',
        `required=${after.required ?? 0}`,
        `system=${afters > containerDelay ? 'running' : 'starting'}`,
        `failed=${after.failed ?? ''}`,
        ...(after.noContainers ? [] : up),
      ].join('\n'))
    }
    throw new Error(`假远端不认识这段脚本：${body.slice(0, 40)}`)
  }
  const sleep = async (ms) => { clock.t += ms }
  const now = () => clock.t
  return { run, sleep, now, calls, clock }
}

test('kernelChange 只留不同的那段', () => {
  assert.equal(kernelChange('6.8.0-124-generic', '6.8.0-139-generic'), '内核 124 → 139')
  assert.equal(kernelChange('5.14.0-362.el9.x86_64', '5.14.0-427.el9.x86_64'), '内核 362 → 427')
  assert.equal(kernelChange('6.8.0-139-generic', '6.8.0-139-generic'), '内核 6.8.0-139-generic（未变）')
  assert.equal(kernelChange('', '6.8.0'), '')
})

test('检查：该不该重启、能不能重启、容器会不会自己回来', () => {
  const a = assessCheck(parseKv(CHECK_OUT))
  assert.equal(a.required, true)
  assert.equal(a.kernelPending, true)
  assert.deepEqual(a.blockers, [])
  assert.deepEqual(a.autoStart, ['mailserver'])
  assert.deepEqual(a.manual, [])

  // apt 正在装：必须拦下
  const busy = assessCheck(parseKv(`${CHECK_OUT}\npkg_busy=1234 apt-get upgrade -y;`))
  assert.match(busy.blockers[0], /包管理器正在装东西/)

  // 本插件的任务在跑：也拦下
  const task = assessCheck(parseKv(`${CHECK_OUT}\ntask_busy=20260916-200235-c218`))
  assert.match(task.blockers[0], /20260916-200235-c218/)

  // 没设重启策略的容器、Docker 不开机自启：都算「要手动起」
  const manual = assessCheck(parseKv('kernel=6.8.0-139-generic\ncontainer=web|no\ncontainer=db|always\ndocker_enabled=disabled'))
  assert.deepEqual(manual.autoStart, [])
  assert.deepEqual(manual.manual, ['web', 'db'])
  assert.equal(manual.dockerWontStart, true)

  // Alpine 的 vmlinuz-lts 不是版本号，不能拿来跟 uname -r 比
  assert.equal(assessCheck(parseKv('kernel=6.6.30-0-lts\nlatest_kernel=lts\nrequired=0')).required, false)
})

test('计划页第一行就是结论，并给出可照抄的确认命令', () => {
  const plan = formatPlan({ alias: 'vps-dsh', head: '[vps-dsh · 1.2.3.4] 洛杉矶', check: { ok: true, ...(() => { const kv = parseKv(CHECK_OUT); return { kv, assessment: assessCheck(kv) } })() } })
  assert.equal(plan.kind, 'success')
  const lines = plan.text.split('\n')
  assert.equal(lines[0], '[vps-dsh] 该重启了：内核 124 → 139 · libc6 待生效 · 确认发 /vps-yes')
  assert.match(plan.text, /mailserver　会自己起来（重启策略 always）/)

  const kvBusy = parseKv(`${CHECK_OUT}\npkg_busy=1234 apt-get upgrade -y;`)
  const blocked = formatPlan({ alias: 'vps-dsh', head: '', check: { ok: true, kv: kvBusy, assessment: assessCheck(kvBusy) } })
  assert.equal(blocked.kind, 'error')
  assert.match(blocked.text.split('\n')[0], /^\[vps-dsh\] 现在别重启：包管理器正在装东西/)
  assert.doesNotMatch(blocked.text, /vps-yes/, '拦下时不能给出确认命令')
})

test('重启全流程：等旧 boot_id 消失、连不上、再连上，等容器起来再报告', async () => {
  const remote = fakeRemote()
  let closed = 0
  const r = await rebootNow({ ...remote, closeMaster: async () => { closed += 1 } })
  assert.equal(r.phase, 'done')
  assert.equal(closed, 1, '发出重启后要关掉复用连接')
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.failed, [])

  // 探测和回来后的检查都必须走新连接：复用连接这时指着一条死 TCP
  for (const c of remote.calls.filter((x) => x.kind === 'probe' || x.kind === 'after')) {
    assert.equal(c.opts.freshConnection, true, `${c.kind} 必须用新连接`)
  }
  // 容器第一次还没起来，要等第二次
  assert.equal(remote.calls.filter((x) => x.kind === 'after').length, 2)

  const out = formatResult({ alias: 'vps-dsh', head: '[vps-dsh]', result: r })
  assert.equal(out.kind, 'success')
  assert.match(out.text.split('\n')[0], /^\[vps-dsh\] 重启完成，用时 \d+ 秒 · 内核 124 → 139 · 容器 1\/1 已起来 · 无失败服务$/)
})

test('发之前再查一遍：计划页之后开始 apt 了，就不发重启', async () => {
  const remote = fakeRemote({ check: `${CHECK_OUT}\npkg_busy=999 apt-get install nginx;` })
  const r = await rebootNow({ ...remote })
  assert.equal(r.phase, 'blocked')
  assert.equal(remote.calls.some((c) => c.kind === 'trigger'), false, '被拦下时绝不能发出重启')
  assert.match(formatResult({ alias: 'hk', head: '', result: r }).text.split('\n')[0], /^\[hk\] 没重启：包管理器正在装东西/)
})

test('没有 root：说清楚，不假装在等', async () => {
  const remote = fakeRemote({
    trigger: { ok: false, status: STATUS.noPrivilege, exitCode: 96, stdout: '', stderr: 'dsh-vps: 需要 root 权限', hint: '需要 root 权限' },
  })
  const r = await rebootNow({ ...remote })
  assert.equal(r.phase, 'trigger')
  assert.equal(remote.calls.some((c) => c.kind === 'probe'), false)
  assert.equal(formatResult({ alias: 'hk', head: '', result: r }).text.split('\n')[0], '[hk] 没重启：需要 root 或免密 sudo')
})

test('一直回不来：超时后第一行叫你去服务商后台，而不是一直挂着', async () => {
  const remote = fakeRemote({ downProbes: 10_000 })
  const r = await rebootNow({ ...remote, waitMs: 300_000 })
  assert.equal(r.phase, 'timeout')
  assert.equal(r.sawDown, true)
  const out = formatResult({ alias: 'hk', head: '', result: r })
  assert.equal(out.kind, 'error')
  assert.match(out.text.split('\n')[0], /^\[hk\] 发出重启 5 分钟后仍连不上：去服务商后台看控制台$/)
})

test('回来了但容器没起来、有服务失败：第一行先说问题', async () => {
  const remote = fakeRemote({ after: { noContainers: true, failed: 'nginx.service' } })
  const r = await rebootNow({ ...remote, settleMs: 30_000 })
  assert.equal(r.phase, 'done')
  assert.deepEqual(r.missing, ['mailserver'])
  const out = formatResult({ alias: 'hk', head: '', result: r })
  assert.equal(out.kind, 'error')
  const first = out.text.split('\n')[0]
  assert.match(first, /^\[hk\] 重启完成，但mailserver 没起来、1 个服务失败/)
  assert.match(out.text, /\/vps-logs nginx 看原因/)
})

test('远端脚本本身语法正确（前导 + 四段脚本逐个 sh -n）', async () => {
  const prelude = await readFile(new URL('../lib/prelude.sh', import.meta.url), 'utf8')
  for (const [name, body] of Object.entries(SCRIPTS)) {
    const res = await runProcess('sh', ['-n'], { input: `${prelude}\n${body}`, timeoutMs: 10_000 })
    assert.equal(res.exitCode, 0, `${name} 脚本语法错误：${res.stderr}`)
  }
})

test('检查脚本能在真 shell 里跑完，并吐出可解析的结果', async () => {
  const prelude = await readFile(new URL('../lib/prelude.sh', import.meta.url), 'utf8')
  const run = async (body) => {
    const res = await runProcess('sh', ['-s'], { input: `${prelude}\n${body}`, timeoutMs: 20_000 })
    return { ok: res.exitCode === 0, status: res.exitCode === 0 ? STATUS.done : STATUS.failed, stdout: res.stdout, stderr: res.stderr }
  }
  const check = await rebootCheck({ run })
  assert.equal(check.ok, true, check.res?.stderr)
  assert.ok(check.kv.kernel, '至少要读到内核版本')
  assert.ok('required' in check.kv)
})
