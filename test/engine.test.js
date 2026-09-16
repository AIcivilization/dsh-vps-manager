// 用本机 `sh -s` 冒充远端 sshd：执行引擎的状态机可以完整验证，不需要真机。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATUS, runRemote } from '../lib/engine.js'
import { cancelTask, getTask, listTasks, parseTaskLines } from '../lib/task.js'
import { runProcess } from '../lib/spawn.js'
import { appendAudit, readAudit } from '../lib/audit.js'

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-eng-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  const runner = (alias, payload, opts = {}) =>
    runProcess('sh', ['-s'], {
      input: payload,
      env: { ...process.env, HOME: home },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    })
  return { home, env, runner }
}

test('只读执行：成功与失败都能拿到退出码', async () => {
  const { env, runner } = await sandbox()
  const ok = await runRemote({ alias: 'hk', body: 'echo hi', runner, env })
  assert.equal(ok.status, STATUS.done)
  assert.equal(ok.ok, true)
  assert.match(ok.stdout, /hi/)

  const bad = await runRemote({ alias: 'hk', body: 'echo boom >&2; exit 5', runner, env })
  assert.equal(bad.status, STATUS.failed)
  assert.equal(bad.exitCode, 5)
})

test('权限不足与系统不适用是独立状态，不会被当成普通失败', async () => {
  const { env, runner } = await sandbox()
  const noPriv = await runRemote({ alias: 'hk', body: 'SUDO=__NO_PRIV__\nneed_root\necho unreachable', runner, env })
  assert.equal(noPriv.status, STATUS.noPrivilege)
  assert.match(noPriv.hint, /免密 sudo/)

  const unmet = await runRemote({ alias: 'hk', body: 'not_supported "这条菜谱不支持该系统"', runner, env })
  assert.equal(unmet.status, STATUS.requiresUnmet)
})

test('ssh 没连上时不会被误判成“远端失败”', async () => {
  const { env } = await sandbox()
  const runner = async () => ({
    stdout: '',
    stderr: 'root@1.2.3.4: Permission denied (publickey).',
    exitCode: 255,
    aborted: false,
    timedOut: false,
    durationMs: 12,
    truncated: false,
  })
  const res = await runRemote({ alias: 'hk', body: 'echo never', runner, env })
  assert.equal(res.status, STATUS.sshError)
  assert.equal(res.reason, 'auth_failed')
  assert.equal(res.exitCode, 255, '255 是 ssh 自己的退出码，不是远端的')
  assert.match(res.hint, /公钥/)
})

test('参数校验不过时直接返回 invalid，不发起连接', async () => {
  const { env } = await sandbox()
  let called = false
  const runner = async () => {
    called = true
    return { stdout: '', stderr: '', exitCode: 0 }
  }
  const res = await runRemote({
    alias: 'hk',
    body: 'echo "$P_DOMAIN"',
    specs: [{ name: 'domain', pattern: '[A-Za-z0-9.-]+', required: true }],
    params: { domain: 'a.com; rm -rf /' },
    runner,
    env,
  })
  assert.equal(res.status, STATUS.invalid)
  assert.equal(called, false, '参数不合法就不该连出去')
})

test('远端任务：跑完拿到退出码，任务目录留在远端', async () => {
  const { home, env, runner } = await sandbox()
  const res = await runRemote({
    alias: 'hk',
    body: 'echo task-ok; exit 0',
    mode: 'task',
    waitSeconds: 15,
    meta: { source: 'test', action: 'exec' },
    runner,
    env,
  })
  assert.equal(res.status, STATUS.done)
  assert.match(res.stdout, /task-ok/)
  assert.ok(res.taskId)
  await access(join(home, '.cache/dsh-vps/tasks', res.taskId, 'rc'))
})

test('远端任务：等不及就转后台，能列出、能接回、能终止', async () => {
  const { env, runner } = await sandbox()
  const started = await runRemote({
    alias: 'hk',
    body: 'echo starting; sleep 20; echo never',
    mode: 'task',
    waitSeconds: 1,
    meta: { source: 'test', action: 'exec' },
    runner,
    env,
  })
  assert.equal(started.status, STATUS.detached, '超过等待上限应转后台而不是报错')
  assert.match(started.hint, /仍在远端后台运行/)
  assert.ok(started.taskId)

  const list = await listTasks({ alias: 'hk', runner, env })
  assert.equal(list.ok, true)
  const found = list.tasks.find((t) => t.taskId === started.taskId)
  assert.ok(found, '任务应出现在列表里')
  assert.equal(found.state, 'running')
  assert.equal(found.meta?.source, 'test')

  const one = await getTask({ alias: 'hk', taskId: started.taskId, runner, env })
  assert.equal(one.task.running, true)
  assert.match(one.log, /starting/)

  const cancelled = await cancelTask({ alias: 'hk', taskId: started.taskId, runner, env })
  assert.ok(['stopped', 'killed', 'already_stopped'].includes(cancelled.outcome), cancelled.stdout)
  assert.match(cancelled.hint, /终止|结束/)
})

test('任务被锁时返回持有者，不是一句笼统失败', async () => {
  const { env, runner } = await sandbox()
  const first = await runRemote({
    alias: 'hk',
    body: 'sleep 20',
    mode: 'task',
    waitSeconds: 1,
    meta: { source: 'panel', action: 'recipe', recipeId: 'install-docker' },
    runner,
    env,
  })
  assert.equal(first.status, STATUS.detached)

  const second = await runRemote({ alias: 'hk', body: 'echo second', mode: 'task', waitSeconds: 5, runner, env })
  assert.equal(second.status, STATUS.locked)
  assert.equal(second.lockOwner?.recipeId, 'install-docker')
  assert.match(second.hint, /另一个改动任务/)

  await cancelTask({ alias: 'hk', taskId: first.taskId, runner, env })
})

test('超长输出落 spill 文件', async () => {
  const { env, runner } = await sandbox()
  const res = await runRemote({
    alias: 'hk',
    body: 'i=0; while [ $i -lt 3000 ]; do echo "line $i 0123456789"; i=$((i+1)); done',
    runner,
    env,
  })
  assert.equal(res.status, STATUS.done)
  assert.equal(res.truncated, true)
  assert.ok(res.spillPath, '截断了就必须给出完整输出的路径')
  await access(res.spillPath)
})

test('parseTaskLines 解析远端任务行', () => {
  const meta = Buffer.from(JSON.stringify({ taskId: 't1', source: 'ai' })).toString('base64')
  const lines = [`TASK t1 0 123 0 456 ${meta}`, 'TASK t2 - 124 1 10 -', 'TASK t3 - 125 0 0 -'].join('\n')
  const tasks = parseTaskLines(lines)
  assert.equal(tasks[0].state, 'done')
  assert.equal(tasks[0].exitCode, 0)
  assert.equal(tasks[0].meta.source, 'ai')
  assert.equal(tasks[1].state, 'running')
  assert.equal(tasks[2].state, 'interrupted', '没退出码进程也没了 = 异常终止')
})

test('审计日志记哈希不记全文', async () => {
  const { env } = await sandbox()
  await appendAudit({
    source: 'ai',
    alias: 'hk',
    action: 'exec',
    finalTier: 'change',
    decision: 'allow',
    status: 'done',
    exitCode: 0,
    script: 'apt-get install -y nginx',
  }, env)
  const rows = await readAudit({ env })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].alias, 'hk')
  assert.equal(rows[0].scriptSha256.length, 64)
  assert.match(rows[0].scriptHead, /apt-get install/)
  assert.equal(rows[0].script, undefined, '不记完整脚本')
})
