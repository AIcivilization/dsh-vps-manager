import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CappedBuffer, ProcessError, cleanOutput, runProcess } from '../lib/spawn.js'
import { SshError, assertAlias, baseOptions, classifySshFailure, sshArgs } from '../lib/ssh.js'

test('runProcess 拿到退出码与输出', async () => {
  const r = await runProcess('sh', ['-c', 'printf hello; printf oops >&2; exit 4'])
  assert.equal(r.exitCode, 4)
  assert.equal(r.stdout, 'hello')
  assert.equal(r.stderr, 'oops')
  assert.equal(r.timedOut, false)
  assert.equal(r.aborted, false)
})

test('runProcess 能喂 stdin（官方 runNativeCommand 做不到的那件事）', async () => {
  const r = await runProcess('cat', [], { input: 'from-stdin' })
  assert.equal(r.exitCode, 0)
  assert.equal(r.stdout, 'from-stdin')
})

test('runProcess 输出超限时头尾都留', async () => {
  const r = await runProcess('sh', ['-c', 'echo HEAD; i=0; while [ $i -lt 4000 ]; do echo 0123456789; i=$((i+1)); done; echo TAIL'])
  assert.equal(r.exitCode, 0)
  assert.equal(r.truncated, true)
  assert.match(r.stdout, /^HEAD/)
  assert.match(r.stdout, /TAIL\s*$/)
  assert.match(r.stdout, /中间已省略/)
  assert.ok(r.stdout.length < 20000, '返回值必须有上限')
  assert.ok(r.bytes > 40000, '但仍要知道真实体量')
})

test('runProcess 超时会杀掉进程', async () => {
  const r = await runProcess('sh', ['-c', 'sleep 5'], { timeoutMs: 300 })
  assert.equal(r.timedOut, true)
  assert.equal(r.signal, 'SIGTERM')
})

test('runProcess 接取消信号', async () => {
  const ac = new AbortController()
  const p = runProcess('sh', ['-c', 'sleep 5'], { signal: ac.signal })
  setTimeout(() => ac.abort(), 200)
  const r = await p
  assert.equal(r.aborted, true)
})

test('runProcess 区分“本机没有这个命令”', async () => {
  await assert.rejects(runProcess('dsh-vps-no-such-cmd', []), (e) => {
    assert.ok(e instanceof ProcessError)
    assert.equal(e.code, 'not_found')
    return true
  })
})

test('cleanOutput 去掉 ANSI 与控制字符', () => {
  assert.equal(cleanOutput('[32mok[0m\r\ndone'), 'ok\ndone')
})

test('CappedBuffer 不会把多字节字符切坏', () => {
  const buf = new CappedBuffer(10, 10)
  const bytes = Buffer.from('中文测试')
  buf.push(bytes.subarray(0, 4))
  buf.push(bytes.subarray(4))
  assert.match(buf.value().text, /中文测试/)
})

test('别名白名单挡住选项注入', () => {
  assert.equal(assertAlias('hk'), 'hk')
  assert.equal(assertAlias('us-west.1'), 'us-west.1')
  for (const bad of ['-oProxyCommand=touch /tmp/pwned', 'a b', 'a;b', '', '../x', 'a/b']) {
    assert.throws(() => assertAlias(bad), (e) => e instanceof SshError && e.reason === 'invalid_alias')
  }
})

test('sshArgs 带齐必须的选项，别名前有 --', () => {
  const args = sshArgs('hk')
  const joined = args.join(' ')
  for (const must of [
    'BatchMode=yes',
    'ConnectTimeout=10',
    'ServerAliveInterval=15',
    'StrictHostKeyChecking=accept-new',
    'LogLevel=ERROR',
    'ControlMaster=auto',
    'ControlPath=~/.ssh/cm-%C',
    'ControlPersist=10m',
  ]) {
    assert.ok(joined.includes(must), `缺少 ${must}`)
  }
  assert.equal(args.at(-1), 'sh -s', '远端命令必须是常量')
  assert.equal(args.at(-2), 'hk')
  assert.equal(args.at(-3), '--')
  assert.ok(!joined.includes('SetEnv'), '环境变量应该在载荷里 export，不走 SetEnv')
})

test('连通性保险必须绕开连接复用', () => {
  const joined = baseOptions({ controlMaster: false }).join(' ')
  assert.ok(joined.includes('ControlMaster=no'))
  assert.ok(joined.includes('ControlPath=none'))
})

test('classifySshFailure 把常见报错翻译成原因', () => {
  const cases = [
    ['@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 'host_key_changed'],
    ['root@1.2.3.4: Permission denied (publickey).', 'auth_failed'],
    ['ssh: connect to host 1.2.3.4 port 22: Connection refused', 'refused'],
    ['ssh: connect to host 1.2.3.4 port 22: Operation timed out', 'timeout'],
    ['ssh: Could not resolve hostname nope: Name or service not known', 'dns'],
    ['Load key "/x/id_ed25519": incorrect passphrase supplied', 'key_passphrase'],
  ]
  for (const [stderr, reason] of cases) {
    const r = classifySshFailure(stderr, 255)
    assert.equal(r.reason, reason, stderr)
    assert.ok(r.hint.length > 0)
  }
  assert.equal(classifySshFailure('something weird', 255).reason, 'ssh_unknown')
})
