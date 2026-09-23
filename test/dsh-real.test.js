// 用本机装的 DSH Desktop 里「真的」dsh-tools 校验工具定义与返回值。
//
// 教训：假的 ctx 什么 schema 都收，工具在 DSH 里注册失败了整整三天没人发现
// （宿主日志：schema.additionalProperties must be explicitly true or false）。
// 这里照 dsh-tools 的 createSuccessResult 走一遍：无损 JSON → 按 output schema 校验 → render。
// DSH 从哪来：环境变量 DSH_MODULES（装了 @deepseek-ai/dsh 的 node_modules，GitHub 每天的兼容性检查
// 用 npm 装的 latest / next / alpha），没给就用本机 DSH Desktop 自带的。都找不到时整个文件跳过。
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

const APP = process.env.DSH_MODULES
  ? join(process.env.DSH_MODULES, '@deepseek-ai')
  : '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai'
const DSH_TOOLS = process.env.DSH_TOOLS_LIB ?? `${APP}/dsh-tools/lib/index.js`
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


test('真实 dsh-skill：加载时要求是字符串的字段，我们的 skill 一个不缺', { skip }, async () => {
  const { readFile } = await import('node:fs/promises')
  const lib = await readFile(`${APP}/dsh-skill/lib/index.js`, 'utf8')
  // validateDefinition 里无条件检查的那些：if (typeof X !== "string") throw … X must be a string
  // （path 这类写成 `X !== void 0 && typeof X …` 的是可选字段，不算）
  const required = [...lib.matchAll(/if \(typeof (\w+) !== "string"\) throw new TypeError\(`loaded skill "\$\{name\}" \1 must be a string/g)].map((m) => m[1])
  assert.ok(!required.includes('path'), 'path 是可选字段')
  assert.ok(required.includes('source') && required.includes('content'), `没从源码里读到字段清单：${required}`)

  const { registerSkill } = await import('../lib/index.js')
  let registered
  await registerSkill({ skills: { register: (def) => { registered = def; return () => {} } } })
  // 照 SkillRegistry.register 补默认值：invocation 与 provider
  const loaded = { invocation: { modelInvocable: true, userInvocable: true }, provider: 'runtime', ...registered }
  for (const field of required) {
    assert.equal(typeof loaded[field], 'string', `skill 缺字段 ${field}（DSH 加载时会报 “${field} must be a string”）`)
  }
  const { isSkillName } = await import(pathToFileURL(`${APP}/dsh-skill/lib/index.js`).href)
  assert.equal(isSkillName(registered.name), true)
})

test('真实 dsh-user-approval：结果词汇与请求字段对得上', { skip }, async () => {
  const { readFile } = await import('node:fs/promises')
  const lib = await readFile(`${APP}/dsh-user-approval/lib/index.js`, 'utf8')
  const block = /const OUTCOMES = \[([^\]]*)\]/.exec(lib)?.[1] ?? ''
  const outcomes = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort()
  const { APPROVAL_OUTCOMES, requestApproval } = await import('../lib/safety.js')
  assert.deepEqual(Object.values(APPROVAL_OUTCOMES).sort(), outcomes, '审批结果词汇变了，requestApproval 要跟着改')
  assert.match(lib, /toolName: req\.toolName/, '真实服务读的是 toolName')

  // 用真实词汇走一遍：只有 allowed-once 放行
  const hostWith = (outcome) => ({ get: () => ({ request: async (req) => { assert.equal(req.toolName, 'vps_exec'); return outcome } }) })
  for (const outcome of outcomes) {
    const res = await requestApproval(hostWith(outcome), { agent: {}, tool: 'vps_exec', reason: 'x' })
    assert.equal(res.decision === 'allow', outcome === 'allowed-once', `${outcome} → ${res.decision}`)
  }
})

test('真实会话格式：我们插入的说明能被宿主收下（用错形状会让整轮对话失败）', { skip }, async () => {
  // 2026-09-23 实测：DSH 0.1.7-alpha 起会话格式升到 v4，不再收 kind:'plugin'，
  // 我们那条 VPS 模式说明会让整轮报 “format v4 message requires a producer-owned source kind”。
  // 这里拿宿主自己的编码器校验一遍：以后哪一版再改规矩，CI 当天就能发现。
  const catalogPath = `${APP}/dsh-session-format-catalog/lib/index.js`
  if (!existsSync(catalogPath)) return // 老版本没有这个包
  const { sessionFormatCatalog } = await import(pathToFileURL(catalogPath).href)
  const { SOURCE_KIND, UNBOUND_TEXT } = await import('../lib/vps-mode.js')

  const event = {
    seq: 1,
    time: Date.now(),
    surfaceOp: 'append',
    type: 'user/message',
    data: {
      id: '11111111-1111-4111-8111-111111111111',
      role: 'user',
      content: [{ type: 'text', text: UNBOUND_TEXT }],
      source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: 'vps-mode', text: UNBOUND_TEXT }] },
    },
  }
  sessionFormatCatalog.encodeCurrentEvent(event, 1) // 不抛就算过

  // 老形状在 v4 上必须是被拒的：证明这个测试真的在管用
  if (Number(sessionFormatCatalog.currentVersion) >= 4) {
    assert.throws(
      () => sessionFormatCatalog.encodeCurrentEvent({
        ...event,
        data: { ...event.data, source: { kind: 'plugin', plugin: 'vps-manager', form: 'snapshot', sections: [{ name: 'vps-mode', text: UNBOUND_TEXT }] } },
      }, 1),
      /producer-owned source kind/,
    )
  }
})
