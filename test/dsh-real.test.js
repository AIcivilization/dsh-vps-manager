// 用本机装的 DSH Desktop 里「真的」dsh-tools 校验工具定义与返回值。
//
// 教训：假的 ctx 什么 schema 都收，工具在 DSH 里注册失败了整整三天没人发现
// （宿主日志：schema.additionalProperties must be explicitly true or false）。
// 这里照 dsh-tools 的 createSuccessResult 走一遍：无损 JSON → 按 output schema 校验 → render。
// 本机没装 DSH Desktop 时整个文件跳过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeHosts } from '../lib/config.js'
import { runProcess } from '../lib/spawn.js'
import { buildToolDefinitions } from '../lib/tools.js'

const DSH_TOOLS = process.env.DSH_TOOLS_LIB
  ?? '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const skip = existsSync(DSH_TOOLS) ? false : `没找到 DSH 的 dsh-tools（${DSH_TOOLS}）`

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-real-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: '', hosts: { hk: { note: '香港' } } }, env)
  const sshConfig = join(home, 'ssh_config')
  await writeFile(sshConfig, 'Host hk\n  HostName 1.2.3.4\n  Port 22\n  User root\n')
  const runner = (alias, payload, opts = {}) => runProcess('sh', ['-s'], {
    input: payload, env: { ...process.env, HOME: home }, signal: opts.signal, timeoutMs: opts.timeoutMs,
    onStdout: opts.onStdout, onStderr: opts.onStderr,
  })
  return { env, runner }
}

test('真实 defineTool 接受全部 5 个工具', { skip }, async () => {
  const real = await import(pathToFileURL(DSH_TOOLS).href)
  const defs = await buildToolDefinitions({}, { env: { HOME: '/nonexistent', DSH_HOME: '/nonexistent/.dsh' } })
  assert.equal(defs.length, 5)
  for (const def of defs) {
    assert.doesNotThrow(() => real.defineTool(def), `${def.name} 过不了 DSH 的 schema 校验`)
  }
})

test('真实校验：参数合法、返回值是无损 JSON 且符合声明、render 不报错', { skip }, async () => {
  const real = await import(pathToFileURL(DSH_TOOLS).href)
  const { env, runner } = await sandbox()
  const allow = { approval: { request: async () => 'allow' } }
  const defs = await buildToolDefinitions(allow, { env, runner })
  const tools = Object.fromEntries(defs.map((d) => [d.name, real.defineTool(d)]))
  const exec = { agent: { session: { id: 'sess-real' } }, callId: 'c1', signal: new AbortController().signal }

  const calls = [
    ['vps_hosts', {}],
    ['vps_exec', { host: 'hk', script: 'echo hello', intent: 'read' }],
    ['vps_exec', { host: 'hk', script: 'exit 3', intent: 'read' }], // 失败结果也要合法（exitCode、hint 等字段）
    ['vps_recipe', { action: 'list' }],
    ['vps_recipe', { action: 'list', kind: 'query' }],
    ['vps_task', { host: 'hk', action: 'list' }],
  ]
  for (const [name, args] of calls) {
    const tool = tools[name]
    const value = await tool.execute(args, exec) // 真实 execute 包装会先按真实规则校验参数
    const detached = JSON.parse(JSON.stringify(value))
    assert.deepEqual(detached, value, `${name} 的返回值不是无损 JSON（有 undefined 或非纯对象）`)
    const violations = real.validateJsonSchemaValue(tool.output.schema, detached, 'value')
    assert.deepEqual(violations, [], `${name} 返回值不符合声明：${violations.join('; ')}`)
    const rendered = tool.output.render(args, detached)
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} 的 render 没有输出`)
  }

  // 参数写错时，DSH 在执行前就拦下
  await assert.rejects(tools.vps_exec.execute({ host: 'hk' }, exec), /script/)
  await assert.rejects(tools.vps_recipe.execute({ action: 'nope' }, exec))
})
