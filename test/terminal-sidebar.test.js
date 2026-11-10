// 终端扩展到 DSH 的右侧栏（「VPS 终端」页签）：和输入框下方是同一个终端，只是挂的地方不同
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

async function loadClient(store = {}) {
  let spec = null
  globalThis.window = {
    __ModuleLoader__: { load: (s) => { spec = s } }, __DSH_VPS_TOKEN__: 't', confirm: () => true, innerHeight: 800,
    location: { origin: 'http://127.0.0.1:3000' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v }, removeItem: (k) => { delete store[k] } },
  }
  delete globalThis.document
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) })
  await import(`../lib/client.js?${Math.random()}`)
  return spec.factory((n) => {
    if (n === 'react') return React
    throw new Error(n)
  })
}

/** 假的右侧栏：记下登记了什么、打开了哪种页签、关了哪个 */
function fakeSidebar() {
  const defs = []
  const regs = []
  const closers = new Map()
  const calls = { opened: [], closed: [] }
  const right = {
    openTab: (kind) => { calls.opened.push(kind) },
    close: (id) => { calls.closed.push(id) },
    registerCloseHandler: (kind, fn) => { closers.set(kind, fn); return () => closers.delete(kind) },
  }
  const ctx = {
    slots: { inject: (_name, fn) => fn(), register: (d, C) => { regs.push([d, C]); return () => {} } },
    inject: (names, cb) => {
      if (!names.includes('sidebarRight')) return
      cb({ get: (n) => (n === 'sidebarRight' ? right : n === 'sidebarRightTabs' ? { register: (d) => { defs.push(d); return () => {} } } : undefined), effect: (fn) => fn() })
    },
  }
  return { ctx, defs, regs, closers, calls }
}

const fakeEntry = (over = {}) => ({
  key: 'k1', sessionId: 's1', alias: 'la', view: 'normal', restoreView: 'normal', tab: 'terminal', status: 'open', note: '',
  id: 't1', startedAt: Date.now(), version: 0, el: {}, ...over,
})

test('登记：「VPS 终端」是右侧栏的一种页签——开始页有入口、切走保活、正文用类型 id 登记、关页签有处理', async () => {
  const exported = await loadClient()
  const sb = fakeSidebar()
  exported.apply(sb.ctx)
  const term = sb.defs.find((d) => d.kind === 'vps-manager-terminal')
  assert.ok(term, '登记了「VPS 终端」')
  assert.ok(sb.defs.some((d) => d.kind === 'vps-manager-status'), '「VPS 状态」照旧')
  assert.equal(term.keepMounted, true, '切到别的页签、折叠右侧栏，终端照跑')
  assert.equal(term.title(), 'VPS 终端')
  assert.equal(term.guide[0].title(), 'VPS 终端')
  assert.ok(sb.regs.some(([d]) => d.name === 'sidebar.right.pane.tab' && d.key === term.id))
  assert.ok(sb.closers.has('vps-manager-terminal'))
})

test('搬过去、放回来：从「状态」页搬时换到终端页；关掉右侧栏的页签终端不结束，回到输入框下方的横栏', async () => {
  const exported = await loadClient()
  const sb = fakeSidebar()
  exported.apply(sb.ctx)
  const { termStore, moveTermToSidebar, moveTermToDock } = exported.__test
  const entry = fakeEntry({ view: 'maximized', tab: 'status' })
  termStore.set('s1', entry)
  moveTermToSidebar(entry)
  assert.equal(entry.view, 'sidebar')
  assert.equal(entry.tab, 'terminal', '「状态」有自己的「VPS 状态」页签')
  assert.equal(entry.restoreView, 'maximized', '放回来时还是原来的大小')
  assert.deepEqual(sb.calls.opened, ['vps-manager-terminal'])
  // 放回：先改位置再关页签，关页签的处理不会再把它缩成横栏
  entry.sidebarTabId = 'tab-9'
  moveTermToDock(entry)
  assert.equal(entry.view, 'maximized')
  assert.deepEqual(sb.calls.closed, ['tab-9'])
  sb.closers.get('vps-manager-terminal')('s1', { id: 'tab-9' })
  assert.equal(entry.view, 'maximized', '已经放回来了，关页签不再改它')
  // 在右侧栏时用户关掉页签：缩成横栏，点横栏回到普通大小
  moveTermToSidebar(entry)
  sb.closers.get('vps-manager-terminal')('s1', { id: 'tab-10' })
  assert.equal(entry.view, 'minimized')
  assert.equal(entry.restoreView, 'normal')
  assert.equal(termStore.get('s1'), entry, '终端还在，没结束')
})

test('右侧栏页签：终端在这里时撑满（只有「终端 | 文件」两页、「放回输入框下方」、结束）；在输入框下方时给「移到这里」；没连机器时说先连', async () => {
  const exported = await loadClient({ 'dsh-vps:bind:s1': 'la' })
  const { termStore, VpsTerminalSidebar } = exported.__test
  const render = (sessionId) => renderToStaticMarkup(React.createElement(VpsTerminalSidebar, { sessionId, useTabInfo: () => ({ tab: { id: 'tab-1', visible: false, actions: { close() {} } } }) }))
  termStore.set('s1', fakeEntry({ view: 'sidebar' }))
  const here = render('s1')
  assert.match(here, /data-vps-terminal-panel="sidebar"/)
  assert.match(here, /aria-label="终端"/)
  assert.match(here, /aria-label="文件"/)
  assert.doesNotMatch(here, /aria-label="状态"/)
  assert.match(here, /aria-label="放回输入框下方"/)
  assert.match(here, /data-vps-light="close"/)
  assert.doesNotMatch(here, /data-vps-light="minimize"/, '右侧栏自己能折叠、全屏，不放黄绿两个圆点')
  termStore.set('s1', fakeEntry({ view: 'normal' }))
  assert.match(render('s1'), /终端在输入框下方。.*移到这里/)
  termStore.delete('s1')
  assert.match(render('s1'), /连 la 的终端。.*打开终端/)
  assert.match(render('s2'), /这个对话还没连服务器/)
})

test('输入框下方：终端在右侧栏时只留一条横栏，右边「放回这里」；面板标题栏在终端页有「扩展到右侧栏」', async () => {
  const exported = await loadClient()
  const sb = fakeSidebar()
  exported.apply(sb.ctx)
  const { TerminalSidebarBar, SidebarOpenButton, termChrome } = exported.__test
  const bar = renderToStaticMarkup(React.createElement(TerminalSidebarBar, { entry: fakeEntry({ view: 'sidebar' }), prefs: { theme: 'light', fontSize: 13 } }))
  assert.match(bar, /data-vps-terminal-bar="sidebar"/)
  assert.match(bar, /终端在右侧栏 · 刚打开/)
  assert.match(bar, /放回这里/)
  const btn = renderToStaticMarkup(React.createElement(SidebarOpenButton, { c: termChrome('light'), icon: 'panelBottom', title: '放回输入框下方' }))
  assert.match(btn, /aria-label="放回输入框下方"/)
  assert.match(btn, /<path d="M3 15h18"/, '方框里一道横线：放回下方')
})
