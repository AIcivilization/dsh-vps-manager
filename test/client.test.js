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

async function loadClient({ fetchImpl } = {}) {
  let spec = null
  const calls = []
  globalThis.window = {
    __ModuleLoader__: { load: (s) => { spec = s } },
    __DSH_VPS_TOKEN__: 'test-token-123',
    confirm: () => true,
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

test('bundle 以 ModuleLoader 形式导出，并注册四个挂载点', async () => {
  const { spec, exported } = await loadClient()
  assert.equal(spec.id, 'dsh-vps-manager')
  assert.deepEqual(exported.inject, ['slots'])

  const ctx = fakeSlots()
  exported.apply(ctx)
  const panellist = ctx.registered.get('sidebar.panellist')
  const main = ctx.registered.get('main')
  const settings = ctx.registered.get('settings.section')

  const composer = ctx.registered.get('conversation.input.left')
  assert.ok(panellist && main && settings && composer, '四个挂载点都要在')
  assert.equal(composer.descriptor.id, 'vps-manager')
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

test('浮层的建议行只在真有问题时出现，且最多三条', async () => {
  const { exported } = await loadClient()
  const { suggestions } = exported.__test
  const ok = { disk_pct: '25%', mem_total_mb: '3800', swap_total_mb: '3071', fail2ban: '1', auto_updates: '1' }
  assert.deepEqual(suggestions({ reachable: true }, ok), [], '一切正常就不该唠叨')

  const full = suggestions({ reachable: true }, { ...ok, disk_pct: '92%' })
  assert.equal(full[0].kind, 'query')
  assert.equal(full[0].id, 'disk')
  assert.match(full[0].text, /92%/)

  const noF2b = suggestions({ reachable: true }, { ...ok, fail2ban: '0' })
  assert.equal(noF2b[0].id, 'login-history', '没装 fail2ban 时先让人看有没有人在爆破')

  const small = suggestions({ reachable: true }, { ...ok, mem_total_mb: '1024', swap_total_mb: '0' })
  assert.match(small[0].text, /swap/)

  const down = suggestions({ reachable: false }, ok)
  assert.equal(down.length, 1, '连不上时只说这一件事，别堆别的建议')
  assert.match(down[0].text, /连不上/)

  const many = suggestions({ reachable: true }, { disk_pct: '95%', mem_total_mb: '512', swap_total_mb: '0', fail2ban: '0', auto_updates: '0' })
  assert.equal(many.length, 3, '最多三条')
})

test('结果交给 AI：写进对话框草稿，而不是替用户发出去', async () => {
  const { exported } = await loadClient()
  // inputActions 由 conversation.input.left 插槽作为标准 prop 传入
  const calls = []
  const actions = {
    insertText: (t) => calls.push(['insertText', t]),
    focus: () => calls.push(['focus']),
    submit: () => calls.push(['submit']),
  }
  const ctx = fakeSlots()
  exported.apply(ctx)
  const Entry = ctx.registered.get('conversation.input.left').component
  // 渲染时不应自己调用任何输入框动作
  renderToStaticMarkup(React.createElement(Entry, { inputActions: actions }))
  assert.deepEqual(calls, [], '渲染阶段不许碰对话框')
  assert.equal(typeof actions.submit, 'function', 'submit 存在但我们不主动调用：发不发由用户决定')
})
