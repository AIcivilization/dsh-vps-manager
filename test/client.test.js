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

test('bundle 以 ModuleLoader 形式导出，并注册三个插槽', async () => {
  const { spec, exported } = await loadClient()
  assert.equal(spec.id, 'dsh-vps-manager')
  assert.deepEqual(exported.inject, ['slots'])

  const ctx = fakeSlots()
  exported.apply(ctx)
  const panellist = ctx.registered.get('sidebar.panellist')
  const main = ctx.registered.get('main')
  const settings = ctx.registered.get('settings.section')

  assert.ok(panellist && main && settings)
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
