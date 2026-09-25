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
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (error?.name === 'TimeoutError') throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒没有回应：可以再试一次，或刷新页面`)
        throw new Error('连不上 DSH：看看 DSH 还开着吗，或刷新页面')
      }
      let data = null
      try {
        data = await res.json()
      } catch {
        throw new Error(res.status === 405
          ? '这个功能在当前运行的插件里还没有：DSH 运行期间装的新版本要重启 DSH 才生效'
          : `服务返回异常（HTTP ${res.status}）`)
      }
      if (!data || data.ok !== true) {
        const message = data?.error || `请求失败（HTTP ${res.status}）`
        if (/token/i.test(message)) {
          // 先自己换新令牌再试一次，用户什么都不用做；换不到才请他刷新
          if (!retried && (await refreshToken())) return api(path, body, { timeoutMs, retried: true })
          throw new Error('令牌对不上了（DSH 重启过或页面开太久）：刷新页面再试')
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
      return seconds > 1 ? `${text}（${seconds} 秒）` : text
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
    const T = {
      border: 'var(--border, var(--dsw-alias-border-l1, rgba(127,127,127,0.25)))',
      popover: 'var(--popover, var(--dsw-alias-bg-layer-1, rgba(30,30,34,0.985)))',
      popoverText: 'var(--popover-foreground, inherit)',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))',
      danger: 'var(--dsw-alias-state-error-primary, #e5534b)',
      ok: 'var(--dsw-alias-state-success-primary, #2ea043)',
      accent: 'var(--primary, #3b82f6)',
    }
    const line = `1px solid ${T.border}`
    const S = {
      root: { padding: 16, height: '100%', overflow: 'auto', fontSize: 13, lineHeight: 1.6 },
      h1: { fontSize: 16, fontWeight: 600, margin: '0 0 12px' },
      h2: { fontSize: 14, fontWeight: 600, margin: '18px 0 8px' },
      tabs: { display: 'flex', gap: 4, borderBottom: line, marginBottom: 14 },
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
        border: line,
        borderRadius: 6,
        padding: '5px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        minWidth: 0,
      },
      btn: (kind, disabled) => ({
        border: kind === 'primary' ? `1px solid ${T.accent}` : line,
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
        }, copied ? '已复制' : (label || '复制')))
    }

    const CONFIRM_LABEL = { careful: '谨慎（改动要确认）', relaxed: '放手（只有高危才问）', auto: '全自动（都不问）' }
    const PRIV_LABEL = { root: 'root', sudo: '免密 sudo', none: '仅只读', unknown: '未知' }
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

      if (detail.loading || !form) return h('div', { style: S.muted }, '读取中…')
      if (detail.error) return h('div', null, h(ErrorBar, { error: detail.error }), h(Btn, { onClick: onBack }, '返回'))

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
            ? '已保存，连接正常'
            : `已保存，但连接测试没通过：${res.probe?.hint ?? '未知原因'}（可以稍后在这里重试）`)
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
          setMsg(res.ok ? `连接正常：${res.address}` : `连不上：${res.hint}`)
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
            onBack ? h(Btn, { onClick: onBack }, '← 返回') : null,
            h('span', { style: { fontSize: 15, fontWeight: 600 } }, `${d.alias}`),
            h(Badge, { tone: d.state?.reachable ? 'ok' : d.state?.reachable === false ? 'danger' : null },
              `${dot(d.state?.reachable)} ${d.state?.address || '未测'}`),
            h(Badge, null, PRIV_LABEL[facts.privilege] ?? '权限未知')),
          h('div', { style: S.row },
            h(Btn, { onClick: test, disabled: busy === 'test' }, busy === 'test' ? waitingLabel('测试中…', waited) : '测连通'),
            h(Btn, { kind: 'primary', onClick: () => save(), disabled: busy === 'save' }, busy === 'save' ? waitingLabel('保存中…', waited) : '保存'))),

        h(ErrorBar, { error }),
        msg ? h('div', { style: S.note }, msg) : null,

        !form.managed
          ? h('div', { style: S.note },
              `这台机器的连接配置来自你自己的 ${d.sshConfigPath}，这里先只读。`,
              h('div', { style: { marginTop: 6 } },
                h(Btn, { onClick: () => save({ managed: true }) },
                  '交给插件管理（把当前配置复制成插件自己的一份，你的原文件不动）')))
          : null,

        h('div', { style: S.card },
          h('div', { style: S.h2 }, '基本'),
          h('div', { style: S.grid },
            h(Field, { label: '别名', hint: '改名会同步更新 SSH 配置' },
              h(Input, { value: form.alias, onChange: set('alias') })),
            h(Field, { label: '备注' }, h(Input, { value: form.note, onChange: set('note'), placeholder: '香港，建站用' })),
            h(Field, { label: '分组' }, h(Input, { value: form.group, onChange: set('group'), placeholder: '生产 / 测试' })))),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, '连接'),
          h('div', { style: S.grid },
            h(Field, { label: '地址' }, h(Input, { value: form.hostname, onChange: set('hostname'), disabled: !form.managed })),
            h(Field, { label: '端口' }, h(Input, { value: form.port, onChange: set('port'), disabled: !form.managed })),
            h(Field, { label: '用户名' }, h(Input, { value: form.user, onChange: set('user'), disabled: !form.managed })),
            h(Field, { label: '跳板机', hint: '填 用户@地址:端口，或另一台已登记机器的别名' },
              h(Input, { value: form.proxyJump, onChange: set('proxyJump'), disabled: !form.managed }))),
          h('div', { style: { ...S.muted, marginTop: 8, fontSize: 12 } },
            `钥匙：${(d.resolved?.identityFiles ?? []).join('、') || '按 SSH 默认'}`)),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, '钥匙与免密登录'),
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
            }, keyInfo ? '刷新' : '显示公钥与放置命令'),
            keyInfo ? h('span', { style: { ...S.muted, fontSize: 12 } }, keyInfo.fingerprint) : null),
          keyInfo ? h('div', { style: { marginTop: 10 } },
            !form.managed
              ? h('div', { style: S.note }, '这台机器的连接配置还不归插件管，插件专用钥匙不会被自动使用。放完公钥后记得点上面的「交给插件管理」。')
              : null,
            h('div', { style: S.label }, 'A. 复制公钥，贴到服务商后台的「SSH 密钥」'),
            h(Copyable, { text: keyInfo.pubkey, label: '复制公钥' }),
            h('div', { style: { ...S.label, marginTop: 10 } }, 'B. 已经能登录服务器：粘贴这一行执行'),
            h(Copyable, { text: keyInfo.authorizedKeys, label: '复制命令' }),
            h('div', { style: { ...S.label, marginTop: 10 } }, 'C. 只有密码：在终端里执行，密码你自己输'),
            h(Copyable, { text: keyInfo.sshCopyId, label: '复制命令' }),
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
                    if (!r.opened) setError(r.hint || '没能自动打开终端，请复制上面的命令自己执行')
                    else setMsg('已打开终端：输完密码后回到这里点「测连通」')
                  } catch (e) {
                    setError(e.message)
                  }
                },
              }, '在终端中打开'))) : null),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, '安全'),
          h(Field, { label: '确认档位', hint: '留空 = 跟随分组或全局设置' },
            h(Select, {
              value: form.confirm,
              onChange: set('confirm'),
              options: [
                { value: '', label: '跟随分组 / 全局' },
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
            }, '查看服务器指纹'),
            h(Btn, {
              kind: 'danger',
              onClick: async () => {
                if (!window.confirm('重置指纹后，下次连接会重新记录。只有在确认服务器刚重装过时才这么做。')) return
                try {
                  await api('host/reset-key', { hostname: form.hostname, port: Number(form.port) || 22 })
                  setMsg('已清除本机记录的该服务器指纹')
                } catch (e) {
                  setError(e.message)
                }
              },
            }, '重置指纹')),
          fingerprints ? h('div', { style: { ...S.pre, marginTop: 8 } }, fingerprints.join('\n') || '没取到') : null),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, '基础配置'),
          h('div', { style: S.muted }, '填好目标状态，保存时只执行和当前不一样的那几项。取消勾选不会卸载已装的东西。'),
          h('div', { style: { ...S.grid, marginTop: 10 } },
            h(Field, { label: '时区', hint: `当前：${facts.timezone || '未知'}` },
              h(Input, { value: basics.tz, onChange: (v) => setBasics({ ...basics, tz: v }), placeholder: 'Asia/Shanghai' })),
            h(Field, {
              label: '虚拟内存 swap（MB）',
              hint: Number(facts.swap_total_mb || 0) > 0
                ? `已有 ${facts.swap_total_mb} MB，改大小要手工操作`
                : '当前没有 swap，填个数字就会创建',
            },
              h(Input, {
                value: basics.swapMb,
                onChange: (v) => setBasics({ ...basics, swapMb: v }),
                disabled: Number(facts.swap_total_mb || 0) > 0,
                placeholder: '2048',
              }))),
          h('div', { style: { marginTop: 10 } },
            [
              ['bbr', `开启 BBR 拥塞控制（当前：${facts.congestion || '未知'}）`],
              ['autoUpdates', `自动安装安全更新（当前：${facts.auto_updates === '1' ? '已开' : '未开'}）`],
              ['fail2ban', `装 fail2ban 挡爆破（当前：${facts.fail2ban === '1' ? '已装并在跑' : '没装'}）`],
              ['tools', `补齐常用命令行工具（当前缺 ${facts.tools_missing ?? '?'} 个）`],
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
                  steps.push({ id: 'set-timezone', params: { tz: basics.tz }, name: `设置时区为 ${basics.tz}` })
                }
                if (Number(basics.swapMb) > 0 && Number(facts.swap_total_mb || 0) === 0) {
                  steps.push({ id: 'setup-swap', params: { size_mb: String(Number(basics.swapMb)) }, name: `创建 ${basics.swapMb} MB 虚拟内存` })
                }
                if (basics.bbr && facts.congestion !== 'bbr') steps.push({ id: 'enable-bbr', name: '开启 BBR' })
                if (basics.autoUpdates && facts.auto_updates !== '1') steps.push({ id: 'auto-security-updates', name: '打开自动安全更新' })
                if (basics.fail2ban && facts.fail2ban !== '1') steps.push({ id: 'install-fail2ban', name: '安装 fail2ban' })
                if (basics.tools && Number(facts.tools_missing || 0) > 0) steps.push({ id: 'install-tools', name: '补齐常用命令行工具' })

                if (!steps.length) {
                  setMsg('当前状态已经和你填的一致，没有要执行的项')
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
                      state[i].hint = task.exitCode === 0 ? '' : `退出码 ${task.exitCode}`
                      if (task.exitCode === 0) {
                        const v = await api('recipes/verify', { id: state[i].id, alias: d.alias }).catch(() => null)
                        if (v && !v.ok) {
                          state[i].state = 'failed'
                          state[i].hint = '验证没通过'
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
                setMsg(state.every((x) => x.state === 'done') ? '全部执行完成' : '有项目没成功，展开看日志')
              },
            }, applying ? '执行中…' : '保存并应用'),
            h('span', { style: S.muted }, '只执行有差异的项；每项都是远端任务，断线也会跑完')),
          applying ? h('div', { style: { marginTop: 10 } },
            applying.steps.map((st) => h('div', { key: st.id, style: { ...S.row, padding: '2px 0' } },
              h(Badge, { tone: st.state === 'done' ? 'ok' : st.state === 'failed' ? 'danger' : null },
                { pending: '等待', running: '执行中', done: '完成', failed: '失败' }[st.state]),
              h('span', null, st.name),
              st.hint ? h('span', { style: S.muted }, st.hint) : null)),
            applying.log ? h('div', { style: { ...S.pre, marginTop: 6, maxHeight: 200 } }, applying.log) : null) : null),

        h('div', { style: S.card },
          h('div', { style: S.h2 }, '状态'),
          h('div', { style: S.grid },
            h('div', null, h('div', { style: S.label }, '系统'), `${facts.os_id ?? '?'} ${facts.os_ver ?? ''}`),
            h('div', null, h('div', { style: S.label }, 'init'), facts.init ?? '?'),
            h('div', null, h('div', { style: S.label }, '包管理'), facts.pkg ?? '?'),
            h('div', null, h('div', { style: S.label }, 'CPU'), `${facts.cpu ?? '?'} 核`),
            h('div', null, h('div', { style: S.label }, '内存'), `${facts.mem_used_mb ?? '?'} / ${facts.mem_total_mb ?? '?'} MB`),
            h('div', null, h('div', { style: S.label }, '磁盘'), `${facts.disk_used_mb ?? '?'} / ${facts.disk_total_mb ?? '?'} MB ${facts.disk_pct ?? ''}`)),
          h('div', { style: { ...S.muted, fontSize: 12, marginTop: 8 } },
            d.state?.lastSeen ? `上次体检：${new Date(d.state.lastSeen).toLocaleString()}` : '还没体检过')),

        h('div', { style: { ...S.card, borderColor: 'rgba(229,83,75,0.5)' } },
          h('div', { style: { ...S.h2, color: T.danger } }, '危险区'),
          !removing
            ? h(Btn, { kind: 'danger', onClick: () => setRemoving(true) }, '移除这台机器')
            : h('div', null,
                h('div', { style: { marginBottom: 8 } }, '移除后插件不再管理它。钥匙文件永远不会被删除。'),
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
                  }, '只从插件移除（保留 SSH 配置）'),
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
                  }, '同时删除插件写的 SSH 配置与指纹'),
                  h(Btn, { onClick: () => setRemoving(false) }, '取消')))))
    }

    // ——————————————————————— 添加机器（一页表单）———————————————————————
    // 照 WPN 那种一目了然的写法（用户定的）：地址、端口、用户名、密码填完，点「保存并连接」。
    // 密码只用这一次：插件拿它登录一次，把专用钥匙的公钥放上去，之后一律用钥匙；密码不保存。
    // 服务器关掉了密码登录的，展开「没有密码？」，用原来的几种办法放公钥。

    function autoAliasOf(hostname) {
      const base = String(hostname ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
      return base || 'vps'
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
        if (!form.hostname.trim()) return setError('先填服务器地址')
        if (withPassword && !form.password) return setError('填上服务器的登录密码。服务器只允许密钥登录的，展开下面的「没有密码？」')
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
          setError(res.hint || '没连上')
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
          setError('已经忘掉旧指纹。确认服务器刚重装过系统，再点一次「保存并连接」')
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
          h('div', { style: { fontSize: 16, fontWeight: 600, marginBottom: 12 } }, result.connected ? `已连上 ${result.alias}` : `已保存 ${result.alias}，但还连不上`),
          h('div', { style: S.card },
            result.connected
              ? h('div', null, [
                result.probe?.address,
                f.os_id && f.os_id !== 'unknown' ? `${f.os_id} ${f.os_ver ?? ''}`.trim() : '',
                `权限 ${PRIV_LABEL[f.privilege] ?? '未知'}`,
              ].filter(Boolean).join('　'))
              : h('div', { style: { color: T.danger } }, `原因：${result.hint || result.probe?.hint || '未知'}`),
            fp ? h('div', { style: { marginTop: 10 } },
              h('span', { style: { fontWeight: 600, marginRight: 8 } }, '主机指纹'),
              h('span', { style: S.mono }, `${fp.fp}${fp.type ? `（${fp.type}）` : ''}`),
              h('div', { style: hint }, '首次连接时记录。以后指纹变了会拒绝连接，防止有人冒充你的服务器。')) : null,
            h('div', { style: { marginTop: 10, ...S.muted, fontSize: 12 } },
              result.keyInstalled
                ? `已把插件的专用钥匙放到服务器上，之后免密登录。密码没有保存。钥匙在 ${result.keyPath ?? '~/.ssh/dsh_vps_ed25519'}`
                : `用插件的专用钥匙登录（${result.keyPath ?? '~/.ssh/dsh_vps_ed25519'}）`)),
          h('div', { style: { ...S.row, marginTop: 12 } }, h(Btn, { kind: 'primary', onClick: onCancel }, '完成')))
      }

      // —— 表单 ——
      const passwordInput = h('input', {
        type: 'password',
        value: form.password,
        autoComplete: 'new-password', // 别让浏览器记住服务器密码
        placeholder: '服务器的登录密码',
        onChange: (e) => set('password')(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter') connect()
        },
        style: { ...S.input, width: '100%' },
      })

      return h('div', null,
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, '添加机器'),
        h('div', { style: { ...S.muted, fontSize: 12.5, marginTop: 4, lineHeight: 1.6 } },
          '填好服务器的登录信息，点「保存并连接」。密码只用这一次：插件用它把专用钥匙放到服务器上，之后免密登录，密码不保存。'),
        h('div', { style: { marginTop: 12 } }, h(ErrorBar, { error })),
        hostKeyChanged ? h('div', { style: { ...S.row, marginBottom: 10 } },
          h('span', { style: { ...S.muted, fontSize: 12 } }, '只有在确认服务器刚重装过系统时才重置；否则可能是有人冒充你的服务器'),
          h(Btn, { kind: 'danger', onClick: resetKey }, '重置指纹')) : null,

        section('服务器'),
        h('div', { style: grid2 },
          h('div', null,
            h('label', { style: S.label }, '服务器 IP 或域名'),
            h(Input, { value: form.hostname, onChange: set('hostname'), placeholder: '1.2.3.4' }),
            h('div', { style: hint }, '你买的 VPS 的公网地址')),
          h('div', null,
            h('label', { style: S.label }, 'SSH 端口'),
            h(Input, { value: form.port, onChange: set('port') })),
          h('div', null,
            h('label', { style: S.label }, '用户名'),
            h(Input, { value: form.user, onChange: set('user') }),
            h('div', { style: hint }, '建议用 root；别的用户要有免密 sudo 才能装软件、改配置')),
          h('div', null,
            h('label', { style: S.label }, '密码'),
            passwordInput,
            h('div', { style: hint }, '只用这一次，不保存'))),

        section('在 DSH 里怎么称呼它（选填）'),
        h('div', { style: grid2 },
          h('div', null,
            h('label', { style: S.label }, '别名'),
            h(Input, { value: form.alias, onChange: set('alias'), placeholder: form.hostname.trim() ? autoAliasOf(form.hostname) : '不填就按地址自动起' }),
            h('div', { style: hint }, '以后用它指代这台机器，比如 /vps-use 别名')),
          h('div', null,
            h('label', { style: S.label }, '分组'),
            h(Input, { value: form.group, onChange: set('group'), placeholder: '生产 / 测试' })),
          h('div', { style: { gridColumn: '1 / -1' } },
            h('label', { style: S.label }, '备注'),
            h(Input, { value: form.note, onChange: set('note'), placeholder: '洛杉矶，建站用' }))),

        h('div', { style: { marginTop: 16 } },
          h('button', {
            type: 'button',
            onClick: () => setManual((m) => !m),
            style: { border: 'none', background: 'transparent', color: 'inherit', padding: 0, cursor: 'pointer', fontSize: 12.5, opacity: 0.75 },
          }, `${manual ? '▾' : '▸'} 没有密码？（服务器只允许密钥登录）`)),
        manual ? h('div', { style: { marginTop: 10 } },
          h('div', { style: S.note }, '把下面这把插件专用钥匙的公钥放到服务器上，任选一种办法；放好后点「公钥已经放好了，直接连接」。'),
          h('div', { style: S.card },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'A. 服务商后台添加（新机器推荐）'),
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 6 } }, '粘到服务商的「SSH 密钥」里，重装系统时勾选它。'),
            h(Copyable, { text: key?.pubkey ?? '正在准备…', label: '复制公钥' })),
          h('div', { style: S.card },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'B. 已经能登录（网页控制台或别的终端）'),
            h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 6 } }, '在服务器上粘贴执行这一行。'),
            h(Copyable, { text: cmds?.authorizedKeys ?? (form.hostname.trim() ? '正在准备…' : '先在上面填服务器地址'), label: '复制命令' })),
          h(Btn, { onClick: () => connect({ withPassword: false }), disabled: busy }, '公钥已经放好了，直接连接')) : null,

        h('div', { style: { ...S.row, marginTop: 16 } },
          h(Btn, { kind: 'primary', onClick: () => connect(), disabled: busy }, busy ? waitingLabel('连接中…', waited) : '保存并连接'),
          h(Btn, { onClick: onCancel }, '取消')))
    }

    // ——————————————————————— 设置页 ———————————————————————

    // ——————————————————————— 卸载 ———————————————————————
    // 默认只勾能找回来的两项（移除插件、移除 SSH 配置——配置会先备份）；
    // 删钥匙、删数据、撤销服务器上的登录权限都不能撤销，默认不勾，并写明后果。

    const UNINSTALL_ITEMS = {
      plugin: {
        label: '移除插件本身',
        detail: (pv) => (pv.desktop.canRemove
          ? '从 DSH 里卸载这个插件，重启 DSH 后生效'
          : `这里没法直接移除，完成后会告诉你在终端执行：${pv.removeCommand}`),
      },
      remoteCache: {
        label: '清理服务器上的插件目录',
        detail: (pv) => `每台已登记的机器（${pv.hosts.join('、')}）上的 ~/.cache/dsh-vps：任务日志、改文件前的备份。有任务在跑的机器会跳过`,
      },
      revokeKey: {
        label: '撤销插件钥匙在服务器上的登录权限',
        detail: () => '从每台机器的 ~/.ssh/authorized_keys 删掉插件专用钥匙那一行（先备份）',
        warn: '如果这把钥匙是你登录某台服务器的唯一方式，撤销后就登不上了。确认还有密码或别的钥匙再勾',
      },
      sshConfig: {
        label: '移除 SSH 连接配置',
        detail: (pv) => `去掉 ${pv.paths.sshConfig} 顶部插件加的 Include 行（先备份），${pv.paths.sshDropin} 改名留作备份。之后终端里 ssh <别名> 不再能用`,
      },
      key: {
        label: '删除插件专用钥匙',
        detail: (pv) => `${pv.paths.key} 和 .pub`,
        warn: '删除后不能恢复',
      },
      data: {
        label: '删除插件数据',
        detail: (pv) => `${pv.paths.data}：机器清单、体检结果、审计日志、自定义菜谱`,
        warn: '删除后不能恢复',
      },
    }

    const UNINSTALL_GROUPS = [
      ['插件', ['plugin']],
      ['服务器上（先做：本机配置和钥匙删掉后就连不上了）', ['remoteCache', 'revokeKey']],
      ['本机', ['sshConfig', 'key', 'data']],
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
          setError(`没收到结果（${e.message}）。插件可能已经卸载，请重启 DSH 后确认`)
        }
        setStage('done')
      }

      const restart = async () => {
        setRestartMsg('正在重启 DSH…')
        try {
          await api('desktop/restart', {})
        } catch (e) {
          setRestartMsg(`没能自动重启（${e.message}），请手动重启 DSH`)
        }
      }

      if (!open) {
        return h('div', { style: S.card },
          h('div', { style: S.spread },
            h('div', null,
              h('div', { style: { ...S.h2, margin: 0 } }, '卸载'),
              h('div', { style: { ...S.muted, fontSize: 12 } }, '移除插件，并选择清理它在本机和服务器上留下的东西')),
            h(Btn, { onClick: expand }, '卸载…')))
      }

      const pluginStep = result?.steps?.find((s) => s.id === 'plugin')

      return h('div', { style: { ...S.card, borderColor: T.danger } },
        h('div', { style: S.spread },
          h('div', { style: { ...S.h2, margin: 0 } }, '卸载'),
          stage === 'running' ? null : h(Btn, { onClick: () => { setOpen(false); setStage('idle'); setResult(null); setError('') } }, '收起')),
        h(ErrorBar, { error }),
        !preview && !error ? h('div', { style: S.muted }, '读取中…') : null,

        preview && stage !== 'done'
          ? h('div', null,
              UNINSTALL_GROUPS.map(([title, ids]) => {
                const items = ids.filter((id) => uninstallVisible(id, preview))
                if (!items.length) return null
                return h('div', { key: title, style: { marginTop: 10 } },
                  h('div', { style: { ...S.muted, fontSize: 12, marginBottom: 4 } }, title),
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
                  ? h(Btn, { kind: 'danger', disabled: selected.length === 0, onClick: () => setStage('confirm') }, '开始卸载')
                  : null,
                stage === 'confirm'
                  ? [
                      h('span', { key: 't', style: { color: T.danger } }, `确定执行这 ${selected.length} 项？勾了删除的项不能撤销`),
                      h(Btn, { key: 'y', kind: 'danger', onClick: run }, '确认卸载'),
                      h(Btn, { key: 'n', onClick: () => setStage('idle') }, '取消'),
                    ]
                  : null,
                stage === 'running' ? h('span', { style: S.muted }, '卸载中…（要连服务器的项会慢一些）') : null))
          : null,

        stage === 'done' && result
          ? h('div', { style: { marginTop: 10 } },
              result.steps.map((s, i) => h('div', { key: i, style: { display: 'flex', gap: 8, padding: '3px 0' } },
                h('span', { style: { color: s.ok ? T.ok : T.danger, fontWeight: 600 } }, s.ok ? '✓' : '✗'),
                h('span', null, h('span', { style: S.muted }, `${UNINSTALL_ITEMS[s.id]?.label ?? s.id}：`), s.text))),
              pluginStep?.ok
                ? h('div', { style: { ...S.row, marginTop: 10 } },
                    result.canRestart ? h(Btn, { kind: 'primary', onClick: restart }, '重启 DSH') : h('span', null, '请重启 DSH 完成卸载'),
                    restartMsg ? h('span', { style: S.muted }, restartMsg) : null)
                : null)
          : null)
    }

    function SettingsSection() {
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
          h('div', { style: S.h1 }, 'VPS 管理'),
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
            }, '从 ~/.ssh/config 导入'),
            h(Btn, { kind: 'primary', onClick: () => setAdding(true) }, '+ 添加机器'))),

        h(ErrorBar, { error: error || overview.error }),
        msg ? h('div', { style: S.note }, msg) : null,

        importing ? h('div', { style: S.card },
          h('div', { style: S.h2 }, '可导入的条目'),
          importing.length === 0
            ? h('div', { style: S.muted }, '没有发现可导入的条目')
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
                }, '导入'))),
          h('div', { style: { marginTop: 8 } }, h(Btn, { onClick: () => setImporting(null) }, '关闭'))) : null,

        // —— 机器列表：编号与对话头部的方块一一对应 ——
        h('div', { style: S.card },
          h('div', { style: S.spread },
            h('div', { style: S.h2 }, `机器（${hosts.length}）`),
            h('span', { style: { ...S.muted, fontSize: 11 } }, '编号对应对话头部 VPS 后面的方块')),
          overview.loading && !d ? h('div', { style: S.muted }, '读取中…') : null,
          hosts.length === 0 && !overview.loading
            ? h('div', { style: S.note }, '还没有机器。点右上角「+ 添加机器」，填好地址、用户名和密码，点「保存并连接」就接上了（密码只用这一次，不保存）。')
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
              h('span', { style: S.mono }, host.address || '未测'),
              host.group ? h(Badge, null, host.group) : null,
              h('span', { style: S.muted }, host.note || ''),
              h(Badge, null, PRIV_LABEL[host.privilege] ?? '权限未知')),
            h('div', { style: S.row },
              h(Btn, {
                onClick: async () => {
                  setBusy(host.alias)
                  setError('')
                  try {
                    const res = await api('host/test', { alias: host.alias })
                    setMsg(res.ok ? `${host.alias} 连接正常（${res.address}）` : `${host.alias} 连不上：${res.hint}`)
                    reload()
                  } catch (e) {
                    setError(e.message)
                  } finally {
                    setBusy('')
                  }
                },
                disabled: busy === host.alias,
              }, busy === host.alias ? '测试中…' : '测连通'),
              h(Btn, { kind: 'primary', onClick: () => setSelected(host.alias) }, '设置'))))),

        settings ? h('div', { style: S.card },
          h('div', { style: S.h2 }, '全局'),
          h('div', { style: S.grid },
            h(Field, { label: '默认确认档位', hint: '机器设置 > 分组 > 这里' },
              h(Select, {
                value: settings.confirm,
                onChange: (v) => setSettings({ ...settings, confirm: v }),
                options: Object.entries(CONFIRM_LABEL).map(([value, label]) => ({ value, label })),
              })),
            h(Field, { label: '连通性保险时长（秒）', hint: '改防火墙 / SSH 后多久自动恢复' },
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
              h('span', null, 'DSH 的 Web 服务绑定在 0.0.0.0（局域网可见），允许在这里执行会改东西的操作'))) : null,
          h('div', { style: { marginTop: 10 } },
            h(Btn, {
              kind: 'primary',
              onClick: async () => {
                setError('')
                try {
                  await api('settings/save', { settings })
                  setMsg('已保存')
                  reload()
                } catch (e) {
                  setError(e.message)
                }
              },
            }, '保存设置'))) : null,

        settings ? h(TerminalSettingsCard, { settings, setSettings }) : null,

        // —— 怎么用：机器加完之后的下一步都在对话里，这里只留一张导览 ——
        h('div', { style: S.card },
          h('div', { style: S.h2 }, '怎么用'),
          h('div', { style: { ...S.muted, fontSize: 12, lineHeight: 1.9 } },
            h('div', null, '① 在对话头部点「VPS」后面的编号方块，这个对话就绑到那台机器（编号和上面列表一致，点另一个编号切换）。方块颜色：灰 没选 · 黄 连接中 · 绿 已连上 · 红 连不上（输入框下方写原因，可重试）'),
            h('div', null, '② 看信息不花 token：', h('span', { style: S.mono }, '/vps-sysinfo　/vps-disk　/vps-ports　/vps-sh df -h')),
            h('div', null, `③ 装软件与系统维护走菜谱（现有 ${recipeCount} 条）：`,
              h('span', { style: S.mono }, '/vps-recipes'), ' 看清单，',
              h('span', { style: S.mono }, '/vps-install <id>'), ' 看计划，', h('span', { style: S.mono }, '/vps-yes'), ' 执行'),
            h('div', null, '④ 剩下的直接跟 AI 说，例如「给这台装个 nginx，把 a.com 反代到 3000」'),
            h('div', null, '⑤ 想跟在 ssh 里一样自己敲、用菜单脚本：点对话头部「VPS」后面的 ', h('span', { style: S.mono }, '>_'), '，输入框下方就是终端（设置见下方「终端」）'),
            h('div', null, '⑥ 传文件、改配置：终端面板标题栏切到「文件」——拖进来上传、右键下载、双击编辑、删了进回收站；右键「让 AI 看看这个文件」'),
            h('div', null, '全部命令与用法：', h('span', { style: S.mono }, '/vps-help')))),

        d?.paths ? h('div', { style: S.card },
          h('div', { style: S.h2 }, '数据位置'),
          h('div', { style: S.mono }, d.paths.base),
          h('div', { style: { ...S.muted, fontSize: 12 } },
            'hosts.yml 可以手工编辑；recipes/ 放自己的菜谱；audit/ 是操作记录')) : null,

        h(FeedbackCard),

        h(UninstallCard))
    }

    // —— 反馈与诊断：版本、DSH 验证状态、注册情况、最近错误；一键打开预填好的问题单 ——
    // 只生成链接，用户在 GitHub 上看过再提交，不会自动上传任何东西（诊断内容已打码、不含机器地址）
    function FeedbackCard() {
      const diag = useAsync(() => api('diag/status', {}), [])
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
        h('div', { style: S.h2 }, '反馈与诊断'),
        diag.loading && !d ? h('div', { style: S.muted }, '读取中…') : null,
        diag.error ? h(ErrorBar, { error: diag.error }) : null,
        d ? h('div', { style: { fontSize: 12, lineHeight: 1.9 } },
          h('div', null, `插件 ${d.plugin} · `,
            h('span', { style: { color: d.dsh.status === 'unverified' ? T.danger : 'inherit' } },
              d.dsh.status === 'verified' ? `DSH ${d.dsh.version}（已验证）` : d.dsh.text)),
          h('div', { style: { color: failed.length ? T.danger : 'inherit' } },
            failed.length
              ? `没注册成功：${failed.map((p) => `${p.label}（${p.detail}）`).join('、')}`
              : `各部分都正常：${parts.map((p) => `${p.label}${p.detail ? ` ${p.detail}` : ''}`).join(' · ') || '还没有记录'}`),
          h('div', { style: S.muted }, d.errors.length ? `最近的错误 ${d.errors.length} 条（已打码）：` : '最近没有错误记录'),
          d.errors.slice(0, 3).map((e, i) => h('div', { key: i, style: { ...S.mono, opacity: 0.75 } },
            `${e.at.slice(5, 16).replace('T', ' ')} [${e.source}] ${e.message.slice(0, 140)}`)),
          h('div', { style: { ...S.row, marginTop: 8 } },
            link(d.feedbackUrl, '反馈问题', true),
            link(d.suggestUrl, '提建议', false),
            h(Btn, { onClick: () => diag.reload() }, '刷新')),
          h('div', { style: { ...S.muted, fontSize: 11, marginTop: 4 } },
            '点「反馈问题」会打开 GitHub 上已经预填好版本和上面诊断信息的问题单，你看过、改好再提交；插件不会自动上传任何东西')) : null)
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
            } else if (list.length === 0) setError('还没有机器：DSH 设置 → VPS 管理 → 添加')
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
            setError('还没有机器：DSH 设置 → VPS 管理 → 添加')
          } else {
            setError('先点后面的编号选一台机器，再打开终端')
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
          ? (hosts.length > 1 ? '先点后面的编号选一台机器，再打开终端' : '打开终端：跟在 ssh 里一样操作')
          : termView === 'minimized' ? '终端在后台运行，点一下恢复'
            : termView ? '最小化终端（在后台继续运行）' : `打开 ${alias} 的终端：跟在 ssh 里一样操作`,
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
        return wrap(chip('load', busy ? '·' : '', 'off', error || '点一下绑定这个对话要操作的 VPS', () => click(null)))
      }

      return wrap(hosts.map((host, i) => {
        const name = `${host.alias}${host.note ? `（${host.note}）` : ''}`
        const tone = chipTone(host.alias === alias, reach)
        const title = {
          off: `点一下改成操作 ${name}`,
          checking: `正在连接 ${name}…`,
          ok: `这个对话正在操作 ${name} · 已连上　点一下关掉`,
          fail: `这个对话选了 ${name}，但连不上：${reach?.hint || '原因未知'}　输入框下方可以重试；点一下关掉`,
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
        const names = running.map((t) => t.meta?.recipeId ?? t.meta?.action ?? '任务').join('、')
        items.push({ tone: 'ok', text: `${alias} 上有 ${running.length} 个任务在跑：${names}` })
      }
      if (state?.reachable === false) {
        items.push({ tone: 'danger', text: `${alias} 连不上${state.hint ? `：${state.hint}` : '了'}`, action: 'retry' })
      } else {
        const facts = state?.facts ?? {}
        const pct = Number(String(facts.disk_pct ?? '').replace('%', ''))
        if (pct >= 85) items.push({ tone: 'danger', text: `${alias} 磁盘已用 ${facts.disk_pct}` })
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
        }, reach?.state === 'checking' ? '连接中…' : '重试') : null))))
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
      { value: 'system', label: '跟随系统' },
      { value: 'dark', label: '暗色' },
      { value: 'light', label: '白色' },
    ]
    const TERM_KEEP = [
      { value: 5, label: '5 分钟' },
      { value: 10, label: '10 分钟' },
      { value: 30, label: '30 分钟' },
      { value: 60, label: '1 小时' },
    ]
    const TERM_KEYS = ['keydown', 'keypress', 'keyup', 'paste', 'copy', 'cut']
    const RETRY_DELAYS = [1000, 2000, 4000]

    /** 连接地址：跟着页面走，http→ws，https→wss */
    function terminalUrl(origin, sessionId, cols, rows, extra = {}) {
      const url = new URL('/api-vps/ws/terminal', origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const q = new URLSearchParams({ sessionId, cols: String(cols), rows: String(rows) })
      for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
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
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06))',
      tip: 'var(--dsw-specific-tip, rgba(127,127,127,0.08))',
      accent: 'var(--dsw-alias-state-business-primary, #4176e6)',
      ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
      danger: 'var(--dsw-alias-state-error-primary, #ec1313)',
      scrollbar: 'var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,0.3))',
      code: 'var(--ds-font-family-code, "SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei", monospace)',
      shadow: 'var(--dsw-elevation-soft, none)',
      selected: 'var(--dsw-alias-interactive-bg-selected, rgba(80,130,240,0.16))',
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
      },
      dark: {
        bg: '#2c2c2e', text: '#f9fafb', secondary: '#d0d3d8', tertiary: '#adb2b8',
        border: 'rgba(255,255,255,0.12)', divider: 'rgba(255,255,255,0.06)', hover: 'rgba(255,255,255,0.08)',
        tip: '#353638', accent: '#679efe', ok: '#22c55e', danger: '#f25a5a', scrollbar: 'rgba(255,255,255,0.16)',
        selected: 'rgba(103,158,254,0.22)',
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

    /** 面板里切「终端」「文件」：终端一直在后台跑，切回来接着用 */
    function setTab(entry, tab) {
      entry.tab = tab
      if (tab === 'files') entry.filesOpened = true
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
        entry.note = `终端组件加载失败：${error?.message ?? error}`
        termEmit(entry)
      })
    }

    function connectTerm(entry, resume) {
      const token = window.__DSH_VPS_TOKEN__ || ''
      if (!token) {
        entry.status = 'closed'
        entry.note = '页面里没有 VPS 管理的令牌：刷新页面再试'
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
        entry.note = `连不上终端服务：${error.message}`
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
          entry.note = msg.message || '终端出错了'
          termEmit(entry)
        } else if (msg?.t === 'exit') {
          if (msg.code === 255 && msg.hint) setReach(entry.alias, { state: 'fail', hint: msg.hint, at: new Date().toISOString() })
          finished = true
          entry.ended = true
          entry.note = msg.hint ? `连接断开：${msg.hint}` : msg.code === 0 ? '已退出' : `连接断开（退出码 ${msg.code ?? msg.signal}）`
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
          entry.note = '上次的终端已经结束了（断开超过保留时间）。点「重新连接」开一个新的'
          termEmit(entry)
        } else if (msg?.t === 'taken') {
          finished = true
          entry.note = '这个终端在别的窗口打开了'
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
        if (!entry.note) entry.note = entry.id ? '连接断开了，点「重新连接」接回' : '连不上终端服务：可能是登录过期或 DSH 刚重启过，刷新页面再试'
        try {
          term.write('\r\n\x1b[2m[连接已断开]\x1b[0m\r\n')
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
          entry.term?.write('\r\n\x1b[2m[新的终端]\x1b[0m\r\n')
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
        && !window.confirm('结束这个终端？服务器上的 shell 和里面正在跑的程序会一起结束。')) return
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
      if (m < 1) return '刚打开'
      if (m < 60) return `已开 ${m} 分钟`
      return `已开 ${Math.floor(m / 60)} 小时 ${m % 60} 分钟`
    }

    const STATUS_TEXT = { loading: '加载中…', connecting: '连接中…', reconnecting: '重新连接中…', open: '已连接', closed: '已断开' }

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
        h(Light, { kind: 'close', title: '结束这个终端（服务器上的 shell 一起结束）', onClick: () => endTerminal(entry.sessionId) }),
        h(Light, {
          kind: 'minimize',
          title: entry.view === 'minimized' ? '恢复' : '最小化：缩成输入框下方的一条横栏，终端在后台继续运行',
          onClick: () => setView(entry, entry.view === 'minimized' ? entry.restoreView : 'minimized'),
        }),
        h(Light, {
          kind: maximized ? 'restore' : 'maximize',
          title: maximized ? '恢复原来的大小' : '最大化：终端撑满对话区，输入框移到最上面',
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
          h('span', {
            style: { display: 'inline-flex', marginLeft: 6, border: `0.5px solid ${c.border}`, borderRadius: 8, overflow: 'hidden', flex: '0 0 auto' },
            onDoubleClick: (e) => e.stopPropagation(),
          }, [['terminal', '终端'], ['files', '文件']].map(([key, label], i) => {
            const on = tab === key
            return h('button', {
              key,
              type: 'button',
              onClick: (e) => {
                e.stopPropagation()
                if (!on) setTab(entry, key)
              },
              style: {
                border: 'none', borderLeft: i ? `0.5px solid ${c.border}` : 'none', height: 22, padding: '0 10px',
                fontSize: 12, fontWeight: 500, cursor: on ? 'default' : 'pointer',
                background: on ? c.accent : 'transparent', color: on ? '#fff' : c.secondary,
              },
            }, label)
          })),
          h('span', { style: { flex: 1 } }),
          entry.status === 'closed' ? textBtn('重新连接', () => reconnectTerminal(entry), entry.ended ? '开一个新的 shell' : '接回服务器上的这个终端') : null,
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
          entry.filesOpened ? h('div', { style: { display: tab === 'files' ? 'block' : 'none', height: '100%' } }, h(FileBrowser, { entry, c })) : null)))
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
        ? `终端在后台运行 · ${minutesSince(entry.startedAt)}`
        : entry.status === 'closed' ? '终端已断开' : STATUS_TEXT[entry.status] ?? ''
      return dockRow(barRef, h('div', {
        'data-vps-terminal-bar': '',
        role: 'button',
        title: '点这里恢复终端',
        onClick: () => setView(entry, entry.restoreView),
        style: {
          ...DOCK_WIDTH, marginTop: 8, height: 34, borderRadius: 12, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 14px',
          background: c.bg, color: c.text, border: `0.5px solid ${c.border}`, boxShadow: c.shadow, fontSize: 13,
        },
      },
        h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: running ? c.ok : c.tertiary, flex: '0 0 auto' } }),
        h('span', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, fontWeight: 600, color: c.tertiary } }, entry.tab === 'files' ? '文件' : '>_'),
        h('span', { style: { fontWeight: 500 } }, entry.alias),
        h('span', { style: { color: c.tertiary, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, text),
        h('span', { style: { flex: 1 } }),
        h('span', { style: { color: c.tertiary, fontSize: 12 } }, '点击恢复'),
        h(Lights, { entry })))
    }

    // ——————————————————————— 文件管理器（终端面板的「文件」页）———————————————————————
    // 服务器上的访达：浏览、上传下载、新建改名、删到回收站、编辑文本、让 AI 看看这个文件。
    // 操作的是「这个对话绑定的那台机器」（服务端按对话查），和终端同一台。
    // 状态挂在 entry.files 上：切回终端、最小化再恢复，都还停在原来的目录。

    const FILE_EDIT_LIMIT = 1024 * 1024
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
          else if (xhr.status === 405) resolve({ ok: false, error: '当前运行的插件还没有上传功能：DSH 运行期间装的新版本要重启 DSH 才生效' })
          else if (/token/i.test(data?.error ?? '')) resolve({ ok: false, tokenStale: true, error: '令牌对不上了（DSH 重启过）：刷新页面再试' })
          else resolve({ ok: false, error: data?.error || `上传失败（HTTP ${xhr.status}）` })
        }
        xhr.onerror = () => resolve({ ok: false, error: '连不上 DSH，上传中断了' })
        xhr.onabort = () => resolve({ ok: false, error: '已取消', cancelled: true })
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
          const ok = await ask({ title: '文件太大，不能在这里打开', message: `${item.name} 有 ${fmtBytes(item.size)}，超过 1 MB。要下载到电脑上看吗？`, confirm: '下载' })
          if (ok) download(path)
          return
        }
        setLoading(true)
        try {
          const res = await call('read', { path })
          setEditor({ path: res.path, name: item.name, content: res.content, original: res.content, sha: res.sha, saving: false, error: '' })
        } catch (e) {
          setLoading(false) // 读已经结束了，别让状态栏在问话期间一直写「正在读取」
          if (/二进制|UTF-8/.test(e.message)) {
            const ok = await ask({ title: '不能当文本打开', message: `${e.message}。要下载到电脑上吗？`, confirm: '下载' })
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
        if (item.lossy) return flash('这个名字不是 UTF-8 编码，这里操作不了它：用终端处理', 'error')
        if (isDirLike(item)) return openDir(path)
        if (item.type === 'link' && item.target === 'broken') return flash('这个链接指向的东西已经不在了', 'error')
        if (item.type === 'other') return flash('这不是普通文件（可能是设备或管道），不能打开', 'error')
        return openFile(item, path)
      }

      async function download(path) {
        try {
          const res = await call('download', { path })
          const a = document.createElement('a')
          a.href = res.url
          a.download = res.name
          a.rel = 'noopener'
          a.style.display = 'none'
          document.body.appendChild(a)
          a.click()
          a.remove()
          flash(res.type === 'dir' ? `正在打包下载 ${res.name}` : `开始下载 ${res.name}（${fmtBytes(res.size)}）`)
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      async function share(path, name) {
        try {
          const res = await call('share', { path })
          flash(`已把 ${name} 交给 AI${res.truncated ? `（文件有 ${fmtBytes(res.size)}，只给了最后 ${fmtBytes(res.bytes)}）` : ''}，敏感内容已打码。在上面的输入框说说要它做什么`)
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      function cdInTerminal(dir) {
        if (entry.socket?.readyState !== 1) return flash('终端还没连上，稍等一下再试', 'error')
        setTab(entry, 'terminal')
        sendTerm(entry, { t: 'i', d: `cd ${shellQ(dir)}\r` })
        return undefined
      }

      async function copyPath(path) {
        try {
          await navigator.clipboard.writeText(path)
          flash(`已复制：${path}`)
        } catch {
          flash(path) // 复制不了就把路径亮出来
        }
      }

      async function newFolder() {
        const name = await ask({ title: '新建文件夹', input: '新建文件夹', confirm: '新建' })
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
        const to = await ask({ title: '改名', input: item.name, confirm: '改名' })
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
        const names = items.slice(0, 3).map((i) => i.name).join('、') + (items.length > 3 ? ` 等 ${items.length} 项` : '')
        const system = paths.some((p) => SYSTEM_DIRS.test(p))
        const ok = await ask({
          title: '移到回收站？',
          message: `${names} 会移到服务器上的回收站，随时可以在左边「回收站」里还原。${system ? '这是系统目录里的东西，删掉可能让服务或系统出问题，确认你知道它是做什么的。' : ''}`,
          confirm: '移到回收站',
          danger: system,
        })
        if (!ok) return
        try {
          const res = await call('trash', { paths })
          if (res.failed?.length) flash(`${res.failed.length} 项没删成：${res.failed[0].reason}`, 'error')
          else flash(`已移到回收站 ${res.moved.length} 项`)
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
          else flash(`已还原 ${res.restored.length} 项到原来的位置`)
          await openTrash()
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      async function purge(items, all = false) {
        const ok = await ask({
          title: all ? '清空回收站？' : '彻底删除？',
          message: all ? `回收站里的 ${trash?.length ?? 0} 项会从服务器上永久删除，不能再还原。` : `${items.length} 项会从服务器上永久删除，不能再还原。`,
          confirm: all ? '清空' : '彻底删除',
          danger: true,
        })
        if (!ok) return
        try {
          await call('purge', all ? { all: true } : { ids: items.map((i) => i.id) })
          flash(all ? '回收站已清空' : '已彻底删除')
          await openTrash()
        } catch (e) {
          flash(e.message, 'error')
        }
      }

      async function startUpload(fileList) {
        const list = [...(fileList ?? [])]
        if (!list.length) return
        if (inTrash || !data) {
          flash('先进入一个文件夹再上传', 'error')
          return
        }
        if (!data.writable) {
          flash('这个文件夹没有写权限，传不进去', 'error')
          return
        }
        const dir = st.cwd
        const existing = new Set(data.entries.map((e) => e.name))
        const clash = list.filter((f) => existing.has(f.name))
        if (clash.length) {
          const ok = await ask({
            title: `覆盖 ${clash.length} 个同名文件？`,
            message: `${clash.slice(0, 3).map((f) => f.name).join('、')}${clash.length > 3 ? ' 等' : ''} 已经在这个文件夹里了。覆盖前会先把原文件备份到服务器的 ~/.cache/dsh-vps/backups/，权限和属主保持不变。`,
            confirm: '覆盖',
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
            if (!res.cancelled) flash(`${file.name} 没传上去：${res.error}`, 'error')
          }
        }
        if (done) flash(`已上传 ${done} 个文件`)
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
        if (dirs) flash('文件夹暂时不能直接上传：先压缩成一个文件再传', 'error')
        startUpload(list)
      }

      // —— 编辑器 ——
      const dirty = editor ? editor.content !== editor.original : false

      async function reloadEditor() {
        if (!editor) return
        try {
          const res = await call('read', { path: editor.path })
          setEditor((ed) => ({ ...ed, content: res.content, original: res.content, sha: res.sha, error: '' }))
          flash('已重新加载最新内容')
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
            const choice = await ask({ title: '文件被改过', message: res.error, confirm: '仍然覆盖', danger: true, extra: [{ label: '重新加载', value: 'reload' }] })
            if (choice === true) return saveEditor(true)
            if (choice === 'reload') return reloadEditor()
            return undefined
          }
          setEditor((ed) => ({ ...ed, saving: false, original: content, sha: res.sha || '' }))
          flash(`已保存${res.backupPath ? '，原文件已备份' : ''}`)
          if (st.view === 'dir') openDir(st.cwd, { push: false })
        } catch (e) {
          setEditor((ed) => ({ ...ed, saving: false, error: e.message }))
        }
        return undefined
      }

      async function closeEditor() {
        if (dirty) {
          const ok = await ask({ title: '放弃修改？', message: '改动还没保存，关掉就没了。', confirm: '放弃修改', danger: true })
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
          if (!items.length) return [['清空回收站', () => purge([], true), { danger: true, disabled: !trash?.length }]]
          return [
            [`还原${items.length > 1 ? ` ${items.length} 项` : ''}`, () => restore(items)],
            null,
            [`彻底删除${items.length > 1 ? ` ${items.length} 项` : ''}`, () => purge(items), { danger: true }],
          ]
        }
        const item = menu.item
        if (!item) {
          return [
            ['新建文件夹', newFolder, { disabled: !data?.writable }],
            ['上传文件…', () => fileInput.current?.click(), { disabled: !data?.writable }],
            ['刷新', refresh],
            null,
            ['在终端打开此目录', () => cdInTerminal(st.cwd)],
            ['复制路径', () => copyPath(st.cwd)],
          ]
        }
        if (selectedItems.length > 1) {
          return [[`移到回收站（${selectedItems.length} 项）`, () => trashItems(selectedItems), { danger: true }]]
        }
        const path = joinRemote(st.cwd, item.name)
        if (item.lossy) return [['在终端打开此目录', () => cdInTerminal(st.cwd)]]
        if (isDirLike(item)) {
          return [
            ['打开', () => openDir(path)],
            ['下载（打包成 .tar.gz）', () => download(path)],
            ['在终端打开此目录', () => cdInTerminal(path)],
            null,
            ['改名', () => rename(item)],
            ['复制路径', () => copyPath(path)],
            null,
            ['移到回收站', () => trashItems([item]), { danger: true }],
          ]
        }
        const file = item.type === 'file' || (item.type === 'link' && item.target === 'file')
        return [
          ['编辑', () => openFile(item, path), { disabled: !file || item.size > FILE_EDIT_LIMIT }],
          ['下载', () => download(path), { disabled: !file }],
          ['让 AI 看看这个文件', () => share(path, item.name), { disabled: !file, accent: true }],
          ['在终端打开所在目录', () => cdInTerminal(st.cwd)],
          null,
          ['改名', () => rename(item)],
          ['复制路径', () => copyPath(path)],
          null,
          ['移到回收站', () => trashItems([item]), { danger: true }],
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
        width: '100%', boxSizing: 'border-box', height: 26, borderRadius: 7, border: `0.5px solid ${c.border}`,
        background: 'transparent', color: c.text, padding: '0 8px', fontSize: 12, fontFamily: c.code, outline: 'none',
      }

      // —— 区块 ——
      const toolbar = inTrash
        ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px', height: 38, borderBottom: `0.5px solid ${c.divider}` } },
          btn('‹', goUp, { title: '回到家目录' }),
          h('span', { style: { fontWeight: 500, fontSize: 12, marginLeft: 4 } }, '回收站'),
          h('span', { style: { color: c.tertiary, fontSize: 12 } }, '· 删掉的东西都在这里，服务器上的 ~/.cache/dsh-vps/trash'),
          h('span', { style: { flex: 1 } }),
          btn('↻', refresh, { title: '刷新' }),
          btn('还原', () => restore(selectedItems), { disabled: !selectedItems.length }),
          btn('彻底删除', () => purge(selectedItems), { disabled: !selectedItems.length, danger: true }),
          btn('清空回收站', () => purge([], true), { disabled: !trash?.length, danger: true }))
        : h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px', height: 38, borderBottom: `0.5px solid ${c.divider}` } },
          btn('‹', goBack, { title: '后退', disabled: !st.back.length }),
          btn('›', goForward, { title: '前进', disabled: !st.fwd.length }),
          btn('↑', goUp, { title: '上一级', disabled: !st.cwd || st.cwd === '/' }),
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
              title: '点空白处可以直接输入路径',
              onClick: () => setPathDraft(st.cwd),
              style: {
                flex: 1, minWidth: 0, margin: '0 4px', height: 26, display: 'flex', alignItems: 'center', gap: 0,
                border: `0.5px solid ${c.border}`, borderRadius: 7, padding: '0 4px', overflow: 'hidden', cursor: 'text',
              },
            }, h('div', { style: { display: 'flex', alignItems: 'center', overflow: 'hidden', direction: 'rtl' } },
              h('div', { style: { display: 'flex', alignItems: 'center', direction: 'ltr' } }, crumbs()))),
          btn('↻', refresh, { title: '刷新' }),
          btn('新建文件夹', newFolder, { disabled: !data?.writable, title: data?.writable === false ? '这个文件夹没有写权限' : undefined }),
          btn(st.hidden ? '✓ 显示隐藏文件' : '显示隐藏文件', () => { st.hidden = !st.hidden; bump() }, { active: st.hidden, title: '以 . 开头的文件，比如 .env、.htaccess' }),
          btn('上传', () => fileInput.current?.click(), { primary: true, disabled: !data?.writable, title: data?.writable === false ? '这个文件夹没有写权限' : '也可以把文件直接拖进来' }))

      const home = places?.home || ''
      const sidebar = h('div', { style: { width: 132, flex: '0 0 auto', borderRight: `0.5px solid ${c.divider}`, padding: '8px 6px', overflowY: 'auto', boxSizing: 'border-box' } },
        h('div', { style: { color: c.tertiary, fontSize: 11, padding: '2px 8px 6px' } }, '常用位置'),
        placeRow('家目录', home, !inTrash && st.cwd === home, () => openDir(home || '/')),
        places?.web ? placeRow('网站', places.web, !inTrash && st.cwd === places.web, () => openDir(places.web)) : null,
        placeRow('配置 /etc', '/etc', !inTrash && st.cwd === '/etc', () => openDir('/etc')),
        placeRow('日志 /var/log', '/var/log', !inTrash && st.cwd === '/var/log', () => openDir('/var/log')),
        placeRow('根目录 /', '/', !inTrash && st.cwd === '/', () => openDir('/')),
        h('div', { style: { height: 1, background: c.divider, margin: '6px 8px' } }),
        placeRow('回收站', '~/.cache/dsh-vps/trash', inTrash, openTrash, places?.trash ? String(places.trash) : ''))

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
          th('名称'), th('原来的位置', null, 220), th('删除时间', null, 96), th('大小', null, 64, 'right'))
        : h('div', { style: { display: 'flex', gap: 12, padding: '6px 12px', fontSize: 11, borderBottom: `0.5px solid ${c.divider}` } },
          th('名称', 'name'), th('大小', 'size', 64, 'right'), th('修改时间', 'mtime', 96), th('权限', null, 40), th('所有者', null, 56))

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
            item.type === 'link' ? h('span', { style: { color: item.target === 'broken' ? c.danger : c.tertiary, fontSize: 11, flex: '0 0 auto' } }, item.target === 'broken' ? '链接已失效' : '链接') : null),
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
              btn('重试', refresh, { active: true }),
              home ? btn('回到家目录', () => openDir(home), { active: true }) : null))
          : !rows.length
            ? empty(loading ? '正在读取…' : inTrash ? '回收站是空的' : '这个文件夹是空的。把电脑上的文件拖进来就能上传')
            : rows.map(rowView))

      const statusText = inTrash
        ? `${rows.length} 项${selectedItems.length ? ` · 已选 ${selectedItems.length} 项` : ''}`
        : data
          ? [
            `${rows.length} 项${data.entries.length !== rows.length ? `（另有 ${data.entries.length - rows.length} 个隐藏文件）` : ''}`,
            selectedItems.length ? `已选 ${selectedItems.length} 项` : '',
            data.truncated ? '只显示前 3000 项' : '',
            data.writable ? '' : '只读',
          ].filter(Boolean).join(' · ')
          : ''

      const uploadRows = uploads.map((u) => h('div', { key: u.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', fontSize: 12, borderTop: `0.5px solid ${c.divider}` } },
        h('span', { style: { color: u.status === 'failed' ? c.danger : c.secondary, flex: '0 0 auto' } }, u.status === 'running' ? '上传' : u.status === 'cancelled' ? '已取消' : '失败'),
        h('span', { style: { maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, u.name),
        h('span', { style: { flex: 1, height: 4, borderRadius: 2, background: c.divider, overflow: 'hidden' } },
          h('span', { style: { display: 'block', height: '100%', width: `${u.total ? Math.round((u.loaded / u.total) * 100) : 100}%`, background: u.status === 'failed' ? c.danger : c.accent } })),
        h('span', { style: { color: c.tertiary, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' } }, `${fmtBytes(u.loaded)} / ${fmtBytes(u.total)}`),
        u.status === 'running'
          ? btn('取消', () => u.abortRef.current?.(), {})
          : btn('×', () => setUploads((list) => list.filter((x) => x.id !== u.id)), { title: '关掉' })))

      const noticeRow = notice ? h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12, lineHeight: 1.5,
          borderTop: `0.5px solid ${c.divider}`, background: c.tip, color: notice.tone === 'error' ? c.danger : c.secondary,
        },
      }, h('span', { style: { flex: 1 } }, notice.text), btn('×', () => setNotice(null), { title: '关掉' })) : null

      const status = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 26, fontSize: 11, color: c.tertiary, borderTop: `0.5px solid ${c.divider}` } },
        h('span', { style: { flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' } }, loading ? '正在读取…' : statusText),
        !inTrash && data?.freeBytes !== null && data?.freeBytes !== undefined ? h('span', null, `磁盘剩余 ${fmtBytes(data.freeBytes)}`) : null)

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
          btn('取消', () => closeDialog(null), { active: true }),
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
          }, dialog.confirm ?? '确定')))) : null

      const editorView = editor ? h('div', {
        onClick: (e) => e.stopPropagation(),
        style: { position: 'absolute', inset: 0, zIndex: 6, background: c.bg, display: 'flex', flexDirection: 'column' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px 0 12px', height: 38, borderBottom: `0.5px solid ${c.divider}` } },
          h(FileIcon, { kind: 'file', color: c.tertiary }),
          h('span', { style: { fontWeight: 500, fontSize: 12.5 } }, editor.name),
          h('span', { style: { color: c.tertiary, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 } }, editor.path),
          dirty ? h('span', { style: { color: c.secondary, fontSize: 12, flex: '0 0 auto' } }, '● 未保存') : null,
          btn('让 AI 看看', () => share(editor.path, editor.name), { title: '把保存在服务器上的版本交给 AI' }),
          btn(editor.saving ? '保存中…' : '保存', () => saveEditor(), { primary: true, disabled: !dirty || editor.saving, title: '⌘S / Ctrl+S；保存前会自动备份原文件' }),
          btn('关闭', closeEditor, { active: true })),
        LOCKOUT_FILES.test(editor.path)
          ? h('div', { style: { padding: '6px 12px', fontSize: 12, background: c.tip, color: c.danger, lineHeight: 1.5 } },
            '这个文件改错了可能导致连不上服务器或登录不了。保存前会自动备份；如果要重启服务让它生效，建议让 AI 来做（它会先设好连不上时的自动恢复）。')
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
      }, `松手就上传到 ${st.cwd || '这里'}`) : null

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
      return h('span', {
        style: { display: 'inline-flex', border: line, borderRadius: 8, overflow: 'hidden' },
      }, options.map((o, i) => h('button', {
        key: String(o.value),
        type: 'button',
        onClick: () => onChange(o.value),
        style: {
          border: 'none', borderLeft: i ? line : 'none', padding: '4px 12px', fontSize: 13, cursor: 'pointer',
          background: o.value === value ? T.accent : 'transparent',
          color: o.value === value ? 'var(--primary-foreground, #fff)' : 'inherit',
        },
      }, o.label)))
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
          setMsg('已保存')
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
          h('div', { style: S.h2 }, '终端'),
          msg ? h('span', { style: { ...S.muted, fontSize: 11 } }, msg) : null),
        h(ErrorBar, { error }),
        row('颜色方案',
          h(Segmented, { value: prefs.theme, options: TERM_THEMES, onChange: (v) => setPref('theme', v) }),
          '跟随系统：和 DSH 的外观保持一致（DSH 外观设成跟随系统时，就跟着电脑的深浅色走）'),
        row('字号',
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
            h(Btn, { disabled: prefs.fontSize <= 11, onClick: () => setPref('fontSize', prefs.fontSize - 1), title: '减小字号' }, '−'),
            h('span', { style: { minWidth: 36, textAlign: 'center' } }, `${prefs.fontSize} px`),
            h(Btn, { disabled: prefs.fontSize >= 20, onClick: () => setPref('fontSize', prefs.fontSize + 1), title: '增大字号' }, '+'))),
        row('断线后保留',
          h(Segmented, { value: prefs.keepMinutes, options: TERM_KEEP, onChange: (v) => setPref('keepMinutes', v) }),
          '刷新页面或网络断开后，服务器上的终端保留多久。这段时间内回来会自动接上，断开期间的输出也补回来'),
        row('其他设备',
          h('label', { style: S.row },
            h('input', {
              type: 'checkbox',
              checked: Boolean(settings.allowTerminalRemote),
              onChange: (e) => save({ allowTerminalRemote: e.target.checked }),
            }),
            h('span', null, '允许从其他设备打开 VPS 终端')),
          '终端等于服务器的完整操作权限。默认只能在运行 DSH 的这台电脑上打开；用局域网地址或反向代理访问 DSH 时才需要勾选'),
        h('div', { style: { ...S.muted, fontSize: 12, lineHeight: 1.8, marginTop: 6, borderTop: line, paddingTop: 8 } },
          h('div', null, '对话头部「VPS」后面的 >_ 打开终端；再点一次最小化，再点恢复。面板标题栏切到「文件」就是文件管理'),
          h('div', null, '终端右上角：红色 × 结束（服务器上的 shell 一起结束）· 黄色 − 最小化成输入框下方的横栏 · 绿色最大化（再点恢复，双击标题栏也行）'),
          h('div', null, '最小化、切到别的对话再回来，终端和里面的内容都还在')))
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
          // DSH 0.1.7 起，输入框下面那一栏是「居中、不换行」的一行，里面除了插件插槽
          // 还有 DSH 自己的用量显示（轮次 / token / 上下文占比）。终端面板挤在那一行里，
          // 会把用量显示推到两边、互相压着（用户实测截图）。这里让那一栏可以换行，
          // 并把我们的东西排到最后：用量显示留在原来那行，我们另起一行。
          // 插槽外层是 display:contents，所以真正排版的是「爷爷」那一层，两层都写上；
          // 真正的兜底在 claimOwnRow（运行时往上找那一层），CSS 只是让首帧就不错位。
          'div:has(> [data-vps-dock]),div:has(> * > [data-vps-dock]){flex-wrap:wrap}',
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

    function apply(ctx) {
      injectStyles()
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
          ctx.slots.register({ name: 'settings.section', id: 'vps-manager', order: 30, label: () => 'VPS 管理' }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-vps-manager] 设置页注册失败', error)
        reportClientError('设置页注册失败', error)
      }
    }

    // 给测试用的内部句柄（浏览器里没人碰它）
    module.exports = { name, inject, apply, __test: { api, waitingLabel, alertsFor, readBinding, writeBinding, ballLabel, chipTone, terminalUrl, normalizeTermPrefs, termChrome, minutesSince } }
    return module.exports
  },
})
