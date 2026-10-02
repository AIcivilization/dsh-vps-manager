// 多语言：界面跟着 DSH 的语言走；服务端的报错、提示、命令输出照界面带来的语言说
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { writeHosts } from '../lib/config.js'
import { L, _resetLang, currentLang, normalizeLang, onLangChange, withLang } from '../lib/i18n.js'
import { registerCommands } from '../lib/commands.js'
import { loadRecipes, recipeText } from '../lib/recipes.js'
import { registerRoutes } from '../lib/routes.js'
import { classifySshFailure } from '../lib/ssh.js'

const HAN = /[一-鿿]/ // 汉字（全角空格、标点不算）

// —— 服务端 ——

test('语言名归一：zh / zh-CN / zh-TW 都是中文，其余都按英文', () => {
  assert.equal(normalizeLang('zh'), 'zh')
  assert.equal(normalizeLang('zh-CN'), 'zh')
  assert.equal(normalizeLang('ZH-tw'), 'zh')
  assert.equal(normalizeLang('en'), 'en')
  assert.equal(normalizeLang('ja'), 'en')
  assert.equal(normalizeLang(''), '')
})

test('请求里带的语言只管这个请求；没有请求可依时用最近一次的；测试环境默认中文', async () => {
  _resetLang()
  assert.equal(currentLang(), 'zh', '测试固定成中文（test/test.env）')
  const inside = await withLang('en', async () => {
    await new Promise((r) => setTimeout(r, 5))
    return L('中文', 'English') // 跨过 await 仍然是这个请求的语言
  })
  assert.equal(inside, 'English')
  assert.equal(L('中文', 'English'), 'English', '命令输出这类没有请求的，用最近一次的语言')
  assert.equal(withLang('zh', () => L('中文', 'English')), '中文')
  _resetLang()
})

test('界面换了语言就通知（命令说明要重新登记）；没换不通知', async () => {
  _resetLang()
  const seen = []
  const off = onLangChange((l) => seen.push(l))
  withLang('zh', () => {}) // 和默认一样：不算换
  withLang('en', () => {})
  withLang('en', () => {})
  withLang('zh', () => {})
  await new Promise((r) => setTimeout(r, 10))
  off()
  assert.deepEqual(seen, ['en', 'zh'])
  _resetLang()
})

test('SSH 报错原因按当时的语言说（表是启动时建的，文字要用时才挑）', () => {
  const stderr = 'ssh: connect to host 1.2.3.4 port 22: Connection refused'
  assert.match(withLang('zh', () => classifySshFailure(stderr, 255).hint), /端口拒绝连接/)
  assert.match(withLang('en', () => classifySshFailure(stderr, 255).hint), /^Connection refused on that port/)
  _resetLang()
})

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vps-i18n-'))
  const env = { HOME: dir, DSH_HOME: join(dir, '.dsh') }
  await writeHosts({ current: '', hosts: {} }, env)
  return { dir, env }
}

test('设置页接口：请求头 x-dsh-vps-lang 是什么语言，报错就是什么语言', async () => {
  const { env } = await sandbox()
  const routes = new Map()
  const ws = { config: { host: '127.0.0.1', port: 3000 }, register({ path, handler }) { routes.set(path, handler); return () => {} }, tapIndex() { return () => {} } }
  const reg = registerRoutes({ webServer: ws }, { env })
  const call = async (lang) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: 'nobody' }))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:3000', 'x-dsh-vps-token': reg.token, 'x-dsh-vps-lang': lang }
    req.socket = { remoteAddress: '127.0.0.1' }
    const out = {}
    await routes.get('/api-vps/files/places')(req, { writeHead() {}, end: (t) => { out.body = JSON.parse(t) } })
    return out.body
  }
  assert.equal((await call('en')).error, 'This conversation has not turned on the VPS switch yet')
  assert.equal((await call('zh')).error, '这个对话还没打开 VPS 开关')
  _resetLang()
})

test('/vps- 命令：英文界面下命令说明、/vps-help、菜谱清单全是英文', async () => {
  const { env } = await sandbox()
  const registered = []
  const fakeCtx = { commands: { register: (d) => { registered.push(d); return () => {} } } }
  await withLang('en', async () => {
    registerCommands(fakeCtx, { env })
    for (const d of registered) assert.doesNotMatch(d.description, HAN, `/${d.name} 的说明还有中文：${d.description}`)
    const help = (await registered.find((c) => c.name === 'vps-help').handler({ rawInput: '' })).text
    assert.doesNotMatch(help, HAN, help)
    assert.match(help, /Look things up/)
    const recipes = (await registered.find((c) => c.name === 'vps-recipes').handler({ rawInput: '' })).text
    assert.doesNotMatch(recipes, HAN, recipes)
  })
  _resetLang()
})

test('内置菜谱都有英文名字和说明；带计划的都有英文计划，参数说明也有英文', async () => {
  const { list } = await loadRecipes({ includeUser: false })
  for (const r of list) {
    assert.ok(r.name_en && r.desc_en, `${r.id} 缺英文名字或说明`)
    if (r.plan) assert.ok(r.plan_en, `${r.id} 缺英文计划`)
    for (const p of r.params) assert.ok(p.desc_en, `${r.id} 的参数 ${p.name} 缺英文说明`)
  }
  const swap = list.find((r) => r.id === 'setup-swap')
  assert.equal(withLang('en', () => recipeText(swap, 'name')), 'Add swap')
  assert.equal(withLang('zh', () => recipeText(swap, 'name')), swap.name)
  assert.equal(withLang('en', () => recipeText({ name: '我的菜谱' }, 'name')), '我的菜谱', '自己存的菜谱没写英文就用中文')
  _resetLang()
})

