// 插件体检：注册结果、DSH 版本验证状态、本地错误记录、预填好的反馈链接
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHosts } from '../lib/config.js'
import {
  diagnostics, diagnosticsText, feedbackUrl, markPart, recentErrors, recordError, statusFor, verifiedVersions,
} from '../lib/health.js'

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-health-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: 'hk', hosts: { hk: { note: '香港' } } }, env)
  return { home, env }
}

test('DSH 版本：验证过的、没验证过的、读不到的，说法不同', () => {
  const verified = verifiedVersions()
  assert.ok(verified.includes('0.1.5-rc.2'), '当前正式版必须在已验证列表里')
  assert.equal(statusFor(verified[0]).status, 'verified')
  const other = statusFor('9.9.9')
  assert.equal(other.status, 'unverified')
  assert.match(other.text, /还没经过本插件验证/)
  assert.match(other.text, /反馈问题/)
  assert.equal(statusFor('').status, 'unknown')
})

test('错误记录：打码后存本地，新的在前', async () => {
  const { env, home } = await sandbox()
  await recordError('接口 host/save', new Error('连不上：password=hunter2 token=abcdef123456'), env)
  await recordError('load', 'skill 注册失败：boom', env)
  const errors = await recentErrors(10, env)
  assert.equal(errors.length, 2)
  assert.equal(errors[0].source, 'load', '新的在前')
  assert.doesNotMatch(errors[1].message, /hunter2|abcdef123456/, '密码和令牌先打码再落盘')
  const files = await readdir(join(home, '.dsh/vps-manager/logs'))
  assert.equal(files.length, 1)
  assert.match(files[0], /^errors-\d{4}-\d{2}\.jsonl$/)
  const raw = await readFile(join(home, '.dsh/vps-manager/logs', files[0]), 'utf8')
  assert.doesNotMatch(raw, /hunter2/)
})

test('诊断汇总与反馈链接：带版本和注册情况，不带机器地址', async () => {
  const { env } = await sandbox()
  markPart('tools', true, '5 个')
  markPart('commands', false, 'ctx.commands.register is not a function')
  await recordError('load', '命令注册失败：ctx.commands.register is not a function', env)
  const diag = await diagnostics(env)
  assert.equal(diag.machines, 1)
  assert.deepEqual(diag.failedParts, ['commands'])
  assert.equal(diag.parts.tools.label, 'AI 工具')

  const text = diagnosticsText(diag)
  assert.match(text, /AI 工具 ✓/)
  assert.match(text, /\/vps- 命令 ✗ ctx\.commands\.register is not a function/)
  assert.match(text, /最近错误/)
  assert.doesNotMatch(text, /hk|香港/, '机器名和备注不进问题单')

  const url = new URL(feedbackUrl(diag))
  assert.equal(url.origin + url.pathname, 'https://github.com/AIcivilization/dsh-vps-manager/issues/new')
  assert.equal(url.searchParams.get('template'), 'bug_report.yml')
  assert.equal(url.searchParams.get('plugin-version'), diag.plugin)
  assert.match(url.searchParams.get('diagnostics'), /命令注册失败/)
  assert.ok(url.href.length < 8000, 'GitHub 对链接长度有上限')
  assert.match(diag.suggestUrl, /template=feature_request\.yml/)
})
