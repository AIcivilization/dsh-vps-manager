import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths, readHosts, writeHosts } from '../lib/config.js'
import { registerRoutes } from '../lib/routes.js'
import { runProcess } from '../lib/spawn.js'

function makeReq({ method = 'POST', headers = {}, body = {} } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', ...headers }
  return req
}

function makeRes() {
  const out = {}
  return {
    out,
    writeHead(code, headers) {
      out.code = code
      out.headers = headers
    },
    end(text) {
      out.body = text ? JSON.parse(text) : null
    },
  }
}

function fakeWebServer({ host = '127.0.0.1' } = {}) {
  const routes = new Map()
  const taps = []
  return {
    config: { host, port: 3000 },
    register({ path, handler }) {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {}
    },
    routes,
    taps,
  }
}

async function sandbox({ lan = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vps-routes-'))
  const env = { HOME: home, DSH_HOME: join(home, '.dsh') }
  await writeHosts({ current: 'hk', hosts: { hk: { note: '香港', group: '生产' } } }, env)
  const runner = (alias, payload, opts = {}) =>
    runProcess('sh', ['-s'], { input: payload, env: { ...process.env, HOME: home }, ...opts })
  const ws = fakeWebServer({ host: lan ? '0.0.0.0' : '127.0.0.1' })
  const reg = registerRoutes({ webServer: ws }, { env, runner })
  const call = async (path, body, headers = {}) => {
    const handler = ws.routes.get(`/api-vps/${path}`)
    assert.ok(handler, `没有注册路由 ${path}`)
    const res = makeRes()
    await handler(makeReq({ body, headers: { 'x-dsh-vps-token': reg.token, ...headers } }), res)
    return res.out
  }
  return { home, env, ws, reg, call }
}

test('token 注入页面，没有 token 的请求一律拒绝', async () => {
  const { ws, reg, call } = await sandbox()
  const html = ws.taps[0]('<html><head></head><body></body></html>')
  assert.match(html, /window\.__DSH_VPS_TOKEN__="[a-f0-9]{48}"/)

  const handler = ws.routes.get('/api-vps/overview')
  const res = makeRes()
  await handler(makeReq({ body: {} }), res) // 不带 token
  assert.equal(res.out.code, 403)
  assert.equal(res.out.body.ok, false)

  const ok = await call('overview', {})
  assert.equal(ok.body.ok, true)
  assert.equal(reg.token.length, 48)
})

test('跨站请求、GET、非 JSON 都拒绝', async () => {
  const { ws, reg } = await sandbox()
  const handler = ws.routes.get('/api-vps/overview')

  const cross = makeRes()
  await handler(makeReq({ headers: { 'x-dsh-vps-token': reg.token, origin: 'https://evil.example' } }), cross)
  assert.equal(cross.out.code, 403)
  assert.match(cross.out.body.error, /跨站/)

  const get = makeRes()
  await handler(makeReq({ method: 'GET', headers: { 'x-dsh-vps-token': reg.token } }), get)
  assert.equal(get.out.code, 405)

  const form = makeRes()
  await handler(makeReq({ headers: { 'x-dsh-vps-token': reg.token, 'content-type': 'text/plain' } }), form)
  assert.equal(form.out.code, 415)

  // 同源的 Origin 放行
  const same = makeRes()
  await handler(makeReq({ headers: { 'x-dsh-vps-token': reg.token, origin: 'http://127.0.0.1:3000' } }), same)
  assert.equal(same.out.code, 200)
})

test('overview 给出机器、菜谱和路径', async () => {
  const { call } = await sandbox()
  const { body } = await call('overview', {})
  assert.equal(body.current, 'hk')
  assert.equal(body.hosts[0].alias, 'hk')
  assert.ok(body.recipes.length >= 10)
  assert.ok(body.recipes.some((r) => r.id === 'install-docker'))
  assert.deepEqual(body.recipeErrors, [])
  assert.equal(body.lanBound, false)
})

test('机器设置：保存写进 hosts.yml 与 ssh 配置，删除能带走 ssh 块', async () => {
  const { env, call } = await sandbox()
  const saved = await call('host/save', {
    alias: 'jp',
    hostname: '5.6.7.8',
    port: 2222,
    user: 'root',
    note: '日本',
    group: '测试',
    confirm: 'relaxed',
  })
  assert.equal(saved.body.ok, true)

  const doc = await readHosts(env)
  assert.equal(doc.hosts.jp.note, '日本')
  assert.equal(doc.hosts.jp.confirm, 'relaxed')
  const dropin = await readFile(paths(env).sshDropin, 'utf8')
  assert.match(dropin, /Host jp/)
  assert.match(dropin, /Port 2222/)

  const removed = await call('host/remove', { alias: 'jp', removeSshBlock: true })
  assert.equal(removed.body.ok, true)
  assert.equal((await readHosts(env)).hosts.jp, undefined)
  assert.doesNotMatch(await readFile(paths(env).sshDropin, 'utf8'), /Host jp/)
})

test('连接字段非法时给出可读错误，不写坏配置', async () => {
  const { call } = await sandbox()
  const bad = await call('host/save', { alias: 'x', hostname: 'a b c', port: 22 })
  assert.equal(bad.body.ok, false)
  assert.match(bad.body.error, /地址不合法/)

  const badPort = await call('host/save', { alias: 'x', hostname: '1.2.3.4', port: 99999 })
  assert.equal(badPort.body.ok, false)
  assert.match(badPort.body.error, /端口不合法/)
})

test('面板跑菜谱：按钮即同意，不需要审批界面', async () => {
  const { call } = await sandbox()
  const res = await call('recipes/run', { id: 'health', alias: 'hk' })
  assert.equal(res.body.ok, true, JSON.stringify(res.body))
  assert.match(res.body.output, /内存|磁盘/)
})

test('局域网暴露时，会改东西的路由默认关闭，只读的照常', async () => {
  const { call } = await sandbox({ lan: true })
  const read = await call('overview', {})
  assert.equal(read.body.ok, true)
  assert.equal(read.body.lanBound, true)

  const write = await call('host/save', { alias: 'jp', hostname: '5.6.7.8', port: 22, user: 'root' })
  assert.equal(write.code, 403)
  assert.match(write.body.error, /0\.0\.0\.0/)

  const run = await call('recipes/run', { id: 'health', alias: 'hk' })
  assert.equal(run.code, 403)
})

test('设置页保存全局档位', async () => {
  const { env, call } = await sandbox()
  const res = await call('settings/save', { settings: { confirm: 'relaxed', safetyNetSeconds: 60 } })
  assert.equal(res.body.settings.confirm, 'relaxed')
  assert.equal((await readHosts(env)).settings.safetyNetSeconds, 60)
})

test('向导：拿公钥和两种放公钥的命令', async () => {
  const { call } = await sandbox()
  const key = await call('onboarding/key', { create: true })
  assert.equal(key.body.ok, true)
  assert.match(key.body.pubkey, /^ssh-ed25519 /)

  const cmds = await call('onboarding/commands', { hostname: '1.2.3.4', port: 2222, user: 'root' })
  assert.match(cmds.body.authorizedKeys, /authorized_keys/)
  assert.match(cmds.body.sshCopyId, /ssh-copy-id -i .*\.pub -p 2222 root@1\.2\.3\.4/)
})

test('内置菜谱不能被面板删掉', async () => {
  const { call } = await sandbox()
  const res = await call('recipes/delete', { id: 'install-docker' })
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /内置菜谱不能删除/)
})

