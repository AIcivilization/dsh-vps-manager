// 对话里的迷你终端：交互命令改写、目录标记、打码、交给 AI 的记录
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CWD_MARK, _resetTerminalLog, adaptInteractive, extractCwd, maskSecrets, recordTerminal, takeUnshared, terminalText,
} from '../lib/terminal.js'

const cmd = (s) => adaptInteractive(s).command

test('一直刷新的命令改成一次性输出，并说明改了什么', () => {
  assert.deepEqual(adaptInteractive('top'), { command: 'top -bn1 | head -n 40', note: 'top 会一直刷新，改成打印一次快照：top -bn1' })
  assert.equal(cmd('htop'), 'top -bn1 | head -n 40')
  assert.equal(cmd('sudo top'), 'sudo top -bn1 | head -n 40')
  assert.equal(cmd('top | grep node'), 'top -bn1 | grep node', '后面有管道就不再加 head')
  assert.equal(adaptInteractive('top -bn1').note, undefined, '已经是一次性的不动')

  assert.equal(cmd('tail -f /var/log/syslog'), 'tail -n 100 /var/log/syslog')
  assert.equal(cmd('tail -f -n 20 app.log'), 'tail -n 20 app.log', '自己写了行数就保留')
  assert.equal(cmd('tail -F x.log | grep err'), 'tail -n 100 x.log | grep err')
  assert.equal(cmd('journalctl -u caddy -f'), 'journalctl -u caddy -n 100 --no-pager')
  assert.equal(cmd('docker logs -f mailserver'), 'docker logs --tail 100 mailserver')
  assert.equal(cmd('less /etc/caddy/Caddyfile'), 'cat /etc/caddy/Caddyfile')
  assert.equal(cmd('watch -n 2 df -h'), 'df -h')
  assert.equal(cmd("watch 'ss -tlnp'"), 'ss -tlnp')
  assert.equal(cmd('docker exec -it mailserver ls /'), 'docker exec mailserver ls /')

  // 普通命令原样
  assert.deepEqual(adaptInteractive('df -h'), { command: 'df -h' })
  assert.deepEqual(adaptInteractive('grep -n less /etc/x'), { command: 'grep -n less /etc/x' })
  assert.deepEqual(adaptInteractive('bash /root/backup.sh'), { command: 'bash /root/backup.sh' }, '跑脚本不是交互 shell')
  assert.deepEqual(adaptInteractive('ssh other-host uptime'), { command: 'ssh other-host uptime' })
})

test('改不了的交互命令：不执行，说清怎么办', () => {
  assert.match(adaptInteractive('vim /etc/caddy/Caddyfile').refuse, /交互式编辑器.*cat \/etc\/caddy\/Caddyfile.*vps_write_file/)
  assert.match(adaptInteractive('nano x').refuse, /交互式编辑器/)
  assert.match(adaptInteractive('bash').refuse, /交互界面/)
  assert.match(adaptInteractive('mysql').refuse, /mysql -e/)
  assert.match(adaptInteractive('ssh').refuse, /你已经在这台服务器上了/)
  assert.match(adaptInteractive('docker exec -it mailserver bash').refuse, /docker exec <容器> ls/)
  for (const cmd of ['vim x', 'bash', 'mysql', 'docker exec -it mailserver bash']) {
    assert.match(adaptInteractive(cmd).refuse, /点对话头部「VPS」后面的 >_ 打开终端/, `${cmd} 要指路到真终端`)
  }
})

test('目录标记：取出结束时的目录，并从输出里去掉', () => {
  assert.deepEqual(extractCwd(`hello\nworld\n\n${CWD_MARK}/etc/caddy\n`), { output: 'hello\nworld', cwd: '/etc/caddy' })
  assert.deepEqual(extractCwd('没有标记'), { output: '没有标记', cwd: null })
  assert.equal(extractCwd(`${CWD_MARK}relative\n`).cwd, null, '只认绝对路径')
})

test('交给 AI 之前打码', () => {
  assert.equal(maskSecrets('dsh web: http://127.0.0.1:8787/?token=abc123def456'), 'dsh web: http://127.0.0.1:8787/?token=***')
  assert.equal(maskSecrets('DB_PASSWORD=hunter2 other=1'), 'DB_PASSWORD=*** other=1')
  assert.equal(maskSecrets('password: "s3cret"'), 'password: "***"')
  assert.equal(maskSecrets('Authorization: Bearer eyJhbGciOi.xxx'), 'Authorization: Bearer ***')
  assert.equal(maskSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'), '[私钥已隐去]')
  assert.equal(maskSecrets('api_key = sk-abcdefghijklmnopqrstuvwxyz'), 'api_key = ***')
  assert.equal(maskSecrets('Filesystem Size Used\n/dev/vda1 58G 15G'), 'Filesystem Size Used\n/dev/vda1 58G 15G', '普通输出不动')
})

test('记录：最近几条，交出一次就不再重复；超长输出只留结尾', () => {
  _resetTerminalLog()
  assert.equal(recordTerminal('s1', { alias: 'hk', cwd: '/root', command: 'df -h', exitCode: 0, status: 'done', output: 'ok' }).firstTime, true)
  assert.equal(recordTerminal('s1', { alias: 'hk', cwd: '/etc', command: 'cat big', exitCode: 1, status: 'failed', output: `${'x'.repeat(3000)}END token=zzz` }).firstTime, false)
  const taken = takeUnshared('s1')
  assert.equal(taken.length, 2)
  assert.deepEqual(takeUnshared('s1'), [], '交出去的不再给')
  const text = terminalText(taken)
  assert.match(text, /^\[VPS 终端\]/)
  assert.match(text, /\$ df -h　（hk:\/root，退出码 0）\nok/)
  assert.match(text, /\$ cat big　（hk:\/etc，退出码 1）\n…（前面省略 \d+ 字）/)
  assert.match(text, /END token=\*\*\*/)
  assert.doesNotMatch(text, /zzz/)

  for (let i = 0; i < 10; i += 1) recordTerminal('s2', { alias: 'hk', command: `echo ${i}`, exitCode: 0, status: 'done', output: String(i) })
  assert.equal(takeUnshared('s2').length, 6, '只留最近 6 条')
})