// —— 界面 ——

async function loadClient({ pageLang } = {}) {
  let spec = null
  globalThis.window = {
    __ModuleLoader__: { load: (s) => { spec = s } },
    __DSH_VPS_TOKEN__: 'test-token-123',
    confirm: () => true,
    innerHeight: 800,
    location: { origin: 'http://127.0.0.1:3000' },
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  if (pageLang) globalThis.document = { documentElement: { lang: pageLang }, getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } }
  else delete globalThis.document
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { status: 200, json: async () => ({ ok: true, hosts: [], recipes: [], current: '', settings: {} }) }
  }
  await import(`../lib/client.js?${Math.random()}`)
  const exported = spec.factory((n) => {
    if (n === 'react') return React
    throw new Error(n)
  })
  return { exported, calls }
}

function fakeCtx(locale) {
  const registered = new Map()
  return {
    registered,
    inject: (deps, cb) => {
      if (deps.includes('locale') && locale) cb({ locale, effect: (fn) => fn() })
    },
    slots: {
      inject: (_n, cb) => cb(),
      register: (d, c) => {
        registered.set(d.name, { descriptor: d, component: c })
        return () => {}
      },
    },
  }
}

test('界面：网页是英文（老版本 DSH 只改 <html lang>）时设置页全是英文', async () => {
  const { exported } = await loadClient({ pageLang: 'en' })
  const ctx = fakeCtx()
  exported.apply(ctx)
  const html = renderToStaticMarkup(React.createElement(ctx.registered.get('settings.section').component))
  delete globalThis.document
  assert.match(html, /VPS Manager/)
  assert.match(html, /Feedback and suggestions/)
  assert.match(html, /Report a problem/)
  assert.doesNotMatch(html, HAN, '英文界面不该再有汉字')
})

test('界面：跟 DSH 的语言服务走，语言包按它声明的退回链落到中文或英文；切换时立刻换', async () => {
  let snap = { active: 'zh-TW', locales: [{ id: 'zh' }, { id: 'en' }, { id: 'zh-TW', fallback: 'zh' }, { id: 'ja', fallback: 'en' }] }
  let notify = () => {}
  const locale = { getLocale: () => snap, subscribe: (fn) => { notify = fn; return () => {} } }
  const { exported, calls } = await loadClient()
  exported.apply(fakeCtx(locale))
  const { lang, api } = exported.__test
  assert.equal(lang(), 'zh', '繁体中文语言包退回中文')

  snap = { ...snap, active: 'ja' }
  notify()
  assert.equal(lang(), 'en', '日文语言包退回英文')

  snap = { ...snap, active: 'en' }
  notify()
  await api('overview', {})
  assert.equal(calls.at(-1).init.headers['x-dsh-vps-lang'], 'en', '请求里带上当前语言，服务端照它说')
})

/** 从 `const NAME = {` 或 `[` 开始，取到配对的右括号为止（跳过字符串里的括号） */
function blockOf(source, name) {
  const start = source.indexOf(`const ${name} = `)
  assert.ok(start >= 0, `找不到 ${name}`)
  let i = start + `const ${name} = `.length
  const open = source[i]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  for (; i < source.length; i += 1) {
    const c = source[i]
    if (c === "'" || c === '"' || c === '`') {
      for (i += 1; i < source.length && source[i] !== c; i += 1) if (source[i] === '\\') i += 1
    } else if (c === open) depth += 1
    else if (c === close && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`${name} 括号不配对`)
}

test('界面：启动时建的文字表（卸载项、终端选项、确认档位…）用到时才挑语言', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 直接写 L(...) 的话，语言在插件加载那一刻就定死了；要写成 getter 或函数
  for (const name of ['CONFIRM_LABEL', 'PRIV_LABEL', 'UNINSTALL_ITEMS', 'UNINSTALL_GROUPS', 'TERM_THEMES', 'TERM_KEEP', 'STATUS_TEXT']) {
    const block = blockOf(source, name)
    // 提前定死的写法：属性直接等于 L(...)，或数组元素直接是 L(...)
    const eager = block.split('\n').filter((line) => /(^\s*[\w$]+: L\(|[\[,]\s*L\()/.test(line))
    assert.deepEqual(eager, [], `${name} 里有加载时就求值的 L(...)`)
  }
})

test('服务端：模块一加载就建好的表里，也不能有提前定死语言的 L(...)', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const dir = new URL('../lib/', import.meta.url)
  const hits = []
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.js') && !['client.js', 'i18n.js'].includes(n))) {
    const source = await readFile(new URL(f, dir), 'utf8')
    for (const m of source.matchAll(/^(?:export )?const ([\w$]+) = [[{]/gm)) {
      // 模块顶层的表都在第 0 列的 ] 或 } 处结束（里面有正则，不好按括号配对）
      const rest = source.slice(m.index)
      const end = rest.search(/\n[\]}]/)
      const first = rest.split('\n')[0]
      const oneLine = /[}\]]\s*$/.test(first) // 一行写完的表
      const block = oneLine || end < 0 ? first : rest.slice(0, end)
      const eager = block.split('\n').filter((line) => /(^\s*[\w$]+: L\(|[[,(]\s*L\()/.test(line))
      for (const line of eager) hits.push(`${f} ${m[1]}: ${line.trim().slice(0, 80)}`)
    }
  }
  assert.deepEqual(hits, [])
})
