// 面板是浏览器代码，这里用 react-dom/server 做冒烟渲染：
// 组件树能不能渲染、插槽注册对不对、请求有没有带 token、跨站能不能读到 token。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'

const requireShim = (name) => {
  if (name === 'react') return React
  throw new Error(`面板不该 require ${name}`)
}

async function loadClient({ fetchImpl, storage = {} } = {}) {
  let spec = null
  const calls = []
  const store = new Map(Object.entries(storage))
  globalThis.window = {
    __ModuleLoader__: { load: (s) => { spec = s } },
    __DSH_VPS_TOKEN__: 'test-token-123',
    confirm: () => true,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
  }
  globalThis.fetch = fetchImpl ?? (async (url, init) => {
    calls.push({ url, init })
    return { status: 200, json: async () => ({ ok: true, hosts: [], recipes: [], current: '', settings: {} }) }
  })
  const mod = await import(`../lib/client.js?${Math.random()}`)
  assert.ok(spec, 'client.js 应调用 window.__ModuleLoader__.load')
  const exported = spec.factory(requireShim)
  return { spec, exported, calls, require: createRequire(import.meta.url) }
}

function fakeSlots() {
  const registered = new Map()
  return {
    slots: {
      inject: (_name, cb) => cb(),
      register: (descriptor, component) => {
        registered.set(descriptor.name, { descriptor, component })
        return () => {}
      },
    },
    registered,
  }
}

test('bundle 以 ModuleLoader 形式导出，并注册三个挂载点', async () => {
  const { spec, exported } = await loadClient()
  assert.equal(spec.id, 'dsh-vps-manager')
  assert.deepEqual(exported.inject, ['slots'])

  const ctx = fakeSlots()
  exported.apply(ctx)
  const settings = ctx.registered.get('settings.section')
  const toggle = ctx.registered.get('conversation.session.header.actions')
  const dock = ctx.registered.get('conversation.composer.dock')
  assert.ok(settings && toggle && dock, '三个挂载点都要在')
  assert.equal(toggle.descriptor.id, 'vps-manager')
  assert.equal(dock.descriptor.id, 'vps-manager')
  assert.equal(settings.descriptor.id, 'vps-manager')

  // 左侧面板已删除：对话解决不了的才留在 UI 里
  assert.equal(ctx.registered.get('sidebar.panellist'), undefined, '不该再注册侧栏面板')
  assert.equal(ctx.registered.get('main'), undefined, '不该再注册主区域')
})

test('设置页能渲染', async () => {
  const { exported } = await loadClient()
  const ctx = fakeSlots()
  exported.apply(ctx)
  const html = renderToStaticMarkup(React.createElement(ctx.registered.get('settings.section').component))
  assert.match(html, /VPS 管理/)
  assert.match(html, /卸载…/, '设置页底部要有卸载入口')
})

test('每个请求都带 token 和 JSON 头（跨站网页读不到 token）', async () => {
  const calls = []
  const { exported } = await loadClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { status: 200, json: async () => ({ ok: true, hosts: [] }) }
    },
  })
  const data = await exported.__test.api('overview', { a: 1 })
  assert.deepEqual(data.hosts, [])
  assert.equal(calls[0].url, '/api-vps/overview')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['x-dsh-vps-token'], 'test-token-123')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(calls[0].init.body, '{"a":1}')
})

test('请求失败时把 host 的错误原样带出来', async () => {
  const { exported } = await loadClient({
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: false, error: '没有登记过这台机器：nope' }) }),
  })
  await assert.rejects(exported.__test.api('host/test', { alias: 'nope' }), /没有登记过这台机器：nope/)

  const { exported: broken } = await loadClient({
    fetchImpl: async () => ({ status: 500, json: async () => { throw new Error('not json') } }),
  })
  await assert.rejects(broken.__test.api('overview'), /服务返回异常（HTTP 500）/)
})

