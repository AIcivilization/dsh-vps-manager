#!/usr/bin/env node
// scripts/compat-smoke.mjs — 用一个真的 DSH 把插件装上、启动网页版，逐项确认能用
//
// 为什么要有它：DSH 还在 0.1.x 快速迭代，接口随时可能变。插件里任何一个注册点
// 对不上，DSH 的规矩是整个插件（有时是整个网页版）加载失败 —— 等用户来报就晚了。
// GitHub Actions 每天拿 npm 上 DSH 的 latest / next / alpha 各跑一遍（.github/workflows/dsh-compat.yml）。
//
// 用法：
//   node scripts/compat-smoke.mjs --dsh <装了 @deepseek-ai/dsh 的 node_modules 目录> --plugin <插件 tgz>
// 全部通过退出码 0；任何一项失败退出码 1，并打印每一项的结果（给 CI 贴进问题单）。
// 不需要模型密钥，不连任何服务器。

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

const modulesDir = resolve(arg('dsh') ?? 'node_modules')
const pluginTgz = resolve(arg('plugin') ?? '')
const bin = join(modulesDir, '@deepseek-ai/dsh/lib/bin.js')
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `　${String(detail).slice(0, 200)}` : ''}`)
}

function run(args, env, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveRun({ code, out })
    })
  })
}

async function main() {
  const dshVersion = JSON.parse(await readFile(join(modulesDir, '@deepseek-ai/dsh/package.json'), 'utf8')).version
  const pluginVersion = pluginTgz.match(/-(\d+\.\d+\.\d+[^/]*)\.tgz$/)?.[1] ?? '?'
  console.log(`DSH ${dshVersion} · dsh-vps-manager ${pluginVersion}`)

  const home = await mkdtemp(join(tmpdir(), 'dsh-compat-'))
  // SSH_CONNECTION：让「选择工作区」走网页内的目录浏览，不在 CI 机器上弹系统对话框
  const env = { ...process.env, DSH_HOME: join(home, '.dsh'), HOME: home, SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22' }
  let web = null
  let log = ''
  try {
    // 1. 装插件：和用户在终端里执行 dsh plugin add 完全一样
    const add = await run(['plugin', 'add', '--profile', 'web', pluginTgz], env)
    check('dsh plugin add 能装上插件', add.code === 0, add.code === 0 ? '' : add.out.slice(-400))
    if (add.code !== 0) return finish(dshVersion, pluginVersion, log)

    // 2. 启动网页版（随机端口），等它打印出带令牌的地址
    web = spawn(process.execPath, [bin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      env, cwd: join(home, '.dsh/profiles/web'), stdio: ['ignore', 'pipe', 'pipe'],
    })
    web.stdout.on('data', (d) => { log += d })
    web.stderr.on('data', (d) => { log += d })
    const started = Date.now()
    let url = ''
    while (Date.now() - started < 90_000 && web.exitCode === null) {
      url = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(log)?.[0] ?? ''
      if (url) break
      await new Promise((r) => setTimeout(r, 300))
    }
    check('网页版能启动（插件没有拖垮整个 DSH）', Boolean(url), url ? '' : log.slice(-600))
    if (!url) return finish(dshVersion, pluginVersion, log)
    const base = url.slice(0, url.indexOf('/?token='))

    // 3. 用启动令牌换登录 Cookie，读首页
    const login = await fetch(url, { redirect: 'manual' })
    const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).join('; ')
    check('启动令牌能换到登录 Cookie', login.status === 303 && cookie, `HTTP ${login.status}`)
    const index = await (await fetch(`${base}/`, { headers: { cookie } })).text()
    const token = /__DSH_VPS_TOKEN__="([a-f0-9]+)"/.exec(index)?.[1] ?? ''
    check('插件服务端已加载（首页里有插件令牌）', token)
    const clientRef = /dsh-vps-manager\/client\.js&(?:amp;)?rev=[\w-]+/.exec(index)?.[0]?.replace('&amp;', '&') ?? ''
    check('插件界面代码在加载清单里', clientRef)

    // 4. 界面代码能取到，而且是我们的
    if (clientRef) {
      const res = await fetch(`${base}/plugins/??${clientRef}`, { headers: { cookie } })
      const body = await res.text()
      check('插件界面代码能取到', res.status === 200 && body.includes("id: 'dsh-vps-manager'"), `HTTP ${res.status}`)
    }

    // 5. 设置页接口
    const api = async (path, body = {}) => {
      const res = await fetch(`${base}/api-vps/${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-dsh-vps-token': token, origin: base },
        body: JSON.stringify(body),
      })
      return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
    }
    const overview = await api('overview')
    check('设置页接口能用（overview）', overview.ok && Array.isArray(overview.recipes) && overview.recipes.length > 0,
      overview.ok ? `菜谱 ${overview.recipes?.length} 条` : overview.error)
    const bindings = await api('session/bindings')
    check('对话绑定接口能用', bindings.ok && typeof bindings.bindings === 'object', bindings.error ?? '')

    // 插件自己的体检：每一块都注册成功，读到的 DSH 版本就是装的这个
    const diag = await api('diag/status')
    const expect = { tools: '5 个', commands: null, skill: null, vpsMode: null, guard: null, routes: null, terminal: null }
    for (const [part, detail] of Object.entries(expect)) {
      const got = diag.parts?.[part]
      check(`注册成功：${got?.label ?? part}`, got?.ok && (detail === null || got.detail === detail), got ? got.detail : '没有记录（这一块没挂上）')
    }
    check('插件读到的 DSH 版本正确', diag.dsh?.version === dshVersion, `读到 ${diag.dsh?.version || '（空）'}，实际 ${dshVersion}`)
    check('插件认出这是网页版', diag.form === 'web', diag.form)

    // 文件管理器：接口挂上了（没绑定机器的对话应该得到明确提示）；下载的 GET 路由也在
    const filesPlaces = await api('files/places', { sessionId: 'compat-check' })
    check('文件管理接口能用（未绑定机器时给出提示）', filesPlaces.ok === false && /还没打开 VPS 开关/.test(filesPlaces.error ?? ''), filesPlaces.error ?? JSON.stringify(filesPlaces).slice(0, 120))
    const fetchBad = await fetch(`${base}/api-vps/files/fetch?t=nope`, { headers: { cookie } })
    check('文件下载路由已注册（无效票据被拒）', fetchBad.status === 403, `HTTP ${fetchBad.status}`)

    // 6. xterm.js 静态文件
    const xterm = await fetch(`${base}/api-vps/assets/xterm.mjs?v=6.0.0`, { headers: { cookie } })
    check('终端组件文件能取到', xterm.status === 200 && /javascript/.test(xterm.headers.get('content-type') ?? ''), `HTTP ${xterm.status}`)

    // 7. 终端的实时连接：没绑定机器的对话应该收到明确的提示（说明升级路由和鉴权都通）
    const wsUrl = `${base.replace('http', 'ws')}/api-vps/ws/terminal?sessionId=compat-check&cols=80&rows=24`
    const frames = await new Promise((resolveWs) => {
      const got = []
      const ws = new WebSocket(wsUrl, ['dsh-vps-terminal', token], { headers: { cookie }, origin: base })
      const done = () => resolveWs(got)
      ws.on('message', (d, isBinary) => { if (!isBinary) got.push(String(d)) })
      ws.on('close', done)
      ws.on('error', (e) => { got.push(`error: ${e.message}`); done() })
      ws.on('unexpected-response', (_req, res) => { got.push(`HTTP ${res.statusCode}`); done() })
      setTimeout(() => { ws.terminate(); done() }, 10_000)
    })
    check('终端实时连接能建立（未绑定机器时给出提示）', frames.some((f) => f.includes('还没打开 VPS 开关')), frames.join(' | '))

    // 8. 日志里不能有插件自己报的注册失败
    await new Promise((r) => setTimeout(r, 500))
    const pluginWarnings = log.split('\n').filter((l) => /\[dsh-vps-manager\]/.test(l) && /失败|failed|Error/i.test(l))
    const loaderFailure = /failed to (apply|import) loader entry vps-manager/.test(log)
    check('日志里没有插件的注册失败', !pluginWarnings.length && !loaderFailure, [...pluginWarnings, loaderFailure ? 'loader entry vps-manager 加载失败' : ''].join(' | '))
  } catch (error) {
    check('检查过程没有意外出错', false, error.stack ?? error.message)
  } finally {
    if (web && web.exitCode === null) web.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
  return finish(dshVersion, pluginVersion, log)
}

function finish(dshVersion, pluginVersion, log) {
  const failed = checks.filter((c) => !c.ok)
  const report = { dshVersion, pluginVersion, passed: failed.length === 0, checks, logTail: failed.length ? log.slice(-3000) : '' }
  const out = process.env.COMPAT_REPORT
  if (out) return import('node:fs/promises').then(({ writeFile }) => writeFile(out, JSON.stringify(report, null, 2))).then(() => exit(failed))
  return exit(failed)
}

function exit(failed) {
  console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部通过')
  process.exit(failed.length ? 1 : 0)
}

main()
