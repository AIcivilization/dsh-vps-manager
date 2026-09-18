// 连得上吗：顶部方块的颜色看这里。实测教训：原来方块只表示「选了这台」，
// SSH 配置被卸载移走后照样是绿的，命令和终端却全部失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readState } from '../lib/config.js'
import { STATUS, runRemote } from '../lib/engine.js'
import { checkReach, noteReach } from '../lib/reach.js'
import { runProcess } from '../lib/spawn.js'

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-reach-'))
  return { home, env: { HOME: home, DSH_HOME: join(home, '.dsh') } }
}

test('现测：连得上记绿，连不上记原因；30 秒内再问直接用上次的，force 一定现测', async () => {
  const { env } = await sandbox()
  let calls = 0
  let answer = { ok: false, hint: 'SSH 配置里找不到「hk」这台机器' }
  const run = async () => {
    calls += 1
    return answer
  }
  const first = await checkReach('hk', { env, run })
  assert.deepEqual([first.reachable, first.hint, first.cached], [false, 'SSH 配置里找不到「hk」这台机器', false])
  const st = (await readState(env)).hosts.hk
  assert.equal(st.reachable, false)
  assert.match(st.lastError, /找不到/)
  assert.ok(st.lastCheck)

  const again = await checkReach('hk', { env, run })
  assert.equal(again.cached, true, '打开对话时不必每次都连一次服务器')
  assert.equal(calls, 1)

  answer = { ok: true }
  const forced = await checkReach('hk', { env, run, force: true })
  assert.equal(forced.reachable, true)
  assert.equal(calls, 2)
  assert.equal((await readState(env)).hosts.hk.lastError, null)
})

test('同时点好几下只测一次', async () => {
  const { env } = await sandbox()
  let calls = 0
  const run = async () => {
    calls += 1
    await new Promise((r) => setTimeout(r, 50))
    return { ok: true }
  }
  const results = await Promise.all([1, 2, 3].map(() => checkReach('hk', { env, run, force: true })))
  assert.equal(calls, 1)
  assert.ok(results.every((r) => r.reachable === true))
})

test('命令和 AI 工具连服务器的成败顺手记下：ssh 层失败记红，脚本跑起来了（不管成败）记绿', async () => {
  const { home, env } = await sandbox()
  const failing = async () => ({
    stdout: '', stderr: 'ssh: Could not resolve hostname hk: nodename nor servname provided, or not known',
    exitCode: 255, aborted: false, timedOut: false, durationMs: 5, truncated: false,
  })
  const res = await runRemote({ alias: 'hk', body: 'echo never', runner: failing, env })
  assert.equal(res.status, STATUS.sshError)
  await new Promise((r) => setTimeout(r, 50)) // 记录是异步的，不拖慢命令
  let st = (await readState(env)).hosts.hk
  assert.equal(st.reachable, false)
  assert.match(st.lastError, /SSH 配置里找不到/)

  const sh = (alias, payload, opts = {}) => runProcess('sh', ['-s'], { input: payload, env: { ...process.env, HOME: home }, ...opts })
  const failedScript = await runRemote({ alias: 'hk', body: 'exit 3', runner: sh, env })
  assert.equal(failedScript.status, STATUS.failed)
  await new Promise((r) => setTimeout(r, 50))
  st = (await readState(env)).hosts.hk
  assert.equal(st.reachable, true, '脚本自己失败不代表连不上')
})

test('没有别名就什么都不记，也不抛错', async () => {
  const { env } = await sandbox()
  await noteReach('', true, '', env)
  assert.deepEqual((await readState(env)).hosts ?? {}, {})
})
