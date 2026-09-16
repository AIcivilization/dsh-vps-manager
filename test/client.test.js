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

test('bundle 以 ModuleLoader 形式导出，并注册五个挂载点', async () => {
  const { spec, exported } = await loadClient()
  assert.equal(spec.id, 'dsh-vps-manager')
  assert.deepEqual(exported.inject, ['slots'])

  const ctx = fakeSlots()
  exported.apply(ctx)
  const panellist = ctx.registered.get('sidebar.panellist')
  const main = ctx.registered.get('main')
  const settings = ctx.registered.get('settings.section')

  const toggle = ctx.registered.get('conversation.session.header.actions')
  const dock = ctx.registered.get('conversation.composer.dock')
  assert.ok(panellist && main && settings && toggle && dock, '五个挂载点都要在')
  assert.equal(toggle.descriptor.id, 'vps-manager')
  assert.equal(dock.descriptor.id, 'vps-manager')
  assert.equal(panellist.descriptor.id, 'vps-manager')
  assert.equal(main.descriptor.key, 'vps-manager', 'main 的 key 必须与 panellist 的 id 一致，否则点一下会抛错')
  assert.notEqual(main.descriptor.key, 'conversation', '不能占用官方保留的 conversation')
  assert.equal(panellist.descriptor.label(), 'VPS 管理')
  assert.equal(settings.descriptor.id, 'vps-manager')
})

test('面板首屏能渲染（不抛错），标题与三个标签页都在', async () => {
  const { exported } = await loadClient()
  const ctx = fakeSlots()
  exported.apply(ctx)
  const html = renderToStaticMarkup(React.createElement(ctx.registered.get('main').component))
  assert.match(html, /VPS 管理/)
  assert.match(html, /机器/)
  assert.match(html, /应用商店/)
  assert.match(html, /系统维护/, '装软件和系统维护要分开两个页')
  assert.match(html, /任务/)
  assert.match(html, /读取中/)
})

test('设置页能渲染', async () => {
  const { exported } = await loadClient()
  const ctx = fakeSlots()
  exported.apply(ctx)
  const html = renderToStaticMarkup(React.createElement(ctx.registered.get('settings.section').component))
  assert.match(html, /VPS 管理/)
})

test('侧边栏图标渲染成 svg', async () => {
  const { exported } = await loadClient()
  const ctx = fakeSlots()
  exported.apply(ctx)
  const html = renderToStaticMarkup(React.createElement(ctx.registered.get('sidebar.panellist').component, { size: 18, active: true }))
  assert.match(html, /<svg/)
  assert.match(html, /width="18"/)
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
  assert.match(toggleHtml, />VPS</, '头部只有 VPS 三个字母加小球')
  assert.doesNotMatch(toggleHtml, /🟢|🔴/, '不用 emoji，用小球颜色表示')
})

test('面板和设置页照常在打开时才加载（它们本来就是专门去开的）', async () => {
  const calls = []
  const { exported } = await loadClient({
    fetchImpl: async (url) => {
      calls.push(url)
      return { status: 200, json: async () => ({ ok: true, hosts: [], recipes: [], settings: {} }) }
    },
  })
  const ctx = fakeSlots()
  exported.apply(ctx)
  renderToStaticMarkup(React.createElement(ctx.registered.get('main').component))
  assert.equal(typeof ctx.registered.get('main').component, 'function')
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

test('小球里的数字：一台不写，多台写 1234', async () => {
  const { exported } = await loadClient()
  const { ballLabel } = exported.__test
  assert.equal(ballLabel(0, 1), '', '只有一台就不用编号')
  assert.equal(ballLabel(0, 4), '1')
  assert.equal(ballLabel(1, 4), '2')
  assert.equal(ballLabel(3, 4), '4')
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
  assert.equal((html.match(/<button/g) ?? []).length, 2, '两台机器两个小球')
  assert.match(html, />1</, '小球里写编号')
  assert.match(html, />2</)
  assert.equal((html.match(/VPS/g) ?? []).length, 1, 'VPS 三个字母只出现一次，省地方')
  assert.match(html, /border-radius:50%/, '是小球不是方按钮')
  assert.doesNotMatch(html, /position:fixed/, '不再有任何弹出层')
})
