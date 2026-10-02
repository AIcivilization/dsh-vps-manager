/* global window, document, fetch, navigator, setTimeout, clearTimeout */
// lib/client.js — 界面（设计第三节）
//
// 手写单文件 bundle，没有构建链：供 DSH web 客户端的 ModuleLoader 注入。
// 三处挂载，全部是「对话解决不了的事」：
//   conversation.session.header.actions  VPS 开关（这个对话操作哪台机器）
//   conversation.composer.dock           只在有任务在跑 / 连不上 / 磁盘快满时冒一行；点开终端时放终端
//   settings.section                     设置 → VPS 管理（机器管理、添加机器、全局设置）
//
// 曾经还有左边栏图标 + 主视区面板（机器 / 应用商店 / 系统维护 / 任务），实测后整个删掉：
// 机器管理搬进设置页，其余（浏览菜谱、装、看任务）命令和 AI 都能做，而且更快更省。
//
// 界面只通过 /api-vps/* 路由调 host：它没有 Session 绑定，不能直接执行命令。
// 请求头带的 token 由 host 侧经 index tap 注入页面，跨站网页读不到。
//
// 硬约束：客户端崩了不能影响命令与 AI 工具，所以注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-vps-manager',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    // ——————————————————————— 界面语言：跟着 DSH ———————————————————————
    //
    // DSH 自带中文、英文，语言包还能再加；每种语言都声明「缺词时退回哪种」，最后都退到英文。
    // 插件的文字只有中英两份：沿着当前语言的退回链，先碰到中文用中文，否则用英文。
    // 当前语言从 DSH 的语言服务拿（切换时它会通知）；没有这个服务的老版本，看网页的 lang
    // （DSH 切语言时会改它）。都没有（测试环境）按中文。
    // 写法：L('中文', 'English')，两种文字挨着写。请求里带上当前语言，服务端的报错、提示也照它说
    let localeSvc = null
    let langCache = ''
    const langListeners = new Set()
    function resolveLang() {
      try {
        const snap = localeSvc?.getLocale?.()
        if (snap?.active) {
          const byId = new Map((snap.locales ?? []).map((l) => [String(l.id).toLowerCase(), l]))
          let id = String(snap.active).toLowerCase()
          for (let i = 0; i < 10 && id; i += 1) {
            if (id === 'zh' || id.startsWith('zh-')) return 'zh'
            if (id === 'en' || id.startsWith('en-')) return 'en'
            id = String(byId.get(id)?.fallback ?? '').toLowerCase()
          }
          return 'en'
        }
      } catch {
        // 语言服务出错就看网页
      }
      const page = typeof document === 'undefined' ? '' : document.documentElement?.lang || navigator?.language || ''
      if (!page) return 'zh'
      return /^zh/i.test(page) ? 'zh' : 'en'
    }
    function lang() {
      if (!langCache) langCache = resolveLang()
      return langCache
    }
    function langChanged() {
      const next = resolveLang()
      if (next === langCache) return
      langCache = next
      for (const fn of [...langListeners]) fn()
    }
    /** 中英两份文字，按当前语言挑一份 */
    function L(zh, en) {
      return lang() === 'zh' ? zh : en
    }
    /** 挂在每个插槽的根组件上：语言一换就整棵重画 */
    function useLang() {
      const [, bump] = useState(0)
      useEffect(() => {
        const fn = () => bump((v) => v + 1)
        langListeners.add(fn)
        return () => langListeners.delete(fn)
      }, [])
      return lang()
    }

    // ——————————————————————— 与 host 通信 ———————————————————————

    // 默认 2 分钟超时：卸载要在服务器上干活，单独给更长的时间。
    // 没有超时的话，接口万一不回应，按钮就一直转着「处理中…」，用户只能干等
    const API_TIMEOUT = 120_000

    /**
     * 页面里的令牌过期了（DSH 重启过、装了新版插件后后台重新加载过）：去首页取一次新的。
     * 首页和这个页面同源、带着同一个登录 Cookie，跨站网页读不到它。取不到就返回 false
     */
    async function refreshToken() {
      try {
        const res = await fetch(`${window.location.origin}/`, { credentials: 'same-origin', cache: 'no-store' })
        const html = await res.text()
        const m = /__DSH_VPS_TOKEN__=("[a-f0-9]{16,}")/.exec(html)
        if (!m) return false
        window.__DSH_VPS_TOKEN__ = JSON.parse(m[1])
        return true
      } catch {
        return false
      }
    }

    async function api(path, body = {}, { timeoutMs = API_TIMEOUT, retried = false } = {}) {
      let res
      try {
        res = await fetch(`/api-vps/${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dsh-vps-token': window.__DSH_VPS_TOKEN__ || '',
            'x-dsh-vps-lang': lang(), // 服务端的报错、提示照界面的语言说
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (error?.name === 'TimeoutError') throw new Error(L(`等了 ${Math.round(timeoutMs / 1000)} 秒没有回应：可以再试一次，或刷新页面`, `No response after ${Math.round(timeoutMs / 1000)} seconds: try again, or reload the page`))
        throw new Error(L('连不上 DSH：看看 DSH 还开着吗，或刷新页面', 'Cannot reach DSH: check that DSH is still running, or reload the page'))
      }
      let data = null
      try {
        data = await res.json()
      } catch {
        throw new Error(res.status === 405
          ? L('这个功能在当前运行的插件里还没有：DSH 运行期间装的新版本要重启 DSH 才生效', 'The running plugin does not have this yet: a version installed while DSH was running takes effect after DSH restarts')
          : L(`服务返回异常（HTTP ${res.status}）`, `Unexpected response (HTTP ${res.status})`))
      }
      if (!data || data.ok !== true) {
        // 有的接口把业务上的失败原因放在 hint 里（测连通、查指纹、跑菜谱）：有就显示它，别只说「请求失败」
        const message = data?.error || data?.hint || L(`请求失败（HTTP ${res.status}）`, `Request failed (HTTP ${res.status})`)
        if (/token/i.test(message)) {
          // 先自己换新令牌再试一次，用户什么都不用做；换不到才请他刷新
          if (!retried && (await refreshToken())) return api(path, body, { timeoutMs, retried: true })
          throw new Error(L('令牌对不上了（DSH 重启过或页面开太久）：刷新页面再试', 'Token mismatch (DSH restarted, or the page has been open a long time): reload the page and try again'))
        }
        throw new Error(message)
      }
      return data
    }

    // 按钮在等接口时显示「处理中…（N 秒）」：数字在动，用户就知道还活着，不是卡死了。
    // 接口本身有超时（见 api），所以这个数字不会无限涨下去
    function useElapsed(active) {
      const [seconds, setSeconds] = useState(0)
      useEffect(() => {
        if (!active) {
          setSeconds(0)
          return undefined
        }
        const started = Date.now()
        const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000)
        return () => clearInterval(timer)
      }, [active])
      return seconds
    }

    /** 等待中的按钮文字：一秒以内不显示秒数，免得闪一下 */
    function waitingLabel(text, seconds) {
      return seconds > 1 ? L(`${text}（${seconds} 秒）`, `${text} (${seconds} s)`) : text
    }

    /**
     * 让输入框下方那一栏给我们单独一行。
     *
     * DSH 0.1.7 把插件插槽和它自己的用量显示放进同一个「居中、不换行」的 flex 行，
     * 终端面板被压成窄窄一条（用户实测）。插槽外层是 display:contents，CSS 选择器不好写，
     * 这里直接往上找真正排版的那一层：是横向 flex 就让它换行，并把我们排到最后、整行独占。
     * 纵向排列的老版本什么都不做。
     */
    function claimOwnRow(node) {
      try {
        if (!node?.parentElement) return
        let parent = node.parentElement
        while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement
        if (!parent) return
        const style = getComputedStyle(parent)
        if (!/flex$/.test(style.display) || !style.flexDirection.startsWith('row')) return
        if (style.flexWrap === 'nowrap') parent.style.flexWrap = 'wrap'
        // 这一栏本身没写宽度，又放在「纵向居中」的容器里，宽度跟着内容走；终端按这一栏的宽度适配，
        // 这一栏又按终端的宽度定 —— Windows 的滚动条占十几像素，每适配一次就窄一点，
        // 一路缩到只剩一半（用户实测）。让它铺满整行，宽度就有了固定的参照
        if (parent.style.width !== '100%') parent.style.width = '100%'
        node.style.flexBasis = '100%'
        node.style.order = '1'
      } catch {
        // 拿不到样式（测试环境）就算了
      }
    }

    /**
     * 插槽里每样东西都套一层整行容器：它不限宽，占满整行（claimOwnRow 给它 flex-basis 100%），
     * 里面的面板再按输入框的宽度居中。只给面板本身设 100% 不够——面板有最大宽度，
     * 那一行比输入框宽时，面板加上用量显示仍然放得下一行，照样挤在一起（实测）。
     */
    function dockRow(ref, child) {
      return h('div', {
        ref,
        'data-vps-dock': '',
        style: { width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', boxSizing: 'border-box' },
      }, child)
    }

    /** 挂在插槽里那几个根元素上：拿到 ref 的同时把上面那件事办了 */
    function useOwnRow() {
      const ref = useRef(null)
      useEffect(() => {
        claimOwnRow(ref.current)
      })
      return ref
    }

    function useAsync(fn, deps = []) {
      const [state, setState] = useState({ loading: true, data: null, error: '' })
      const run = useCallback(async () => {
        setState((s) => ({ ...s, loading: true, error: '' }))
        try {
          const data = await fn()
          setState({ loading: false, data, error: '' })
        } catch (error) {
          setState({ loading: false, data: null, error: error.message })
        }
      }, deps) // eslint-disable-line react-hooks/exhaustive-deps
      useEffect(() => {
        run()
      }, [run])
      return { ...state, reload: run }
    }

    // ——————————————————————— 样式 ———————————————————————

    // 跟随 DSH 主题：宿主暴露了 shadcn 那套（--popover / --card / --border）和
    // DSW 别名（--dsw-alias-*）。写死颜色会在浅色主题下变成黑块。
    // 边框分三级，设置页和终端面板同一套（DSH 自己的设置页也是这几级）：
    // divider 行与行之间的分隔、border 板块边框、field 填空框
    const T = {
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,0.24))',
      field: 'var(--dsw-alias-border-l4, rgba(127,127,127,0.32))',
      divider: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.18))',
      // 分段按钮：浅色凹槽 + 浮起的选中项（DSH 代码块语言切换用的那组颜色）
      segTrack: 'var(--dsw-alias-markdown-code-segment-unselected, rgba(127,127,127,0.12))',
      segOn: 'var(--dsw-alias-markdown-code-segment-selected, #fff)',
      text: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, inherit)',
      popover: 'var(--popover, var(--dsw-alias-bg-layer-1, rgba(30,30,34,0.985)))',
      popoverText: 'var(--popover-foreground, inherit)',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))',
      danger: 'var(--dsw-alias-state-error-primary, #e5534b)',
      ok: 'var(--dsw-alias-state-success-primary, #2ea043)',
      accent: 'var(--primary, #3b82f6)',
    }
    const line = `0.5px solid ${T.border}`
    const fieldLine = `0.5px solid ${T.field}`
    const S = {
      root: { padding: 16, height: '100%', overflow: 'auto', fontSize: 13, lineHeight: 1.6 },
      h1: { fontSize: 16, fontWeight: 600, margin: '0 0 12px' },
      h2: { fontSize: 14, fontWeight: 600, margin: '18px 0 8px' },
      tabs: { display: 'flex', gap: 4, borderBottom: `0.5px solid ${T.divider}`, marginBottom: 14 },
      tab: (on) => ({
        padding: '6px 14px',
        cursor: 'pointer',
        borderBottom: on ? `2px solid ${T.accent}` : '2px solid transparent',
        opacity: on ? 1 : 0.65,
        fontWeight: on ? 600 : 400,
      }),
      card: { border: line, borderRadius: 8, padding: 12, marginBottom: 10 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      spread: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
      muted: { opacity: 0.6 },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      pre: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        background: T.layer,
        borderRadius: 6,
        padding: 10,
        maxHeight: 320,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
      },
      input: {
        boxSizing: 'border-box', // 宽 100% 时连内边距一起算，不然会戳出卡片
        border: fieldLine,
        borderRadius: 6,
        padding: '5px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        minWidth: 0,
      },
      btn: (kind, disabled) => ({
        border: kind === 'primary' ? `0.5px solid ${T.accent}` : line,
        background: kind === 'primary' ? T.accent : 'transparent',
        color: kind === 'primary' ? 'var(--primary-foreground, #fff)' : kind === 'danger' ? T.danger : 'inherit',
        borderRadius: 6,
        padding: '5px 12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 13,
      }),
      badge: (tone) => ({
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 10,
        border: line,
        color: tone === 'danger' ? T.danger : tone === 'ok' ? 'var(--dsw-alias-state-success-primary, #2ea043)' : 'inherit',
        opacity: tone ? 1 : 0.7,
        whiteSpace: 'nowrap',
      }),
      err: { border: `1px solid ${T.danger}`, color: T.danger, borderRadius: 6, padding: '8px 10px', marginBottom: 10 },
      note: { border: line, borderRadius: 6, padding: '8px 10px', marginBottom: 10, background: T.layer },
      label: { display: 'block', fontSize: 12, opacity: 0.75, marginBottom: 3 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 },
    }

    /**
     * 分段按钮的样子（设置页「颜色方案」「断线后保留」、终端面板「终端 | 文件 | 状态」共用）：
     * 浅色凹槽里几个分开的按钮，选中的那个浮起来；不用整块蓝色，免得太抢眼
     * @param {{ track: string, on: string, edge: string, text: string, idle: string }} k 颜色
     */
    const seg = {
      track: (k, extra) => ({ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 8, background: k.track, flex: '0 0 auto', ...extra }),
      item: (k, on, { height = 24, padding = '0 11px', fontSize = 12.5 } = {}) => ({
        display: 'inline-flex', alignItems: 'center', gap: 5, height, padding, borderRadius: 6, border: 'none',
        fontSize, fontWeight: on ? 500 : 400, whiteSpace: 'nowrap', cursor: on ? 'default' : 'pointer',
        background: on ? k.on : 'transparent', color: on ? k.text : k.idle,
        boxShadow: on ? `0 0 0 0.5px ${k.edge}, 0 1px 2px rgba(0,0,0,0.08)` : 'none',
        transition: 'background .12s, color .12s',
      }),
      // 没选中的按钮：鼠标移上去字变深，看得出能点
      hover: (k, on) => (on ? {} : {
        onMouseEnter: (e) => { e.currentTarget.style.color = k.text },
        onMouseLeave: (e) => { e.currentTarget.style.color = k.idle },
      }),
    }

    // ——————————————————————— 基础组件 ———————————————————————

    const Btn = ({ kind, onClick, disabled, children, title }) =>
      h('button', { style: S.btn(kind, disabled), onClick, disabled, title, type: 'button' }, children)

    const Badge = ({ tone, children }) => h('span', { style: S.badge(tone) }, children)

    const ErrorBar = ({ error }) => (error ? h('div', { style: S.err }, error) : null)

    const Field = ({ label, hint, children }) =>
      h('div', null,
        h('label', { style: S.label }, label),
        children,
        hint ? h('div', { style: { ...S.muted, fontSize: 11, marginTop: 2 } }, hint) : null)

    const Input = ({ value, onChange, placeholder, type, disabled }) =>
      h('input', {
        style: { ...S.input, width: '100%' },
        value: value ?? '',
        placeholder,
        type: type || 'text',
        disabled,
        onChange: (e) => onChange(e.target.value),
      })

    const Select = ({ value, onChange, options, disabled }) =>
      h('select', {
        style: { ...S.input, width: '100%' },
        value: value ?? '',
        disabled,
        onChange: (e) => onChange(e.target.value),
      }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label)))

    function Copyable({ text, label }) {
      const [copied, setCopied] = useState(false)
      return h('div', { style: { ...S.row, alignItems: 'flex-start' } },
        h('div', { style: { ...S.pre, flex: 1, margin: 0 } }, text),
        h(Btn, {
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            } catch {
              setCopied(false)
            }
          },
        }, copied ? L('已复制', 'Copied') : (label || L('复制', 'Copy'))))
    }

    const CONFIRM_LABEL = { get careful() { return L('谨慎（改动要确认）', 'Careful (changes need confirmation)') }, get relaxed() { return L('放手（只有高危才问）', 'Relaxed (only dangerous ones ask)') }, get auto() { return L('全自动（都不问）', 'Fully automatic (never asks)') } }
    const PRIV_LABEL = { root: 'root', get sudo() { return L('免密 sudo', 'passwordless sudo') }, get none() { return L('仅只读', 'read-only') }, get unknown() { return L('未知', 'unknown') } }
    const dot = (reachable) => (reachable === true ? '🟢' : reachable === false ? '🔴' : '⚪')

    /** 轮询直到任务结束，过程中把日志回调出去 */
    async function waitTask(alias, taskId, onLog) {
      for (let i = 0; i < 600; i += 1) {
        const res = await api('tasks/status', { alias, taskId, tailBytes: 8000 })
        if (onLog) onLog(res.log || '')
        const state = res.task?.state ?? 'running'
        if (state !== 'running') return res.task ?? { state, exitCode: null }
        await new Promise((r) => setTimeout(r, 1500))
      }
      return { state: 'running', exitCode: null }
    }

    // ——————————————————————— 单台机器的设置页 ———————————————————————

    function MachineSettings({ alias, onBack, onChanged }) {
      const detail = useAsync(() => api('host/detail', { alias }), [alias])
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [msg, setMsg] = useState('')
      const [fingerprints, setFingerprints] = useState(null)
      const waited = useElapsed(Boolean(busy))
      const [keyInfo, setKeyInfo] = useState(null)
      const [basics, setBasics] = useState({ tz: '', swapMb: '', bbr: false, autoUpdates: false, fail2ban: false, tools: false })
      const [applying, setApplying] = useState(null)
      const [removing, setRemoving] = useState(false)

      useEffect(() => {
        if (!detail.data) return
        const d = detail.data
        setForm({
          alias: d.alias,
          hostname: d.resolved?.hostname ?? '',
          port: String(d.resolved?.port ?? 22),
          user: d.resolved?.user ?? '',
          proxyJump: d.resolved?.proxyJump ?? '',
          note: d.host.note ?? '',
          group: d.host.group ?? '',
          confirm: d.host.confirm ?? '',
          managed: d.managed,
        })
        const f = d.state?.facts ?? {}
        setBasics({
          tz: f.timezone ?? '',
          swapMb: Number(f.swap_total_mb || 0) > 0 ? String(f.swap_total_mb) : '',
          bbr: f.congestion === 'bbr',
          autoUpdates: f.auto_updates === '1',
          fail2ban: f.fail2ban === '1',
          tools: Number(f.tools_missing ?? 1) === 0,
        })
      }, [detail.data])

      if (detail.loading || !form) return h('div', { style: S.muted }, L('读取中…', 'Loading…'))
      if (detail.error) return h('div', null, h(ErrorBar, { error: detail.error }), h(Btn, { onClick: onBack }, L('返回', 'Back')))

      const d = detail.data
      const facts = d.state?.facts ?? {}
      const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

      const save = async (extra = {}) => {
        setBusy('save')
        setError('')
        setMsg('')
        try {
          const res = await api('host/save', {
            alias: form.alias,
            previousAlias: d.alias,
            hostname: form.hostname,
            port: Number(form.port) || 22,
            user: form.user,
            proxyJump: form.proxyJump,
            note: form.note,
            group: form.group,
            confirm: form.confirm || undefined,
            managed: true,
            ...extra,
          })
          setMsg(res.probe?.ok
            ? L('已保存，连接正常', 'Saved; the connection works')
            : L(`已保存，但连接测试没通过：${res.probe?.hint ?? '未知原因'}（可以稍后在这里重试）`, `Saved, but the connection test failed: ${res.probe?.hint ?? 'unknown reason'} (you can retry here later)`))
          detail.reload()
          onChanged?.()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      const test = async () => {
        setBusy('test')
        setError('')
        setMsg('')
        try {
          const res = await api('host/test', { alias: d.alias })
          setMsg(res.ok ? L(`连接正常：${res.address}`, `Connection works: ${res.address}`) : L(`连不上：${res.hint}`, `Unreachable: ${res.hint}`))
          detail.reload()
          onChanged?.()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      return h('div', null,
        h('div', { style: { ...S.spread, marginBottom: 12 } },
          h('div', { style: S.row },
            onBack ? h(Btn, { onClick: onBack }, L('← 返回', '← Back')) : null,
            h('span', { style: { fontSize: 15, fontWeight: 600 } }, `${d.alias}`),
            h(Badge, { tone: d.state?.reachable ? 'ok' : d.state?.reachable === false ? 'danger' : null },
              L(`${dot(d.state?.reachable)} ${d.state?.address || '未测'}`, `${dot(d.state?.reachable)} ${d.state?.address || 'not tested'}`)),
            h(Badge, null, PRIV_LABEL[facts.privilege] ?? L('权限未知', 'privilege unknown'))),
          h('div', { style: S.row },
            h(Btn, { onClick: test, disabled: busy === 'test' }, busy === 'test' ? waitingLabel(L('测试中…', 'Testing…'), waited) : L('测连通', 'Test connection')),
            h(Btn, { kind: 'primary', onClick: () => save(), disabled: busy === 'save' }, busy === 'save' ? waitingLabel(L('保存中…', 'Saving…'), waited) : L('保存', 'Save')))),

        h(ErrorBar, { error }),
        msg ? h('div', { style: S.note }, msg) : null,

        !form.managed
          ? h('div', { style: S.note },
              L(`这台机器的连接配置来自你自己的 ${d.sshConfigPath}，这里先只读。`, `This machine's connection settings come from your own ${d.sshConfigPath}, so they are read-only here.`),
              h('div', { style: { marginTop: 6 } },
                h(Btn, { onClick: () => save({ managed: true }) },
                  L('交给插件管理（把当前配置复制成插件自己的一份，你的原文件不动）', 'Let the plugin manage it (copies the current settings into the plugin\'s own file; your file is left alone)'))))
          : null,

        h('div', { style: S.card },
          h('div', { style: S.h2 }, L('基本', 'Basics')),
          h('div', { style: S.grid },
            h(Field, { label: L('别名', 'Alias'), hint: L('改名会同步更新 SSH 配置', 'Renaming also updates the SSH configuration') },
              h(Input, { value: form.alias, onChange: set('alias') })),
            h(Field, { label: L('备注', 'Note') }, h(Input, { value: form.note, onChange: set('note'), placeholder: L('香港，建站用', 'Hong Kong, web sites') })),
            h(Field, { label: L('分组', 'Group') }, h(Input, { value: form.group, onChange: set('group'), placeholder: L('生产 / 测试', 'production / testing') })))),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, L('连接', 'Connection')),
          h('div', { style: S.grid },
            h(Field, { label: L('地址', 'Address') }, h(Input, { value: form.hostname, onChange: set('hostname'), disabled: !form.managed })),
            h(Field, { label: L('端口', 'Port') }, h(Input, { value: form.port, onChange: set('port'), disabled: !form.managed })),
            h(Field, { label: L('用户名', 'User') }, h(Input, { value: form.user, onChange: set('user'), disabled: !form.managed })),
            h(Field, { label: L('跳板机', 'Jump host'), hint: L('填 用户@地址:端口，或另一台已登记机器的别名', 'user@address:port, or the alias of another registered machine') },
              h(Input, { value: form.proxyJump, onChange: set('proxyJump'), disabled: !form.managed }))),
          h('div', { style: { ...S.muted, marginTop: 8, fontSize: 12 } },
            L(`钥匙：${(d.resolved?.identityFiles ?? []).join('、') || '按 SSH 默认'}`, `Key: ${(d.resolved?.identityFiles ?? []).join(', ') || 'SSH default'}`))),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, L('钥匙与免密登录', 'Key and passwordless login')),
          h('div', { style: S.row },
            h(Btn, {
              onClick: async () => {
                setBusy('key')
                setError('')
                try {
                  setKeyInfo(await api('onboarding/commands', {
                    hostname: form.hostname,
                    port: Number(form.port) || 22,
                    user: form.user,
                  }))
                } catch (e) {
                  setError(e.message)
                } finally {
                  setBusy('')
                }
              },
              disabled: busy === 'key',
            }, keyInfo ? L('刷新', 'Refresh') : L('显示公钥与放置命令', 'Show the public key and placement commands')),
            keyInfo ? h('span', { style: { ...S.muted, fontSize: 12 } }, keyInfo.fingerprint) : null),
          keyInfo ? h('div', { style: { marginTop: 10 } },
            !form.managed
              ? h('div', { style: S.note }, L('这台机器的连接配置还不归插件管，插件专用钥匙不会被自动使用。放完公钥后记得点上面的「交给插件管理」。', 'The plugin does not manage this machine\'s connection settings yet, so its dedicated key will not be used automatically. After placing the public key, click "Let the plugin manage it" above.'))
              : null,
            h('div', { style: S.label }, L('A. 复制公钥，贴到服务商后台的「SSH 密钥」', 'A. Copy the public key and paste it into "SSH keys" in your provider\'s console')),
            h(Copyable, { text: keyInfo.pubkey, label: L('复制公钥', 'Copy public key') }),
            h('div', { style: { ...S.label, marginTop: 10 } }, L('B. 已经能登录服务器：粘贴这一行执行', 'B. If you can already log in to the server: paste and run this line')),
            h(Copyable, { text: keyInfo.authorizedKeys, label: L('复制命令', 'Copy command') }),
            h('div', { style: { ...S.label, marginTop: 10 } }, L('C. 只有密码：在终端里执行，密码你自己输', 'C. Password only: run this in a terminal and type the password yourself')),
            h(Copyable, { text: keyInfo.sshCopyId, label: L('复制命令', 'Copy command') }),
            h('div', { style: { marginTop: 8 } },
              h(Btn, {
                onClick: async () => {
                  setError('')
                  try {
                    const r = await api('onboarding/open-terminal', {
                      hostname: form.hostname,
                      port: Number(form.port) || 22,
                      user: form.user,
                    })
                    if (!r.opened) setError(r.hint || L('没能自动打开终端，请复制上面的命令自己执行', 'Could not open a terminal automatically. Copy the command above and run it yourself'))
                    else setMsg(L('已打开终端：输完密码后回到这里点「测连通」', 'A terminal is open: after entering the password, come back and click "Test connection"'))
                  } catch (e) {
                    setError(e.message)
                  }
                },
              }, L('在终端中打开', 'Open in a terminal')))) : null),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, L('安全', 'Safety')),
          h(Field, { label: L('确认档位', 'Confirmation level'), hint: L('留空 = 跟随分组或全局设置', 'Empty = follow the group or global setting') },
            h(Select, {
              value: form.confirm,
              onChange: set('confirm'),
              options: [
                { value: '', label: L('跟随分组 / 全局', 'Follow group / global') },
                { value: 'careful', label: CONFIRM_LABEL.careful },
                { value: 'relaxed', label: CONFIRM_LABEL.relaxed },
                { value: 'auto', label: CONFIRM_LABEL.auto },
              ],
            })),
          h('div', { style: { ...S.row, marginTop: 10 } },
            h(Btn, {
              onClick: async () => {
                setBusy('fp')
                try {
                  const res = await api('host/fingerprint', { hostname: form.hostname, port: Number(form.port) || 22 })
                  setFingerprints(res.fingerprints ?? [])
                } catch (e) {
                  setError(e.message)
                } finally {
                  setBusy('')
                }
              },
              disabled: busy === 'fp',
            }, L('查看服务器指纹', 'Show server fingerprint')),
            h(Btn, {
              kind: 'danger',
              onClick: async () => {
                if (!window.confirm(L('重置指纹后，下次连接会重新记录。只有在确认服务器刚重装过时才这么做。', 'After a reset, the next connection records the fingerprint again. Only do this if you know the server was just reinstalled.'))) return
                try {
                  await api('host/reset-key', { hostname: form.hostname, port: Number(form.port) || 22 })
                  setMsg(L('已清除本机记录的该服务器指纹', 'The fingerprint stored on this computer for this server was cleared'))
                } catch (e) {
                  setError(e.message)
                }
              },
            }, L('重置指纹', 'Reset fingerprint'))),
          fingerprints ? h('div', { style: { ...S.pre, marginTop: 8 } }, fingerprints.join('\n') || L('没取到', 'not available')) : null),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, L('基础配置', 'Basics')),
          h('div', { style: S.muted }, L('填好目标状态，保存时只执行和当前不一样的那几项。取消勾选不会卸载已装的东西。', 'Fill in the state you want; saving runs only the items that differ from now. Unticking does not uninstall anything.')),
          h('div', { style: { ...S.grid, marginTop: 10 } },
            h(Field, { label: L('时区', 'Timezone'), hint: L(`当前：${facts.timezone || '未知'}`, `Now: ${facts.timezone || 'unknown'}`) },
              h(Input, { value: basics.tz, onChange: (v) => setBasics({ ...basics, tz: v }), placeholder: 'Asia/Shanghai' })),
            h(Field, {
              label: L('虚拟内存 swap（MB）', 'Swap (MB)'),
              hint: Number(facts.swap_total_mb || 0) > 0
                ? L(`已有 ${facts.swap_total_mb} MB，改大小要手工操作`, `${facts.swap_total_mb} MB already; changing the size has to be done by hand`)
                : L('当前没有 swap，填个数字就会创建', 'No swap yet; enter a number to create it'),
            },
              h(Input, {
                value: basics.swapMb,
                onChange: (v) => setBasics({ ...basics, swapMb: v }),
                disabled: Number(facts.swap_total_mb || 0) > 0,
                placeholder: '2048',
              }))),
          h('div', { style: { marginTop: 10 } },
            [
              ['bbr', L(`开启 BBR 拥塞控制（当前：${facts.congestion || '未知'}）`, `Turn on BBR congestion control (now: ${facts.congestion || 'unknown'})`)],
              ['autoUpdates', L(`自动安装安全更新（当前：${facts.auto_updates === '1' ? '已开' : '未开'}）`, `Install security updates automatically (now: ${facts.auto_updates === '1' ? 'on' : 'off'})`)],
              ['fail2ban', L(`装 fail2ban 挡爆破（当前：${facts.fail2ban === '1' ? '已装并在跑' : '没装'}）`, `Install fail2ban against brute force (now: ${facts.fail2ban === '1' ? 'installed and running' : 'not installed'})`)],
              ['tools', L(`补齐常用命令行工具（当前缺 ${facts.tools_missing ?? '?'} 个）`, `Install the missing common CLI tools (${facts.tools_missing ?? '?'} missing)`)],
            ].map(([key, text]) => h('label', { key, style: { ...S.row, marginBottom: 4 } },
              h('input', {
                type: 'checkbox',
                checked: Boolean(basics[key]),
                onChange: (e) => setBasics({ ...basics, [key]: e.target.checked }),
              }),
              h('span', null, text)))),
          h('div', { style: { ...S.row, marginTop: 10 } },
            h(Btn, {
              kind: 'primary',
              disabled: Boolean(applying),
              onClick: async () => {
                const steps = []
                if (basics.tz && basics.tz !== facts.timezone) {
                  steps.push({ id: 'set-timezone', params: { tz: basics.tz }, name: L(`设置时区为 ${basics.tz}`, `Set the timezone to ${basics.tz}`) })
                }
                if (Number(basics.swapMb) > 0 && Number(facts.swap_total_mb || 0) === 0) {
                  steps.push({ id: 'setup-swap', params: { size_mb: String(Number(basics.swapMb)) }, name: L(`创建 ${basics.swapMb} MB 虚拟内存`, `Create ${basics.swapMb} MB of swap`) })
                }
                if (basics.bbr && facts.congestion !== 'bbr') steps.push({ id: 'enable-bbr', name: L('开启 BBR', 'Turn on BBR') })
                if (basics.autoUpdates && facts.auto_updates !== '1') steps.push({ id: 'auto-security-updates', name: L('打开自动安全更新', 'Turn on automatic security updates') })
                if (basics.fail2ban && facts.fail2ban !== '1') steps.push({ id: 'install-fail2ban', name: L('安装 fail2ban', 'Install fail2ban') })
                if (basics.tools && Number(facts.tools_missing || 0) > 0) steps.push({ id: 'install-tools', name: L('补齐常用命令行工具', 'Install the missing CLI tools') })

                if (!steps.length) {
                  setMsg(L('当前状态已经和你填的一致，没有要执行的项', 'The machine already matches what you filled in; nothing to run'))
                  return
                }
                setError('')
                setMsg('')
                const state = steps.map((x) => ({ ...x, state: 'pending' }))
                setApplying({ steps: state, log: '' })
                for (let i = 0; i < state.length; i += 1) {
                  state[i].state = 'running'
                  setApplying({ steps: [...state], log: '' })
                  try {
                    const res = await api('recipes/run', { id: state[i].id, alias: d.alias, params: state[i].params ?? {}, waitSeconds: 0 })
                    if (res.taskId) {
                      const task = await waitTask(d.alias, res.taskId, (log) => setApplying((a) => ({ ...a, log })))
                      state[i].state = task.exitCode === 0 ? 'done' : 'failed'
                      state[i].hint = task.exitCode === 0 ? '' : L(`退出码 ${task.exitCode}`, `exit code ${task.exitCode}`)
                      if (task.exitCode === 0) {
                        const v = await api('recipes/verify', { id: state[i].id, alias: d.alias }).catch(() => null)
                        if (v && !v.ok) {
                          state[i].state = 'failed'
                          state[i].hint = L('验证没通过', 'verification failed')
                        }
                      }
                    } else {
                      state[i].state = res.ok ? 'done' : 'failed'
                      state[i].hint = res.hint ?? ''
                    }
                  } catch (e) {
                    state[i].state = 'failed'
                    state[i].hint = e.message
                  }
                  setApplying({ steps: [...state], log: '' })
                  if (state[i].state === 'failed') break
                }
                await api('host/test', { alias: d.alias }).catch(() => {})
                detail.reload()
                onChanged?.()
                setMsg(state.every((x) => x.state === 'done') ? L('全部执行完成', 'All done') : L('有项目没成功，展开看日志', 'Some items failed; expand to see the log'))
              },
            }, applying ? L('执行中…', 'Running…') : L('保存并应用', 'Save and apply')),
            h('span', { style: S.muted }, L('只执行有差异的项；每项都是远端任务，断线也会跑完', 'Only items that differ run; each is a remote task that finishes even if the connection drops'))),
          applying ? h('div', { style: { marginTop: 10 } },
            applying.steps.map((st) => h('div', { key: st.id, style: { ...S.row, padding: '2px 0' } },
              h(Badge, { tone: st.state === 'done' ? 'ok' : st.state === 'failed' ? 'danger' : null },
                { pending: L('等待', 'Waiting'), running: L('执行中', 'Running'), done: L('完成', 'Done'), failed: L('失败', 'Failed') }[st.state]),
              h('span', null, st.name),
              st.hint ? h('span', { style: S.muted }, st.hint) : null)),
            applying.log ? h('div', { style: { ...S.pre, marginTop: 6, maxHeight: 200 } }, applying.log) : null) : null),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, L('状态', 'State')),
          h('div', { style: S.grid },
            h('div', null, h('div', { style: S.label }, L('系统', 'OS')), `${facts.os_id ?? '?'} ${facts.os_ver ?? ''}`),
            h('div', null, h('div', { style: S.label }, 'init'), facts.init ?? '?'),
            h('div', null, h('div', { style: S.label }, L('包管理', 'Packages')), facts.pkg ?? '?'),
            h('div', null, h('div', { style: S.label }, 'CPU'), L(`${facts.cpu ?? '?'} 核`, `${facts.cpu ?? '?'} cores`)),
            h('div', null, h('div', { style: S.label }, L('内存', 'Memory')), `${facts.mem_used_mb ?? '?'} / ${facts.mem_total_mb ?? '?'} MB`),
            h('div', null, h('div', { style: S.label }, L('磁盘', 'Disk')), `${facts.disk_used_mb ?? '?'} / ${facts.disk_total_mb ?? '?'} MB ${facts.disk_pct ?? ''}`)),
          h('div', { style: { ...S.muted, fontSize: 12, marginTop: 8 } },
            d.state?.lastSeen ? L(`上次体检：${new Date(d.state.lastSeen).toLocaleString()}`, `Last health check: ${new Date(d.state.lastSeen).toLocaleString()}`) : L('还没体检过', 'No health check yet'))),

        h('div', { style: { ...S.card, borderColor: 'rgba(229,83,75,0.5)' } },
          h('div', { style: { ...S.h2, color: T.danger } }, L('危险区', 'Danger zone')),
          !removing
            ? h(Btn, { kind: 'danger', onClick: () => setRemoving(true) }, L('移除这台机器', 'Remove this machine'))
            : h('div', null,
                h('div', { style: { marginBottom: 8 } }, L('移除后插件不再管理它。钥匙文件永远不会被删除。', 'After removal the plugin no longer manages it. Key files are never deleted.')),
                h('div', { style: S.row },
                  h(Btn, {
                    kind: 'danger',
                    onClick: async () => {
                      try {
                        await api('host/remove', { alias: d.alias, removeSshBlock: false })
                        onChanged?.()
                        onBack?.()
                      } catch (e) {
                        setError(e.message)
                      }
                    },
                  }, L('只从插件移除（保留 SSH 配置）', 'Remove from the plugin only (keep the SSH configuration)')),
                  h(Btn, {
                    kind: 'danger',
                    onClick: async () => {
                      try {
                        await api('host/remove', { alias: d.alias, removeSshBlock: true, removeKnownHost: true })
                        onChanged?.()
                        onBack?.()
                      } catch (e) {
                        setError(e.message)
                      }
                    },
                  }, L('同时删除插件写的 SSH 配置与指纹', 'Also delete the SSH configuration and fingerprint the plugin wrote')),
                  h(Btn, { onClick: () => setRemoving(false) }, L('取消', 'Cancel'))))))
    }

    // ——————————————————————— 添加机器（一页表单）———————————————————————
    // 照 WPN 那种一目了然的写法（用户定的）：地址、端口、用户名、密码填完，点「保存并连接」。
    // 密码只用这一次：插件拿它登录一次，把专用钥匙的公钥放上去，之后一律用钥匙；密码不保存。
    // 服务器关掉了密码登录的，展开「没有密码？」，用原来的几种办法放公钥。

    function autoAliasOf(hostname) {
      const base = String(hostname ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
      return base || 'vps'
    }

    // 别名会写进 SSH 配置的 Host 行，也用在 /vps-use 后面：只收英文字母、数字和 . _ -
    const ALIAS_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

    /** 别名哪里不行；没问题返回空串。中文名字（洛杉矶、香港）引导到备注里 */
    function aliasProblem(alias) {
      const a = String(alias ?? '').trim()
      if (!a || ALIAS_OK.test(a)) return ''
      if (/[^\x00-\x7f]/.test(a)) return L(`别名只能用英文字母、数字和 - _ .（它会写进 SSH 配置）。「${a}」这样的中文名字写到备注里，别名留空会自动起一个`, `An alias may only use letters, digits and - _ . (it goes into the SSH configuration). Put a name like "${a}" in the note; leave the alias empty and one is picked for you`)
      return L('别名只能用英文字母、数字和 - _ .，而且要以字母或数字开头', 'An alias may only use letters, digits and - _ ., and must start with a letter or digit')
    }

    /** ssh-keygen -l 的输出里挑一个给人看：优先 ED25519 */
    function pickFingerprint(lines) {
      const list = (lines ?? []).map((l) => ({
        fp: /SHA256:\S+/.exec(l)?.[0] ?? '',
        type: /\(([A-Z0-9-]+)\)\s*$/.exec(l)?.[1] ?? '',
      })).filter((x) => x.fp)
      return list.find((x) => x.type === 'ED25519') ?? list[0] ?? null
    }

    function AddWizard({ onDone, onCancel }) {
      const [form, setForm] = useState({ hostname: '', port: '22', user: 'root', password: '', alias: '', note: '', group: '' })
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [manual, setManual] = useState(false)
      const [key, setKey] = useState(null)
      const [cmds, setCmds] = useState(null)
      const [hostKeyChanged, setHostKeyChanged] = useState(false)
      const waited = useElapsed(busy)
      const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
      const target = () => ({ hostname: form.hostname.trim(), port: Number(form.port) || 22, user: form.user.trim() || 'root' })

      // 展开「没有密码？」时才准备钥匙和命令
      async function loadManual() {
        try {
          const k = key ?? await api('onboarding/key', { create: true })
          setKey(k)
          if (form.hostname.trim()) setCmds(await api('onboarding/commands', target()))
        } catch (e) {
          setError(e.message)
        }
      }
      useEffect(() => {
        if (manual) loadManual()
      }, [manual, form.hostname, form.port, form.user]) // eslint-disable-line react-hooks/exhaustive-deps

      async function connect({ withPassword = true } = {}) {
        setError('')
        setHostKeyChanged(false)
        if (!form.hostname.trim()) return setError(L('先填服务器地址', 'Enter the server address first'))
        const aliasErr = aliasProblem(form.alias)
        if (aliasErr) return setError(aliasErr)
        if (withPassword && !form.password) return setError(L('填上服务器的登录密码。服务器只允许密钥登录的，展开下面的「没有密码？」', 'Enter the server\'s login password. If the server only allows key login, expand "No password?" below'))
        setBusy(true)
        try {
          const res = await api('onboarding/connect', {
            ...target(),
            password: withPassword ? form.password : '',
            alias: form.alias.trim(),
            note: form.note.trim(),
            group: form.group.trim(),
          })
          setForm((f) => ({ ...f, password: '' })) // 密码用过就从页面上清掉
          if (res.connected || (res.alias && res.stage !== 'password')) {
            setResult(res)
            onDone?.(res.alias, res)
            return undefined
          }
          if (res.reason === 'password_disabled') setManual(true)
          if (res.reason === 'host_key_changed') setHostKeyChanged(true)
          setError(res.hint || L('没连上', 'Not connected'))
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
        return undefined
      }

      async function resetKey() {
        try {
          await api('host/reset-key', target())
          setHostKeyChanged(false)
          setError(L('已经忘掉旧指纹。确认服务器刚重装过系统，再点一次「保存并连接」', 'The old fingerprint is forgotten. If the server was just reinstalled, click "Save and connect" again'))
        } catch (e) {
          setError(e.message)
        }
      }

      const grid2 = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px 14px' }
      const section = (text) => h('div', { style: { fontSize: 14, fontWeight: 600, margin: '18px 0 10px' } }, text)
      const hint = { ...S.muted, fontSize: 12, marginTop: 4, lineHeight: 1.5 }

      // —— 连上了 ——
      if (result) {
        const fp = pickFingerprint(result.fingerprints)
        const f = result.probe?.facts ?? {}
        return h('div', null,
          h('div', { style: { fontSize: 16, fontWeight: 600, marginBottom: 12 } }, result.connected ? L(`已连上 ${result.alias}`, `Connected to ${result.alias}`) : L(`已保存 ${result.alias}，但还连不上`, `Saved ${result.alias}, but it is not reachable yet`)),
          h('div', { style: S.card },
            result.connected
              ? h('div', null, [
                result.probe?.address,
                f.os_id && f.os_id !== 'unknown' ? `${f.os_id} ${f.os_ver ?? ''}`.trim() : '',
                L(`权限 ${PRIV_LABEL[f.privilege] ?? '未知'}`, `privilege ${PRIV_LABEL[f.privilege] ?? 'unknown'}`),
              ].filter(Boolean).join('　'))
              : h('div', { style: { color: T.danger } }, L(`原因：${result.hint || result.probe?.hint || '未知'}`, `Reason: ${result.hint || result.probe?.hint || 'unknown'}`)),
            fp ? h('div', { style: { marginTop: 10 } },
              h('span', { style: { fontWeight: 600, marginRight: 8 } }, L('主机指纹', 'Host fingerprint')),
              h('span', { style: S.mono }, L(`${fp.fp}${fp.type ? `（${fp.type}）` : ''}`, `${fp.fp}${fp.type ? ` (${fp.type})` : ''}`)),
              h('div', { style: hint }, L('首次连接时记录。以后指纹变了会拒绝连接，防止有人冒充你的服务器。', 'Recorded on first contact. If it ever changes, connections are refused, so nobody can pose as your server.'))) : null,
            h('div', { style: { marginTop: 10, ...S.muted, fontSize: 12 } },
              result.keyInstalled
                ? L(`已把插件的专用钥匙放到服务器上，之后免密登录。密码没有保存。钥匙在 ${result.keyPath ?? '~/.ssh/dsh_vps_ed25519'}`, `The plugin's dedicated key is on the server; logins need no password from now on. The password was not stored. The key is at ${result.keyPath ?? '~/.ssh/dsh_vps_ed25519'}`)
                : L(`用插件的专用钥匙登录（${result.keyPath ?? '~/.ssh/dsh_vps_ed25519'}）`, `Logs in with the plugin's dedicated key (${result.keyPath ?? '~/.ssh/dsh_vps_ed25519'})`))),
          h('div', { style: { ...S.row, marginTop: 12 } }, h(Btn, { kind: 'primary', onClick: onCancel }, L('完成', 'Done'))))
      }

      // —— 表单 ——
      const passwordInput = h('input', {
        type: 'password',
        value: form.password,
        autoComplete: 'new-password', // 别让浏览器记住服务器密码
        placeholder: L('服务器的登录密码', 'The server\'s login password'),
        onChange: (e) => set('password')(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter') connect()
        },
        style: { ...S.input, width: '100%' },
      })

      return h('div', null,
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, L('添加机器', 'Add machine')),
        h('div', { style: { ...S.muted, fontSize: 12.5, marginTop: 4, lineHeight: 1.6 } },
          L('填好服务器的登录信息，点「保存并连接」。密码只用这一次：插件用它把专用钥匙放到服务器上，之后免密登录，密码不保存。', 'Fill in the server\'s login details and click "Save and connect". The password is used once, to put the plugin\'s dedicated key on the server; after that logins need no password, and the password is not stored.')),
        h('div', { style: { marginTop: 12 } }, h(ErrorBar, { error })),
        hostKeyChanged ? h('div', { style: { ...S.row, marginBottom: 10 } },
          h('span', { style: { ...S.muted, fontSize: 12 } }, L('只有在确认服务器刚重装过系统时才重置；否则可能是有人冒充你的服务器', 'Only reset if you know the server was just reinstalled; otherwise someone may be posing as your server')),
          h(Btn, { kind: 'danger', onClick: resetKey }, L('重置指纹', 'Reset fingerprint'))) : null,

        section(L('服务器', 'Server')),
        h('div', { style: grid2 },
          h('div', null,
            h('label', { style: S.label }, L('服务器 IP 或域名', 'Server IP or domain')),
            h(Input, { value: form.hostname, onChange: set('hostname'), placeholder: '1.2.3.4' }),
            h('div', { style: hint }, L('你买的 VPS 的公网地址', 'The public address of your VPS'))),
          h('div', null,
            h('label', { style: S.label }, L('SSH 端口', 'SSH port')),
            h(Input, { value: form.port, onChange: set('port') })),
          h('div', null,
            h('label', { style: S.label }, L('用户名', 'User')),
            h(Input, { value: form.user, onChange: set('user') }),
            h('div', { style: hint }, L('建议用 root；别的用户要有免密 sudo 才能装软件、改配置', 'root is recommended; other users need passwordless sudo to install software or change settings'))),
          h('div', null,
            h('label', { style: S.label }, L('密码', 'Password')),
            passwordInput,
            h('div', { style: hint }, L('只用这一次，不保存', 'Used once, not stored')))),

        section(L('在 DSH 里怎么称呼它（选填）', 'What to call it in DSH (optional)')),
        h('div', { style: grid2 },
          h('div', null,
            h('label', { style: S.label }, L('别名', 'Alias')),
            h(Input, { value: form.alias, onChange: set('alias'), placeholder: form.hostname.trim() ? autoAliasOf(form.hostname) : L('不填就按地址自动起', 'Derived from the address if left empty') }),
            aliasProblem(form.alias)
              ? h('div', { style: { ...hint, color: T.danger, opacity: 1 } }, aliasProblem(form.alias))
              : h('div', { style: hint }, L('英文字母、数字和 - _ .，比如 la、hk-web；中文名字写备注', 'Letters, digits and - _ ., e.g. la, hk-web; put other names in the note'))),
          h('div', null,
            h('label', { style: S.label }, L('分组', 'Group')),
            h(Input, { value: form.group, onChange: set('group'), placeholder: L('生产 / 测试', 'production / testing') })),
          h('div', { style: { gridColumn: '1 / -1' } },
            h('label', { style: S.label }, L('备注', 'Note')),
            h(Input, { value: form.note, onChange: set('note'), placeholder: L('洛杉矶，建站用', 'Los Angeles, web sites') }))),

        h('div', { style: { marginTop: 16 } },
          h('button', {
            type: 'button',
            onClick: () => setManual((m) => !m),
            style: { border: 'none', background: 'transparent', color: 'inherit', padding: 0, cursor: 'pointer', fontSize: 12.5, opacity: 0.75 },
          }, L(`${manual ? '▾' : '▸'} 没有密码？（服务器只允许密钥登录）`, `${manual ? '▾' : '▸'} No password? (the server only allows key login)`))),
        manual ? h('div', { style: { marginTop: 10 } },
          h('div', { style: S.note }, L('把下面这把插件专用钥匙的公钥放到服务器上，任选一种办法；放好后点「公钥已经放好了，直接连接」。', 'Put the public half of the plugin\'s dedicated key below on the server, either way; then click "The public key is in place, connect".')),
          h('div', { style: S.card },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, L('A. 服务商后台添加（新机器推荐）', 'A. Add it in your provider\'s console (recommended for new machines)')),
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 6 } }, L('粘到服务商的「SSH 密钥」里，重装系统时勾选它。', 'Paste it into your provider\'s "SSH keys" and select it when reinstalling the OS.')),
            h(Copyable, { text: key?.pubkey ?? L('正在准备…', 'Preparing…'), label: L('复制公钥', 'Copy public key') })),
          h('div', { style: S.card },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, L('B. 已经能登录（网页控制台或别的终端）', 'B. If you can already log in (web console or another terminal)')),
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 6 } }, L('在服务器上粘贴执行这一行。', 'Paste and run this line on the server.')),
            h(Copyable, { text: cmds?.authorizedKeys ?? (form.hostname.trim() ? L('正在准备…', 'Preparing…') : L('先在上面填服务器地址', 'Enter the server address above first')), label: L('复制命令', 'Copy command') })),
          h(Btn, { onClick: () => connect({ withPassword: false }), disabled: busy }, L('公钥已经放好了，直接连接', 'The public key is in place, connect'))) : null,

        h('div', { style: { ...S.row, marginTop: 16 } },
          h(Btn, { kind: 'primary', onClick: () => connect(), disabled: busy }, busy ? waitingLabel(L('连接中…', 'Connecting…'), waited) : L('保存并连接', 'Save and connect')),
          h(Btn, { onClick: onCancel }, L('取消', 'Cancel'))))
    }

    // ——————————————————————— 设置页 ———————————————————————

    // ——————————————————————— 卸载 ———————————————————————
    // 默认只勾能找回来的两项（移除插件、移除 SSH 配置——配置会先备份）；
    // 删钥匙、删数据、撤销服务器上的登录权限都不能撤销，默认不勾，并写明后果。

    const UNINSTALL_ITEMS = {
      plugin: {
        get label() { return L('移除插件本身', 'Remove the plugin itself') },
        detail: (pv) => (pv.desktop.canRemove
          ? L('从 DSH 里卸载这个插件，重启 DSH 后生效', 'Uninstalls the plugin from DSH; takes effect after DSH restarts')
          : L(`这里没法直接移除，完成后会告诉你在终端执行：${pv.removeCommand}`, `It cannot be removed directly here; when done you will be told to run in a terminal: ${pv.removeCommand}`)),
      },
      remoteCache: {
        get label() { return L('清理服务器上的插件目录', 'Clean up the plugin folder on the servers') },
        detail: (pv) => L(`每台已登记的机器（${pv.hosts.join('、')}）上的 ~/.cache/dsh-vps：任务日志、改文件前的备份、回收站。有任务在跑的机器会跳过；别的电脑上的插件也在管的机器，这个目录是共用的，也会保留`, `~/.cache/dsh-vps on every registered machine (${pv.hosts.join(', ')}): task logs, backups taken before edits, the trash. Machines with a running task are skipped; on machines the plugin on another computer also manages, the folder is shared and is kept too`),
      },
      revokeKey: {
        get label() { return L('撤销插件钥匙在服务器上的登录权限', 'Revoke the plugin key\'s login access on the servers') },
        detail: () => L('从每台机器的 ~/.ssh/authorized_keys 删掉这台电脑的插件钥匙那一行（先备份）。别的电脑上的插件钥匙不动', 'Removes this computer\'s plugin key line from ~/.ssh/authorized_keys on every machine (after a backup). Other computers\' plugin keys are left alone'),
        get warn() { return L('如果这把钥匙是你登录某台服务器的唯一方式，撤销后就登不上了。确认还有密码或别的钥匙再勾', 'If this key is your only way into a server, you will be locked out. Tick it only if you still have a password or another key') },
      },
      sshConfig: {
        get label() { return L('移除 SSH 连接配置', 'Remove the SSH connection settings') },
        detail: (pv) => L(`去掉 ${pv.paths.sshConfig} 顶部插件加的 Include 行（先备份），${pv.paths.sshDropin} 改名留作备份。之后终端里 ssh <别名> 不再能用`, `Removes the Include line the plugin added at the top of ${pv.paths.sshConfig} (after a backup) and renames ${pv.paths.sshDropin} as a backup. ssh <alias> in a terminal stops working afterwards`),
      },
      key: {
        get label() { return L('删除插件专用钥匙', 'Delete the plugin\'s dedicated key') },
        detail: (pv) => L(`${pv.paths.key} 和 .pub`, `${pv.paths.key} and .pub`),
        get warn() { return L('删除后不能恢复', 'Cannot be restored once deleted') },
      },
      data: {
        get label() { return L('删除插件数据', 'Delete the plugin data') },
        detail: (pv) => L(`${pv.paths.data}：机器清单、体检结果、审计日志、自定义菜谱`, `${pv.paths.data}: machine list, health checks, audit log, your own recipes`),
        get warn() { return L('删除后不能恢复', 'Cannot be restored once deleted') },
      },
    }

    const UNINSTALL_GROUPS = [
      [() => L('插件', 'Plugin'), ['plugin']],
      [() => L('服务器上（先做：本机配置和钥匙删掉后就连不上了）', 'On the servers (done first: once the local settings and key are gone, the servers cannot be reached)'), ['remoteCache', 'revokeKey']],
      [() => L('本机', 'This computer'), ['sshConfig', 'key', 'data']],
    ]

    function uninstallVisible(id, pv) {
      if (id === 'remoteCache') return pv.hosts.length > 0
      if (id === 'revokeKey') return pv.hosts.length > 0 && pv.present.key
      if (id === 'sshConfig') return pv.present.sshConfig
      if (id === 'key') return pv.present.key
      if (id === 'data') return pv.present.data
      return true
    }

    function UninstallCard() {
      const [open, setOpen] = useState(false)
      const [preview, setPreview] = useState(null)
      const [choices, setChoices] = useState({ plugin: true, remoteCache: false, revokeKey: false, sshConfig: true, key: false, data: false })
      const [stage, setStage] = useState('idle') // idle | confirm | running | done
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')
      const [restartMsg, setRestartMsg] = useState('')

      const expand = async () => {
        setOpen(true)
        setError('')
        try {
          setPreview(await api('uninstall/preview', {}))
        } catch (e) {
          setError(e.message)
        }
      }

      const selected = preview
        ? Object.keys(UNINSTALL_ITEMS).filter((id) => choices[id] && uninstallVisible(id, preview))
        : []

      const run = async () => {
        setStage('running')
        setError('')
        try {
          const picked = Object.fromEntries(selected.map((id) => [id, true]))
          // 卸载要在服务器上撤钥匙、清目录，给足时间
          setResult(await api('uninstall/run', { choices: picked }, { timeoutMs: 600_000 }))
        } catch (e) {
          // 插件移除后自己的接口可能随之消失，请求就断了——多半已经卸载成功
          setResult(null)
          setError(L(`没收到结果（${e.message}）。插件可能已经卸载，请重启 DSH 后确认`, `No result received (${e.message}). The plugin may already be uninstalled; restart DSH to check`))
        }
        setStage('done')
      }

      const restart = async () => {
        setRestartMsg(L('正在重启 DSH…', 'Restarting DSH…'))
        try {
          await api('desktop/restart', {})
        } catch (e) {
          setRestartMsg(L(`没能自动重启（${e.message}），请手动重启 DSH`, `Could not restart automatically (${e.message}); please restart DSH yourself`))
        }
      }

      if (!open) {
        return h('div', { style: S.card },
          h('div', { style: S.spread },
            h('div', null,
              h('div', { style: { ...S.h2, margin: 0 } }, L('卸载', 'Uninstall')),
              h('div', { style: { ...S.muted, fontSize: 12 } }, L('移除插件，并选择清理它在本机和服务器上留下的东西', 'Remove the plugin, and choose what it left on this computer and the servers to clean up'))),
            h(Btn, { onClick: expand }, L('卸载…', 'Uninstall…'))))
      }

      const pluginStep = result?.steps?.find((s) => s.id === 'plugin')

      return h('div', { style: { ...S.card, borderColor: T.danger } },
        h('div', { style: S.spread },
          h('div', { style: { ...S.h2, margin: 0 } }, L('卸载', 'Uninstall')),
          stage === 'running' ? null : h(Btn, { onClick: () => { setOpen(false); setStage('idle'); setResult(null); setError('') } }, L('收起', 'Collapse'))),
        h(ErrorBar, { error }),
        !preview && !error ? h('div', { style: S.muted }, L('读取中…', 'Loading…')) : null,

        preview && stage !== 'done'
          ? h('div', null,
              UNINSTALL_GROUPS.map(([title, ids]) => {
                const items = ids.filter((id) => uninstallVisible(id, preview))
                if (!items.length) return null
                return h('div', { key: ids[0], style: { marginTop: 10 } },
                  h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 4 } }, title()),
                  items.map((id) => {
                    const item = UNINSTALL_ITEMS[id]
                    return h('label', { key: id, style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0', cursor: 'pointer' } },
                      h('input', {
                        type: 'checkbox',
                        checked: Boolean(choices[id]),
                        disabled: stage !== 'idle',
                        onChange: (e) => setChoices({ ...choices, [id]: e.target.checked }),
                        style: { marginTop: 3 },
                      }),
                      h('span', null,
                        h('span', { style: { fontWeight: 600 } }, item.label),
                        h('div', { style: { ...S.muted, fontSize: 12 } }, item.detail(preview)),
                        item.warn ? h('div', { style: { color: T.danger, fontSize: 12 } }, `⚠ ${item.warn}`) : null))
                  }))
              }),
              h('div', { style: { ...S.row, marginTop: 12 } },
                stage === 'idle'
                  ? h(Btn, { kind: 'danger', disabled: selected.length === 0, onClick: () => setStage('confirm') }, L('开始卸载', 'Start uninstalling'))
                  : null,
                stage === 'confirm'
                  ? [
                      h('span', { key: 't', style: { color: T.danger } }, L(`确定执行这 ${selected.length} 项？勾了删除的项不能撤销`, `Run these ${selected.length} items? Deletions cannot be undone`)),
                      h(Btn, { key: 'y', kind: 'danger', onClick: run }, L('确认卸载', 'Confirm uninstall')),
                      h(Btn, { key: 'n', onClick: () => setStage('idle') }, L('取消', 'Cancel')),
                    ]
                  : null,
                stage === 'running' ? h('span', { style: S.muted }, L('卸载中…（要连服务器的项会慢一些）', 'Uninstalling… (items that reach the servers take longer)')) : null))
          : null,

        stage === 'done' && result
          ? h('div', { style: { marginTop: 10 } },
              result.steps.map((s, i) => h('div', { key: i, style: { display: 'flex', gap: 8, padding: '3px 0' } },
                h('span', { style: { color: s.ok ? T.ok : T.danger, fontWeight: 600 } }, s.ok ? '✓' : '✗'),
                h('span', null, h('span', { style: S.muted }, L(`${UNINSTALL_ITEMS[s.id]?.label ?? s.id}：`, `${UNINSTALL_ITEMS[s.id]?.label ?? s.id}: `)), s.text))),
              pluginStep?.ok
                ? h('div', { style: { ...S.row, marginTop: 10 } },
                    result.canRestart ? h(Btn, { kind: 'primary', onClick: restart }, L('重启 DSH', 'Restart DSH')) : h('span', null, L('请重启 DSH 完成卸载', 'Restart DSH to finish uninstalling')),
                    restartMsg ? h('span', { style: S.muted }, restartMsg) : null)
                : null)
          : null)
    }

    function SettingsSection() {
      useLang()
      const overview = useAsync(async () => {
        const res = await api('overview', {})
        cacheHosts(res.hosts)
        return res
      }, [])
      const [selected, setSelected] = useState('')
      const [adding, setAdding] = useState(false)
      const [importing, setImporting] = useState(null)
      const [settings, setSettings] = useState(null)
      const [msg, setMsg] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')

      useEffect(() => {
        if (overview.data?.settings) setSettings(overview.data.settings)
      }, [overview.data])

      const reload = () => {
        overview.reload()
        setMsg('')
      }

      if (adding) {
        return h('div', { style: S.root },
          h(AddWizard, { onDone: reload, onCancel: () => { setAdding(false); reload() } }))
      }
      if (selected) {
        return h('div', { style: S.root },
          h(MachineSettings, { alias: selected, onBack: () => setSelected(''), onChanged: reload }))
      }

      const d = overview.data
      const hosts = d?.hosts ?? []
      const recipeCount = d?.recipes?.length ?? 0

      return h('div', { style: S.root },
        h('div', { style: S.spread },
          h('div', { style: S.h1 }, L('VPS 管理', 'VPS Manager')),
          h('div', { style: S.row },
            h(Btn, {
              onClick: async () => {
                setError('')
                try {
                  const res = await api('import/candidates', {})
                  setImporting(res.candidates ?? [])
                } catch (e) {
                  setError(e.message)
                }
              },
            }, L('从 ~/.ssh/config 导入', 'Import from ~/.ssh/config')),
            h(Btn, { kind: 'primary', onClick: () => setAdding(true) }, L('+ 添加机器', '+ Add machine')))),

        h(ErrorBar, { error: error || overview.error }),
        msg ? h('div', { style: S.note }, msg) : null,

        importing ? h('div', { style: S.card },
          h('div', { style: S.h2 }, L('可导入的条目', 'Entries you can import')),
          importing.length === 0
            ? h('div', { style: S.muted }, L('没有发现可导入的条目', 'No entries to import'))
            : importing.map((c) => h('div', { key: c.alias, style: { ...S.spread, padding: '4px 0' } },
                h('span', null, `${c.alias}　`, h('span', { style: S.muted }, `${c.hostname}:${c.port} ${c.user}`)),
                h(Btn, {
                  onClick: async () => {
                    try {
                      await api('import/adopt', { aliases: [c.alias] })
                      setImporting(importing.filter((x) => x.alias !== c.alias))
                      reload()
                    } catch (e) {
                      setError(e.message)
                    }
                  },
                }, L('导入', 'Import')))),
          h('div', { style: { marginTop: 8 } }, h(Btn, { onClick: () => setImporting(null) }, L('关闭', 'Close')))) : null,

        // —— 机器列表：编号与对话头部的方块一一对应 ——
        h('div', { style: S.card },
          h('div', { style: S.spread },
            h('div', { style: S.h2 }, L(`机器（${hosts.length}）`, `Machines (${hosts.length})`)),
            h('span', { style: { ...S.muted, fontSize: 11 } }, L('编号对应对话头部 VPS 后面的方块', 'Numbers match the squares after VPS in the conversation header'))),
          overview.loading && !d ? h('div', { style: S.muted }, L('读取中…', 'Loading…')) : null,
          hosts.length === 0 && !overview.loading
            ? h('div', { style: S.note }, L('还没有机器。点右上角「+ 添加机器」，填好地址、用户名和密码，点「保存并连接」就接上了（密码只用这一次，不保存）。', 'No machines yet. Click "+ Add machine" at the top right, fill in the address, user and password, and click "Save and connect" (the password is used once and not stored).'))
            : null,
          hosts.map((host, i) => h('div', { key: host.alias, style: { ...S.spread, padding: '6px 0', borderTop: i ? line : 'none' } },
            h('div', { style: S.row },
              h('span', {
                style: {
                  minWidth: 17, height: 17, borderRadius: 4, fontSize: 10, fontWeight: 600,
                  lineHeight: '17px', textAlign: 'center', padding: hosts.length > 9 ? '0 3px' : 0,
                  background: host.reachable === false ? T.danger : T.ok,
                  color: '#fff', opacity: host.reachable === false ? 0.6 : 1,
                },
              }, ballLabel(i)),
              h('span', { style: { fontWeight: 600 } }, host.alias),
              h('span', { style: S.mono }, host.address || L('未测', 'not tested')),
              host.group ? h(Badge, null, host.group) : null,
              h('span', { style: S.muted }, host.note || ''),
              h(Badge, null, PRIV_LABEL[host.privilege] ?? L('权限未知', 'privilege unknown'))),
            h('div', { style: S.row },
              h(Btn, {
                onClick: async () => {
                  setBusy(host.alias)
                  setError('')
                  try {
                    const res = await api('host/test', { alias: host.alias })
                    setMsg(res.ok ? L(`${host.alias} 连接正常（${res.address}）`, `${host.alias} connection works (${res.address})`) : L(`${host.alias} 连不上：${res.hint}`, `${host.alias} is unreachable: ${res.hint}`))
                    reload()
                  } catch (e) {
                    setError(e.message)
                  } finally {
                    setBusy('')
                  }
                },
                disabled: busy === host.alias,
              }, busy === host.alias ? L('测试中…', 'Testing…') : L('测连通', 'Test connection')),
              h(Btn, { kind: 'primary', onClick: () => setSelected(host.alias) }, L('设置', 'Settings')))))),

        settings ? h('div', { style: S.card },
          h('div', { style: S.h2 }, L('全局', 'Global')),
          h('div', { style: S.grid },
            h(Field, { label: L('默认确认档位', 'Default confirmation level'), hint: L('机器设置 > 分组 > 这里', 'machine setting > group > this') },
              h(Select, {
                value: settings.confirm,
                onChange: (v) => setSettings({ ...settings, confirm: v }),
                options: Object.entries(CONFIRM_LABEL).map(([value, label]) => ({ value, label })),
              })),
            h(Field, { label: L('连通性保险时长（秒）', 'Connectivity safety net (seconds)'), hint: L('改防火墙 / SSH 后多久自动恢复', 'How long after a firewall / SSH change to restore automatically') },
              h(Input, {
                value: String(settings.safetyNetSeconds ?? 120),
                onChange: (v) => setSettings({ ...settings, safetyNetSeconds: Number(v) || 120 }),
              }))),
          d?.lanBound ? h('div', { style: { marginTop: 10 } },
            h('label', { style: S.row },
              h('input', {
                type: 'checkbox',
                checked: Boolean(settings.allowPanelExecOnLan),
                onChange: (e) => setSettings({ ...settings, allowPanelExecOnLan: e.target.checked }),
              }),
              h('span', null, L('DSH 的 Web 服务绑定在 0.0.0.0（局域网可见），允许在这里执行会改东西的操作', 'DSH\'s web server is bound to 0.0.0.0 (visible on the local network); allow actions that change things from here')))) : null,
          h('div', { style: { marginTop: 10 } },
            h(Btn, {
              kind: 'primary',
              onClick: async () => {
                setError('')
                try {
                  await api('settings/save', { settings })
                  setMsg(L('已保存', 'Saved'))
                  reload()
                } catch (e) {
                  setError(e.message)
                }
              },
            }, L('保存设置', 'Save settings')))) : null,

        settings ? h(TerminalSettingsCard, { settings, setSettings }) : null,

        // —— 怎么用：机器加完之后的下一步都在对话里，这里只留一张导览 ——
        h('div', { style: S.card },
          h('div', { style: S.h2 }, L('怎么用', 'How to use it')),
          h('div', { style: { ...S.muted, fontSize: 12, lineHeight: 1.9 } },
            h('div', null, L('① 在对话头部点「VPS」后面的编号方块，这个对话就绑到那台机器（编号和上面列表一致，点另一个编号切换）。方块颜色：灰 没选 · 黄 连接中 · 绿 已连上 · 红 连不上（输入框下方写原因，可重试）', '① In the conversation header, click a numbered square after "VPS" to bind the conversation to that machine (numbers match the list above; click another to switch). Colours: grey not selected · yellow connecting · green connected · red unreachable (the reason is shown below the input box, with a retry)')),
            h('div', null, L('② 看信息不花 token：', '② Look things up without spending tokens: '), h('span', { style: S.mono }, '/vps-sysinfo　/vps-disk　/vps-ports　/vps-sh df -h')),
            h('div', null, L(`③ 装软件与系统维护走菜谱（现有 ${recipeCount} 条）：`, `③ Installs and system maintenance are recipes (${recipeCount} so far): `),
              h('span', { style: S.mono }, '/vps-recipes'), L(' 看清单，', ' lists them, '),
              h('span', { style: S.mono }, '/vps-install <id>'), L(' 看计划，', ' shows the plan, '), h('span', { style: S.mono }, '/vps-yes'), L(' 执行', ' runs it')),
            h('div', null, L('④ 剩下的直接跟 AI 说，例如「给这台装个 nginx，把 a.com 反代到 3000」', '④ For anything else just tell the AI, e.g. "install nginx on this machine and reverse-proxy a.com to 3000"')),
            h('div', null, L('⑤ 想跟在 ssh 里一样自己敲、用菜单脚本：点对话头部「VPS」后面的 ', '⑤ To type yourself as in ssh, or use menu scripts: click '), h('span', { style: S.mono }, '>_'), L('，输入框下方就是终端（设置见下方「终端」）', ' after "VPS" in the conversation header and a terminal opens below the input box (settings: "Terminal" below)')),
            h('div', null, L('⑥ 传文件、改配置：终端面板标题栏切到「文件」——拖进来上传、右键下载、双击编辑、删了进回收站；右键「让 AI 看看这个文件」', '⑥ Move files and edit configs: switch the terminal panel\'s title bar to "Files" — drag in to upload, right-click to download, double-click to edit, deletes go to the trash; right-click "Let the AI look at this file"')),
            h('div', null, L('全部命令与用法：', 'Every command and how to use it: '), h('span', { style: S.mono }, '/vps-help')))),

        d?.paths ? h('div', { style: S.card },
          h('div', { style: S.h2 }, L('数据位置', 'Data location')),
          h('div', { style: S.mono }, d.paths.base),
          h('div', { style: { ...S.muted, fontSize: 12 } },
            L('hosts.yml 可以手工编辑；recipes/ 放自己的菜谱；audit/ 是操作记录', 'hosts.yml can be edited by hand; recipes/ holds your own recipes; audit/ is the activity log'))) : null,

        h(FeedbackCard),

        h(UninstallCard))
    }

    // —— 反馈与建议：平时只有两个按钮；诊断信息（版本、注册情况、最近错误）收起来，要用时自己点开 ——
    // 用户定的：自动摆出一堆报错记录，看起来像产品有很多问题；这些只在反馈问题时才用得上。
    // 诊断照样在后台读好，「反馈问题」的链接要带上它（预填进问题单，用户在 GitHub 上看过再提交，
    // 不会自动上传任何东西；内容已打码、不含机器地址）
    const ISSUE_URL = 'https://github.com/AIcivilization/dsh-vps-manager/issues/new'
    function FeedbackCard() {
      const diag = useAsync(() => api('diag/status', {}), [])
      const [open, setOpen] = useState(false)
      const d = diag.data
      const link = (href, label, primary) => h('a', {
        href,
        target: '_blank',
        rel: 'noopener noreferrer',
        style: { ...S.btn(primary ? 'primary' : null, false), textDecoration: 'none', display: 'inline-block' },
      }, label)
      const parts = Object.values(d?.parts ?? {})
      const failed = parts.filter((p) => !p.ok)
      return h('div', { style: S.card },
        h('div', { style: S.h2 }, L('反馈与建议', 'Feedback and suggestions')),
        h('div', { style: { ...S.muted, fontSize: 12 } }, L('用着不顺手、遇到问题，或者想要什么功能，都欢迎告诉我们。', 'Something awkward, a problem, or a feature you want? Tell us.')),
        // 装了新版还没重启：这是更新提示，不是报错，照常显示
        d?.restartNeeded
          ? h('div', { style: { fontSize: 12, marginTop: 8 } },
            L(`新版本 ${d.restartNeeded} 已经装好，完全退出 DSH 再打开就会用上`, `Version ${d.restartNeeded} is installed; quit DSH completely and open it again to use it`))
          : null,
        h('div', { style: { ...S.row, marginTop: 10 } },
          link(d?.feedbackUrl ?? `${ISSUE_URL}?template=bug_report.yml`, L('反馈问题', 'Report a problem'), true),
          link(d?.suggestUrl ?? `${ISSUE_URL}?template=feature_request.yml`, L('提建议', 'Suggest'), false),
          h(Btn, { onClick: () => setOpen(!open) }, open ? L('收起诊断信息', 'Hide diagnostics') : L('诊断信息', 'Diagnostics'))),
        open ? h('div', { style: { fontSize: 12, lineHeight: 1.9, marginTop: 10 } },
          diag.loading && !d ? h('div', { style: S.muted }, L('读取中…', 'Loading…')) : null,
          diag.error ? h(ErrorBar, { error: diag.error }) : null,
          d ? h('div', null,
            h('div', null, L(`插件 ${d.plugin} · ${d.dsh.status === 'verified' ? `DSH ${d.dsh.version}（已验证）` : d.dsh.text}`, `Plugin ${d.plugin} · ${d.dsh.status === 'verified' ? `DSH ${d.dsh.version} (verified)` : d.dsh.text}`)),
            h('div', null,
              failed.length
                ? L(`没注册成功：${failed.map((p) => `${p.label}（${p.detail}）`).join('、')}`, `Failed to register: ${failed.map((p) => `${p.label} (${p.detail})`).join(', ')}`)
                : L(`各部分都正常：${parts.map((p) => `${p.label}${p.detail ? ` ${p.detail}` : ''}`).join(' · ') || '还没有记录'}`, `Every part is fine: ${parts.map((p) => `${p.label}${p.detail ? ` ${p.detail}` : ''}`).join(' · ') || 'nothing recorded yet'}`)),
            d.errors.some((e) => e.at >= (d.startedAt ?? '') && /already registered|duplicate (exact|upgrade) route/.test(e.message))
              ? h('div', null, L('同一个 DSH 里加载过两份本插件（常见于插件市场装了新版、DSH 没重启）：完全退出 DSH 再打开就好', 'Two copies of this plugin were loaded in the same DSH (common after installing a new version from the plugin market without restarting DSH): quit DSH completely and open it again'))
              : null,
            h('div', { style: S.muted }, d.errors.length ? L(`最近的错误 ${d.errors.length} 条（已打码）：`, `Recent errors (${d.errors.length}, masked):`) : L('最近没有错误记录', 'No recent errors')),
            d.errors.slice(0, 3).map((e, i) => h('div', { key: i, style: { ...S.mono, opacity: 0.75 } },
              `${e.at.slice(5, 16).replace('T', ' ')} [${e.source}] ${e.message.slice(0, 140)}`)),
            h('div', { style: { ...S.row, marginTop: 6 } }, h(Btn, { onClick: () => diag.reload() }, L('刷新', 'Refresh'))),
            h('div', { style: { ...S.muted, fontSize: 11, marginTop: 4 } },
              L('这些信息只在排查问题时用得上。点「反馈问题」会打开 GitHub 上预填好这些内容的问题单，你看过、改好再提交；插件不会自动上传任何东西', 'This is only useful when tracking down a problem. "Report a problem" opens a GitHub issue pre-filled with it, for you to review and edit before submitting; the plugin never uploads anything by itself'))) : null) : null)
    }

    // ——————————————————————— 对话里的 VPS 开关 ———————————————————————
    // 「打开 = 这个对话在操作这台 VPS，关闭 = 不操作」。绑定是**每个对话各自的**，
    // 所以另一个窗口切机器不会影响这里；host 侧从 agent.session 认出是哪个会话，
    // 于是命令和 AI 工具都能省掉 -h。

    const BIND_EVENT = 'dsh-vps:binding'

    function readBinding(sessionId) {
      if (!sessionId) return ''
      try {
        return window.localStorage?.getItem(`dsh-vps:bind:${sessionId}`) ?? ''
      } catch {
        return ''
      }
    }

    function writeBinding(sessionId, alias) {
      if (!sessionId) return
      try {
        if (alias) window.localStorage?.setItem(`dsh-vps:bind:${sessionId}`, alias)
        else window.localStorage?.removeItem(`dsh-vps:bind:${sessionId}`)
      } catch {
        // 隐私模式写不了，只影响刷新后开关的显示，host 侧的绑定仍在
      }
    }

    // 服务器记的所有对话绑定：每个页面读一次（30 秒内复用），不是每个对话一次。
    // 头部按钮的状态存在浏览器本地，同一个对话在桌面版选了机器，网页版（另一个浏览器）
    // 打开时本地没有记录，方块就全是灰的（实测）—— 这里以服务器为准补上。
    const SERVER_BINDINGS_TTL_MS = 30_000
    let serverBindingsCache = null // { at, promise }

    function serverBindings() {
      if (serverBindingsCache && Date.now() - serverBindingsCache.at < SERVER_BINDINGS_TTL_MS) return serverBindingsCache.promise
      const promise = api('session/bindings', {}).then((res) => res.bindings ?? {}).catch(() => ({}))
      serverBindingsCache = { at: Date.now(), promise }
      return promise
    }

    /** 头部开关和输入框下方的状态条是两个组件，用事件保持同步 */
    function useBinding(sessionId) {
      const [alias, setAlias] = useState(() => readBinding(sessionId))
      useEffect(() => {
        const onChange = (e) => {
          if (e?.detail?.sessionId === sessionId) setAlias(e.detail.alias ?? '')
        }
        window.addEventListener(BIND_EVENT, onChange)
        // 本地没有记录、服务器有：以服务器为准（本地有记录的由输入框下方的检测对齐）
        let alive = true
        if (sessionId && !readBinding(sessionId)) {
          serverBindings().then((map) => {
            const server = map[sessionId] ?? ''
            if (!alive || !server) return
            // 头部和输入框下方各有一份，谁先到谁写；写完用事件通知所有人，别让后到的那个以为「已经有了」就不更新自己
            if (!readBinding(sessionId)) writeBinding(sessionId, server)
            if (readBinding(sessionId) !== server) return
            setAlias(server)
            try {
              window.dispatchEvent(new CustomEvent(BIND_EVENT, { detail: { sessionId, alias: server } }))
            } catch {
              // 老浏览器没有 CustomEvent 构造器
            }
          })
        }
        return () => {
          alive = false
          window.removeEventListener(BIND_EVENT, onChange)
        }
      }, [sessionId])
      const bind = useCallback(async (next) => {
        await api('session/bind', { sessionId, alias: next || null })
        serverBindingsCache = null // 绑定变了，下次重新读
        writeBinding(sessionId, next || '')
        setAlias(next || '')
        try {
          window.dispatchEvent(new CustomEvent(BIND_EVENT, { detail: { sessionId, alias: next || '' } }))
        } catch {
          // 老浏览器没有 CustomEvent 构造器时，另一个组件下次挂载时会自己读
        }
      }, [sessionId])
      return { alias, bind }
    }

    // —— 对话头部的开关：VPS + 一串方块，不弹任何东西 ——
    //
    // 顺序（用户定的）：VPS → 终端按钮 >_ → 每台机器一个圆角方块。
    // 方块：绿 = 这个对话正在操作它，红 = 没有；里面写编号 1234（只有一台也写 1），
    // 和设置页的编号一致。点哪个绑哪个，再点一次关掉；每次只能亮一个。
    //
    // 机器清单缓存在 localStorage，所以**挂载时依然零请求**——大多数对话跟 VPS 无关。

    const HOSTS_CACHE_KEY = 'dsh-vps:hosts'

    function readCachedHosts() {
      try {
        const raw = window.localStorage?.getItem(HOSTS_CACHE_KEY)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list : []
      } catch {
        return []
      }
    }

    /** 任何地方拉到机器清单都顺手缓存，供头部开关零请求渲染 */
    function cacheHosts(hosts) {
      try {
        const list = (hosts ?? []).map((h) => ({ alias: h.alias, note: h.note ?? '' }))
        window.localStorage?.setItem(HOSTS_CACHE_KEY, JSON.stringify(list))
      } catch {
        // 写不了就每次点开关时现拉
      }
    }

    const CHIP_BG = {
      off: 'var(--dsw-alias-label-tertiary, #81858c)',
      checking: '#f5a623',
      ok: T.ok,
      fail: T.danger,
    }

    /** 方块的颜色：没选 → 灰；选了 → 看测出来的连接状态（还没结果就算正在连接） */
    function chipTone(selected, reach) {
      if (!selected) return 'off'
      if (reach?.state === 'ok') return 'ok'
      if (reach?.state === 'fail') return 'fail'
      return 'checking'
    }

    /** 方块里的编号：第一台 1，第二台 2……只有一台也写 1 */
    function ballLabel(index) {
      return String(index + 1)
    }

    function VpsToggle(props) {
      useLang()
      const sessionId = props?.sessionId ? String(props.sessionId) : ''
      const { alias, bind } = useBinding(sessionId)
      const termEntry = useTermState(sessionId)
      const termView = termEntry && termEntry.alias === alias ? termEntry.view : ''
      const reach = useReach(alias)
      const [hosts, setHosts] = useState(() => readCachedHosts())
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')

      const refresh = useCallback(async () => {
        const res = await api('overview', {})
        const list = (res.hosts ?? []).map((h) => ({ alias: h.alias, note: h.note ?? '' }))
        cacheHosts(list)
        setHosts(list)
        return list
      }, [])

      // 这个对话绑着机器、但这个浏览器还没缓存机器清单（比如第一次在网页版打开）：自己拉一次，
      // 不然头部只有一个空方块，看不出绑的是哪台
      useEffect(() => {
        if (alias && !hosts.length) refresh().catch(() => {})
      }, [alias, hosts.length, refresh])

      const click = async (target) => {
        setError('')
        setBusy(target?.alias ?? 'load')
        try {
          // 还没有缓存：先拉清单；只有一台就直接绑上，多台则显示出来让你点
          if (!target) {
            const list = await refresh()
            if (list.length === 1) {
              await bind(list[0].alias)
              checkNow(sessionId, list[0].alias, true)
            } else if (list.length === 0) setError(L('还没有机器：DSH 设置 → VPS 管理 → 添加', 'No machines yet: DSH Settings → VPS Manager → Add'))
            return
          }
          const next = alias === target.alias ? '' : target.alias
          await bind(next)
          if (next) checkNow(sessionId, next, true) // 打开开关就现测：绿要是真连上了
          // 关掉开关或换机器：终端连的是原来那台，一并结束（服务器那头也会结束）
          if (termStore.has(sessionId)) endTerminal(sessionId, { confirm: false })
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      // 方块颜色 = 连接状态（实测教训：原来绿只表示「选了这台」，连不上也是绿的）：
      //   灰 = 这个对话没选这台 · 黄（闪）= 正在连接 · 绿 = 已连上 · 红 = 选了但连不上
      // 每次只能选一台。用圆角方块而不是圆球：数字更好读、点击面积大、和 DSH 其他控件一致。
      const chip = (key, text, tone, title, onClick) => h('button', {
        key,
        type: 'button',
        onClick,
        title,
        'data-vps-chip': tone,
        style: {
          minWidth: 17,
          height: 17,
          padding: text.length > 1 ? '0 3px' : 0,
          borderRadius: 4,
          border: 'none',
          cursor: 'pointer',
          fontSize: 10,
          lineHeight: '17px',
          fontWeight: 600,
          background: CHIP_BG[tone],
          color: '#fff',
          opacity: tone === 'off' ? 0.45 : 1,
          animation: tone === 'checking' ? 'dshVpsPulse 1s ease-in-out infinite' : 'none',
          flex: '0 0 auto',
        },
      }, text)

      // 终端按钮：紧跟在 VPS 后面，一直在（位置不跳），仍是开关。
      // 已绑定：没开 → 打开；开着 → 最小化；最小化 → 恢复。
      // 没绑定：只有一台机器就顺手绑上并打开；多台时先点后面的编号选一台。
      const clickTerminal = async () => {
        if (alias) {
          toggleTerminal(sessionId, alias)
          return
        }
        setError('')
        try {
          const list = hosts.length ? hosts : await refresh()
          if (list.length === 1) {
            setBusy(list[0].alias)
            await bind(list[0].alias)
            checkNow(sessionId, list[0].alias, true)
            openTerminal(sessionId, list[0].alias)
          } else if (list.length === 0) {
            setError(L('还没有机器：DSH 设置 → VPS 管理 → 添加', 'No machines yet: DSH Settings → VPS Manager → Add'))
          } else {
            setError(L('先点后面的编号选一台机器，再打开终端', 'Pick a machine with one of the numbers first, then open the terminal'))
          }
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      const terminalButton = h('button', {
        key: 'terminal',
        type: 'button',
        'data-vps-terminal': '',
        onClick: clickTerminal,
        title: !alias
          ? (hosts.length > 1 ? L('先点后面的编号选一台机器，再打开终端', 'Pick a machine with one of the numbers first, then open the terminal') : L('打开终端：跟在 ssh 里一样操作', 'Open the terminal: works just like ssh'))
          : termView === 'minimized' ? L('终端在后台运行，点一下恢复', 'The terminal is running in the background; click to restore')
            : termView ? L('最小化终端（在后台继续运行）', 'Minimize the terminal (keeps running in the background)') : L(`打开 ${alias} 的终端：跟在 ssh 里一样操作`, `Open the terminal on ${alias}: works just like ssh`),
        style: {
          position: 'relative',
          height: 17,
          padding: '0 4px',
          marginRight: 2,
          borderRadius: 4,
          border: termView ? `1px solid ${T.accent}` : line,
          background: termView && termView !== 'minimized' ? T.accent : 'transparent',
          color: termView && termView !== 'minimized' ? '#fff' : 'inherit',
          opacity: alias ? 1 : 0.55,
          cursor: 'pointer',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 10,
          lineHeight: '15px',
          fontWeight: 600,
          flex: '0 0 auto',
        },
      },
        '>_',
        // 最小化着：右上角一个小绿点，表示终端在后台跑着
        termView === 'minimized' ? h('span', {
          'data-vps-terminal-running': '',
          style: {
            position: 'absolute', top: -3, right: -3, width: 6, height: 6, borderRadius: '50%',
            background: T.ok, border: '1px solid var(--dsw-alias-bg-base, #fff)',
          },
        }) : null)

      // 外面一圈浅色细框：一眼看出 VPS、终端、机器方块是同一个插件的一组按钮。
      // 颜色取 DSH 主题的边框变量，深浅色都合适
      const wrap = (children) => h('span', {
        'data-vps-group': '',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 12,
          height: 25,
          boxSizing: 'border-box',
          padding: '0 4px 0 7px',
          border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25))',
          borderRadius: 8,
        },
        title: error || undefined,
      },
        h('span', { style: { opacity: 0.7, letterSpacing: 0.3 } }, 'VPS'),
        terminalButton,
        children)

      if (!hosts.length) {
        return wrap(chip('load', busy ? '·' : '', 'off', error || L('点一下绑定这个对话要操作的 VPS', 'Click to bind the VPS this conversation operates on'), () => click(null)))
      }

      return wrap(hosts.map((host, i) => {
        const name = L(`${host.alias}${host.note ? `（${host.note}）` : ''}`, `${host.alias}${host.note ? ` (${host.note})` : ''}`)
        const tone = chipTone(host.alias === alias, reach)
        const title = {
          off: L(`点一下改成操作 ${name}`, `Click to operate ${name} instead`),
          checking: L(`正在连接 ${name}…`, `Connecting to ${name}…`),
          ok: L(`这个对话正在操作 ${name} · 已连上　点一下关掉`, `This conversation operates ${name} · connected. Click to turn off`),
          fail: L(`这个对话选了 ${name}，但连不上：${reach?.hint || '原因未知'}　输入框下方可以重试；点一下关掉`, `This conversation selected ${name}, but it is unreachable: ${reach?.hint || 'reason unknown'}. Retry below the input box; click to turn off`),
        }[tone]
        return chip(host.alias, busy === host.alias ? '·' : ballLabel(i), tone, title, () => click(host))
      }))
    }

    // —— 输入框下方：只在「你不问就会漏掉」的时候才冒一行 ——
    //
    // 判断标准（用户定的）：对话解决不了的，才有保留的意义。
    // 查询、跑命令、装软件，说话都能办，而且更自然 —— 所以按钮、命令框全部删掉。
    // 剩下的只有一件事对话给不了：**你不主动问就不会知道的状况**。
    // 所以这里平时渲染为空，只有这三种情况才出现一行：
    //   1. 有后台任务在跑（你关掉页面它还在跑，不说你不知道）
    //   2. 机器连不上
    //   3. 体检发现了该管的事（磁盘快满、有服务挂了）

    /**
     * 该不该打扰你：只报「你不主动问就不会知道」的事。
     * 一切正常时返回空数组 —— 平时一个像素都不占。
     */
    function alertsFor(alias, state) {
      const items = []
      const running = state?.running ?? []
      if (running.length) {
        const names = running.map((t) => t.meta?.recipeId ?? t.meta?.action ?? L('任务', 'task')).join(L('、', ', '))
        items.push({ tone: 'ok', text: L(`${alias} 上有 ${running.length} 个任务在跑：${names}`, `${running.length} tasks running on ${alias}: ${names}`) })
      }
      if (state?.reachable === false) {
        items.push({ tone: 'danger', text: L(`${alias} 连不上${state.hint ? `：${state.hint}` : '了'}`, `${alias} is unreachable${state.hint ? `: ${state.hint}` : ''}`), action: 'retry' })
      } else {
        const facts = state?.facts ?? {}
        const pct = Number(String(facts.disk_pct ?? '').replace('%', ''))
        if (pct >= 85) items.push({ tone: 'danger', text: L(`${alias} 磁盘已用 ${facts.disk_pct}`, `${alias} disk ${facts.disk_pct} used`) })
      }
      return items
    }

    const ALERT_TTL_MS = 60_000
    const alertCache = new Map() // alias → { at, data }

    // —— 连得上吗：顶部方块的颜色 ——
    //
    // 实测的教训：方块原来只表示「选了这台」，SSH 配置被卸载移走后照样是绿的，
    // 命令和终端却全部失败。现在方块颜色是测出来的连接状态：
    //   灰 = 这个对话没选这台 · 黄（闪）= 正在连接 · 绿 = 已连上 · 红 = 选了但连不上
    // 打开开关、打开这个对话、切回 DSH 窗口时现测（服务器 30 秒内测过就用上次的）；
    // 命令、AI 工具、终端每次连服务器的成败，服务器也会记下，这里每 30 秒读一次。

    const REACH_EVENT = 'dsh-vps:reach'
    const reachStore = new Map() // 别名 → { state: 'checking' | 'ok' | 'fail', hint, at }

    function setReach(alias, patch) {
      if (!alias) return
      reachStore.set(alias, { ...(reachStore.get(alias) ?? {}), ...patch })
      try {
        window.dispatchEvent(new CustomEvent(REACH_EVENT, { detail: { alias } }))
      } catch {
        // 老浏览器没有 CustomEvent 构造器
      }
    }

    function useReach(alias) {
      const [, force] = useState(0)
      useEffect(() => {
        const on = (e) => {
          if (e?.detail?.alias === alias) force((n) => n + 1)
        }
        window.addEventListener(REACH_EVENT, on)
        return () => window.removeEventListener(REACH_EVENT, on)
      }, [alias])
      return alias ? reachStore.get(alias) ?? null : null
    }

    /** 服务器给的结果 → 方块颜色 */
    function applyReach(alias, res) {
      if (!res || res.alias !== alias || typeof res.reachable !== 'boolean') return
      setReach(alias, { state: res.reachable ? 'ok' : 'fail', hint: res.hint || '', at: res.checkedAt || null })
    }

    /** 现测一次。force：不用缓存（打开开关、点重试）。已有结果时不闪黄，免得每次打开对话都跳一下 */
    async function checkNow(sessionId, alias, force = false) {
      if (!sessionId || !alias) return null
      if (force || !reachStore.get(alias)?.state) setReach(alias, { state: 'checking' })
      try {
        const res = await api('session/status', { sessionId, check: force ? 'force' : true })
        applyReach(alias, res)
        return res
      } catch (error) {
        setReach(alias, { state: 'fail', hint: error.message })
        return null
      }
    }

    const REACH_POLL_MS = 30_000

    function VpsAlert(props) {
      const alertRef = useOwnRow()
      const sessionId = props?.sessionId ? String(props.sessionId) : ''
      const { alias } = useBinding(sessionId)
      const reach = useReach(alias)
      const [state, setState] = useState(null)

      // 打开对话：测连接 + 读体检和任务；头部和服务器的绑定不一致时对齐
      useEffect(() => {
        if (!alias) {
          setState(null)
          return undefined
        }
        let alive = true
        ;(async () => {
          const status = await checkNow(sessionId, alias, false)
          // 头部显示的绑定和服务器记的不一致：一律以服务器为准（实测：头部是绿的，/vps-disk 却说没开开关）。
          // 头部状态存在浏览器本地，桌面版和网页版是两个浏览器；在一边关掉开关，另一边打开这个对话时
          // 不能又把它绑回去 —— 服务器没记就变灰，记的是另一台（/vps-use 改过）就跟着换
          if (status && status.alias !== alias) {
            writeBinding(sessionId, status.alias || '')
            if (!status.alias && termStore.has(sessionId)) endTerminal(sessionId, { confirm: false })
            try {
              window.dispatchEvent(new CustomEvent(BIND_EVENT, { detail: { sessionId, alias: status.alias || '' } }))
            } catch {
              // 老浏览器没有 CustomEvent 构造器
            }
            return
          }
          const cached = alertCache.get(alias)
          if (cached && Date.now() - cached.at < ALERT_TTL_MS) {
            if (alive) setState(cached.data)
            return
          }
          try {
            const tasks = await api('tasks/list', { alias }).catch(() => ({ tasks: [] }))
            const data = {
              facts: status?.facts ?? {},
              running: (tasks.tasks ?? []).filter((t) => t.state === 'running'),
            }
            alertCache.set(alias, { at: Date.now(), data })
            if (alive) setState(data)
          } catch {
            // 读不到就当没事，别为了报错占地方
          }
        })()

        // 切回 DSH 窗口时再测；平时每 30 秒读一次服务器记下的结果（命令、AI 工具连不上也会反映出来）
        const onVisible = () => {
          if (document.visibilityState === 'visible') checkNow(sessionId, alias, false)
        }
        const poll = setInterval(() => {
          if (document.visibilityState !== 'visible') return
          api('session/status', { sessionId }).then((res) => applyReach(alias, res)).catch(() => {})
        }, REACH_POLL_MS)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          clearInterval(poll)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [alias, sessionId])

      if (!alias) return null
      const reachable = reach?.state === 'fail' ? false : reach?.state === 'ok' ? true : null
      const items = alertsFor(alias, { ...(state ?? {}), reachable, hint: reach?.hint ?? '' })
      if (!items.length) return null // 没事就什么都不显示

      return dockRow(alertRef, h('div', {
        style: {
          ...DOCK_WIDTH,
          marginTop: 6,
          padding: '4px 10px',
          border: line,
          borderRadius: 8,
          fontSize: 12,
          background: T.layer,
        },
      }, items.map((item, i) => h('div', {
        key: i,
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          color: item.tone === 'danger' ? T.danger : 'inherit', opacity: item.tone === 'ok' ? 0.85 : 1,
        },
      },
        h('span', { style: { flex: 1, minWidth: 0 } }, `• ${item.text}`),
        item.action === 'retry' ? h('button', {
          type: 'button',
          onClick: () => checkNow(sessionId, alias, true),
          disabled: reach?.state === 'checking',
          style: {
            border: line, background: 'transparent', color: 'inherit', borderRadius: 6,
            padding: '1px 8px', fontSize: 12, cursor: 'pointer', flex: '0 0 auto',
          },
        }, reach?.state === 'checking' ? L('连接中…', 'Connecting…') : L('重试', 'Retry')) : null))))
    }

    // ——————————————————————— 对话里的终端 ———————————————————————
    //
    // /vps-sh 一问一答，菜单脚本、top、vim 这类要反复按键的程序用不了；这里是真终端：
    // xterm.js ⇄ WebSocket ⇄ 插件 ⇄ ssh -tt ⇄ 服务器上的伪终端。
    //
    // DSH 两种形态通用：连接地址用 location.origin 拼（http→ws、https→wss），
    // Desktop 的 127.0.0.1:端口、dsh web 的本机 / 局域网地址、反向代理的域名都一样。
    // 浏览器 WebSocket 加不了请求头，token 放在子协议里带过去。
    //
    // 窗口三态（用户定的，照 macOS 的红黄绿）：
    //   normal     输入框下方的终端，右下角可拖高度
    //   minimized  黄色 −：缩成输入框下方的一条横栏，点横栏回来
    //   maximized  绿色：终端撑满对话区，输入框被推到最上面
    //   红色 ×：结束这个终端（服务器上的 shell 一起结束）
    // 顶部 >_ 仍是开关：没开 → 打开；开着 → 最小化；最小化 → 恢复。
    //
    // 终端不属于某个 React 组件，而是每个对话一个常驻会话（termStore）：
    // 最小化、切走对话、再回来，屏幕内容和服务器上的 shell 都还在。
    // 刷新页面或断网时，服务器把会话保留一段时间（设置里可调），回来按记下的会话 id
    // 接上，从断开处补发输出。xterm.js 三百多 KB，第一次打开终端时才加载。

    const XTERM_VERSION = '6.0.0'
    const TERMINAL_PROTOCOL = 'dsh-vps-terminal'
    const TERM_EVENT = 'dsh-vps:terminal'
    const TERM_HEIGHT_KEY = 'dsh-vps:terminal-height'
    const TERM_PREFS_KEY = 'dsh-vps:terminal-prefs'
    const TERM_PREFS_EVENT = 'dsh-vps:terminal-prefs'
    const TERM_RESUME_PREFIX = 'dsh-vps:term:'
    const TERM_THEMES = [
      { value: 'system', get label() { return L('跟随系统', 'Follow system') } },
      { value: 'dark', get label() { return L('暗色', 'Dark') } },
      { value: 'light', get label() { return L('白色', 'Light') } },
    ]
    const TERM_KEEP = [
      { value: 5, get label() { return L('5 分钟', '5 minutes') } },
      { value: 10, get label() { return L('10 分钟', '10 minutes') } },
      { value: 30, get label() { return L('30 分钟', '30 minutes') } },
      { value: 60, get label() { return L('1 小时', '1 hour') } },
    ]
    const TERM_KEYS = ['keydown', 'keypress', 'keyup', 'paste', 'copy', 'cut']
    const RETRY_DELAYS = [1000, 2000, 4000]

    /** 连接地址：跟着页面走，http→ws，https→wss */
    function terminalUrl(origin, sessionId, cols, rows, extra = {}) {
      const url = new URL('/api-vps/ws/terminal', origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const q = new URLSearchParams({ sessionId, cols: String(cols), rows: String(rows) })
      for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
      q.set('lang', lang()) // 实时连接加不了请求头：终端里的提示照界面的语言说
      url.search = q.toString()
      return url.toString()
    }

    let xtermLoading = null

    function loadXterm() {
      if (xtermLoading) return xtermLoading
      const asset = (file) => `${window.location.origin}/api-vps/assets/${file}?v=${XTERM_VERSION}`
      // 必须等样式表加载完再建终端（实测）：样式没到时量出来的字符宽度不对，
      // 终端会按一两列打开，服务器那头的 shell 也按这个宽度折行
      const css = new Promise((resolve) => {
        try {
          if (document.querySelector('link[data-dsh-vps-xterm][data-loaded]')) return resolve()
          let link = document.querySelector('link[data-dsh-vps-xterm]')
          if (!link) {
            link = document.createElement('link')
            link.rel = 'stylesheet'
            link.href = asset('xterm.css')
            link.setAttribute('data-dsh-vps-xterm', '')
            document.head.appendChild(link)
          }
          const done = () => {
            link.setAttribute('data-loaded', '')
            resolve()
          }
          link.addEventListener('load', done, { once: true })
          link.addEventListener('error', () => resolve(), { once: true }) // 样式加载不了也能用，只是不好看
          setTimeout(resolve, 4000)
        } catch {
          resolve()
        }
      })
      xtermLoading = Promise.all([import(asset('xterm.mjs')), import(asset('addon-fit.mjs')), css])
        .then(([xterm, fit]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon }))
        .catch((error) => {
          xtermLoading = null // 下次点开再试
          throw error
        })
      return xtermLoading
    }

    function readTerminalHeight() {
      try {
        const n = Number(window.localStorage?.getItem(TERM_HEIGHT_KEY))
        return n >= 120 && n <= 2000 ? n : 300
      } catch {
        return 300
      }
    }

    // —— 终端设置：存在 host 的 hosts.yml，本地缓存一份让终端打开时立刻可用 ——

    function normalizeTermPrefs(raw) {
      const fontSize = Math.floor(Number(raw?.fontSize))
      const keep = Math.floor(Number(raw?.keepMinutes))
      return {
        theme: TERM_THEMES.some((t) => t.value === raw?.theme) ? raw.theme : 'system',
        fontSize: fontSize >= 11 && fontSize <= 20 ? fontSize : 13,
        keepMinutes: keep >= 1 && keep <= 1440 ? keep : 10,
      }
    }

    function readTermPrefs() {
      try {
        return normalizeTermPrefs(JSON.parse(window.localStorage?.getItem(TERM_PREFS_KEY) || 'null'))
      } catch {
        return normalizeTermPrefs(null)
      }
    }

    /** 设置变了：写缓存、通知界面、已经开着的终端立刻换字号和配色 */
    function writeTermPrefs(raw) {
      const prefs = normalizeTermPrefs(raw)
      try {
        window.localStorage?.setItem(TERM_PREFS_KEY, JSON.stringify(prefs))
      } catch {
        // 写不了就只在这次页面里生效
      }
      for (const entry of termStore.values()) applyPrefs(entry)
      try {
        window.dispatchEvent(new CustomEvent(TERM_PREFS_EVENT, { detail: prefs }))
      } catch {
        // 老浏览器没有 CustomEvent 构造器
      }
      return prefs
    }

    let prefsFetched = false
    function refreshTermPrefs() {
      if (prefsFetched) return
      prefsFetched = true
      api('terminal/prefs', {})
        .then((res) => writeTermPrefs(res.terminal))
        .catch(() => {
          prefsFetched = false
        })
    }

    function useTermPrefs() {
      const [prefs, setPrefs] = useState(() => readTermPrefs())
      useEffect(() => {
        const on = () => setPrefs(readTermPrefs())
        window.addEventListener(TERM_PREFS_EVENT, on)
        return () => window.removeEventListener(TERM_PREFS_EVENT, on)
      }, [])
      return prefs
    }

    // —— 跟 DSH 的主题走 ——
    //
    // 输入框下方那一栏是「居中排列」的弹性布局，里面的东西不写宽度就会缩到最窄（实测）。
    // DSH 自己的输入框卡片写的是「宽 100%、最大宽度 --dsh-composer-card-max-width」，照抄。
    // 插槽外层是 display:contents，不占布局，所以这里的宽度就是相对那一栏算的。
    const DOCK_WIDTH = {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 'var(--dsh-composer-card-max-width, 100%)',
    }

    // 颜色和字体全部取 DSH 主题变量（与输入框卡片同一套），深浅色切换时即时跟随。
    // DSH 没有终端专用的 16 色表：按深浅两套底色各调一份看得清的，蓝红绿用 DSH 自己的色值。
    const DS = {
      bg: 'var(--dsw-specific-input-major, var(--dsw-alias-bg-base, #fff))',
      text: 'var(--dsw-alias-label-primary, #0f1115)',
      secondary: 'var(--dsw-alias-label-secondary, #4b4f56)',
      tertiary: 'var(--dsw-alias-label-tertiary, #81858c)',
      border: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.1))',
      divider: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.04))',
      // 板块边框、填空框、分段按钮：和设置页同一套（见上面 T 的说明）
      edge: 'var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
      field: 'var(--dsw-alias-border-l4, rgba(0,0,0,0.16))',
      segTrack: 'var(--dsw-alias-markdown-code-segment-unselected, #f1f3f5)',
      segOn: 'var(--dsw-alias-markdown-code-segment-selected, #fff)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06))',
      tip: 'var(--dsw-specific-tip, rgba(127,127,127,0.08))',
      accent: 'var(--dsw-alias-state-business-primary, #4176e6)',
      ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
      danger: 'var(--dsw-alias-state-error-primary, #ec1313)',
      scrollbar: 'var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,0.3))',
      code: 'var(--ds-font-family-code, "SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei", monospace)',
      shadow: 'var(--dsw-elevation-soft, none)',
      selected: 'var(--dsw-alias-interactive-bg-selected, rgba(80,130,240,0.16))',
      // 「状态」页签：警告黄、各状态的浅底色、AI 解读框的浅蓝底（DSH 自己的状态色，深浅色跟着变）
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      okBg: 'var(--dsw-alias-state-success-tertiary, rgba(34,197,94,0.12))',
      warnBg: 'var(--dsw-alias-state-warn-tertiary, rgba(217,119,6,0.13))',
      dangerBg: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 11%, transparent)',
      infoBg: 'var(--dsw-alias-state-business-tertiary, rgba(65,118,230,0.09))',
      track: 'color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) 18%, transparent)',
    }

    const ANSI = {
      light: {
        black: '#0f1115', red: '#ec1313', green: '#1a7f37', yellow: '#9a6700',
        blue: '#4176e6', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
        brightBlack: '#57606a', brightRed: '#ef4444', brightGreen: '#22a355', brightYellow: '#b7791f',
        brightBlue: '#5686fe', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#81858c',
      },
      dark: {
        black: '#5e6168', red: '#f25a5a', green: '#4ed17e', yellow: '#e3b341',
        blue: '#679efe', magenta: '#bc8cff', cyan: '#39c5cf', white: '#d0d3d8',
        brightBlack: '#81858c', brightRed: '#ff8080', brightGreen: '#6fdd96', brightYellow: '#f0cc6b',
        brightBlue: '#8fb6ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f9fafb',
      },
    }

    function isDarkTheme() {
      try {
        return document.body.hasAttribute('data-ds-dark-theme')
      } catch {
        return false
      }
    }

    /** CSS 变量 → 具体颜色：xterm 画在 canvas 上，不认 var() */
    function resolveCss(anchor, property, value) {
      const probe = document.createElement('span')
      probe.style.display = 'none'
      probe.style[property] = value
      anchor.appendChild(probe)
      const out = window.getComputedStyle(probe)[property]
      probe.remove()
      return out
    }

    function withAlpha(color, alpha) {
      const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(color))
      return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : color
    }

    // 选了「暗色」或「白色」时不跟 DSH 走：用 DSH 那一套配色的具体值，面板和终端一起换
    const SCHEME = {
      light: {
        bg: '#ffffff', text: '#0f1115', secondary: '#4b4f56', tertiary: '#81858c',
        border: 'rgba(0,0,0,0.1)', divider: 'rgba(0,0,0,0.05)', hover: 'rgba(38,49,72,0.06)',
        tip: '#f5f6f7', accent: '#4176e6', ok: '#22c55e', danger: '#ec1313', scrollbar: 'rgba(0,0,0,0.12)',
        selected: 'rgba(65,118,230,0.12)',
        warn: '#d97706', okBg: 'rgba(34,197,94,0.12)', warnBg: 'rgba(217,119,6,0.12)', dangerBg: 'rgba(236,19,19,0.09)',
        infoBg: 'rgba(65,118,230,0.08)', track: 'rgba(0,0,0,0.07)',
        edge: 'rgba(0,0,0,0.12)', field: 'rgba(0,0,0,0.16)', segTrack: '#f1f3f5', segOn: '#ffffff',
      },
      dark: {
        bg: '#2c2c2e', text: '#f9fafb', secondary: '#d0d3d8', tertiary: '#adb2b8',
        border: 'rgba(255,255,255,0.12)', divider: 'rgba(255,255,255,0.06)', hover: 'rgba(255,255,255,0.08)',
        tip: '#353638', accent: '#679efe', ok: '#22c55e', danger: '#f25a5a', scrollbar: 'rgba(255,255,255,0.16)',
        selected: 'rgba(103,158,254,0.22)',
        warn: '#f5a524', okBg: 'rgba(34,197,94,0.16)', warnBg: 'rgba(245,165,36,0.16)', dangerBg: 'rgba(242,90,90,0.16)',
        infoBg: 'rgba(103,158,254,0.13)', track: 'rgba(255,255,255,0.10)',
        edge: 'rgba(255,255,255,0.16)', field: 'rgba(255,255,255,0.2)', segTrack: '#1b1b1c', segOn: '#353638',
      },
    }

    /** 面板用的颜色：跟随系统 = DSH 主题变量；暗色 / 白色 = 固定值 */
    function termChrome(theme) {
      return theme === 'dark' || theme === 'light' ? { ...DS, ...SCHEME[theme] } : DS
    }

    function termIsDark(theme) {
      return theme === 'dark' ? true : theme === 'light' ? false : isDarkTheme()
    }

    /** xterm 的配色（它画在 canvas 上，颜色要换成具体值） */
    function terminalTheme(anchor, theme = 'system') {
      const c = termChrome(theme)
      const dark = termIsDark(theme)
      const color = (v) => resolveCss(anchor, 'color', v)
      const background = color(c.bg)
      const accent = color(c.accent)
      return {
        ...(dark ? ANSI.dark : ANSI.light),
        background,
        foreground: color(c.text),
        cursor: accent,
        cursorAccent: background,
        selectionBackground: withAlpha(accent, dark ? 0.4 : 0.25),
        scrollbarSliderBackground: color(c.scrollbar),
        scrollbarSliderHoverBackground: withAlpha(color(c.tertiary), 0.5),
        scrollbarSliderActiveBackground: withAlpha(color(c.tertiary), 0.7),
      }
    }

    // —— 每个对话一个常驻终端 ——

    const termStore = new Map() // 对话 id → 终端

    function termEmit(entry) {
      entry.version += 1
      try {
        window.dispatchEvent(new CustomEvent(TERM_EVENT, { detail: { sessionId: entry.sessionId } }))
      } catch {
        // 老浏览器没有 CustomEvent 构造器
      }
    }

    /** 头部按钮、输入框下方都订阅同一个对话的终端状态 */
    function useTermState(sessionId) {
      const [, force] = useState(0)
      useEffect(() => {
        const on = (e) => {
          if (e?.detail?.sessionId === sessionId) force((n) => n + 1)
        }
        window.addEventListener(TERM_EVENT, on)
        return () => window.removeEventListener(TERM_EVENT, on)
      }, [sessionId])
      return termStore.get(sessionId) ?? null
    }

    /** 不在屏幕上的终端放这里：页面外、但有尺寸，xterm 照常接收输出 */
    let termHolderEl = null
    function termHolder() {
      if (termHolderEl?.isConnected) return termHolderEl
      termHolderEl = document.createElement('div')
      termHolderEl.setAttribute('data-dsh-vps-terminal-holder', '')
      Object.assign(termHolderEl.style, {
        position: 'fixed', left: '-10000px', top: '0', width: '900px', height: '320px',
        overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none',
      })
      document.body.appendChild(termHolderEl)
      return termHolderEl
    }

    // 刷新页面后按记下的会话 id 接回（服务器那头还保留着的话）
    function saveResume(entry) {
      try {
        if (!entry.id) return
        window.localStorage?.setItem(TERM_RESUME_PREFIX + entry.sessionId,
          JSON.stringify({ id: entry.id, alias: entry.alias, view: entry.view }))
      } catch {
        // 写不了就只是刷新后接不回
      }
    }

    function clearResume(sessionId) {
      try {
        window.localStorage?.removeItem(TERM_RESUME_PREFIX + sessionId)
      } catch {
        // 无所谓
      }
    }

    function readResume(sessionId) {
      try {
        const raw = JSON.parse(window.localStorage?.getItem(TERM_RESUME_PREFIX + sessionId) || 'null')
        return raw && typeof raw.id === 'string' && typeof raw.alias === 'string' ? raw : null
      } catch {
        return null
      }
    }

    function createEntry(sessionId, alias, view) {
      const el = document.createElement('div')
      el.style.width = '100%'
      el.style.height = '100%'
      // xterm.js 借用 VS Code 的滚动阴影，默认黑色，贴着终端四边画出细灰线（实测）
      el.style.setProperty('--vscode-scrollbar-shadow', 'transparent')
      termHolder().appendChild(el)
      const entry = {
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sessionId, alias, view,
        restoreView: 'normal', // 最小化前是普通还是最大化
        status: 'loading', note: '',
        id: null, received: 0, startedAt: Date.now(),
        term: null, fit: null, socket: null, el,
        ended: false, closedByUs: false, retries: 0, retryTimer: null, themeObserver: null,
        version: 0,
      }
      termStore.set(sessionId, entry)
      return entry
    }

    /** 面板里切「终端」「文件」「状态」：终端一直在后台跑，切回来接着用 */
    function setTab(entry, tab) {
      entry.tab = tab
      if (tab === 'files') entry.filesOpened = true
      if (tab === 'status') entry.statusOpened = true
      termEmit(entry)
      if (tab === 'terminal') {
        setTimeout(() => {
          try {
            entry.fit?.fit()
            entry.term?.focus()
          } catch {
            // 终端已经销毁
          }
        }, 80)
      }
    }

    function setView(entry, view) {
      if (view === 'minimized' && entry.view !== 'minimized') entry.restoreView = entry.view
      entry.view = view
      saveResume(entry)
      termEmit(entry)
    }

    function applyPrefs(entry) {
      if (!entry.term) return
      const prefs = readTermPrefs()
      try {
        entry.term.options.fontSize = prefs.fontSize
        entry.term.options.theme = terminalTheme(entry.el, prefs.theme)
        if (entry.el.parentElement !== termHolderEl) entry.fit?.fit()
      } catch {
        // 终端已经销毁
      }
    }

    function sendTerm(entry, data) {
      if (entry.socket?.readyState === 1) entry.socket.send(JSON.stringify(data))
    }

    /** 建 xterm 并连上。resume：接回服务器上还留着的会话 */
    /** 等面板把终端挂上（React 的副作用在下一帧才跑），最小化着的就不等 */
    function whenPlaced(entry) {
      return new Promise((resolve) => {
        const started = Date.now()
        const check = () => {
          if (entry.disposed || entry.view === 'minimized' || entry.el.parentElement !== termHolderEl || Date.now() - started > 300) return resolve()
          requestAnimationFrame(check)
        }
        check()
      })
    }

    function startTerm(entry, resume) {
      loadXterm().then(async (mods) => {
        await whenPlaced(entry)
        return mods
      }).then(({ Terminal, FitAddon }) => {
        if (entry.disposed) return
        const prefs = readTermPrefs()
        const term = new Terminal({
          cursorBlink: true,
          fontSize: prefs.fontSize,
          fontFamily: resolveCss(entry.el, 'fontFamily', DS.code) || 'monospace',
          scrollback: 5000,
          theme: terminalTheme(entry.el, prefs.theme),
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(entry.el)
        entry.term = term
        entry.fit = fit
        if (entry.el.parentElement !== termHolderEl) {
          try {
            fit.fit()
          } catch {
            // 容器还没尺寸
          }
        }
        // Windows / Linux 的习惯：选中了文字时 Ctrl+C 是复制（没选中才是中断），Ctrl+Shift+C 也复制。
        // Mac 用 ⌘C，不走这里。粘贴（Ctrl+V / ⌘V）浏览器本来就会交给终端
        if (!/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '')) {
          term.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 'c') return true
            if (!e.shiftKey && !term.hasSelection()) return true
            const text = term.getSelection()
            if (text) navigator.clipboard?.writeText(text).catch(() => {})
            term.clearSelection()
            e.preventDefault()
            return false
          })
        }
        term.onData((data) => sendTerm(entry, { t: 'i', d: data }))
        term.onResize(({ cols, rows }) => sendTerm(entry, { t: 'r', cols, rows }))
        // DSH 切换深浅色：改的是 body 上的属性和变量。只有「跟随系统」才需要跟
        entry.themeObserver = new MutationObserver(() => {
          if (readTermPrefs().theme === 'system') applyPrefs(entry)
        })
        entry.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
        connectTerm(entry, resume)
      }).catch((error) => {
        if (entry.disposed) return
        entry.status = 'closed'
        entry.note = L(`终端组件加载失败：${error?.message ?? error}`, `The terminal component failed to load: ${error?.message ?? error}`)
        termEmit(entry)
      })
    }

    function connectTerm(entry, resume) {
      const token = window.__DSH_VPS_TOKEN__ || ''
      if (!token) {
        entry.status = 'closed'
        entry.note = L('页面里没有 VPS 管理的令牌：刷新页面再试', 'The page has no VPS Manager token: reload the page and try again')
        termEmit(entry)
        return
      }
      const term = entry.term
      const extra = resume ? { resume: resume.id, since: resume.since, resumeOnly: resume.only ? 1 : '' } : {}
      entry.status = entry.status === 'reconnecting' ? 'reconnecting' : 'connecting'
      entry.closedByUs = false
      termEmit(entry)
      let socket
      try {
        socket = new WebSocket(terminalUrl(window.location.origin, entry.sessionId, term.cols, term.rows, extra), [TERMINAL_PROTOCOL, token])
      } catch (error) {
        entry.status = 'closed'
        entry.note = L(`连不上终端服务：${error.message}`, `Cannot reach the terminal service: ${error.message}`)
        termEmit(entry)
        return
      }
      socket.binaryType = 'arraybuffer'
      entry.socket = socket
      let finished = false // 服务器明确说了结果（结束 / 没了 / 让位），不用自动重连
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          const bytes = new Uint8Array(event.data)
          entry.received += bytes.length
          term.write(bytes)
          return
        }
        let msg = null
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg?.t === 'ready') {
          if (msg.resizable) setReach(entry.alias, { state: 'ok', hint: '', at: new Date().toISOString() })
          entry.id = msg.id
          entry.received = Number(msg.offset) || 0
          entry.status = 'open'
          entry.note = ''
          entry.retries = 0
          saveResume(entry)
          termEmit(entry)
          if (entry.view !== 'minimized') term.focus()
        } else if (msg?.t === 'error') {
          entry.note = msg.message || L('终端出错了', 'The terminal ran into an error')
          termEmit(entry)
        } else if (msg?.t === 'exit') {
          if (msg.code === 255 && msg.hint) setReach(entry.alias, { state: 'fail', hint: msg.hint, at: new Date().toISOString() })
          finished = true
          entry.ended = true
          entry.note = msg.hint ? L(`连接断开：${msg.hint}`, `Disconnected: ${msg.hint}`) : msg.code === 0 ? L('已退出', 'Exited') : L(`连接断开（退出码 ${msg.code ?? msg.signal}）`, `Disconnected (exit code ${msg.code ?? msg.signal})`)
          clearResume(entry.sessionId)
          termEmit(entry)
        } else if (msg?.t === 'gone') {
          finished = true
          entry.ended = true
          entry.id = null
          clearResume(entry.sessionId)
          if (entry.view === 'minimized') {
            disposeEntry(entry) // 最小化着的终端已经没了：横栏也不留
            return
          }
          entry.note = L('上次的终端已经结束了（断开超过保留时间）。点「重新连接」开一个新的', 'The previous terminal has ended (it was disconnected longer than the keep time). Click "Reconnect" to open a new one')
          termEmit(entry)
        } else if (msg?.t === 'taken') {
          finished = true
          entry.note = L('这个终端在别的窗口打开了', 'This terminal was opened in another window')
          termEmit(entry)
        }
      }
      socket.onclose = () => {
        if (entry.disposed || entry.socket !== socket) return
        entry.socket = null
        // 意外断开（网络抖、DSH 重启中）：服务器还留着会话，自动接回几次
        if (!finished && !entry.closedByUs && entry.id && entry.retries < RETRY_DELAYS.length) {
          entry.status = 'reconnecting'
          termEmit(entry)
          const delay = RETRY_DELAYS[entry.retries]
          entry.retries += 1
          // 只接回，不新开：服务器那头已经没了（比如 DSH 重启过）就如实告诉用户，
          // 不能悄悄开一个新 shell 接在旧屏幕后面
          entry.retryTimer = setTimeout(() => {
            if (!entry.disposed) connectTerm(entry, { id: entry.id, since: entry.received, only: true })
          }, delay)
          return
        }
        entry.status = 'closed'
        if (!entry.note) entry.note = entry.id ? L('连接断开了，点「重新连接」接回', 'Disconnected. Click "Reconnect" to resume') : L('连不上终端服务：可能是登录过期或 DSH 刚重启过，刷新页面再试', 'Cannot reach the terminal service: the login may have expired or DSH just restarted; reload the page and try again')
        try {
          term.write(L('\r\n\x1b[2m[连接已断开]\x1b[0m\r\n', '\r\n\x1b[2m[disconnected]\x1b[0m\r\n'))
        } catch {
          // 终端已经销毁
        }
        termEmit(entry)
      }
    }

    /** 打开这个对话的终端：已有就恢复显示，没有就新开 */
    function openTerminal(sessionId, alias) {
      let entry = termStore.get(sessionId)
      if (entry && entry.alias !== alias) {
        endTerminal(sessionId, { confirm: false })
        entry = null
      }
      if (entry) {
        setView(entry, entry.view === 'minimized' ? entry.restoreView : entry.view)
        return entry
      }
      refreshTermPrefs()
      entry = createEntry(sessionId, alias, 'normal')
      termEmit(entry)
      startTerm(entry, null)
      return entry
    }

    /** 刷新页面后：服务器上还留着就接回，已经没了就什么都不做 */
    function restoreTerminal(sessionId, alias) {
      if (termStore.has(sessionId)) return
      const saved = readResume(sessionId)
      if (!saved) return
      if (saved.alias !== alias) {
        clearResume(sessionId)
        return
      }
      refreshTermPrefs()
      const view = ['normal', 'minimized', 'maximized'].includes(saved.view) ? saved.view : 'normal'
      const entry = createEntry(sessionId, alias, view)
      entry.id = saved.id
      entry.status = 'reconnecting'
      termEmit(entry)
      startTerm(entry, { id: saved.id, since: 0, only: true })
    }

    /** 重新连接：服务器上还留着就接回，没了就开个新的 */
    function reconnectTerminal(entry) {
      clearTimeout(entry.retryTimer)
      entry.retries = 0
      entry.note = ''
      if (entry.ended || !entry.id) {
        entry.ended = false
        entry.id = null
        entry.received = 0
        entry.startedAt = Date.now()
        try {
          entry.term?.write(L('\r\n\x1b[2m[新的终端]\x1b[0m\r\n', '\r\n\x1b[2m[new terminal]\x1b[0m\r\n'))
        } catch {
          // 终端已经销毁
        }
        connectTerm(entry, null)
      } else {
        // 先试着接回；已经没了会收到 gone，再点一次就开新的
        connectTerm(entry, { id: entry.id, since: entry.received, only: true })
      }
    }

    function disposeEntry(entry) {
      entry.disposed = true
      clearTimeout(entry.retryTimer)
      entry.themeObserver?.disconnect()
      try {
        entry.closedByUs = true
        entry.socket?.close()
      } catch {
        // 已经关了
      }
      try {
        entry.term?.dispose()
      } catch {
        // 已经销毁
      }
      entry.el.remove()
      if (termStore.get(entry.sessionId) === entry) termStore.delete(entry.sessionId)
      clearResume(entry.sessionId)
      termEmit(entry)
    }

    /** 结束（红色 ×）：服务器上的 shell 一起结束 */
    function endTerminal(sessionId, { confirm = true } = {}) {
      const entry = termStore.get(sessionId)
      if (!entry) return
      if (confirm && entry.status === 'open' && typeof window.confirm === 'function'
        && !window.confirm(L('结束这个终端？服务器上的 shell 和里面正在跑的程序会一起结束。', 'End this terminal? The shell on the server and anything running in it will end too.'))) return
      sendTerm(entry, { t: 'end' })
      disposeEntry(entry)
    }

    /** 顶部 >_ 仍是开关：没开 → 打开；开着 → 最小化；最小化 → 恢复 */
    function toggleTerminal(sessionId, alias) {
      const entry = termStore.get(sessionId)
      if (!entry || entry.alias !== alias) return openTerminal(sessionId, alias)
      if (entry.view === 'minimized') setView(entry, entry.restoreView)
      else setView(entry, 'minimized')
      return entry
    }

    function minutesSince(ts) {
      const m = Math.floor((Date.now() - ts) / 60000)
      if (m < 1) return L('刚打开', 'just opened')
      if (m < 60) return L(`已开 ${m} 分钟`, `open ${m} min`)
      return L(`已开 ${Math.floor(m / 60)} 小时 ${m % 60} 分钟`, `open ${Math.floor(m / 60)} h ${m % 60} min`)
    }

    const STATUS_TEXT = { get loading() { return L('加载中…', 'Loading…') }, get connecting() { return L('连接中…', 'Connecting…') }, get reconnecting() { return L('重新连接中…', 'Reconnecting…') }, get open() { return L('已连接', 'Connected') }, get closed() { return L('已断开', 'Disconnected') } }

    // —— 红黄绿三个圆按钮 ——
    const LIGHTS = {
      close: { color: '#ff5f57', ring: '#e0443e', icon: 'M3.5 3.5l5 5M8.5 3.5l-5 5' },
      minimize: { color: '#febc2e', ring: '#dea123', icon: 'M3 6h6' },
      maximize: { color: '#28c840', ring: '#1aab29', icon: 'M3.5 6h5M6 3.5v5' },
      restore: { color: '#28c840', ring: '#1aab29', icon: 'M3.5 8.5l2-2M8.5 3.5l-2 2M3.5 6.5v2h2M8.5 5.5v-2h-2' },
    }

    function Light({ kind, title, onClick }) {
      const l = LIGHTS[kind]
      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        'data-vps-light': kind,
        onClick: (e) => {
          e.stopPropagation()
          onClick()
        },
        style: {
          width: 13, height: 13, padding: 0, borderRadius: '50%', flex: '0 0 auto',
          border: `0.5px solid ${l.ring}`, background: l.color, cursor: 'pointer',
          display: 'grid', placeItems: 'center',
        },
      }, h('svg', { width: 9, height: 9, viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', { d: l.icon, stroke: 'rgba(0,0,0,0.55)', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' })))
    }

    function Lights({ entry }) {
      const maximized = entry.view === 'maximized'
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 7, marginLeft: 4 } },
        h(Light, { kind: 'close', title: L('结束这个终端（服务器上的 shell 一起结束）', 'End this terminal (the shell on the server ends too)'), onClick: () => endTerminal(entry.sessionId) }),
        h(Light, {
          kind: 'minimize',
          title: entry.view === 'minimized' ? L('恢复', 'Restore') : L('最小化：缩成输入框下方的一条横栏，终端在后台继续运行', 'Minimize to a bar below the input box; the terminal keeps running in the background'),
          onClick: () => setView(entry, entry.view === 'minimized' ? entry.restoreView : 'minimized'),
        }),
        h(Light, {
          kind: maximized ? 'restore' : 'maximize',
          title: maximized ? L('恢复原来的大小', 'Restore the previous size') : L('最大化：终端撑满对话区，输入框移到最上面', 'Maximize: the terminal fills the conversation area and the input box moves to the top'),
          onClick: () => setView(entry, maximized ? 'normal' : 'maximized'),
        }))
    }

    /** 最大化时终端区域的高度：对话区高度减去输入框和边距，输入框就被推到最上面 */
    function maximizedHeight(panel) {
      let node = panel?.parentElement
      let area = null
      while (node && node !== document.body) {
        const oy = window.getComputedStyle(node).overflowY
        if (oy === 'auto' || oy === 'scroll') {
          area = node
          break
        }
        node = node.parentElement
      }
      const areaHeight = area ? area.clientHeight : window.innerHeight
      const dock = panel?.closest?.('[data-slot="conversation.composer.dock"]')
      const card = dock?.previousElementSibling
      const cardHeight = card ? card.getBoundingClientRect().height : 140
      return Math.max(200, Math.floor(areaHeight - cardHeight - 34 - 48))
    }

    /** 展开的终端（普通 / 最大化） */
    /** 终端面板标题栏上的「终端 | 文件 | 状态」：和设置页的分段按钮同一个样子 */
    function PanelTabs({ entry, tab, c }) {
      const segColors = { track: c.segTrack, on: c.segOn, edge: c.edge, text: c.text, idle: c.secondary }
      return h('span', {
        role: 'tablist',
        style: seg.track(segColors, { marginLeft: 6 }),
        onDoubleClick: (e) => e.stopPropagation(),
      }, [['terminal', 'terminal', L('终端', 'Terminal')], ['files', 'folder', L('文件', 'Files')], ['status', 'activity', L('状态', 'Status')]].map(([key, icon, label]) => {
        const on = tab === key
        return h('button', {
          key,
          type: 'button',
          role: 'tab',
          'aria-selected': on,
          onClick: (e) => {
            e.stopPropagation()
            if (!on) setTab(entry, key)
          },
          ...seg.hover(segColors, on),
          style: seg.item(segColors, on, { height: 22, padding: '0 9px 0 8px', fontSize: 12 }),
        }, h(Icon, { name: icon, size: 12, style: { opacity: on ? 0.9 : 0.7 } }), label)
      }))
    }

    function TerminalPanel({ entry, prefs }) {
      const rowRef = useOwnRow() // 每次渲染都确认一次：DSH 换布局/重挂载也不会又挤回去
      const panelRef = useRef(null)
      const boxRef = useRef(null)
      const [maxHeight, setMaxHeight] = useState(0)
      const c = termChrome(prefs.theme)
      const maximized = entry.view === 'maximized'

      // 把常驻的终端挂进来；卸下时放回页面外，不销毁
      useEffect(() => {
        const box = boxRef.current
        if (!box) return undefined
        box.appendChild(entry.el)
        const stop = (e) => e.stopPropagation()
        for (const type of TERM_KEYS) box.addEventListener(type, stop)
        let fitTimer = null
        const refit = () => {
          clearTimeout(fitTimer)
          fitTimer = setTimeout(() => {
            try {
              // 高度从外层量：终端页和文件页共用一块，拖哪一页都记住
              if (entry.view === 'normal') {
                const height = Math.round((box.parentElement ?? box).getBoundingClientRect().height)
                if (height >= 120) window.localStorage?.setItem(TERM_HEIGHT_KEY, String(height))
              }
              if (box.offsetWidth > 0) entry.fit?.fit() // 在文件页时终端看不见，不量
            } catch {
              // 量不到尺寸
            }
          }, 60)
        }
        refit()
        if (entry.term && entry.status === 'open' && (entry.tab ?? 'terminal') === 'terminal') entry.term.focus()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null
        observer?.observe(box)
        if (box.parentElement) observer?.observe(box.parentElement)
        return () => {
          clearTimeout(fitTimer)
          observer?.disconnect()
          for (const type of TERM_KEYS) box.removeEventListener(type, stop)
          if (entry.el.parentElement === box && !entry.disposed) termHolder().appendChild(entry.el)
        }
      }, [entry])

      // 最大化：跟着窗口大小算高度
      useEffect(() => {
        if (!maximized) return undefined
        const measure = () => setMaxHeight(maximizedHeight(panelRef.current))
        measure()
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [maximized])

      const textBtn = (label, onClick, title) => h('button', {
        type: 'button',
        onClick,
        title,
        onMouseEnter: (e) => { e.currentTarget.style.background = c.hover },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
        style: {
          border: 'none', background: 'transparent', color: c.secondary, borderRadius: 8,
          padding: '0 8px', height: 24, fontSize: 12, fontWeight: 500, cursor: 'pointer',
        },
      }, label)

      const dotColor = entry.status === 'open' ? c.ok : entry.status === 'closed' ? c.danger : c.tertiary
      const tab = entry.tab ?? 'terminal'
      const boxHeight = maximized ? (maxHeight || maximizedHeight(panelRef.current)) : readTerminalHeight()

      return dockRow(rowRef, h('div', {
        ref: panelRef,
        'data-vps-terminal-panel': entry.view,
        style: {
          ...DOCK_WIDTH, marginTop: 8, borderRadius: 16, overflow: 'hidden',
          background: c.bg, color: c.text, border: `0.5px solid ${c.border}`, boxShadow: c.shadow,
        },
      },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 12px 0 14px',
            borderBottom: `0.5px solid ${c.divider}`, fontSize: 13,
          },
          onDoubleClick: () => setView(entry, maximized ? 'normal' : 'maximized'),
        },
          h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: dotColor, flex: '0 0 auto' } }),
          h('span', { style: { fontWeight: 500 } }, entry.alias),
          h('span', { style: { color: c.tertiary, fontSize: 12 } }, STATUS_TEXT[entry.status] ?? ''),
          h(PanelTabs, { entry, tab, c }),
          h('span', { style: { flex: 1 } }),
          entry.status === 'closed' ? textBtn(L('重新连接', 'Reconnect'), () => reconnectTerminal(entry), entry.ended ? L('开一个新的 shell', 'Open a new shell') : L('接回服务器上的这个终端', 'Resume this terminal on the server')) : null,
          h(Lights, { entry })),
        entry.note && tab === 'terminal' ? h('div', { style: { padding: '6px 14px', fontSize: 12, color: c.secondary, background: c.tip } }, entry.note) : null,
        h('div', {
          style: {
            height: boxHeight,
            minHeight: 120,
            maxHeight: maximized ? 'none' : '80vh',
            resize: maximized ? 'none' : 'vertical', // 普通大小时右下角拖高度；宽度跟着输入框走
            overflow: 'hidden',
            boxSizing: 'border-box',
          },
        },
          h('div', {
            ref: boxRef,
            style: { display: tab === 'terminal' ? 'block' : 'none', height: '100%', padding: '6px 4px 4px 12px', boxSizing: 'border-box' },
          }),
          // 文件页第一次打开后就一直挂着（隐藏而不卸载）：上传进度、编辑中的内容切回终端也不丢
          entry.filesOpened ? h('div', { style: { display: tab === 'files' ? 'block' : 'none', height: '100%' } }, h(FileBrowser, { entry, c })) : null,
          // 状态页同理：第一次打开后一直挂着，切走再回来还是上次看到的样子
          entry.statusOpened ? h('div', { style: { display: tab === 'status' ? 'block' : 'none', height: '100%' } }, h(StatusView, { entry, c, maximized, visible: tab === 'status' })) : null)))
    }

    /** 最小化后的横栏：在输入框下方，点它恢复 */
    function TerminalBar({ entry, prefs }) {
      const barRef = useOwnRow()
      const [, tick] = useState(0)
      useEffect(() => {
        const t = setInterval(() => tick((n) => n + 1), 30_000)
        return () => clearInterval(t)
      }, [])
      const c = termChrome(prefs.theme)
      const running = entry.status === 'open'
      const text = running
        ? L(`终端在后台运行 · ${minutesSince(entry.startedAt)}`, `Terminal running in the background · ${minutesSince(entry.startedAt)}`)
        : entry.status === 'closed' ? L('终端已断开', 'Terminal disconnected') : STATUS_TEXT[entry.status] ?? ''
      return dockRow(barRef, h('div', {
        'data-vps-terminal-bar': '',
        role: 'button',
        title: L('点这里恢复终端', 'Click here to restore the terminal'),
        onClick: () => setView(entry, entry.restoreView),
        style: {
          ...DOCK_WIDTH, marginTop: 8, height: 34, borderRadius: 12, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 14px',
          background: c.bg, color: c.text, border: `0.5px solid ${c.border}`, boxShadow: c.shadow, fontSize: 13,
        },
      },
        h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: running ? c.ok : c.tertiary, flex: '0 0 auto' } }),
        h('span', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, fontWeight: 600, color: c.tertiary } }, entry.tab === 'files' ? L('文件', 'Files') : entry.tab === 'status' ? L('状态', 'Status') : '>_'),
        h('span', { style: { fontWeight: 500 } }, entry.alias),
        h('span', { style: { color: c.tertiary, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, text),
        h('span', { style: { flex: 1 } }),
        h('span', { style: { color: c.tertiary, fontSize: 12 } }, L('点击恢复', 'Click to restore')),
        h(Lights, { entry })))
    }

    // ——————————————————————— 「状态」页签 ———————————————————————
    // 这台机器现在怎么样、哪些要紧：插件一次 SSH 看一遍，规则判出「需注意」（零 token），
    // 点「让 AI 解读」才调模型。设计见 工作流/dsh-vps-manager-状态页签设计.md。
    // 页签第一次打开后一直挂着（隐藏不卸载）；状态挂在 entry.statusState 上，最小化再恢复也还在。
    // 图标路径取自 Lucide（ISC 许可），只用到几个，内联，不引图标库。

    const ICONS = {
      refresh: [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }], ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }], ['path', { d: 'M8 16H3v5' }]],
      sparkles: [['path', { d: 'M9.94 15.5a2 2 0 0 0-1.44-1.44l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94a2 2 0 0 0 1.44-1.44l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5a2 2 0 0 0 1.44 1.44l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z' }]],
      chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
      check: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm9 12 2 2 4-4' }]],
      terminal: [['polyline', { points: '4 17 10 11 4 5' }], ['line', { x1: 12, x2: 20, y1: 19, y2: 19 }]],
      folder: [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
      activity: [['path', { d: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2' }]],
      alert: [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
    }
    function Icon({ name, size = 14, style }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: '0 0 auto', ...style },
      }, ICONS[name].map(([tag, attrs], i) => h(tag, { key: i, ...attrs })))
    }

    const NUM = { fontVariantNumeric: 'tabular-nums', fontFeatureSettings: '"tnum" 1' }
    const levelColor = (c, level) => (level === 'danger' ? c.danger : level === 'warn' ? c.warn : level === 'ok' ? c.ok : c.tertiary)
    const levelBg = (c, level) => (level === 'danger' ? c.dangerBg : level === 'warn' ? c.warnBg : level === 'ok' ? c.okBg : c.track)
    const pctLevel = (pct, warn = 85, danger = 95) => (pct >= danger ? 'danger' : pct >= warn ? 'warn' : 'ok')

    /** 秒数说成人话：12 天 3 小时 / 5 小时 20 分 */
    function fmtUptime(sec) {
      if (!Number.isFinite(sec)) return ''
      const d = Math.floor(sec / 86400)
      const hr = Math.floor((sec % 86400) / 3600)
      const m = Math.floor((sec % 3600) / 60)
      if (d) return L(`${d} 天${hr ? ` ${hr} 小时` : ''}`, `${d}d${hr ? ` ${hr}h` : ''}`)
      if (hr) return L(`${hr} 小时 ${m} 分`, `${hr}h ${m}m`)
      return L(`${m} 分钟`, `${m} min`)
    }
    const fmtClock = (iso) => {
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    /**
     * 替用户在对话里发一句（同「让 AI 看看这个文件」）。
     * @returns 'sent' 发出去了；'draft' 输入框里有没发的话，没动；'none' 拿不到输入框
     */
    async function sendToChat(sessionId, text) {
      const input = composerFor(sessionId)
      if (!input) return 'none'
      if (composerDraft(input)) return 'draft'
      // 同一句话已经在排队就不再排一条：AI 忙着时连点几下，会留下一串重复的排队消息
      if (queuedTexts(input).includes(text.trim())) return 'queued'
      input.setDraft(text)
      // 输入框更新是异步的：等它收到这句话再发，不然发出去的是空的
      for (let i = 0; i < 20 && !composerDraft(input); i += 1) await new Promise((r) => setTimeout(r, 25))
      if (!composerDraft(input)) {
        input.focus?.()
        return 'none'
      }
      await input.submit('queue')
      return 'sent'
    }

    /** 从别的页签跳到文件页的某个目录（或回收站） */
    function openInFiles(entry, { path, trash = false } = {}) {
      if (!entry.files) entry.files = { cwd: '', back: [], fwd: [], hidden: false, view: 'dir', sort: 'name', desc: false }
      const st = entry.files
      if (trash) st.view = 'trash'
      else {
        if (st.cwd && st.cwd !== path) {
          st.back.push(st.cwd)
          st.fwd = []
        }
        st.cwd = path
        st.view = 'dir'
      }
      entry.filesGoto = Date.now()
      setTab(entry, 'files')
    }

    /** 一项「需注意」或「正常」说成人话：名字 + 一句说明（采集只给类型和数字，句子在这里拼） */
    function describeItem(item) {
      const days = item.days
      switch (item.type) {
        case 'svc_failed': return { name: item.name, detail: L('服务运行失败', 'service failed') }
        case 'svc_down': return { name: item.name, detail: L('设了开机自启，但没在运行', 'enabled at boot, but not running') }
        case 'timer_failed': return { name: item.name, detail: L('定时任务上次运行失败', 'last scheduled run failed') }
        case 'ctr_exited': return { name: item.name, detail: L('容器已退出，不会自动重启', 'container exited and will not restart'), raw: item.status }
        case 'ctr_restarting': return { name: item.name, detail: L('容器在反复重启', 'container keeps restarting'), raw: item.status }
        case 'disk': return { name: L(`磁盘 ${item.mount}`, `Disk ${item.mount}`), detail: L(`已用 ${item.pct}% · 剩 ${fmtBytes(item.avail)}`, `${item.pct}% used · ${fmtBytes(item.avail)} free`), pct: item.pct }
        case 'inode': return { name: L(`inode ${item.mount}`, `Inodes ${item.mount}`), detail: L(`已用 ${item.pct}%（小文件太多）`, `${item.pct}% used (too many small files)`), pct: item.pct }
        case 'mem': return { name: L('内存', 'Memory'), detail: L(`只剩 ${item.availPct}% 可用（${fmtBytes(item.avail)}）`, `only ${item.availPct}% available (${fmtBytes(item.avail)})`), pct: 100 - item.availPct }
        case 'swap': return { name: 'Swap', detail: L(`已用 ${item.usedPct}%`, `${item.usedPct}% used`), pct: item.usedPct }
        case 'load': return { name: L('负载', 'Load'), detail: L(`${item.load} · ${item.cores} 核`, `${item.load} on ${item.cores} cores`) }
        case 'cert': return {
          name: item.name,
          detail: days < 0 ? L(`证书已过期 ${-days} 天`, `certificate expired ${-days} days ago`) : days === 0 ? L('证书今天到期', 'certificate expires today') : L(`证书还有 ${days} 天到期`, `certificate expires in ${days} days`),
        }
        case 'reboot': return { name: L('需要重启', 'Reboot required'), detail: L('有更新要重启才生效，可以发 /vps-reboot 先检查', 'updates take effect after a reboot; to check first, use /vps-reboot') }
        case 'updates_sec': return { name: L('安全更新', 'Security updates'), detail: L(`${item.count} 个待装`, `${item.count} pending`) }
        case 'login_fail': return { name: L('登录失败', 'Failed logins'), detail: L(`24 小时 ${item.count} 次，没有 fail2ban`, `${item.count} in 24 h, no fail2ban`) }
        default: return { name: item.type, detail: '' }
      }
    }

    /** 「其余正常」那一行里每一项的短名字 */
    function okChip(item) {
      switch (item.type) {
        case 'mem': return L('内存', 'Memory')
        case 'swap': return 'Swap'
        case 'load': return L('负载', 'Load')
        case 'disks': return L('磁盘', 'Disks')
        case 'services': return item.level === 'na' ? L('服务', 'Services') : L(`服务 ${item.running}`, `${item.running} services`)
        case 'containers': return item.level === 'na' ? L('容器', 'Containers') : L(`容器 ${item.running}`, `${item.running} containers`)
        case 'certs': return L(`证书 ${item.count}`, `${item.count} certs`)
        case 'updates_sec': return L('安全更新', 'Security updates')
        case 'login_fail': return L('登录', 'Logins')
        case 'firewall': return item.level === 'na' ? L('防火墙', 'Firewall') : item.fwType === 'none' ? L('无防火墙', 'No firewall') : item.fwType
        default: return item.type
      }
    }

    /** 细用量条：4px 高，按阈值变色；正常时用强调色 */
    function UsageBar({ c, pct, level, width = '100%' }) {
      const v = Math.max(0, Math.min(100, Number(pct) || 0))
      const color = level === 'danger' ? c.danger : level === 'warn' ? c.warn : c.accent
      return h('span', { style: { display: 'block', width, height: 4, borderRadius: 2, background: c.track, overflow: 'hidden', flex: width === '100%' ? '1 1 auto' : '0 0 auto' } },
        h('span', { style: { display: 'block', width: `${v}%`, height: '100%', borderRadius: 2, background: color, transition: 'width .3s ease-out' } }))
    }

    function StatusView({ entry, c, maximized, visible }) {
      const sessionId = entry.sessionId
      if (!entry.statusState) entry.statusState = { view: null, loading: false, error: '', expanded: false, interpreting: false, interpError: '', notice: '' }
      const st = entry.statusState
      const [, rerender] = useState(0)
      const bump = () => rerender((n) => n + 1)
      const loadingSecs = useElapsed(st.loading)
      const aiSecs = useElapsed(st.interpreting)
      const view = st.view
      const status = view?.status
      const data = status?.data
      const judged = status?.judged
      const alias = entry.alias

      async function collect() {
        if (st.loading) return
        st.loading = true
        st.error = ''
        bump()
        try {
          const res = await api('status/collect', { sessionId }, { timeoutMs: 90_000 })
          st.view = res.status ? res : { ...(st.view ?? {}), ...res, status: st.view?.status ?? null }
          st.error = res.failed ? res.failed.hint || L('没采到', 'Could not check') : ''
        } catch (e) {
          st.error = e.message
        } finally {
          st.loading = false
          bump()
        }
      }

      useEffect(() => {
        if (!visible) return
        let alive = true
        ;(async () => {
          if (!st.view) {
            try {
              const cached = await api('status/get', { sessionId })
              if (alive && !st.view) {
                st.view = cached
                bump()
              }
            } catch {
              // 读不到上次的结果就直接采
            }
          }
          // 切到这个页签时采一次；刚采过（2 分钟内）就不重复采，要新的点刷新
          const at = Date.parse(st.view?.status?.collectedAt ?? '')
          if (alive && !(Date.now() - at < 120_000)) collect()
        })()
        return () => {
          alive = false
        }
      }, [visible, sessionId, alias]) // eslint-disable-line react-hooks/exhaustive-deps

      const flash = (text) => {
        st.notice = text
        bump()
        setTimeout(() => {
          if (st.notice === text) {
            st.notice = ''
            bump()
          }
        }, 6000)
      }

      async function chat(text, sentNote) {
        const r = await sendToChat(sessionId, text)
        if (r === 'sent') flash(sentNote)
        else if (r === 'queued') flash(L('这个问题已经在排队了，AI 忙完这一轮就会回答', 'This question is already queued; the AI answers it after the current turn'))
        else if (r === 'draft') flash(L('输入框里有你还没发出去的话，先发掉或清空再试', 'The input box holds a message you have not sent; send or clear it first'))
        else {
          try {
            await navigator.clipboard.writeText(text)
            flash(L('已复制到剪贴板：粘贴到上面的输入框发送', 'Copied: paste it into the input box above and send'))
          } catch {
            flash(L('没能发到对话里', 'Could not send it to the conversation'))
          }
        }
      }

      async function interpret() {
        if (!status) return
        if (!view.canInterpret) {
          return chat(L(`请根据下面这台服务器的状态，用几句话说说它现在怎么样、最要紧的是什么（只查看，不要改动）：\n\n${status.brief}`, `Based on this server status, tell me in a few sentences how it is doing and what matters most (look only, change nothing):\n\n${status.brief}`), L('已在对话里请 AI 解读', 'Asked the AI in the conversation'))
        }
        st.interpreting = true
        st.interpError = ''
        bump()
        try {
          const res = await api('status/interpret', { sessionId }, { timeoutMs: 150_000 })
          if (res.interpretation) st.view = { ...st.view, interpretation: res.interpretation }
          else st.interpError = res.error || L('解读没成功', 'Interpretation failed')
        } catch (e) {
          st.interpError = e.message
        } finally {
          st.interpreting = false
          bump()
        }
      }

      function followUp() {
        const it = view?.interpretation
        if (!it || !status) return
        chat(L(
          `接着这次对服务器 ${alias} 的状态解读往下聊（只查看，需要改动先告诉我）：\n\n解读：${it.text}\n\n状态数据：\n${status.brief}`,
          `Let's continue from this status interpretation of server ${alias} (look only; tell me before changing anything):\n\nInterpretation: ${it.text}\n\nStatus data:\n${status.brief}`,
        ), L('已带进对话，可以接着问', 'Sent to the conversation; ask away'))
      }

      function askItem(item) {
        const { name, detail, raw } = describeItem(item)
        chat(L(
          `请看看服务器 ${alias} 上的这个问题：${name}：${detail}${raw ? `（${raw}）` : ''}。先只查看、找出原因；需要改动时先告诉我再做。`,
          `Please look into this on server ${alias}: ${name}: ${detail}${raw ? ` (${raw})` : ''}. Investigate first without changing anything; tell me before making changes.`,
        ), L('已在对话里问 AI', 'Asked the AI in the conversation'))
      }

      function showLogs(item) {
        if (entry.socket?.readyState !== 1) return flash(L('终端还没连上，稍等一下再试', 'The terminal is not connected yet; try again in a moment'))
        const cmd = item.type.startsWith('ctr_') ? `docker logs --tail 50 ${shellQ(item.name)}` : `journalctl -u ${shellQ(item.name)} -n 50 --no-pager`
        setTab(entry, 'terminal')
        sendTerm(entry, { t: 'i', d: `${cmd}\r` })
      }

      // —— 小部件 ——
      const smallBtn = (label, onClick, { primary = false, icon, title, disabled = false } = {}) => h('button', {
        type: 'button', onClick, title, disabled,
        onMouseEnter: (e) => { if (!primary && !disabled) e.currentTarget.style.background = c.hover },
        onMouseLeave: (e) => { if (!primary) e.currentTarget.style.background = 'transparent' },
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px', borderRadius: 7, fontSize: 12, fontWeight: 500,
          whiteSpace: 'nowrap', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1, flex: '0 0 auto',
          border: primary ? 'none' : `0.5px solid ${c.edge}`, background: primary ? c.accent : 'transparent', color: primary ? '#fff' : c.secondary,
        },
      }, icon ? h(Icon, { name: icon, size: 13 }) : null, label)
      const dot = (level, size = 8) => h('span', { 'aria-hidden': 'true', style: { width: size, height: size, borderRadius: '50%', background: levelColor(c, level), flex: '0 0 auto' } })
      const tag = (text, level) => h('span', { style: { ...NUM, fontSize: 11, padding: '1px 6px', borderRadius: 4, background: levelBg(c, level), color: level === 'na' || level === 'ok' ? c.secondary : levelColor(c, level), whiteSpace: 'nowrap', flex: '0 0 auto' } }, text)
      const sectionTitle = (text, right) => h('div', { role: 'heading', 'aria-level': 3, style: { display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 0 6px', fontSize: 12, fontWeight: 500, color: c.secondary } },
        h('span', null, text), right ? h('span', { style: { ...NUM, marginInlineStart: 'auto', fontSize: 11, fontWeight: 400, color: c.tertiary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, right) : null)
      const pad = maximized ? 16 : 12

      // —— 第一次、还没有任何数据：骨架 ——
      if (!status) {
        return h('div', { style: { height: '100%', overflow: 'auto', padding: pad, boxSizing: 'border-box' } },
          st.error
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8, background: c.dangerBg, color: c.danger, fontSize: 12.5 } },
              h(Icon, { name: 'alert', size: 15 }), h('span', { style: { flex: 1 } }, st.error), smallBtn(L('重试', 'Retry'), collect, { icon: 'refresh' }))
            : h('div', null,
              h('div', { style: { fontSize: 12, color: c.tertiary, marginBottom: 12 } }, waitingLabel(L(`正在看一遍 ${alias}…`, `Checking ${alias}…`), loadingSecs)),
              [72, 44, 32, 32, 32].map((height, i) => h('div', { key: i, style: { height, borderRadius: 8, background: c.track, marginBottom: 8, animation: 'dshVpsPulse 1.2s ease-in-out infinite' } }))))
      }

      const attention = judged.attention
      const okItems = [...judged.ok, ...judged.na]
      const worst = attention.some((i) => i.level === 'danger') ? 'danger' : attention.length ? 'warn' : 'ok'
      const showSections = maximized || st.expanded
      const it = view.interpretation
      const stale = it && it.basedOn !== status.collectedAt
      const privText = { root: 'root', sudo: L('免密 sudo', 'passwordless sudo'), none: L('只读账号', 'read-only account') }[data.priv] ?? ''

      // —— 顶部：结论一行 + 机器概况 ——
      const header = h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 8, background: levelBg(c, worst), color: levelColor(c, worst), flex: '0 0 auto' } },
          h(Icon, { name: worst === 'ok' ? 'check' : 'alert', size: 15 })),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { style: { ...NUM, fontSize: 14, fontWeight: 500, color: c.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
            attention.length ? L(`需注意 ${attention.length} 项`, `${attention.length} need attention`) : L('一切正常', 'All good'),
            h('span', { style: { fontWeight: 400, color: c.tertiary } }, L(` · 其余 ${judged.ok.length} 项正常`, ` · ${judged.ok.length} OK`))),
          h('div', { style: { ...NUM, fontSize: 11.5, color: c.tertiary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 } },
            [data.host || alias, data.os, data.kernel && `${L('内核', 'kernel')} ${data.kernel}`, data.uptime ? L(`已运行 ${fmtUptime(data.uptime)}`, `up ${fmtUptime(data.uptime)}`) : '', privText].filter(Boolean).join(' · '))),
        h('span', { style: { ...NUM, fontSize: 11, color: c.tertiary, whiteSpace: 'nowrap' } },
          st.loading ? waitingLabel(L('正在采集…', 'Checking…'), loadingSecs) : L(`${fmtClock(status.collectedAt)} 采集`, `checked ${fmtClock(status.collectedAt)}`)),
        h('button', {
          type: 'button', onClick: collect, disabled: st.loading, title: L('重新看一遍', 'Check again'), 'aria-label': L('刷新', 'Refresh'),
          style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, border: `0.5px solid ${c.edge}`, background: 'transparent', color: c.secondary, cursor: st.loading ? 'default' : 'pointer', flex: '0 0 auto' },
        }, h(Icon, { name: 'refresh', size: 13, style: st.loading ? { animation: 'dshVpsSpin 1s linear infinite' } : undefined })))

      const errorBar = st.error
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, background: c.dangerBg, color: c.danger, fontSize: 12, marginBottom: 10 } },
          h(Icon, { name: 'alert', size: 14 }), h('span', { style: { flex: 1, minWidth: 0 } }, L(`这次没采到，下面是 ${fmtClock(status.collectedAt)} 的结果：`, `This check failed; below are the results from ${fmtClock(status.collectedAt)}: `), st.error))
        : null

      // —— AI 解读框 ——
      const aiBox = h('div', { style: { borderRadius: 10, background: c.infoBg, padding: '10px 12px', marginBottom: 12 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: c.accent, marginBottom: it || st.interpreting ? 6 : 0 } },
          h(Icon, { name: 'sparkles', size: 13 }), L('AI 解读', 'AI interpretation'),
          it && !st.interpreting ? h('span', { style: { ...NUM, marginInlineStart: 'auto', fontWeight: 400, fontSize: 11, color: c.tertiary } },
            L(`基于 ${fmtClock(it.basedOn)} 的数据`, `from ${fmtClock(it.basedOn)} data`), it.model ? ` · ${it.model}` : '') : null),
        st.interpreting
          ? h('div', null,
            [100, 92, 60].map((w, i) => h('div', { key: i, style: { width: `${w}%`, height: 10, borderRadius: 5, background: c.track, margin: '6px 0', animation: 'dshVpsPulse 1.2s ease-in-out infinite' } })),
            h('div', { style: { fontSize: 11, color: c.tertiary, marginTop: 4 } }, waitingLabel(L('AI 正在看这些数据…', 'The AI is reading the data…'), aiSecs)))
          : it
            ? h('div', null,
              h('div', { lang: it.lang === 'en' ? 'en' : 'zh-CN', style: { fontSize: 13, lineHeight: 1.65, color: c.text, whiteSpace: 'pre-wrap' } }, it.text),
              stale ? h('div', { style: { fontSize: 11.5, color: c.warn, marginTop: 6 } }, L('数据已经更新，可以重新解读', 'The data has been updated; you can re-check')) : null,
              h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8, flexWrap: 'wrap' } },
                smallBtn(L('在对话里追问', 'Ask in chat'), followUp),
                smallBtn(L('重新解读', 'Re-check'), interpret, { icon: 'sparkles' })))
            : h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' } },
              h('span', { style: { flex: '1 1 200px', fontSize: 12.5, color: c.secondary, lineHeight: 1.55 } },
                view.canInterpret
                  ? L('让 AI 看一遍这些数据，用几句话说说这台机器怎么样、最要紧的是什么。点了才调用模型。', 'Let the AI read this data and say in a few sentences how the machine is doing and what matters most. The model is only called when you click.')
                  : L('这个版本的 DSH 不让插件直接调用模型，点一下会在对话里问 AI。', 'This DSH version does not let plugins call the model directly; clicking asks the AI in the conversation.')),
              smallBtn(view.canInterpret ? L('让 AI 解读', 'Interpret') : L('在对话里问', 'Ask in chat'), interpret, { primary: true, icon: 'sparkles' })),
        st.interpError ? h('div', { style: { fontSize: 12, color: c.danger, marginTop: 6 } }, st.interpError) : null)

      // —— 需注意 ——
      const actionsFor = (item) => {
        const btns = []
        if (['svc_failed', 'svc_down', 'timer_failed', 'ctr_exited', 'ctr_restarting'].includes(item.type)) btns.push(smallBtn(L('看日志', 'Logs'), () => showLogs(item)))
        if (item.type === 'disk' || item.type === 'inode') btns.push(smallBtn(L('打开', 'Open'), () => openInFiles(entry, { path: item.mount })))
        btns.push(smallBtn(L('问 AI', 'Ask AI'), () => askItem(item)))
        return btns
      }
      // 名字一栏按最长的那个定宽（有上限），说明文字就能对齐成一列
      const textWidth = (t) => [...String(t)].reduce((w, ch) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 13 : 7.6), 0)
      const nameCol = Math.ceil(Math.min(150, Math.max(56, ...attention.map((i) => textWidth(describeItem(i).name) + 6))))
      const attentionList = attention.length
        ? h('div', { style: { marginBottom: 12 } },
          sectionTitle(L('需注意', 'Needs attention')),
          h('div', { style: { borderRadius: 10, border: `0.5px solid ${c.edge}`, overflow: 'hidden' } },
            attention.map((item, i) => {
              const d = describeItem(item)
              return h('div', { key: item.id, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderTop: i ? `0.5px solid ${c.divider}` : 'none', minWidth: 0 } },
                dot(item.level),
                h('span', { title: d.name, style: { fontSize: 13, fontWeight: 500, color: c.text, whiteSpace: 'nowrap', flex: `0 0 ${nameCol}px`, overflow: 'hidden', textOverflow: 'ellipsis' } }, d.name),
                h('span', { style: { ...NUM, fontSize: 12, color: c.tertiary, flex: '1 1 0', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: d.raw ? `${d.detail} · ${d.raw}` : d.detail },
                  d.detail, d.raw ? h('span', { style: { opacity: 0.8 } }, ` · ${d.raw}`) : null),
                d.pct !== undefined ? h(UsageBar, { c, pct: d.pct, level: item.level, width: 64 }) : null,
                h('span', { style: { display: 'inline-flex', gap: 6, flex: '0 0 auto' } }, ...actionsFor(item)))
            })))
        : null

      // —— 其余正常（折成一行） ——
      const okRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 10, background: c.okBg, marginBottom: showSections ? 14 : 0, minWidth: 0 } },
        h('span', { style: { color: c.ok, display: 'inline-flex' } }, h(Icon, { name: 'check', size: 15 })),
        h('span', { style: { fontSize: 12.5, fontWeight: 500, color: c.text, whiteSpace: 'nowrap' } }, attention.length ? L('其余正常', 'Everything else is fine') : L('都正常', 'All fine')),
        h('span', { style: { ...NUM, flex: 1, minWidth: 0, fontSize: 12, color: c.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
          okItems.map((item, i) => h('span', { key: item.id, title: item.level === 'na' ? (item.reason === 'root' ? L('取不到（需要 root）', 'Unavailable (needs root)') : L('取不到', 'Unavailable')) : undefined, style: { color: item.level === 'na' ? c.tertiary : undefined } }, i ? ' · ' : '', okChip(item), item.level === 'na' ? L('（取不到）', ' (n/a)') : ''))),
        maximized ? null : smallBtn(st.expanded ? L('收起', 'Less') : L('展开全部', 'Show all'), () => {
          st.expanded = !st.expanded
          bump()
        }, { icon: 'chevron' }))

      return h('div', { style: { height: '100%', overflow: 'auto', padding: pad, boxSizing: 'border-box' } },
        header,
        errorBar,
        st.notice ? h('div', { style: { fontSize: 12, color: c.secondary, background: c.tip, borderRadius: 8, padding: '6px 10px', marginBottom: 10 } }, st.notice) : null,
        aiBox,
        attentionList,
        okRow,
        showSections ? h(StatusSections, { c, data, judged, entry, sectionTitle, tag, dot, smallBtn }) : null)
    }

    /** 展开 / 最大化后的完整分区：资源卡片、磁盘，再把其余分区排成两列卡片 */
    function StatusSections({ c, data, judged, entry, sectionTitle, tag, dot, smallBtn }) {
      const levelOf = (prefix) => {
        const hits = judged.attention.filter((i) => i.area === prefix)
        return hits.some((i) => i.level === 'danger') ? 'danger' : hits.length ? 'warn' : 'ok'
      }
      const memPct = data.mem ? Math.round(((data.mem.total - data.mem.avail) / data.mem.total) * 100) : null
      const swapPct = data.swap?.total ? Math.round(((data.swap.total - data.swap.free) / data.swap.total) * 100) : null
      const loadRatio = data.cores && data.load[0] !== null ? data.load[0] / data.cores : null

      const tile = (label, value, sub, pct, level) => h('div', { style: { borderRadius: 10, border: `0.5px solid ${c.edge}`, padding: '9px 11px', minWidth: 0 } },
        h('div', { style: { fontSize: 11.5, color: c.tertiary, marginBottom: 2 } }, label),
        h('div', { style: { ...NUM, fontSize: 20, fontWeight: 500, lineHeight: 1.25, color: level === 'danger' ? c.danger : level === 'warn' ? c.warn : c.text } }, value),
        h('div', { style: { ...NUM, fontSize: 11, color: c.tertiary, margin: '2px 0 7px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, sub),
        pct === null || pct === undefined ? h('div', { style: { height: 4 } }) : h(UsageBar, { c, pct, level }))
      const na = L('取不到', 'n/a')
      const tiles = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(108px, 1fr))', gap: 8, marginBottom: 14 } },
        tile('CPU', data.cpu !== null ? `${data.cpu}%` : na, [data.cores ? L(`${data.cores} 核`, `${data.cores} cores`) : '', data.load[0] !== null ? L(`负载 ${data.load[0]}`, `load ${data.load[0]}`) : ''].filter(Boolean).join(' · '), data.cpu, loadRatio === null ? 'ok' : loadRatio > 2 ? 'danger' : loadRatio > 1 ? 'warn' : 'ok'),
        tile(L('内存', 'Memory'), memPct !== null ? `${memPct}%` : na, data.mem ? L(`${fmtBytes(data.mem.total - data.mem.avail)} / ${fmtBytes(data.mem.total)}`, `${fmtBytes(data.mem.total - data.mem.avail)} of ${fmtBytes(data.mem.total)}`) : '', memPct, memPct === null ? 'ok' : 100 - memPct < 5 ? 'danger' : 100 - memPct < 10 ? 'warn' : 'ok'),
        tile('Swap', swapPct !== null ? `${swapPct}%` : '—', data.swap?.total ? `${fmtBytes(data.swap.total - data.swap.free)} / ${fmtBytes(data.swap.total)}` : L('没有 swap', 'no swap'), swapPct, swapPct !== null && swapPct > 50 ? 'warn' : 'ok'),
        tile(L('网络（开机以来）', 'Network (since boot)'), data.net ? h('span', null, h('span', { style: { fontSize: 13, color: c.tertiary, marginInlineEnd: 3 } }, '↓'), fmtBytes(data.net.rx)) : na, data.net ? `↑ ${fmtBytes(data.net.tx)} · ${data.net.dev}` : '', null, 'ok'))

      const disks = data.disks.length
        ? h('div', { style: { marginBottom: 14 } },
          sectionTitle(L('磁盘', 'Disks'), L(`${data.disks.length} 个挂载点`, `${data.disks.length} mounts`)),
          h('div', { style: { borderRadius: 10, border: `0.5px solid ${c.edge}`, overflow: 'hidden' } },
            data.disks.map((d, i) => {
              const lv = pctLevel(d.pct ?? 0)
              return h('div', { key: d.mount, style: { display: 'grid', gridTemplateColumns: 'minmax(70px, 1.1fr) minmax(80px, 2fr) auto', alignItems: 'center', gap: 12, padding: '8px 10px', borderTop: i ? `0.5px solid ${c.divider}` : 'none' } },
                h('span', { style: { fontFamily: DS.code, fontSize: 12, color: c.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: d.mount }, d.mount),
                h('span', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } }, h(UsageBar, { c, pct: d.pct, level: lv }),
                  h('span', { style: { ...NUM, fontSize: 12, fontWeight: 500, color: lv === 'ok' ? c.text : levelColor(c, lv), width: 36, textAlign: 'end' } }, d.pct !== null ? `${d.pct}%` : '—')),
                h('span', { style: { ...NUM, fontSize: 11, color: c.tertiary, whiteSpace: 'nowrap' } },
                  L(`剩 ${fmtBytes(d.avail)} / ${fmtBytes(d.size)}`, `${fmtBytes(d.avail)} free of ${fmtBytes(d.size)}`), d.inodePct !== null ? ` · inode ${d.inodePct}%` : ''))
            })))
        : null

      // 两列卡片
      const card = (key, title, level, right, body) => h('div', { key, style: { borderRadius: 10, border: `0.5px solid ${c.edge}`, padding: '9px 11px', minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 } },
          dot(level, 7),
          h('span', { role: 'heading', 'aria-level': 3, style: { fontSize: 12.5, fontWeight: 500, color: c.text } }, title),
          right ? h('span', { style: { ...NUM, marginInlineStart: 'auto', fontSize: 11, color: c.tertiary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } }, right) : null),
        body)
      const line = (left, right, { mono = false, color, key } = {}) => h('div', { key, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12, minWidth: 0 } },
        h('span', { style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: color ?? c.secondary, fontFamily: mono ? DS.code : undefined, fontSize: mono ? 11.5 : 12 } }, left),
        right === undefined || right === null ? null : typeof right === 'string' || typeof right === 'number' ? h('span', { style: { ...NUM, color: c.tertiary, whiteSpace: 'nowrap' } }, right) : right)
      const empty = (text) => h('div', { style: { fontSize: 12, color: c.tertiary, padding: '3px 0' } }, text)
      const more = (n) => (n > 0 ? h('div', { style: { fontSize: 11, color: c.tertiary, paddingTop: 2 } }, L(`还有 ${n} 项`, `${n} more`)) : null)
      const naText = (reason) => (reason === 'root' ? L('取不到（需要 root）', 'Unavailable (needs root)') : L('取不到', 'Unavailable'))

      const cards = []
      // 服务
      if (data.services) {
        const bad = [...data.services.failed.map((u) => [u, L('失败', 'failed'), 'danger']), ...data.services.down.map((u) => [u, L('没在跑', 'not running'), 'danger'])]
        cards.push(card('svc', L('服务', 'Services'), levelOf('service'), L(`运行 ${data.services.running}`, `${data.services.running} running`),
          h('div', null,
            bad.map(([u, t, lv]) => line(u.replace(/\.service$/, ''), tag(t, lv), { key: u, color: c.text })),
            data.services.names.length
              ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: bad.length ? 6 : 2 } }, data.services.names.slice(0, 14).map((n) => h('span', { key: n, style: { fontSize: 11, padding: '1px 6px', borderRadius: 4, background: c.track, color: c.secondary } }, n)))
              : bad.length ? null : empty(L('没有失败的服务', 'No failed services')))))
      } else {
        cards.push(card('svc', L('服务', 'Services'), 'na', '', empty(naText())))
      }
      // 容器
      if (data.containers) {
        const list = data.containers.list
        const running = list.filter((x) => x.state === 'running').length
        cards.push(card('ctr', L('容器', 'Containers'), levelOf('container'), data.containers.noAccess ? '' : L(`运行 ${running} / 共 ${list.length}`, `${running} of ${list.length} running`),
          data.containers.noAccess ? empty(naText('root')) : list.length
            ? h('div', null, list.slice(0, 8).map((x) => line(x.name, tag(x.state === 'running' ? L('运行中', 'running') : x.state === 'restarting' ? L('反复重启', 'restarting') : L('已退出', 'exited'), x.state === 'running' ? 'ok' : x.state === 'restarting' ? 'danger' : (x.policy && x.policy !== 'no') ? 'na' : 'warn'), { key: x.name, color: c.text })), more(list.length - 8))
            : empty(L('没有容器', 'No containers'))))
      }
      // 进程
      if (data.procCpu.length || data.procMem.length) {
        cards.push(card('proc', L('进程', 'Processes'), 'ok', L('近 1 秒', 'last second'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
            h('div', { style: { minWidth: 0 } }, h('div', { style: { fontSize: 11, color: c.tertiary, marginBottom: 2 } }, L('最占 CPU', 'Top CPU')),
              data.procCpu.length ? data.procCpu.map((p) => line(p.name, `${p.pct}%`, { key: p.name, mono: true })) : empty(L('都很空闲', 'All idle'))),
            h('div', { style: { minWidth: 0 } }, h('div', { style: { fontSize: 11, color: c.tertiary, marginBottom: 2 } }, L('最占内存', 'Top memory')),
              data.procMem.length ? data.procMem.map((p) => line(p.name, fmtBytes(p.bytes), { key: p.name, mono: true })) : empty('—')))))
      }
      // 端口
      cards.push(card('ports', L('端口', 'Ports'), 'ok', data.ports.length ? L(`监听 ${data.ports.length} 个`, `${data.ports.length} listening`) : '',
        data.ports.length
          ? h('div', null, data.ports.slice(0, 10).map((p) => h('div', { key: `${p.port}${p.local}`, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12, minWidth: 0 } },
            h('span', { style: { ...NUM, fontFamily: DS.code, fontSize: 12, fontWeight: 500, color: c.text, width: 46, flex: '0 0 auto' } }, p.port),
            h('span', { style: { flex: 1, minWidth: 0, color: c.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, p.proc || (data.priv === 'none' ? L('（要 root 才看得到进程）', '(needs root to see the process)') : '—')),
            tag(p.local ? L('仅本机', 'local') : L('对外', 'public'), p.local ? 'na' : 'ok'))), more(data.ports.length - 10))
          : empty(L('没有监听的端口', 'No listening ports'))))
      // 防火墙
      if (data.firewall) {
        const fw = data.firewall
        cards.push(card('fw', L('防火墙', 'Firewall'), fw.type === 'unknown' ? 'na' : 'ok', fw.type === 'unknown' ? '' : fw.type === 'none' ? L('没有', 'none') : fw.type,
          fw.type === 'unknown' ? empty(naText('root')) : fw.type === 'none'
            ? empty(L('没有检测到 ufw / firewalld / nftables / iptables 规则（可能用的是服务商的防火墙）', 'No ufw / firewalld / nftables / iptables rules found (your provider\'s firewall may be in use)'))
            : h('div', null,
              line(L('状态', 'State'), tag(fw.active ? L('已启用', 'active') : L('未启用', 'inactive'), fw.active ? 'ok' : 'na')),
              fw.allow.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: 4 } },
                h('span', { style: { fontSize: 11, color: c.tertiary, marginInlineEnd: 2 } }, L('放行', 'Allowed')),
                fw.allow.slice(0, 16).map((a) => h('span', { key: a, style: { ...NUM, fontFamily: DS.code, fontSize: 11, padding: '1px 6px', borderRadius: 4, background: c.track, color: c.secondary } }, a))) : null)))
      }
      // 计划任务
      cards.push(card('cron', L('计划任务', 'Scheduled tasks'), levelOf('cron'), '',
        h('div', null,
          line('crontab', data.cron.lines !== null ? L(`${data.cron.lines} 条`, `${data.cron.lines}`) : '—'),
          line('/etc/cron.d', data.cron.files !== null ? L(`${data.cron.files} 个文件`, `${data.cron.files} files`) : '—', { mono: true }),
          data.timers !== null ? line(L('systemd 定时器', 'systemd timers'), L(`${data.timers} 个`, `${data.timers}`)) : null,
          data.services?.timerFailed.length ? line(L('上次失败', 'Last run failed'), tag(data.services.timerFailed.map((u) => u.replace(/\.service$/, '')).join(', '), 'warn')) : null)))
      // 证书
      if (data.certs.length || data.certNoAccess) {
        // 级别由服务端算好（judged.certs）；老缓存没有就按 90 天证书的阈值估
        const certs = (judged.certs ?? data.certs.map((x) => {
          const days = x.expires ? Math.floor((Date.parse(x.expires) - Date.now()) / 86_400_000) : null
          return { name: x.name, days, level: days === null ? 'na' : days <= 3 ? 'danger' : days <= 14 ? 'warn' : 'ok' }
        })).slice().sort((a, b) => (a.level === 'stale') - (b.level === 'stale') || (a.days ?? 1e9) - (b.days ?? 1e9))
        const certTag = (x) => {
          if (x.days === null) return tag('?', 'na')
          if (x.level === 'stale') return tag(L('已过期 · Caddy 已不用', 'expired · unused'), 'na')
          return tag(x.days < 0 ? L(`已过期 ${-x.days} 天`, `expired ${-x.days}d`) : L(`${x.days} 天`, `${x.days} days`), x.level)
        }
        const live = certs.filter((x) => x.level !== 'stale').length
        cards.push(card('cert', L('证书', 'Certificates'), levelOf('cert'), certs.length ? L(`${live} 张`, `${live}`) : '',
          certs.length
            ? h('div', null, certs.slice(0, 8).map((x) => line(x.name, certTag(x), { key: x.name, color: x.level === 'stale' ? c.tertiary : c.text })), more(certs.length - 8))
            : empty(naText('root'))))
      }
      // 安全
      cards.push(card('sec', L('安全', 'Security'), levelOf('security'), '',
        h('div', null,
          line(L('待装安全更新', 'Security updates'), data.updatesSec !== null ? tag(String(data.updatesSec), data.updatesSec > 0 ? 'warn' : 'ok') : data.updates !== null ? L(`可升级 ${data.updates} 个`, `${data.updates} upgradable`) : '—'),
          line(L('需要重启', 'Reboot required'), tag(data.reboot ? L('是', 'yes') : L('否', 'no'), data.reboot ? 'warn' : 'ok')),
          line(L('24 小时登录失败', 'Failed logins (24 h)'), data.loginFail !== null ? tag(String(data.loginFail), data.loginFail >= 100 && !data.fail2ban ? 'warn' : 'ok') : naText(data.priv === 'none' ? 'root' : '')),
          line('fail2ban', tag(data.fail2ban ? L('在跑', 'running') : L('没有', 'off'), data.fail2ban ? 'ok' : 'na')))))
      // 插件自己在服务器上的东西 + 正在跑的改动任务
      cards.push(card('plugin', L('插件占用', 'Plugin data'), 'ok', '~/.cache/dsh-vps',
        h('div', null,
          line(L('回收站', 'Trash'), h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            h('span', { style: { ...NUM, color: c.tertiary } }, data.plugin.trash !== null ? fmtBytes(data.plugin.trash) : '0 B'),
            smallBtn(L('打开', 'Open'), () => openInFiles(entry, { trash: true })))),
          line(L('改文件前的备份', 'Backups before edits'), data.plugin.backups !== null ? fmtBytes(data.plugin.backups) : '0 B'),
          line(L('正在跑的改动任务', 'Change task running'), data.task
            ? tag(data.task.device ? L(`电脑 ${data.task.device}`, `computer ${data.task.device}`) : data.task.taskId, 'warn')
            : tag(L('无', 'none'), 'na')))))

      return h('div', null,
        tiles,
        disks,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8 } }, cards))
    }

    // ——————————————————————— 文件管理器（终端面板的「文件」页）———————————————————————
    // 服务器上的访达：浏览、上传下载、新建改名、删到回收站、编辑文本、让 AI 看看这个文件。
    // 操作的是「这个对话绑定的那台机器」（服务端按对话查），和终端同一台。
    // 状态挂在 entry.files 上：切回终端、最小化再恢复，都还停在原来的目录。

    const FILE_EDIT_LIMIT = 1024 * 1024
    const DOWNLOAD_IN_PAGE_LIMIT = 1024 * 1024 * 1024 // 1 GB 以内由页面取回（见 download）
    // 删这些目录里的东西之前多提醒一句
    const SYSTEM_DIRS = /^\/(etc|boot|usr|bin|sbin|lib|lib32|lib64|var\/lib)(\/|$)/
    // 改错了可能连不上服务器的文件：编辑时顶部标黄
    const LOCKOUT_FILES = /sshd_config|sudoers|\/etc\/fstab$|\/etc\/(passwd|shadow|group|gshadow)$|authorized_keys$|\/etc\/(ufw|nftables|iptables|netplan|network)\//

    function fmtBytes(n) {
      if (n === null || n === undefined || !Number.isFinite(n)) return ''
      if (n < 1024) return `${n} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let v = n / 1024
      let i = 0
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i += 1
      }
      return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
    }

    function fmtTime(sec) {
      if (!sec) return ''
      const d = new Date(sec * 1000)
      const pad = (x) => String(x).padStart(2, '0')
      const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      return d.getFullYear() === new Date().getFullYear() ? `${md} ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getFullYear()}-${md}`
    }

    function joinRemote(dir, name) {
      return dir === '/' ? `/${name}` : `${dir}/${name}`
    }

    function parentRemote(path) {
      const i = path.lastIndexOf('/')
      return i <= 0 ? '/' : path.slice(0, i)
    }

    function shellQ(s) {
      return `'${String(s).replaceAll("'", "'\\''")}'`
    }

    function isDirLike(e) {
      return e.type === 'dir' || (e.type === 'link' && e.target === 'dir')
    }

    /** 缩进习惯：文件里已经用 tab 就插 tab，否则插两个空格 */
    function indentUnit(text) {
      return /^\t/m.test(text) ? '\t' : '  '
    }

    function FileIcon({ kind, color }) {
      const box = { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true, style: { flex: '0 0 auto', display: 'block' } }
      if (kind === 'dir') {
        return h('svg', box, h('path', {
          d: 'M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.9l1.4 1.4h5.2c.83 0 1.5.67 1.5 1.5v6.6c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5z',
          fill: color,
        }))
      }
      const stroke = { fill: 'none', stroke: color, strokeWidth: 1.2, strokeLinejoin: 'round', strokeLinecap: 'round' }
      return h('svg', box,
        h('path', { d: 'M4 1.75h5l3.25 3.25v9.25H4z', ...stroke }),
        h('path', { d: 'M9 1.75V5h3.25', ...stroke }),
        kind === 'link' ? h('path', { d: 'M6.2 11.3l3.1-3.1M7.2 8.2h2.1v2.1', ...stroke }) : null)
    }

    /** 上传一个文件：用 XHR 才拿得到上传进度。请求体就是文件本身 */
    function uploadOne({ sessionId, path, file, onProgress, abortRef }) {
      return new Promise((resolve) => {
        const xhr = new window.XMLHttpRequest()
        abortRef.current = () => xhr.abort()
        const q = new URLSearchParams({ sessionId, path, size: String(file.size) })
        xhr.open('POST', `/api-vps/files/upload?${q}`)
        xhr.setRequestHeader('content-type', 'application/octet-stream')
        xhr.setRequestHeader('x-dsh-vps-token', window.__DSH_VPS_TOKEN__ || '')
        xhr.setRequestHeader('x-dsh-vps-lang', lang())
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded)
        }
        xhr.onload = () => {
          let data = null
          try {
            data = JSON.parse(xhr.responseText)
          } catch {
            // 不是 JSON：多半是旧版服务端没有这个接口
          }
          if (data?.ok) resolve({ ok: true, ...data })
          else if (xhr.status === 405) resolve({ ok: false, error: L('当前运行的插件还没有上传功能：DSH 运行期间装的新版本要重启 DSH 才生效', 'The running plugin cannot upload yet: a version installed while DSH was running takes effect after DSH restarts') })
          else if (/token/i.test(data?.error ?? '')) resolve({ ok: false, tokenStale: true, error: L('令牌对不上了（DSH 重启过）：刷新页面再试', 'Token mismatch (DSH restarted): reload the page and try again') })
          else resolve({ ok: false, error: data?.error || L(`上传失败（HTTP ${xhr.status}）`, `Upload failed (HTTP ${xhr.status})`) })
        }
        xhr.onerror = () => resolve({ ok: false, error: L('连不上 DSH，上传中断了', 'Cannot reach DSH; the upload was interrupted') })
        xhr.onabort = () => resolve({ ok: false, error: L('已取消', 'Cancelled'), cancelled: true })
        xhr.send(file)
      })
    }

    function FileBrowser({ entry, c }) {
      const sessionId = entry.sessionId
      if (!entry.files) entry.files = { cwd: '', back: [], fwd: [], hidden: false, view: 'dir', sort: 'name', desc: false }
      const st = entry.files
      const rootRef = useRef(null)
      const fileInput = useRef(null)
      const anchorRef = useRef(null)
      const [, rerender] = useState(0)
      const bump = () => rerender((n) => n + 1)
      const [places, setPlaces] = useState(null)
      const [data, setData] = useState(null)
      const [trash, setTrash] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState(null)
      const [selected, setSelected] = useState(() => new Set())
      const [menu, setMenu] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [editor, setEditor] = useState(null)
      const [uploads, setUploads] = useState([])
      const [drag, setDrag] = useState(false)
      const [pathDraft, setPathDraft] = useState(null)
      const call = (path, body = {}) => api(`files/${path}`, { sessionId, ...body })
      const inTrash = st.view === 'trash'

      const flash = (text, tone = 'ok') => setNotice({ text, tone, at: Date.now() })
      useEffect(() => {
        if (!notice) return undefined
        const t = setTimeout(() => setNotice(null), notice.tone === 'error' ? 12_000 : 6_000)
        return () => clearTimeout(t)
      }, [notice])

      /** 面板里的对话框（Electron 里 window.prompt 用不了）。返回：输入的文字 / true / 额外按钮的值 / null */
      const ask = (opts) => new Promise((resolve) => setDialog({ ...opts, value: opts.input ?? '', resolve }))

      const refreshPlaces = () => call('places').then(setPlaces).catch(() => {})

      async function openDir(path, { push = true } = {}) {
        setLoading(true)
        setError('')
        setMenu(null)
        try {
          const res = await call('list', { path })
          if (push && st.cwd && st.cwd !== res.path) {
            st.back.push(st.cwd)
            st.fwd = []
          }
          st.cwd = res.path
          st.view = 'dir'
          setData(res)
          setSelected(new Set())
          anchorRef.current = null
        } catch (e) {
          setError(e.message)
        } finally {
          setLoading(false)
        }
      }

      async function openTrash() {
        setLoading(true)
        setError('')
        setMenu(null)
        try {
          const res = await call('trash-list')
          st.view = 'trash'
          setTrash(res.items)
          setSelected(new Set())
          anchorRef.current = null
          refreshPlaces()
        } catch (e) {
          setError(e.message)
        } finally {
          setLoading(false)
        }
      }

      const refresh = () => (inTrash ? openTrash() : openDir(st.cwd || places?.home || '/', { push: false }))

      useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const p = await call('places')
            if (!alive) return
            setPlaces(p)
            if (st.view === 'trash') openTrash()
            else openDir(st.cwd || p.home || '/', { push: false })
          } catch (e) {
            if (alive) setError(e.message)
          }
        })()
        return () => {
          alive = false
        }
      }, [sessionId, entry.alias]) // eslint-disable-line react-hooks/exhaustive-deps

      // 从「状态」页签跳过来（磁盘快满 → 打开那个挂载点；回收站很大 → 打开回收站）
      const gotoRef = useRef(entry.filesGoto)
      useEffect(() => {
        if (!entry.filesGoto || entry.filesGoto === gotoRef.current) return
        gotoRef.current = entry.filesGoto
        if (st.view === 'trash') openTrash()
        else openDir(st.cwd || places?.home || '/', { push: false })
      }, [entry.filesGoto]) // eslint-disable-line react-hooks/exhaustive-deps

      const goBack = () => {
        const prev = st.back.pop()
        if (!prev) return
        st.fwd.push(st.cwd)
        openDir(prev, { push: false })
      }
      const goForward = () => {
        const next = st.fwd.pop()
        if (!next) return
        st.back.push(st.cwd)
        openDir(next, { push: false })
      }
      const goUp = () => {
        if (inTrash) return openDir(places?.home || '/')
        if (st.cwd && st.cwd !== '/') openDir(parentRemote(st.cwd))
      }

      // —— 列表 ——
      const entries = useMemo(() => {
        const list = (data?.entries ?? []).filter((e) => st.hidden || !e.name.startsWith('.'))
        const dir = st.desc ? -1 : 1
        const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
        const cmp = st.sort === 'size' ? (a, b) => a.size - b.size || byName(a, b)
          : st.sort === 'mtime' ? (a, b) => a.mtime - b.mtime || byName(a, b)
            : byName
        return [...list].sort((a, b) => (Number(isDirLike(b)) - Number(isDirLike(a))) || dir * cmp(a, b))
      }, [data, st.hidden, st.sort, st.desc])
      const rows = inTrash ? (trash ?? []) : entries
      const keyOf = (item) => (inTrash ? item.id : item.name)
      const selectedItems = rows.filter((r) => selected.has(keyOf(r)))

      const clickRow = (e, item, index) => {
        setMenu(null)
        const key = keyOf(item)
        if (e.shiftKey && anchorRef.current !== null) {
          const [a, b] = [anchorRef.current, index].sort((x, y) => x - y)
          setSelected(new Set(rows.slice(a, b + 1).map(keyOf)))
          return
        }
        if (e.metaKey || e.ctrlKey) {
          const next = new Set(selected)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          setSelected(next)
        } else {
          setSelected(new Set([key]))
        }
        anchorRef.current = index
      }

      const sortBy = (key) => {
        if (st.sort === key) st.desc = !st.desc
        else {
          st.sort = key
          st.desc = key !== 'name' // 大小、时间默认从大到小
        }
        bump()
      }

      // —— 动作 ——
      async function openFile(item, path) {
        if (item.size > FILE_EDIT_LIMIT) {
          const ok = await ask({ title: L('文件太大，不能在这里打开', 'Too large to open here'), message: L(`${item.name} 有 ${fmtBytes(item.size)}，超过 1 MB。要下载到电脑上看吗？`, `${item.name} is ${fmtBytes(item.size)}, over 1 MB. Download it to your computer instead?`), confirm: L('下载', 'Download') })
          if (ok) download(path)
          return
        }
        setLoading(true)
        try {
          const res = await call('read', { path })
          setEditor({ path: res.path, name: item.name, content: res.content, original: res.content, sha: res.sha, saving: false, error: '' })
        } catch (e) {
          setLoading(false) // 读已经结束了，别让状态栏在问话期间一直写「正在读取」
          if (/二进制|UTF-8|binary/i.test(e.message)) {
            const ok = await ask({ title: L('不能当文本打开', 'Cannot open as text'), message: L(`${e.message}。要下载到电脑上吗？`, `${e.message}. Download it to your computer?`), confirm: L('下载', 'Download') })
            if (ok) download(path)
          } else {
            flash(e.message, 'error')
          }
        } finally {
          setLoading(false)
        }
      }

      function activate(item) {
        if (inTrash) return undefined
        const path = joinRemote(st.cwd, item.name)
        if (item.lossy) return flash(L('这个名字不是 UTF-8 编码，这里操作不了它：用终端处理', 'This name is not UTF-8 encoded and cannot be handled here: use the terminal'), 'error')
        if (isDirLike(item)) return openDir(path)
        if (item.type === 'link' && item.target === 'broken') return flash(L('这个链接指向的东西已经不在了', 'What this link points to is gone'), 'error')
        if (item.type === 'other') return flash(L('这不是普通文件（可能是设备或管道），不能打开', 'Not a regular file (perhaps a device or a pipe); it cannot be opened'), 'error')
        return openFile(item, path)
      }

      /** 让浏览器把一个地址（blob: 或下载链接）存成文件 */
      function saveAs(href, name) {
        const a = document.createElement('a')
        a.href = href
        a.download = name
        a.rel = 'noopener'
        a.style.display = 'none'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }

      // 下载由页面自己取回来再交给浏览器存：直接给浏览器一个下载链接的话，电脑上装的下载工具
      // （IDM、Folx 这类）会把下载截走、自己再请求一次，它没有 DSH 的登录状态，结果 403（用户实测）。
      // 页面自己取还能在底部显示进度、能取消。特别大的文件整个放进内存不合适，仍走下载链接
      async function download(path) {
        let res
        try {
          res = await call('download', { path })
        } catch (e) {
          return flash(e.message, 'error')
        }
        if (res.type === 'file' && res.size > DOWNLOAD_IN_PAGE_LIMIT) {
          saveAs(res.url, res.name)
          return flash(L(`${res.name} 有 ${fmtBytes(res.size)}，交给浏览器直接下载。下载工具要是截走了下不下来，把它对 DSH 的接管关掉再试`, `${res.name} is ${fmtBytes(res.size)}, so the browser downloads it directly. If a download manager takes it over and fails, turn off its interception for DSH and try again`))
        }
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const abort = new AbortController()
        const abortRef = { current: () => abort.abort() }
        const total = res.type === 'file' ? res.size : 0 // 文件夹是边打包边传，事先不知道多大
        const update = (patch) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)))
        setUploads((u) => [...u, { id, kind: 'download', name: res.name, total, loaded: 0, status: 'running', abortRef }])
        try {
          const r = await fetch(res.url, { credentials: 'same-origin', signal: abort.signal, headers: { 'x-dsh-vps-lang': lang() } })
          if (!r.ok) throw new Error((await r.text().catch(() => '')).trim() || L(`服务返回 HTTP ${r.status}`, `The server answered HTTP ${r.status}`))
          const chunks = []
          let got = 0
          let shown = 0
          const reader = r.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            got += value.length
            if (Date.now() - shown > 200) {
              shown = Date.now()
              update({ loaded: got })
            }
          }
          if (total && got !== total) throw new Error(L(`只收到 ${fmtBytes(got)}，文件有 ${fmtBytes(total)}，连接可能中断了`, `Only ${fmtBytes(got)} of ${fmtBytes(total)} arrived; the connection may have dropped`))
          const url = URL.createObjectURL(new Blob(chunks, { type: res.type === 'dir' ? 'application/gzip' : 'application/octet-stream' }))
          saveAs(url, res.name)
          setTimeout(() => URL.revokeObjectURL(url), 60_000)
          setUploads((u) => u.filter((x) => x.id !== id))
          flash(L(`已下载 ${res.name}（${fmtBytes(got)}），在浏览器或系统的「下载」里`, `Downloaded ${res.name} (${fmtBytes(got)}); it is in your browser's or system's Downloads`))
        } catch (e) {
          const cancelled = abort.signal.aborted
          update({ status: cancelled ? 'cancelled' : 'failed', error: e.message })
          if (!cancelled) flash(L(`${res.name} 没下载下来：${e.message}`, `${res.name} did not download: ${e.message}`), 'error')
        }
      }

      // 让 AI 看看：文件内容（打码后）先交给插件，再替用户在输入框发一句，AI 马上开始看。
      // 只附上、等用户自己发话的话，用户点完什么都没发生，以为功能坏了（用户实测）
      async function share(path, name) {
        // 刚交过的同一个文件：AI 正在看，再点只会多排一条一样的问题（停掉后那条还留在队里）
        const last = entry.lastShare
        if (last && last.path === path && Date.now() - last.at < 60_000) {
          flash(L(`${name} 刚交给 AI 了，结果在上面的对话里。要再看一遍，在输入框里说一句就行`, `${name} was just given to the AI; the answer is in the conversation above. To look again, just say so in the input box`))
          return
        }
        try {
          const res = await call('share', { path })
          const note = res.truncated ? L(`（文件有 ${fmtBytes(res.size)}，只给了最后 ${fmtBytes(res.bytes)}）`, ` (the file is ${fmtBytes(res.size)}; only the last ${fmtBytes(res.bytes)} was shared)`) : ''
          const r = await sendToChat(sessionId, L(`请看看这个服务器文件：${path}（内容已附上）。说说它是做什么的，有没有需要注意的问题`, `Please take a look at this server file: ${path} (its content is attached). What is it for, and is there anything to watch out for?`))
          entry.lastShare = { path, at: Date.now() }
          if (r === 'sent') flash(L(`已把 ${name} 交给 AI${note}，它正在看，结果在上面的对话里`, `Gave ${name} to the AI${note}; it is looking now, and the answer appears in the conversation above`))
          else if (r === 'queued') flash(L(`${name} 的问题已经在排队了，AI 忙完这一轮就会看`, `The question about ${name} is already queued; the AI looks at it after the current turn`))
          else if (r === 'draft') flash(L(`已把 ${name} 附上${note}。输入框里有你还没发出去的话，发出去时 AI 会一起看到这个文件`, `Attached ${name}${note}. The input box holds a message you have not sent; when you send it, the AI sees the file along with it`))
          else flash(L(`已把 ${name} 附上${note}，敏感内容已打码。在上面的输入框说一句（比如「看看这个文件有没有问题」）并发送，AI 就会看`, `Attached ${name}${note}, with secrets masked. Say something in the input box above (e.g. "check this file for problems") and send it, and the AI will look`))
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      function cdInTerminal(dir) {
        if (entry.socket?.readyState !== 1) return flash(L('终端还没连上，稍等一下再试', 'The terminal is not connected yet; try again in a moment'), 'error')
        setTab(entry, 'terminal')
        sendTerm(entry, { t: 'i', d: `cd ${shellQ(dir)}\r` })
        return undefined
      }

      async function copyPath(path) {
        try {
          await navigator.clipboard.writeText(path)
          flash(L(`已复制：${path}`, `Copied: ${path}`))
        } catch {
          flash(path) // 复制不了就把路径亮出来
        }
      }

      async function newFolder() {
        const name = await ask({ title: L('新建文件夹', 'New folder'), input: L('新建文件夹', 'New folder'), confirm: L('新建', 'Create') })
        if (!name) return
        try {
          await call('mkdir', { dir: st.cwd, name })
          await openDir(st.cwd, { push: false })
          setSelected(new Set([name]))
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      async function rename(item) {
        const to = await ask({ title: L('改名', 'Rename'), input: item.name, confirm: L('改名', 'Rename') })
        if (!to || to === item.name) return
        try {
          await call('rename', { dir: st.cwd, from: item.name, to })
          await openDir(st.cwd, { push: false })
          setSelected(new Set([to]))
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      async function trashItems(items) {
        if (!items.length) return
        const paths = items.map((i) => joinRemote(st.cwd, i.name))
        const names = items.slice(0, 3).map((i) => i.name).join(L('、', ', ')) + (items.length > 3 ? L(` 等 ${items.length} 项`, ` and ${items.length - 3} more`) : '')
        const system = paths.some((p) => SYSTEM_DIRS.test(p))
        const ok = await ask({
          title: L('移到回收站？', 'Move to the trash?'),
          message: L(`${names} 会移到服务器上的回收站，随时可以在左边「回收站」里还原。${system ? '这是系统目录里的东西，删掉可能让服务或系统出问题，确认你知道它是做什么的。' : ''}`, `${names} will move to the trash on the server; you can restore it any time from "Trash" on the left. ${system ? 'This is inside a system folder; deleting it may break services or the system, so make sure you know what it does.' : ''}`),
          confirm: L('移到回收站', 'Move to trash'),
          danger: system,
        })
        if (!ok) return
        try {
          const res = await call('trash', { paths })
          if (res.failed?.length) flash(L(`${res.failed.length} 项没删成：${res.failed[0].reason}`, `${res.failed.length} items were not deleted: ${res.failed[0].reason}`), 'error')
          else flash(L(`已移到回收站 ${res.moved.length} 项`, `Moved ${res.moved.length} items to the trash`))
          await openDir(st.cwd, { push: false })
          refreshPlaces()
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      async function restore(items) {
        if (!items.length) return
        try {
          const res = await call('restore', { ids: items.map((i) => i.id) })
          if (res.failed?.length) flash(res.failed[0].reason, 'error')
          else flash(L(`已还原 ${res.restored.length} 项到原来的位置`, `Restored ${res.restored.length} items to where they were`))
          await openTrash()
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      async function purge(items, all = false) {
        const ok = await ask({
          title: all ? L('清空回收站？', 'Empty the trash?') : L('彻底删除？', 'Delete permanently?'),
          message: all ? L(`回收站里的 ${trash?.length ?? 0} 项会从服务器上永久删除，不能再还原。回收站在服务器上，其他电脑上的插件删的东西也在里面。`, `The ${trash?.length ?? 0} items in the trash will be deleted from the server for good and cannot be restored. The trash lives on the server and also holds what the plugin on other computers deleted.`) : L(`${items.length} 项会从服务器上永久删除，不能再还原。`, `${items.length} items will be deleted from the server for good and cannot be restored.`),
          confirm: all ? L('清空', 'Empty') : L('彻底删除', 'Delete permanently'),
          danger: true,
        })
        if (!ok) return
        try {
          await call('purge', all ? { all: true } : { ids: items.map((i) => i.id) })
          flash(all ? L('回收站已清空', 'The trash is empty') : L('已彻底删除', 'Deleted permanently'))
          await openTrash()
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      async function startUpload(fileList) {
        const list = [...(fileList ?? [])]
        if (!list.length) return
        if (inTrash || !data) {
          flash(L('先进入一个文件夹再上传', 'Open a folder first, then upload'), 'error')
          return
        }
        if (!data.writable) {
          flash(L('这个文件夹没有写权限，传不进去', 'No write permission for this folder, so nothing can be uploaded'), 'error')
          return
        }
        const dir = st.cwd
        const existing = new Set(data.entries.map((e) => e.name))
        const clash = list.filter((f) => existing.has(f.name))
        if (clash.length) {
          const ok = await ask({
            title: L(`覆盖 ${clash.length} 个同名文件？`, `Overwrite ${clash.length} files with the same name?`),
            message: L(`${clash.slice(0, 3).map((f) => f.name).join('、')}${clash.length > 3 ? ' 等' : ''} 已经在这个文件夹里了。覆盖前会先把原文件备份到服务器的 ~/.cache/dsh-vps/backups/，权限和属主保持不变。`, `${clash.slice(0, 3).map((f) => f.name).join(', ')}${clash.length > 3 ? ' and more' : ''} already exist in this folder. Before overwriting, the originals are backed up to ~/.cache/dsh-vps/backups/ on the server, keeping their mode and owner.`),
            confirm: L('覆盖', 'Overwrite'),
          })
          if (!ok) return
        }
        let done = 0
        for (const file of list) {
          const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
          const abortRef = { current: null }
          setUploads((u) => [...u, { id, name: file.name, total: file.size, loaded: 0, status: 'running', abortRef }])
          const send = () => uploadOne({
            sessionId,
            path: joinRemote(dir, file.name),
            file,
            abortRef,
            onProgress: (loaded) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, loaded } : x))),
          })
          let res = await send()
          if (res.tokenStale && (await refreshToken())) res = await send() // 令牌过期：换新的再传一次
          if (res.ok) {
            done += 1
            setUploads((u) => u.filter((x) => x.id !== id))
          } else {
            setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: res.cancelled ? 'cancelled' : 'failed', error: res.error } : x)))
            if (!res.cancelled) flash(L(`${file.name} 没传上去：${res.error}`, `${file.name} did not upload: ${res.error}`), 'error')
          }
        }
        if (done) flash(L(`已上传 ${done} 个文件`, `Uploaded ${done} files`))
        if (st.view === 'dir' && st.cwd === dir) openDir(dir, { push: false })
      }

      function onDrop(e) {
        e.preventDefault()
        e.stopPropagation()
        setDrag(false)
        const dt = e.dataTransfer
        if (!dt) return
        const dirs = [...(dt.items ?? [])].filter((it) => it.webkitGetAsEntry?.()?.isDirectory).length
        const list = [...(dt.files ?? [])].filter((f, i) => !dt.items?.[i]?.webkitGetAsEntry?.()?.isDirectory)
        if (dirs) flash(L('文件夹暂时不能直接上传：先压缩成一个文件再传', 'Folders cannot be uploaded directly yet: compress it into one file first'), 'error')
        startUpload(list)
      }

      // —— 编辑器 ——
      const dirty = editor ? editor.content !== editor.original : false

      async function reloadEditor() {
        if (!editor) return
        try {
          const res = await call('read', { path: editor.path })
          setEditor((ed) => ({ ...ed, content: res.content, original: res.content, sha: res.sha, error: '' }))
          flash(L('已重新加载最新内容', 'Reloaded the latest content'))
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      async function saveEditor(force = false) {
        if (!editor || editor.saving) return
        const { path, content, sha } = editor
        setEditor((ed) => ({ ...ed, saving: true, error: '' }))
        try {
          const res = await call('save', { path, content, expectSha: sha, force })
          if (res.conflict) {
            setEditor((ed) => ({ ...ed, saving: false }))
            const choice = await ask({ title: L('文件被改过', 'The file has changed'), message: res.error, confirm: L('仍然覆盖', 'Overwrite anyway'), danger: true, extra: [{ label: L('重新加载', 'Reload'), value: 'reload' }] })
            if (choice === true) return saveEditor(true)
            if (choice === 'reload') return reloadEditor()
            return undefined
          }
          setEditor((ed) => ({ ...ed, saving: false, original: content, sha: res.sha || '' }))
          flash(L(`已保存${res.backupPath ? '，原文件已备份' : ''}`, `Saved${res.backupPath ? '; the original was backed up' : ''}`))
          if (st.view === 'dir') openDir(st.cwd, { push: false })
        } catch (e) {
          setEditor((ed) => ({ ...ed, saving: false, error: e.message }))
        }
        return undefined
      }

      async function closeEditor() {
        if (dirty) {
          const ok = await ask({ title: L('放弃修改？', 'Discard changes?'), message: L('改动还没保存，关掉就没了。', 'The changes are not saved; closing loses them.'), confirm: L('放弃修改', 'Discard changes'), danger: true })
          if (!ok) return
        }
        setEditor(null)
      }

      function editorKey(e) {
        e.stopPropagation()
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          saveEditor()
        } else if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault()
          const ta = e.currentTarget
          const unit = indentUnit(editor.content)
          const { selectionStart: a, selectionEnd: b, value } = ta
          const next = value.slice(0, a) + unit + value.slice(b)
          setEditor((ed) => ({ ...ed, content: next }))
          requestAnimationFrame(() => {
            ta.selectionStart = ta.selectionEnd = a + unit.length
          })
        } else if (e.key === 'Escape') {
          closeEditor()
        }
      }

      // —— 键盘：面板里的按键不交给 DSH（它的快捷键会抢走） ——
      function onKeyDown(e) {
        e.stopPropagation()
        if (dialog || editor) return
        const tag = e.target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (e.key === 'Escape') setMenu(null)
        else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItems.length) {
          e.preventDefault()
          if (inTrash) purge(selectedItems)
          else trashItems(selectedItems)
        } else if (e.key === 'Enter' && selectedItems.length === 1) {
          e.preventDefault()
          activate(selectedItems[0])
        } else if (e.key === 'F2' && selectedItems.length === 1 && !inTrash) {
          e.preventDefault()
          rename(selectedItems[0])
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault()
          setSelected(new Set(rows.map(keyOf)))
        }
      }

      // —— 右键菜单 ——
      function openMenu(e, item, index) {
        e.preventDefault()
        e.stopPropagation()
        if (item && !selected.has(keyOf(item))) {
          setSelected(new Set([keyOf(item)]))
          anchorRef.current = index
        }
        const box = rootRef.current?.getBoundingClientRect()
        setMenu({ x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0), item: item ?? null })
      }

      function menuItems() {
        if (!menu) return []
        if (inTrash) {
          const items = selectedItems.length ? selectedItems : menu.item ? [menu.item] : []
          if (!items.length) return [[L('清空回收站', 'Empty trash'), () => purge([], true), { danger: true, disabled: !trash?.length }]]
          return [
            [L(`还原${items.length > 1 ? ` ${items.length} 项` : ''}`, `Restore${items.length > 1 ? ` ${items.length} items` : ''}`), () => restore(items)],
            null,
            [L(`彻底删除${items.length > 1 ? ` ${items.length} 项` : ''}`, `Delete permanently${items.length > 1 ? ` ${items.length} items` : ''}`), () => purge(items), { danger: true }],
          ]
        }
        const item = menu.item
        if (!item) {
          return [
            [L('新建文件夹', 'New folder'), newFolder, { disabled: !data?.writable }],
            [L('上传文件…', 'Upload files…'), () => fileInput.current?.click(), { disabled: !data?.writable }],
            [L('刷新', 'Refresh'), refresh],
            null,
            [L('在终端打开此目录', 'Open this folder in the terminal'), () => cdInTerminal(st.cwd)],
            [L('复制路径', 'Copy path'), () => copyPath(st.cwd)],
          ]
        }
        if (selectedItems.length > 1) {
          return [[L(`移到回收站（${selectedItems.length} 项）`, `Move to trash (${selectedItems.length} items)`), () => trashItems(selectedItems), { danger: true }]]
        }
        const path = joinRemote(st.cwd, item.name)
        if (item.lossy) return [[L('在终端打开此目录', 'Open this folder in the terminal'), () => cdInTerminal(st.cwd)]]
        if (isDirLike(item)) {
          return [
            [L('打开', 'Open'), () => openDir(path)],
            [L('下载（打包成 .tar.gz）', 'Download (as .tar.gz)'), () => download(path)],
            [L('在终端打开此目录', 'Open this folder in the terminal'), () => cdInTerminal(path)],
            null,
            [L('改名', 'Rename'), () => rename(item)],
            [L('复制路径', 'Copy path'), () => copyPath(path)],
            null,
            [L('移到回收站', 'Move to trash'), () => trashItems([item]), { danger: true }],
          ]
        }
        const file = item.type === 'file' || (item.type === 'link' && item.target === 'file')
        return [
          [L('编辑', 'Edit'), () => openFile(item, path), { disabled: !file || item.size > FILE_EDIT_LIMIT }],
          [L('下载', 'Download'), () => download(path), { disabled: !file }],
          [L('让 AI 看看这个文件', 'Let the AI look at this file'), () => share(path, item.name), { disabled: !file, accent: true }],
          [L('在终端打开所在目录', 'Open its folder in the terminal'), () => cdInTerminal(st.cwd)],
          null,
          [L('改名', 'Rename'), () => rename(item)],
          [L('复制路径', 'Copy path'), () => copyPath(path)],
          null,
          [L('移到回收站', 'Move to trash'), () => trashItems([item]), { danger: true }],
        ]
      }

      // —— 样式小零件 ——
      const btn = (label, onClick, { title, disabled, primary, danger, active, width } = {}) => h('button', {
        type: 'button',
        title,
        disabled,
        onClick: (e) => {
          e.stopPropagation()
          onClick(e)
        },
        onMouseEnter: (e) => {
          if (!disabled && !primary) e.currentTarget.style.background = c.hover
        },
        onMouseLeave: (e) => {
          if (!primary) e.currentTarget.style.background = active ? c.hover : 'transparent'
        },
        style: {
          border: primary ? 'none' : `0.5px solid ${active ? c.border : 'transparent'}`,
          background: primary ? c.accent : active ? c.hover : 'transparent',
          color: primary ? '#fff' : danger ? c.danger : c.secondary,
          borderRadius: 7, height: 26, minWidth: width ?? 26, padding: '0 8px', fontSize: 12, fontWeight: 500,
          cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, whiteSpace: 'nowrap', flex: '0 0 auto',
        },
      }, label)

      const placeRow = (label, path, active, onClick, extra) => h('button', {
        key: label,
        type: 'button',
        onClick,
        title: path,
        style: {
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', border: 'none', textAlign: 'left',
          background: active ? c.selected : 'transparent', color: active ? c.text : c.secondary,
          borderRadius: 7, padding: '5px 8px', fontSize: 12, cursor: 'pointer',
        },
      }, h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
      extra ? h('span', { style: { color: c.tertiary, fontSize: 11 } }, extra) : null)

      // 面包屑：点哪一段就去哪；点空白处直接输入路径
      const crumbs = () => {
        const parts = (st.cwd || '/').split('/').filter(Boolean)
        const out = [h('button', { key: '/', type: 'button', onClick: (e) => { e.stopPropagation(); openDir('/') }, style: crumbStyle(parts.length === 0) }, '/')]
        parts.forEach((p, i) => {
          const path = `/${parts.slice(0, i + 1).join('/')}`
          if (i) out.push(h('span', { key: `s${i}`, style: { color: c.tertiary, padding: '0 1px' } }, '›'))
          out.push(h('button', { key: path, type: 'button', onClick: (e) => { e.stopPropagation(); openDir(path) }, style: crumbStyle(i === parts.length - 1) }, p))
        })
        return out
      }
      function crumbStyle(last) {
        return {
          border: 'none', background: 'transparent', padding: '0 3px', fontSize: 12, cursor: 'pointer',
          color: last ? c.text : c.secondary, fontWeight: last ? 500 : 400, whiteSpace: 'nowrap',
        }
      }

      const inputStyle = {
        width: '100%', boxSizing: 'border-box', height: 26, borderRadius: 7, border: `0.5px solid ${c.field}`,
        background: 'transparent', color: c.text, padding: '0 8px', fontSize: 12, fontFamily: c.code, outline: 'none',
      }

      // —— 区块 ——
      const toolbar = inTrash
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px', height: 38, borderBottom: `0.5px solid ${c.divider}` } },
          btn('‹', goUp, { title: L('回到家目录', 'Back to home') }),
          h('span', { style: { fontWeight: 500, fontSize: 12, marginLeft: 4 } }, L('回收站', 'Trash')),
          h('span', { style: { color: c.tertiary, fontSize: 12 } }, L('· 删掉的东西都在这里，服务器上的 ~/.cache/dsh-vps/trash', '· everything deleted is here, ~/.cache/dsh-vps/trash on the server')),
          h('span', { style: { flex: 1 } }),
          btn('↻', refresh, { title: L('刷新', 'Refresh') }),
          btn(L('还原', 'Restore'), () => restore(selectedItems), { disabled: !selectedItems.length }),
          btn(L('彻底删除', 'Delete permanently'), () => purge(selectedItems), { disabled: !selectedItems.length, danger: true }),
          btn(L('清空回收站', 'Empty trash'), () => purge([], true), { disabled: !trash?.length, danger: true }))
        : h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px', height: 38, borderBottom: `0.5px solid ${c.divider}` } },
          btn('‹', goBack, { title: L('后退', 'Back'), disabled: !st.back.length }),
          btn('›', goForward, { title: L('前进', 'Forward'), disabled: !st.fwd.length }),
          btn('↑', goUp, { title: L('上一级', 'Up one level'), disabled: !st.cwd || st.cwd === '/' }),
          pathDraft !== null
            ? h('input', {
              autoFocus: true,
              value: pathDraft,
              onChange: (e) => setPathDraft(e.target.value),
              onBlur: () => setPathDraft(null),
              onKeyDown: (e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  const target = pathDraft.trim()
                  setPathDraft(null)
                  if (target) openDir(target.startsWith('~') ? `${places?.home ?? ''}${target.slice(1)}` : target)
                } else if (e.key === 'Escape') setPathDraft(null)
              },
              style: { ...inputStyle, flex: 1, minWidth: 0, margin: '0 4px' },
            })
            : h('div', {
              title: L('点空白处可以直接输入路径', 'Click the empty space to type a path'),
              onClick: () => setPathDraft(st.cwd),
              style: {
                flex: 1, minWidth: 0, margin: '0 4px', height: 26, display: 'flex', alignItems: 'center', gap: 0,
                border: `0.5px solid ${c.field}`, borderRadius: 7, padding: '0 4px', overflow: 'hidden', cursor: 'text',
              },
            }, h('div', { style: { display: 'flex', alignItems: 'center', overflow: 'hidden', direction: 'rtl' } },
              h('div', { style: { display: 'flex', alignItems: 'center', direction: 'ltr' } }, crumbs()))),
          btn('↻', refresh, { title: L('刷新', 'Refresh') }),
          btn(L('新建文件夹', 'New folder'), newFolder, { disabled: !data?.writable, title: data?.writable === false ? L('这个文件夹没有写权限', 'No write permission for this folder') : undefined }),
          btn(st.hidden ? L('✓ 显示隐藏文件', '✓ Show hidden files') : L('显示隐藏文件', 'Show hidden files'), () => { st.hidden = !st.hidden; bump() }, { active: st.hidden, title: L('以 . 开头的文件，比如 .env、.htaccess', 'Files starting with ., such as .env and .htaccess') }),
          btn(L('上传', 'Upload'), () => fileInput.current?.click(), { primary: true, disabled: !data?.writable, title: data?.writable === false ? L('这个文件夹没有写权限', 'No write permission for this folder') : L('也可以把文件直接拖进来', 'You can also drag files straight in') }))

      const home = places?.home || ''
      const sidebar = h('div', { style: { width: 132, flex: '0 0 auto', borderRight: `0.5px solid ${c.divider}`, padding: '8px 6px', overflowY: 'auto', boxSizing: 'border-box' } },
        h('div', { style: { color: c.tertiary, fontSize: 11, padding: '2px 8px 6px' } }, L('常用位置', 'Places')),
        placeRow(L('家目录', 'Home'), home, !inTrash && st.cwd === home, () => openDir(home || '/')),
        places?.web ? placeRow(L('网站', 'Websites'), places.web, !inTrash && st.cwd === places.web, () => openDir(places.web)) : null,
        placeRow(L('配置 /etc', 'Config /etc'), '/etc', !inTrash && st.cwd === '/etc', () => openDir('/etc')),
        placeRow(L('日志 /var/log', 'Logs /var/log'), '/var/log', !inTrash && st.cwd === '/var/log', () => openDir('/var/log')),
        placeRow(L('根目录 /', 'Root /'), '/', !inTrash && st.cwd === '/', () => openDir('/')),
        h('div', { style: { height: 1, background: c.divider, margin: '6px 8px' } }),
        placeRow(L('回收站', 'Trash'), '~/.cache/dsh-vps/trash', inTrash, openTrash, places?.trash ? String(places.trash) : ''))

      const th = (label, key, width, align = 'left') => h('div', {
        role: 'button',
        onClick: key ? () => sortBy(key) : undefined,
        style: { width, flex: width ? '0 0 auto' : 1, textAlign: align, cursor: key ? 'pointer' : 'default', color: st.sort === key ? c.secondary : c.tertiary, whiteSpace: 'nowrap', overflow: 'hidden' },
      }, label, key && st.sort === key ? (st.desc ? ' ↓' : ' ↑') : '')

      const cell = (text, width, align = 'left', color = c.secondary) => h('div', {
        style: { width, flex: '0 0 auto', textAlign: align, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums' },
      }, text)

      const header = inTrash
        ? h('div', { style: { display: 'flex', gap: 12, padding: '6px 12px', fontSize: 11, borderBottom: `0.5px solid ${c.divider}` } },
          th(L('名称', 'Name')), th(L('原来的位置', 'Original location'), null, 220), th(L('删除时间', 'Deleted'), null, 96), th(L('大小', 'Size'), null, 64, 'right'))
        : h('div', { style: { display: 'flex', gap: 12, padding: '6px 12px', fontSize: 11, borderBottom: `0.5px solid ${c.divider}` } },
          th(L('名称', 'Name'), 'name'), th(L('大小', 'Size'), 'size', 64, 'right'), th(L('修改时间', 'Modified'), 'mtime', 96), th(L('权限', 'Mode'), null, 40), th(L('所有者', 'Owner'), null, 56))

      const rowView = (item, index) => {
        const key = keyOf(item)
        const isSel = selected.has(key)
        const kind = inTrash ? (item.type === 'dir' ? 'dir' : 'file') : isDirLike(item) ? 'dir' : item.type === 'link' ? 'link' : 'file'
        const iconColor = kind === 'dir' ? c.accent : c.tertiary
        return h('div', {
          key,
          onClick: (e) => {
            e.stopPropagation() // 不然冒泡到列表空白处，刚选中的又被清掉
            clickRow(e, item, index)
          },
          onDoubleClick: () => activate(item),
          onContextMenu: (e) => openMenu(e, item, index),
          onMouseEnter: (e) => {
            if (!isSel) e.currentTarget.style.background = c.hover
          },
          onMouseLeave: (e) => {
            if (!isSel) e.currentTarget.style.background = 'transparent'
          },
          style: {
            display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px', height: 28, fontSize: 12.5, cursor: 'default',
            background: isSel ? c.selected : 'transparent', userSelect: 'none',
          },
        },
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 } },
            h(FileIcon, { kind, color: iconColor }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: item.name.startsWith('.') ? c.secondary : c.text } }, item.name),
            item.type === 'link' ? h('span', { style: { color: item.target === 'broken' ? c.danger : c.tertiary, fontSize: 11, flex: '0 0 auto' } }, item.target === 'broken' ? L('链接已失效', 'broken link') : L('链接', 'link')) : null),
          inTrash
            ? [cell(item.origin, 220, 'left', c.tertiary), cell(fmtTime(item.deletedAt), 96), cell(item.type === 'dir' ? '—' : fmtBytes(item.size), 64, 'right')]
            : [cell(isDirLike(item) ? '—' : fmtBytes(item.size), 64, 'right'), cell(fmtTime(item.mtime), 96), cell(item.mode, 40, 'left', c.tertiary), cell(item.owner, 56, 'left', c.tertiary)])
      }

      const empty = (text) => h('div', { style: { padding: '28px 12px', textAlign: 'center', color: c.tertiary, fontSize: 12 } }, text)

      const listArea = h('div', {
        onClick: () => {
          setSelected(new Set())
          setMenu(null)
        },
        onContextMenu: (e) => openMenu(e, null, -1),
        style: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' },
      },
        error
          ? h('div', { style: { padding: '24px 16px', fontSize: 12.5, color: c.danger, lineHeight: 1.6 } },
            error,
            h('div', { style: { marginTop: 10, display: 'flex', gap: 6 } },
              btn(L('重试', 'Retry'), refresh, { active: true }),
              home ? btn(L('回到家目录', 'Back to home'), () => openDir(home), { active: true }) : null))
          : !rows.length
            ? empty(loading ? L('正在读取…', 'Reading…') : inTrash ? L('回收站是空的', 'The trash is empty') : L('这个文件夹是空的。把电脑上的文件拖进来就能上传', 'This folder is empty. Drag files from your computer here to upload them'))
            : rows.map(rowView))

      const statusText = inTrash
        ? L(`${rows.length} 项${selectedItems.length ? ` · 已选 ${selectedItems.length} 项` : ''}`, `${rows.length} items${selectedItems.length ? ` · ${selectedItems.length} selected` : ''}`)
        : data
          ? [
            L(`${rows.length} 项${data.entries.length !== rows.length ? `（另有 ${data.entries.length - rows.length} 个隐藏文件）` : ''}`, `${rows.length} items${data.entries.length !== rows.length ? ` (plus ${data.entries.length - rows.length} hidden)` : ''}`),
            selectedItems.length ? L(`已选 ${selectedItems.length} 项`, `${selectedItems.length} selected`) : '',
            data.truncated ? L('只显示前 3000 项', 'showing the first 3000 only') : '',
            data.writable ? '' : L('只读', 'read-only'),
          ].filter(Boolean).join(' · ')
          : ''

      const uploadRows = uploads.map((u) => h('div', { key: u.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', fontSize: 12, borderTop: `0.5px solid ${c.divider}` } },
        h('span', { style: { color: u.status === 'failed' ? c.danger : c.secondary, flex: '0 0 auto' } },
          u.status === 'running' ? (u.kind === 'download' ? L('下载', 'Download') : L('上传', 'Upload')) : u.status === 'cancelled' ? L('已取消', 'Cancelled') : L('失败', 'Failed')),
        h('span', { style: { maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, u.name),
        h('span', { style: { flex: 1, height: 4, borderRadius: 2, background: c.divider, overflow: 'hidden' } },
          h('span', { style: { display: 'block', height: '100%', width: `${u.total ? Math.round((u.loaded / u.total) * 100) : 100}%`, background: u.status === 'failed' ? c.danger : c.accent, opacity: u.total || u.status !== 'running' ? 1 : 0.4 } })),
        h('span', { style: { color: c.tertiary, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' } }, u.total ? `${fmtBytes(u.loaded)} / ${fmtBytes(u.total)}` : fmtBytes(u.loaded)),
        u.status === 'running'
          ? btn(L('取消', 'Cancel'), () => u.abortRef.current?.(), {})
          : btn('×', () => setUploads((list) => list.filter((x) => x.id !== u.id)), { title: L('关掉', 'Dismiss') })))

      const noticeRow = notice ? h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12, lineHeight: 1.5,
          borderTop: `0.5px solid ${c.divider}`, background: c.tip, color: notice.tone === 'error' ? c.danger : c.secondary,
        },
      }, h('span', { style: { flex: 1 } }, notice.text), btn('×', () => setNotice(null), { title: L('关掉', 'Dismiss') })) : null

      const status = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 26, fontSize: 11, color: c.tertiary, borderTop: `0.5px solid ${c.divider}` } },
        h('span', { style: { flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' } }, loading ? L('正在读取…', 'Reading…') : statusText),
        !inTrash && data?.freeBytes !== null && data?.freeBytes !== undefined ? h('span', null, L(`磁盘剩余 ${fmtBytes(data.freeBytes)}`, `${fmtBytes(data.freeBytes)} free`)) : null)

      // —— 浮层：右键菜单、对话框、编辑器、拖放提示 ——
      const menuView = menu ? (() => {
        const items = menuItems()
        const box = rootRef.current?.getBoundingClientRect()
        const width = 190
        const height = items.length * 28 + 8
        const left = Math.max(4, Math.min(menu.x, (box?.width ?? 600) - width - 4))
        const top = Math.max(4, Math.min(menu.y, (box?.height ?? 400) - height - 4))
        return h('div', {
          onClick: (e) => e.stopPropagation(),
          onContextMenu: (e) => e.preventDefault(),
          style: {
            position: 'absolute', left, top, width, zIndex: 5, padding: 4, borderRadius: 10, boxSizing: 'border-box',
            background: c.bg, border: `0.5px solid ${c.border}`, boxShadow: '0 8px 24px rgba(0,0,0,0.16)',
          },
        }, items.map((it, i) => (it === null
          ? h('div', { key: `sep${i}`, style: { height: 1, background: c.divider, margin: '4px 6px' } })
          : h('button', {
            key: it[0],
            type: 'button',
            disabled: it[2]?.disabled,
            onClick: () => {
              setMenu(null)
              it[1]()
            },
            onMouseEnter: (e) => {
              if (!it[2]?.disabled) e.currentTarget.style.background = c.hover
            },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
            style: {
              display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', borderRadius: 6,
              height: 28, padding: '0 10px', fontSize: 12.5, cursor: it[2]?.disabled ? 'default' : 'pointer',
              color: it[2]?.danger ? c.danger : it[2]?.accent ? c.accent : c.text, opacity: it[2]?.disabled ? 0.4 : 1,
            },
          }, it[0]))))
      })() : null

      const closeDialog = (value) => {
        dialog?.resolve(value)
        setDialog(null)
      }
      const dialogView = dialog ? h('div', {
        onClick: (e) => {
          e.stopPropagation()
          closeDialog(null)
        },
        style: { position: 'absolute', inset: 0, zIndex: 8, background: 'rgba(0,0,0,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      }, h('div', {
        onClick: (e) => e.stopPropagation(),
        style: { width: 380, maxWidth: '90%', background: c.bg, color: c.text, borderRadius: 12, border: `0.5px solid ${c.border}`, padding: 16, boxShadow: '0 12px 32px rgba(0,0,0,0.2)' },
      },
        h('div', { style: { fontWeight: 600, fontSize: 14, marginBottom: 8 } }, dialog.title),
        dialog.message ? h('div', { style: { fontSize: 12.5, color: c.secondary, lineHeight: 1.6, marginBottom: 12 } }, dialog.message) : null,
        dialog.input !== undefined ? h('input', {
          autoFocus: true,
          value: dialog.value,
          onFocus: (e) => {
            const v = e.target.value
            const dot = v.lastIndexOf('.')
            e.target.setSelectionRange(0, dot > 0 ? dot : v.length) // 改名时先选中不带扩展名的部分
          },
          onChange: (e) => setDialog((d) => ({ ...d, value: e.target.value })),
          onKeyDown: (e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && dialog.value.trim()) closeDialog(dialog.value.trim())
            if (e.key === 'Escape') closeDialog(null)
          },
          style: { ...inputStyle, height: 30, fontFamily: 'inherit', fontSize: 13, marginBottom: 14 },
        }) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          btn(L('取消', 'Cancel'), () => closeDialog(null), { active: true }),
          ...(dialog.extra ?? []).map((x) => btn(x.label, () => closeDialog(x.value), { active: true })),
          h('button', {
            type: 'button',
            autoFocus: dialog.input === undefined,
            disabled: dialog.input !== undefined && !dialog.value.trim(),
            onClick: () => closeDialog(dialog.input !== undefined ? dialog.value.trim() : true),
            onKeyDown: (e) => e.stopPropagation(),
            style: {
              border: 'none', borderRadius: 7, height: 26, padding: '0 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              background: dialog.danger ? c.danger : c.accent, color: '#fff',
            },
          }, dialog.confirm ?? L('确定', 'OK'))))) : null

      const editorView = editor ? h('div', {
        onClick: (e) => e.stopPropagation(),
        style: { position: 'absolute', inset: 0, zIndex: 6, background: c.bg, display: 'flex', flexDirection: 'column' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px 0 12px', height: 38, borderBottom: `0.5px solid ${c.divider}` } },
          h(FileIcon, { kind: 'file', color: c.tertiary }),
          h('span', { style: { fontWeight: 500, fontSize: 12.5 } }, editor.name),
          h('span', { style: { color: c.tertiary, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 } }, editor.path),
          dirty ? h('span', { style: { color: c.secondary, fontSize: 12, flex: '0 0 auto' } }, L('● 未保存', '● unsaved')) : null,
          btn(L('让 AI 看看', 'Let the AI look'), () => share(editor.path, editor.name), { title: L('把保存在服务器上的版本交给 AI', 'Give the version saved on the server to the AI') }),
          btn(editor.saving ? L('保存中…', 'Saving…') : L('保存', 'Save'), () => saveEditor(), { primary: true, disabled: !dirty || editor.saving, title: L('⌘S / Ctrl+S；保存前会自动备份原文件', '⌘S / Ctrl+S; the original is backed up before saving') }),
          btn(L('关闭', 'Close'), closeEditor, { active: true })),
        LOCKOUT_FILES.test(editor.path)
          ? h('div', { style: { padding: '6px 12px', fontSize: 12, background: c.tip, color: c.danger, lineHeight: 1.5 } },
            L('这个文件改错了可能导致连不上服务器或登录不了。保存前会自动备份；如果要重启服务让它生效，建议让 AI 来做（它会先设好连不上时的自动恢复）。', 'A mistake in this file can cut you off from the server or stop logins. It is backed up before saving; if a service must restart for it to take effect, let the AI do it (it sets up an automatic restore first in case the connection is lost).'))
          : null,
        editor.error ? h('div', { style: { padding: '6px 12px', fontSize: 12, background: c.tip, color: c.danger } }, editor.error) : null,
        h('textarea', {
          value: editor.content,
          spellCheck: false,
          autoFocus: true,
          wrap: 'off',
          onChange: (e) => {
            const content = e.target.value
            setEditor((ed) => ({ ...ed, content }))
          },
          onKeyDown: editorKey,
          style: {
            flex: 1, minHeight: 0, resize: 'none', border: 'none', outline: 'none', padding: '10px 12px', margin: 0,
            background: 'transparent', color: c.text, fontFamily: c.code, fontSize: 12.5, lineHeight: 1.55, tabSize: 4,
            whiteSpace: 'pre', overflow: 'auto', boxSizing: 'border-box',
          },
        })) : null

      const dropView = drag ? h('div', {
        style: {
          position: 'absolute', inset: 6, zIndex: 4, borderRadius: 10, border: `1.5px dashed ${c.accent}`, background: c.selected,
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.accent, fontSize: 13, fontWeight: 500, pointerEvents: 'none',
        },
      }, L(`松手就上传到 ${st.cwd || '这里'}`, `Drop to upload to ${st.cwd || 'here'}`)) : null

      return h('div', {
        ref: rootRef,
        tabIndex: -1,
        onKeyDown,
        onDragOver: (e) => {
          if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return
          e.preventDefault()
          e.stopPropagation()
          if (!inTrash && data?.writable && !editor) setDrag(true)
        },
        onDragLeave: (e) => {
          if (!rootRef.current?.contains(e.relatedTarget)) setDrag(false)
        },
        onDrop,
        onClick: () => setMenu(null),
        style: {
          position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', outline: 'none',
          background: c.bg, color: c.text, fontSize: 12.5,
        },
      },
        toolbar,
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } },
          sidebar,
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } }, header, listArea)),
        uploadRows,
        noticeRow,
        status,
        h('input', {
          ref: fileInput,
          type: 'file',
          multiple: true,
          style: { display: 'none' },
          onChange: (e) => {
            const list = [...(e.target.files ?? [])]
            e.target.value = ''
            startUpload(list)
          },
        }),
        dropView,
        menuView,
        editorView,
        dialogView)
    }

    /** 输入框下方：终端（打开时）+ 状态提醒（有事时） */
    function VpsDock(props) {
      useLang()
      const sessionId = props?.sessionId ? String(props.sessionId) : ''
      const { alias } = useBinding(sessionId)
      const entry = useTermState(sessionId)
      const prefs = useTermPrefs()
      useEffect(() => {
        if (sessionId && alias) restoreTerminal(sessionId, alias)
      }, [sessionId, alias])
      const alert = h(VpsAlert, { key: 'alert', ...props })
      if (!alias || !entry || entry.alias !== alias) return alert
      const view = entry.view === 'minimized'
        ? h(TerminalBar, { key: `bar:${entry.key}`, entry, prefs })
        : h(TerminalPanel, { key: `panel:${entry.key}`, entry, prefs })
      return h(React.Fragment, null, view, alert)
    }

    // —— 设置 → VPS 管理 → 终端 ——

    function Segmented({ value, options, onChange }) {
      const k = { track: T.segTrack, on: T.segOn, edge: T.border, text: T.text, idle: T.secondary }
      return h('span', { role: 'radiogroup', style: seg.track(k) }, options.map((o) => {
        const on = o.value === value
        return h('button', {
          key: String(o.value),
          type: 'button',
          role: 'radio',
          'aria-checked': on,
          onClick: () => { if (!on) onChange(o.value) },
          ...seg.hover(k, on),
          style: seg.item(k, on, { height: 26, padding: '0 12px', fontSize: 13 }),
        }, o.label)
      }))
    }

    function TerminalSettingsCard({ settings, setSettings }) {
      const [msg, setMsg] = useState('')
      const [error, setError] = useState('')
      const prefs = normalizeTermPrefs(settings.terminal)
      const save = async (patch) => {
        setError('')
        const next = { ...settings, ...patch }
        setSettings(next)
        try {
          await api('settings/save', { settings: patch })
          if (patch.terminal) writeTermPrefs(patch.terminal)
          setMsg(L('已保存', 'Saved'))
        } catch (e) {
          setError(e.message)
        }
      }
      const setPref = (key, value) => save({ terminal: { ...prefs, [key]: value } })
      const row = (label, control, hint) => h('div', { style: { display: 'flex', gap: 12, padding: '8px 0', alignItems: 'flex-start' } },
        h('div', { style: { width: 96, flex: '0 0 auto', fontSize: 13, paddingTop: 4 } }, label),
        h('div', { style: { flex: 1, minWidth: 0 } },
          control,
          hint ? h('div', { style: { ...S.muted, fontSize: 11, marginTop: 4 } }, hint) : null))

      return h('div', { style: S.card },
        h('div', { style: S.spread },
          h('div', { style: S.h2 }, L('终端', 'Terminal')),
          msg ? h('span', { style: { ...S.muted, fontSize: 11 } }, msg) : null),
        h(ErrorBar, { error }),
        row(L('颜色方案', 'Colour scheme'),
          h(Segmented, { value: prefs.theme, options: TERM_THEMES, onChange: (v) => setPref('theme', v) }),
          L('跟随系统：和 DSH 的外观保持一致（DSH 外观设成跟随系统时，就跟着电脑的深浅色走）', 'Follow system: matches DSH\'s appearance (when DSH follows the system, it follows your computer\'s light or dark mode)')),
        row(L('字号', 'Font size'),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
            h(Btn, { disabled: prefs.fontSize <= 11, onClick: () => setPref('fontSize', prefs.fontSize - 1), title: L('减小字号', 'Smaller') }, '−'),
            h('span', { style: { minWidth: 36, textAlign: 'center' } }, `${prefs.fontSize} px`),
            h(Btn, { disabled: prefs.fontSize >= 20, onClick: () => setPref('fontSize', prefs.fontSize + 1), title: L('增大字号', 'Larger') }, '+'))),
        row(L('断线后保留', 'Keep after disconnect'),
          h(Segmented, { value: prefs.keepMinutes, options: TERM_KEEP, onChange: (v) => setPref('keepMinutes', v) }),
          L('刷新页面或网络断开后，服务器上的终端保留多久。这段时间内回来会自动接上，断开期间的输出也补回来', 'How long the terminal on the server is kept after a reload or network drop. Come back within that time and it reconnects, replaying the output you missed')),
        row(L('其他设备', 'Other devices'),
          h('label', { style: S.row },
            h('input', {
              type: 'checkbox',
              checked: Boolean(settings.allowTerminalRemote),
              onChange: (e) => save({ allowTerminalRemote: e.target.checked }),
            }),
            h('span', null, L('允许从其他设备打开 VPS 终端', 'Allow opening the VPS terminal from other devices'))),
          L('终端等于服务器的完整操作权限。默认只能在运行 DSH 的这台电脑上打开；用局域网地址或反向代理访问 DSH 时才需要勾选', 'The terminal is full control of the server. By default it only opens on the computer running DSH; tick this only when you reach DSH through a LAN address or a reverse proxy')),
        h('div', { style: { ...S.muted, fontSize: 12, lineHeight: 1.8, marginTop: 6, borderTop: line, paddingTop: 8 } },
          h('div', null, L('对话头部「VPS」后面的 >_ 打开终端；再点一次最小化，再点恢复。面板标题栏切到「文件」就是文件管理', '>_ after "VPS" in the conversation header opens the terminal; click again to minimize, again to restore. Switch the panel\'s title bar to "Files" to manage files')),
          h('div', null, L('终端右上角：红色 × 结束（服务器上的 shell 一起结束）· 黄色 − 最小化成输入框下方的横栏 · 绿色最大化（再点恢复，双击标题栏也行）', 'Top right of the terminal: red × ends it (the shell on the server too) · yellow − minimizes to a bar below the input box · green maximizes (click again, or double-click the title bar, to restore)')),
          h('div', null, L('最小化、切到别的对话再回来，终端和里面的内容都还在', 'Minimize, switch to another conversation and come back: the terminal and everything in it are still there'))))
    }

    // ——————————————————————— 注册 ———————————————————————

    const name = 'vps-manager-client'
    const inject = ['slots']

    function injectStyles() {
      try {
        if (document.getElementById('dsh-vps-styles')) return
        const style = document.createElement('style')
        style.id = 'dsh-vps-styles'
        style.textContent = [
          '@keyframes dshVpsPulse{0%,100%{opacity:1}50%{opacity:.4}}',
          '@keyframes dshVpsSpin{to{transform:rotate(360deg)}}',
          // DSH 0.1.7 起，输入框下面那一栏是「居中、不换行」的一行，里面除了插件插槽
          // 还有 DSH 自己的用量显示（轮次 / token / 上下文占比）。终端面板挤在那一行里，
          // 会把用量显示推到两边、互相压着（用户实测截图）。这里让那一栏可以换行，
          // 并把我们的东西排到最后：用量显示留在原来那行，我们另起一行。
          // 插槽外层是 display:contents，所以真正排版的是「爷爷」那一层，两层都写上；
          // 真正的兜底在 claimOwnRow（运行时往上找那一层），CSS 只是让首帧就不错位。
          // 宽度 100%：那一栏原本随内容伸缩，终端按它适配会越缩越窄（见 claimOwnRow）
          'div:has(> [data-vps-dock]),div:has(> * > [data-vps-dock]){flex-wrap:wrap;width:100%}',
          '[data-vps-dock]{order:1}',
        ].join('')
        document.head.appendChild(style)
      } catch {
        // 没有 document（测试环境）
      }
    }

    /** 界面自己出的错报给插件记下来（打码后存在本机，反馈时附上）；报不出去就算了 */
    function reportClientError(where, error) {
      try {
        api('diag/client-error', { where, message: String(error?.stack ?? error?.message ?? error).slice(0, 1000) }).catch(() => {})
      } catch {
        // 连报错都报不出去：什么也不做
      }
    }

    // 对话输入框：DSH 0.1.7 起每个对话的输入框能放文字、能发送（DSH 自带的插件也这么用）。
    // 「让 AI 看看这个文件」靠它替用户把话发出去；拿不到（老版本 DSH）就退回提示用户自己发
    let composerOf = null
    function composerFor(sessionId) {
      try {
        return (sessionId && composerOf?.(sessionId)) || null
      } catch {
        return null
      }
    }
    /** 这个对话里排着队、还没轮到的消息（只取文字） */
    function queuedTexts(input) {
      try {
        const queue = input.snapshot?.queue ?? input.state?.get?.()?.queue ?? []
        return queue.map((m) => (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim())
      } catch {
        return []
      }
    }
    /** 输入框里还没发出去的文字 */
    function composerDraft(input) {
      try {
        return String(input.snapshot?.draft ?? input.state?.get?.()?.draft ?? '').trim()
      } catch {
        return ''
      }
    }

    function apply(ctx) {
      injectStyles()
      try {
        ctx.inject?.(['locale'], (scope) => {
          const svc = scope.locale ?? scope.get?.('locale')
          if (!svc) return
          const setup = () => {
            localeSvc = svc
            langChanged()
            const off = svc.subscribe?.(langChanged)
            return () => {
              off?.()
              if (localeSvc === svc) localeSvc = null
              langChanged()
            }
          }
          if (typeof scope.effect === 'function') scope.effect(setup, 'vps-manager: locale')
          else setup()
        })
      } catch (error) {
        console.warn('[dsh-vps-manager] 拿不到 DSH 的语言服务，按网页语言显示', error)
      }
      try {
        if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
          new MutationObserver(langChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        }
      } catch {
        // 没有 DOM（测试环境）
      }
      try {
        // 可选服务：有才用，没有不影响其他功能
        ctx.inject?.(['sessions', 'conversation'], (scope) => {
          const sessions = scope.get?.('sessions') ?? scope.sessions
          const reader = (sessionId) => {
            const actx = sessions?.scope?.(sessionId)
            const input = actx?.get?.('conversation')?.input?.for?.(actx)
            return input && typeof input.setDraft === 'function' && typeof input.submit === 'function' ? input : null
          }
          composerOf = reader
          scope.effect?.(() => () => {
            if (composerOf === reader) composerOf = null
          }, 'vps-manager: composer')
        })
      } catch (error) {
        console.warn('[dsh-vps-manager] 拿不到对话输入框', error)
      }
      // 插槽注册失败只降级：命令与 AI 工具不依赖界面
      try {
        // 对话头部：VPS 开关（打开 = 这个对话在操作这台机器）
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register({ name: 'conversation.session.header.actions', id: 'vps-manager', order: 40 }, VpsToggle))
      } catch (error) {
        console.warn('[dsh-vps-manager] 对话头部开关注册失败', error)
        reportClientError('对话头部开关注册失败', error)
      }
      try {
        // 输入框下方：平时不渲染，只有「不说你不知道」的事才冒一行；点开终端时放终端
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'vps-manager', order: 40 }, VpsDock))
      } catch (error) {
        console.warn('[dsh-vps-manager] 输入框状态条注册失败', error)
        reportClientError('输入框状态条注册失败', error)
      }
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'vps-manager', order: 30, label: () => L('VPS 管理', 'VPS Manager') }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-vps-manager] 设置页注册失败', error)
        reportClientError('设置页注册失败', error)
      }
    }

    // 给测试用的内部句柄（浏览器里没人碰它）
    module.exports = { name, inject, apply, __test: { api, lang, langChanged, StatusView, PanelTabs, termChrome, describeItem, sendToChat, waitingLabel, alertsFor, readBinding, writeBinding, ballLabel, chipTone, terminalUrl, normalizeTermPrefs, termChrome, minutesSince } }
    return module.exports
  },
})