test('面板的执行流程：立刻拿任务号 → 轮询日志 → 单独验证', async () => {
  const { env, call } = await sandbox()
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { paths } = await import('../lib/config.js')
  await mkdir(paths(env).recipesDir, { recursive: true })
  await writeFile(join(paths(env).recipesDir, 'slow.yml'), [
    'schema: 1',
    'recipes:',
    '  - id: my-slow',
    '    kind: install',
    '    name: 慢活',
    '    desc: 模拟一个要跑几秒的安装',
    '    timeout: 60',
    '    detect: test -f "$HOME/.slow-done"',
    '    plan: 分三步，每步一秒',
    '    run: |',
    '      echo 第一步; sleep 1',
    '      echo 第二步; sleep 1',
    '      echo 第三步; touch "$HOME/.slow-done"',
    '    verify: test -f "$HOME/.slow-done" && echo 验证通过',
  ].join('\n'))

  // 1) 启动：waitSeconds 0，必须立刻返回，不能在 HTTP 里干等
  const t0 = Date.now()
  const started = await call('recipes/run', { id: 'my-slow', alias: 'hk', waitSeconds: 0 })
  const startCost = Date.now() - t0
  assert.equal(started.body.ok, false, '这时候还没跑完，ok 应为 false')
  assert.equal(started.body.status, 'detached')
  assert.ok(started.body.taskId, '必须给出任务号，面板靠它轮询')
  assert.ok(startCost < 8000, `启动请求应很快返回，实际 ${startCost}ms`)

  // 2) 轮询：能看到执行过程中的日志
  let sawPartialLog = false
  let task = null
  for (let i = 0; i < 30; i += 1) {
    const res = await call('tasks/status', { alias: 'hk', taskId: started.body.taskId })
    assert.equal(res.body.ok, true)
    task = res.body.task
    if (task?.state === 'running' && /第一步/.test(res.body.log ?? '')) sawPartialLog = true
    if (task && task.state !== 'running') break
    await new Promise((r) => setTimeout(r, 500))
  }
  assert.ok(sawPartialLog, '任务还在跑的时候就应该能看到部分日志')
  assert.equal(task.state, 'done')
  assert.equal(task.exitCode, 0)

  // 3) 验证：任务结束后单独跑 verify
  const verified = await call('recipes/verify', { id: 'my-slow', alias: 'hk' })
  assert.equal(verified.body.ok, true)
  assert.match(verified.body.output, /验证通过/)
})

test('没有 verify 的菜谱，验证接口如实说明', async () => {
  const { env, call } = await sandbox()
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { paths } = await import('../lib/config.js')
  await mkdir(paths(env).recipesDir, { recursive: true })
  await writeFile(join(paths(env).recipesDir, 'noverify.yml'),
    'schema: 1\nrecipes:\n  - id: my-noverify\n    kind: config\n    name: 没写验证\n    run: "true"\n')
  const res = await call('recipes/verify', { id: 'my-noverify', alias: 'hk' })
  assert.equal(res.body.ok, true)
  assert.match(res.body.hint, /没有写 verify/)
})

test('快捷查询路由只收查询类菜谱，且局域网只读模式下照常可用', async () => {
  const { call } = await sandbox({ lan: true })
  const ok = await call('recipes/query', { id: 'health', alias: 'hk' })
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body))
  assert.match(ok.body.output, /内存|磁盘/)

  const refused = await call('recipes/query', { id: 'install-docker', alias: 'hk' })
  assert.equal(refused.body.ok, false)
  assert.match(refused.body.error, /不是查询类菜谱/)
})
