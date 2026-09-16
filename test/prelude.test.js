// 前导脚本里的判断函数必须只返回 0 或 1。
// 这条是真机踩出来的：Ubuntu 的 /bin/sh 是 dash，dash 的 `command -v` 找不到命令时
// 返回 127；`systemctl is-active` 对未运行的服务返回 3。这些码一旦透出去，
// detect 就从「未装」变成「说不清」，安装流程会毫无必要地停下问人。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runProcess } from '../lib/spawn.js'

const preludePath = new URL('../lib/prelude.sh', import.meta.url)

async function runWithPrelude(script, { prefix = '' } = {}) {
  const prelude = await readFile(preludePath, 'utf8')
  return runProcess('sh', ['-s'], { input: `${prefix}\n${prelude}\n${script}\n`, timeoutMs: 20_000 })
}

test('has_cmd：命令存在返回 0，不存在返回 1（即使底层返回 127）', async () => {
  const real = await runWithPrelude('has_cmd ls; echo "存在=$?"; has_cmd dsh-vps-no-such-cmd; echo "缺失=$?"')
  assert.match(real.stdout, /存在=0/)
  assert.match(real.stdout, /缺失=1/)

  // 用假的 command 模拟 dash：找不到时返回 127
  const dashLike = await runWithPrelude('has_cmd whatever; echo "dash 行为=$?"', {
    prefix: 'command() { return 127; }',
  })
  assert.match(dashLike.stdout, /dash 行为=1/, '127 必须被归一成 1，否则 detect 会判成「说不清」')
})

test('svc_active：服务未运行返回 1（systemd 原本返回 3）', async () => {
  const res = await runWithPrelude('INIT=systemd; svc_active whatever; echo "未运行=$?"', {
    prefix: 'systemctl() { return 3; }',
  })
  assert.match(res.stdout, /未运行=1/)

  const active = await runWithPrelude('INIT=systemd; svc_active whatever; echo "运行中=$?"', {
    prefix: 'systemctl() { return 0; }',
  })
  assert.match(active.stdout, /运行中=0/)
})

test('port_listening：端口没被监听时返回 1', async () => {
  const res = await runWithPrelude('port_listening 65535; echo "未监听=$?"')
  assert.match(res.stdout, /未监听=1/)
})

test('前导本身不产生输出（否则会污染菜谱的第一行摘要）', async () => {
  const res = await runWithPrelude('echo 正文第一行')
  assert.equal(res.stdout.trim(), '正文第一行')
  assert.equal(res.stderr.trim(), '')
})
