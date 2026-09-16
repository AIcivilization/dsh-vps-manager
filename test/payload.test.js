// test/payload.test.js — 载荷协议的单元测试与本地端到端测试
//
// 端到端部分用本机 `sh -s` 代替远端 sshd：载荷从 stdin 进去，行为与远端一致，
// 因此注入、吞脚本、哨兵、退出码这几件事不用真机就能验。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PayloadError,
  buildReadPayload,
  buildRemoteScript,
  buildTaskPayload,
  makeNonce,
  parseOutput,
  shellQuote,
  validateParams,
} from '../lib/payload.js'

function runPayload(payload, home) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-s'], {
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ out, err, code }))
    child.stdin.end(payload)
  })
}

const fakeHome = () => mkdtemp(join(tmpdir(), 'dsh-vps-test-'))

test('shellQuote 转义单引号', () => {
  assert.equal(shellQuote('a.com'), "'a.com'")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(shellQuote('a; rm -rf /'), "'a; rm -rf /'")
})

test('validateParams 按 pattern 拦截、补默认值、拒绝未声明参数', () => {
  const specs = [
    { name: 'domain', pattern: '[A-Za-z0-9.-]{1,253}', required: true },
    { name: 'port', pattern: '[0-9]{1,5}', default: '80' },
  ]
  const ok = validateParams(specs, { domain: 'a.com' })
  assert.deepEqual(ok.normalized, { domain: 'a.com', port: '80' })
  assert.deepEqual(ok.assignments, ["P_DOMAIN='a.com'", "P_PORT='80'"])

  assert.throws(() => validateParams(specs, { domain: 'a.com; touch /tmp/pwned' }), (e) => {
    assert.ok(e instanceof PayloadError)
    assert.equal(e.code, 'param_invalid')
    return true
  })
  assert.throws(() => validateParams(specs, {}), (e) => e.code === 'param_missing')
  assert.throws(() => validateParams(specs, { domain: 'a.com', evil: 'x' }), (e) => e.code === 'param_unknown')
  assert.throws(() => validateParams(specs, { domain: 'a.com', port: '80\nrm -rf /' }), (e) => e.code === 'param_invalid')
})

test('buildRemoteScript 拼接前导、参数与正文', () => {
  const { script, params } = buildRemoteScript({
    prelude: 'PKG=apt',
    specs: [{ name: 'domain', pattern: '.+' }],
    params: { domain: "a'b" },
    body: 'echo "$P_DOMAIN"',
  })
  assert.match(script, /^PKG=apt/)
  assert.match(script, /P_DOMAIN='a'\\''b'/)
  assert.match(script, /echo "\$P_DOMAIN"\n$/)
  assert.deepEqual(params, { domain: "a'b" })
})

test('parseOutput：没有 BEGIN 表示脚本没跑起来', () => {
  const r = parseOutput('ssh: connect to host 1.2.3.4 port 22: Connection refused\n', makeNonce())
  assert.equal(r.started, false)
  assert.equal(r.exitCode, null)
})

test('parseOutput：剥掉哨兵与 BEGIN 之前的噪音', () => {
  const n = 'abc123def456'
  const raw = [
    'Welcome to Ubuntu 24.04 (from .bashrc)',
    `__DSH_BEGIN_${n}__`,
    'hello',
    '',
    `__DSH_RC_${n}__=7`,
    '',
  ].join('\n')
  const r = parseOutput(raw, n)
  assert.equal(r.started, true)
  assert.equal(r.output, 'hello')
  assert.equal(r.exitCode, 7)
  assert.match(r.noise, /Welcome to Ubuntu/)
})

test('parseOutput：任务、转后台、被锁三种标记', () => {
  const n = 'abc123def456'
  const task = parseOutput(`__DSH_BEGIN_${n}__\n__DSH_TASK_${n}__=t-1\nlog line\n__DSH_DETACHED_${n}__=t-1\n`, n)
  assert.equal(task.taskId, 't-1')
  assert.equal(task.detached, true)
  assert.equal(task.exitCode, null)
  assert.equal(task.output, 'log line')

  const owner = { taskId: 't-0', source: 'panel', recipe: 'install-docker' }
  const locked = parseOutput(`__DSH_BEGIN_${n}__\n__DSH_LOCKED_${n}__\n${JSON.stringify(owner)}\n`, n)
  assert.equal(locked.locked, true)
  assert.deepEqual(locked.lockOwner, owner)
})

test('端到端：参数里的注入串不会被执行，脚本也不会被 read 吞掉', async () => {
  const home = await fakeHome()
  const marker = join(home, 'pwned')
  const nonce = makeNonce()
  const { script } = buildRemoteScript({
    specs: [{ name: 'domain', pattern: '.+' }],
    params: { domain: `a.com; touch ${marker}` },
    body: [
      'echo "domain=[$P_DOMAIN]"',
      'read line || echo "stdin-empty"',
      'echo done',
      'exit 3',
    ].join('\n'),
  })
  const { out, code } = await runPayload(buildReadPayload({ script, nonce }), home)
  const r = parseOutput(out, nonce)

  assert.equal(code, 0, '载荷本身应正常结束')
  assert.equal(r.started, true)
  assert.equal(r.exitCode, 3, '远端脚本的退出码应原样拿到')
  assert.match(r.output, /domain=\[a\.com; touch /, '注入串应作为普通文本')
  assert.match(r.output, /stdin-empty/, '脚本自己的 stdin 必须是空的')
  assert.match(r.output, /done/)
  await assert.rejects(access(marker), '注入串绝不能被执行')
})

test('端到端：远端任务跑完能拿到日志和退出码', async () => {
  const home = await fakeHome()
  const nonce = makeNonce()
  const { script } = buildRemoteScript({ body: 'echo hello-task\nexit 7' })
  const payload = buildTaskPayload({ script, nonce, taskId: 'test-task-1', waitSeconds: 15 })
  const { out, code } = await runPayload(payload, home)
  const r = parseOutput(out, nonce)

  assert.equal(code, 0)
  assert.equal(r.taskId, 'test-task-1')
  assert.equal(r.exitCode, 7)
  assert.match(r.output, /hello-task/)
  assert.equal(r.locked, false)
  await access(join(home, '.cache/dsh-vps/tasks/test-task-1/rc'))
})

test('端到端：同机已有任务时拿到 locked 与持有者信息', async () => {
  const home = await fakeHome()
  const lockDir = join(home, '.cache/dsh-vps/lock')
  await mkdir(lockDir, { recursive: true })
  await writeFile(join(lockDir, 'pid'), `${process.pid}\n`)
  await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ taskId: 'busy-1', source: 'panel' }))

  const nonce = makeNonce()
  const { script } = buildRemoteScript({ body: 'echo should-not-run' })
  const { out } = await runPayload(buildTaskPayload({ script, nonce, taskId: 'test-task-2' }), home)
  const r = parseOutput(out, nonce)

  assert.equal(r.started, true)
  assert.equal(r.locked, true)
  assert.equal(r.lockOwner?.taskId, 'busy-1')
  await assert.rejects(access(join(home, '.cache/dsh-vps/tasks/test-task-2')), '被锁时不应创建任务目录')
})