test('没打开开关的对话：状态条一个像素都不渲染，头部开关也不发请求', async () => {
  const calls = []
  const { exported } = await loadClient({
    fetchImpl: async (url) => {
      calls.push(url)
      return { status: 200, json: async () => ({ ok: true, hosts: [], recipes: [] }) }
    },
  })
  const ctx = fakeSlots()
  exported.apply(ctx)

  const dockHtml = renderToStaticMarkup(
    React.createElement(ctx.registered.get('conversation.composer.dock').component, { sessionId: 'unbound' }),
  )
  const toggleHtml = renderToStaticMarkup(
    React.createElement(ctx.registered.get('conversation.session.header.actions').component, { sessionId: 'unbound' }),
  )
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(dockHtml, '', '没绑定机器的对话，输入框下方不该有任何东西')
  assert.deepEqual(calls, [], '大多数对话跟 VPS 无关，挂载时不该发任何请求')
  assert.match(toggleHtml, />VPS</, '头部只有 VPS 三个字母加方块')
  assert.doesNotMatch(toggleHtml, /🟢|🔴/, '不用 emoji，用方块颜色表示')
})

test('输入框下方：没事就一个像素都不占，只报「不问就不知道」的事', async () => {
  const { exported } = await loadClient()
  const { alertsFor } = exported.__test

  // 一切正常 —— 什么都不显示
  assert.deepEqual(alertsFor('hk', { reachable: true, facts: { disk_pct: '25%' }, running: [] }), [])

  // 后台任务在跑：你关掉页面它还在跑，不说你不知道
  const busy = alertsFor('hk', { reachable: true, facts: {}, running: [{ meta: { recipeId: 'install-docker' } }] })
  assert.equal(busy.length, 1)
  assert.match(busy[0].text, /install-docker/)

  // 连不上
  const down = alertsFor('hk', { reachable: false, facts: {}, running: [] })
  assert.equal(down[0].tone, 'danger')
  assert.match(down[0].text, /连不上/)

  // 磁盘快满
  const full = alertsFor('hk', { reachable: true, facts: { disk_pct: '92%' }, running: [] })
  assert.equal(full[0].tone, 'danger')
  assert.match(full[0].text, /92%/)

  // 磁盘没满就不提
  assert.deepEqual(alertsFor('hk', { reachable: true, facts: { disk_pct: '60%' }, running: [] }), [])
})

test('绑定了机器但一切正常时，输入框下方仍然什么都不渲染', async () => {
  const { exported } = await loadClient({ storage: { 'dsh-vps:bind:s2': 'vps-dsh' } })
  const ctx = fakeSlots()
  exported.apply(ctx)
  const html = renderToStaticMarkup(
    React.createElement(ctx.registered.get('conversation.composer.dock').component, { sessionId: 's2' }),
  )
  assert.equal(html, '', '没有要报的事就不该占位置')
})

test('方块里的编号：第一台 1，第二台 2，只有一台也写 1', async () => {
  const { exported } = await loadClient()
  const { ballLabel } = exported.__test
  assert.equal(ballLabel(0), '1', '只有一台也写编号')
  assert.equal(ballLabel(1), '2')
  assert.equal(ballLabel(3), '4')
})

test('头部顺序：VPS → 终端按钮 → 机器方块', async () => {
  const { exported } = await loadClient({
    storage: {
      'dsh-vps:hosts': JSON.stringify([{ alias: 'hk', note: '' }, { alias: 'jp', note: '' }]),
      'dsh-vps:bind:s7': 'hk',
    },
  })
  const ctx = fakeSlots()
  exported.apply(ctx)
  const html = renderToStaticMarkup(
    React.createElement(ctx.registered.get('conversation.session.header.actions').component, { sessionId: 's7' }),
  )
  const vps = html.indexOf('>VPS<')
  const term = html.indexOf('&gt;_')
  const first = html.indexOf('>1</button>')
  const second = html.indexOf('>2</button>')
  assert.ok(vps >= 0 && term > vps, '终端按钮紧跟在 VPS 后面')
  assert.ok(first > term && second > first, '机器方块在终端按钮之后，按编号排')
})

