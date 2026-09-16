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

test('渲染阶段不碰对话框，submit 也永远不主动调用', async () => {
  const { exported } = await loadClient({ storage: { 'dsh-vps:bind:s1': 'hk' } })
  const calls = []
  const actions = {
    insertText: (t) => calls.push(['insertText', t]),
    focus: () => calls.push(['focus']),
    submit: () => calls.push(['submit']),
  }
  const ctx = fakeSlots()
  exported.apply(ctx)
  const Dock = ctx.registered.get('conversation.composer.dock').component
  renderToStaticMarkup(React.createElement(Dock, { sessionId: 's1', inputActions: actions }))
  assert.deepEqual(calls, [], '渲染阶段不许碰对话框')
  assert.equal(typeof actions.submit, 'function', 'submit 存在但我们不主动调用：发不发由用户决定')
})

test('浮层里的每一项都推成对话里的命令，而不是自己显示结果', async () => {
  const { exported } = await loadClient()
  const { commandForQuery } = exported.__test
  // 有专属命令的用专属命令，读起来像人话
  assert.equal(commandForQuery('disk'), '/vps-disk')
  assert.equal(commandForQuery('sysinfo'), '/vps-sysinfo')
  assert.equal(commandForQuery('health'), '/vps-ping')
  assert.equal(commandForQuery('docker-ps'), '/vps-docker')
  // 没有专属命令的走通用入口，仍然落在对话里
  assert.equal(commandForQuery('cert-expiry'), '/vps-q cert-expiry')
  assert.equal(commandForQuery('login-history'), '/vps-q login-history')
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
  assert.match(toggleHtml, />VPS</, '头部只有一个安静的开关')
  assert.doesNotMatch(toggleHtml, /🟢|🔴/, '没打开时不显示机器状态')
})

test('打开开关的对话：状态条出现并显示绑定的机器', async () => {
  const { exported } = await loadClient({
    storage: { 'dsh-vps:bind:s2': 'vps-dsh' },
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, alias: 'vps-dsh', recipes: [], tasks: [] }) }),
  })
  const ctx = fakeSlots()
  exported.apply(ctx)
  const html = renderToStaticMarkup(
    React.createElement(ctx.registered.get('conversation.composer.dock').component, { sessionId: 's2' }),
  )
  assert.match(html, /vps-dsh/, '绑定后状态条要显示是哪台机器')
  assert.match(html, /敲命令/, '状态条里有命令框：对话框就是这台机器的命令行')
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

test('写进输入框用的是 setDraft（InputActions 上没有 insertText）', async () => {
  const { exported } = await loadClient()
  const { writeDraft } = exported.__test

  // 空输入框 + 命令 → 直接写进去
  const calls = []
  const actions = { setDraft: (t) => calls.push(t), focus: () => calls.push('focus') }
  assert.deepEqual(writeDraft({ inputActions: actions }, '/vps-disk', { current: '' }), { ok: true })
  assert.deepEqual(calls, ['/vps-disk', 'focus'])

  // 输入框里有内容 + 命令 → 不覆盖（命令行必须以 / 开头，接在后面不成立）
  const calls2 = []
  const res = writeDraft(
    { inputActions: { setDraft: (t) => calls2.push(t) } },
    '/vps-disk',
    { current: '我正在写一段话' },
  )
  assert.deepEqual(res, { ok: false, reason: 'draft-busy' })
  assert.deepEqual(calls2, [], '绝不能把用户写了一半的内容冲掉')

  // 自然语言（交给 AI）→ 可以接在已有内容后面
  const calls3 = []
  writeDraft(
    { inputActions: { setDraft: (t) => calls3.push(t) } },
    '看看磁盘',
    { current: '顺便', command: false },
  )
  assert.deepEqual(calls3, ['顺便\n看看磁盘'])

  // 宿主没给 inputActions → 明确失败，由调用方提示手动输入
  assert.deepEqual(writeDraft({}, '/vps-disk', {}), { ok: false, reason: 'no-actions' })
})

test('只用 InputActions 真实存在的方法', async () => {
  const { exported } = await loadClient()
  const used = new Set()
  const actions = new Proxy({}, {
    get: (_t, prop) => {
      used.add(String(prop))
      return () => {}
    },
  })
  exported.__test.writeDraft({ inputActions: actions }, '/vps-ping', { current: '' })
  for (const name of used) {
    assert.ok(
      ['setDraft', 'focus', 'submit', 'addAttachments', 'removeAttachment', 'pruneAttachments'].includes(name),
      `用了不存在的方法：${name}`,
    )
  }
  assert.ok(used.has('setDraft'))
  assert.ok(!used.has('insertText'), 'insertText 是编辑器内部的，不在 InputActions 上')
})