test('多台机器时头部是一排开关，没有下拉菜单', async () => {
  const { exported } = await loadClient({
    storage: {
      'dsh-vps:hosts': JSON.stringify([{ alias: 'hk', note: '香港' }, { alias: 'jp', note: '日本' }]),
      'dsh-vps:bind:s9': 'jp',
    },
  })
  const ctx = fakeSlots()
  exported.apply(ctx)
  const html = renderToStaticMarkup(
    React.createElement(ctx.registered.get('conversation.session.header.actions').component, { sessionId: 's9' }),
  )
  assert.equal((html.match(/<button/g) ?? []).length, 3, '两台机器两个方块 + 绑定后的终端按钮')
  assert.match(html, />&gt;_</, '终端按钮')
  assert.match(html, />1</, '方块里写编号')
  assert.match(html, />2</)
  assert.equal((html.match(/VPS/g) ?? []).length, 1, 'VPS 三个字母只出现一次，省地方')
  assert.match(html, /border-radius:4px/, '圆角方块：数字更好读、点击面积更大')
  assert.doesNotMatch(html, /position:fixed/, '不再有任何弹出层')
})

test('终端按钮：没绑定也一直在（位置不跳），但显示为淡色', async () => {
  const { exported } = await loadClient({
    storage: { 'dsh-vps:hosts': JSON.stringify([{ alias: 'hk', note: '' }]) },
  })
  const ctx = fakeSlots()
  exported.apply(ctx)
  const html = renderToStaticMarkup(
    React.createElement(ctx.registered.get('conversation.session.header.actions').component, { sessionId: 'free' }),
  )
  assert.match(html, /&gt;_/, '终端按钮一直在')
  assert.match(html, /data-vps-terminal=""[^>]*opacity:0\.55/, '没绑定时淡色')
  assert.match(html, />1<\/button>/, '只有一台也写编号 1')
  assert.equal((html.match(/<button/g) ?? []).length, 2)
})

test('终端连接地址跟着页面走：Desktop、dsh web 局域网、https 反向代理都能用', async () => {
  const { exported } = await loadClient()
  const { terminalUrl } = exported.__test
  assert.equal(
    terminalUrl('http://127.0.0.1:52100', 's 1', 90, 20),
    'ws://127.0.0.1:52100/api-vps/ws/terminal?sessionId=s+1&cols=90&rows=20',
  )
  assert.equal(
    terminalUrl('http://192.168.1.8:8787', 's1', 80, 24),
    'ws://192.168.1.8:8787/api-vps/ws/terminal?sessionId=s1&cols=80&rows=24',
  )
  assert.equal(
    terminalUrl('https://dsh.example.com', 's1', 80, 24),
    'wss://dsh.example.com/api-vps/ws/terminal?sessionId=s1&cols=80&rows=24',
    'https 页面必须用 wss，否则浏览器拦截',
  )
})

test('输入框下方：绑定了机器但没点开终端时，仍然什么都不渲染', async () => {
  const { exported } = await loadClient({ storage: { 'dsh-vps:bind:s3': 'hk' } })
  const ctx = fakeSlots()
  exported.apply(ctx)
  const html = renderToStaticMarkup(
    React.createElement(ctx.registered.get('conversation.composer.dock').component, { sessionId: 's3' }),
  )
  assert.equal(html, '')
})

test('界面代码里的协议名、路径、xterm 版本与服务端一致', async () => {
  const { readFile } = await import('node:fs/promises')
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const server = await import('../lib/terminal-server.js')
  assert.ok(client.includes(`'${server.TERMINAL_PROTOCOL}'`), '子协议名')
  assert.ok(client.includes(`'${server.TERMINAL_PATH}'`), '连接路径')
  assert.ok(client.includes(`XTERM_VERSION = '${server.XTERM_VERSION}'`), 'xterm 版本号（缓存地址）')
})
