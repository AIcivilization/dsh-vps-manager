/* global window, document, fetch, navigator, setTimeout, clearTimeout */
// lib/client.js — 面板（设计第三节）
//
// 手写单文件 bundle，没有构建链：供 DSH web 客户端的 ModuleLoader 注入。
// 三处挂载，机器设置页在面板和 DSH 设置页里是**同一个组件**：
//   sidebar.panellist  左边栏图标
//   main               主视区面板（机器 / 应用商店 / 任务）
//   settings.section   设置 → VPS 管理（全局设置 + 分组 + 机器设置页）
//
// 面板只通过 /api-vps/* 路由调 host：它没有 Session 绑定，不能直接执行命令。
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

    async function api(path, body = {}) {
      const res = await fetch(`/api-vps/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dsh-vps-token': window.__DSH_VPS_TOKEN__ || '',
        },
        body: JSON.stringify(body),
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        throw new Error(`服务返回异常（HTTP ${res.status}）`)
      }
      if (!data || data.ok !== true) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`)
      return data
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

    // ——————————————————————— 机器设置页（面板与设置页共用）———————————————————————

    function MachineSettings({ alias, onBack, onChanged }) {
      const detail = useAsync(() => api('host/detail', { alias }), [alias])
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [msg, setMsg] = useState('')
      const [fingerprints, setFingerprints] = useState(null)
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
            h(Btn, { onClick: test, disabled: busy === 'test' }, busy === 'test' ? '测试中…' : '测连通'),
            h(Btn, { kind: 'primary', onClick: () => save(), disabled: busy === 'save' }, busy === 'save' ? '保存中…' : '保存'))),

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

    // ——————————————————————— 添加机器向导 ———————————————————————

    function AddWizard({ onDone, onCancel }) {
      const [step, setStep] = useState(1)
      const [form, setForm] = useState({ hostname: '', port: '22', user: 'root', alias: '', note: '', group: '' })
      const [key, setKey] = useState(null)
      const [cmds, setCmds] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [result, setResult] = useState(null)
      const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

      const next = async () => {
        setError('')
        if (step === 1) {
          if (!form.hostname) return setError('先填服务器地址')
          if (!form.alias) setForm((f) => ({ ...f, alias: f.hostname.replace(/[^A-Za-z0-9]/g, '-').slice(0, 20) }))
          setBusy('key')
          try {
            const k = await api('onboarding/key', { create: true })
            setKey(k)
            const c = await api('onboarding/commands', {
              hostname: form.hostname,
              port: Number(form.port) || 22,
              user: form.user,
            })
            setCmds(c)
            setStep(2)
          } catch (e) {
            setError(e.message)
          } finally {
            setBusy('')
          }
          return
        }
        if (step === 2) return setStep(3)
        if (step === 3) {
          setBusy('save')
          try {
            const res = await api('host/save', {
              alias: form.alias,
              hostname: form.hostname,
              port: Number(form.port) || 22,
              user: form.user,
              note: form.note,
              group: form.group,
              identityFile: key?.path,
              managed: true,
            })
            setResult(res)
            setStep(4)
            onDone?.(form.alias, res)
          } catch (e) {
            setError(e.message)
          } finally {
            setBusy('')
          }
        }
      }

      const steps = ['填写信息', '生成钥匙', '放公钥到服务器', '完成']
      return h('div', null,
        h('div', { style: { ...S.row, marginBottom: 12 } },
          steps.map((s, i) => h('span', { key: s, style: S.badge(step === i + 1 ? 'ok' : null) }, `${i + 1}. ${s}`))),
        h(ErrorBar, { error }),

        step === 1 ? h('div', { style: S.card },
          h('div', { style: S.grid },
            h(Field, { label: '服务器地址', hint: 'IP 或域名' }, h(Input, { value: form.hostname, onChange: set('hostname'), placeholder: '1.2.3.4' })),
            h(Field, { label: '端口' }, h(Input, { value: form.port, onChange: set('port') })),
            h(Field, { label: '用户名' }, h(Input, { value: form.user, onChange: set('user') })),
            h(Field, { label: '别名', hint: '以后用它指代这台机器' }, h(Input, { value: form.alias, onChange: set('alias'), placeholder: 'hk' })),
            h(Field, { label: '备注' }, h(Input, { value: form.note, onChange: set('note'), placeholder: '香港，建站用' })),
            h(Field, { label: '分组' }, h(Input, { value: form.group, onChange: set('group'), placeholder: '生产' })))) : null,

        step === 2 ? h('div', { style: S.card },
          h('div', { style: S.h2 }, '插件专用钥匙'),
          h('div', { style: S.muted }, key?.created ? '已经为你生成了一把新的专用钥匙（不动你原有的钥匙）' : '使用已有的插件专用钥匙'),
          h('div', { style: { ...S.mono, marginTop: 6 } }, key?.path),
          key?.fingerprint ? h('div', { style: { ...S.muted, fontSize: 12 } }, key.fingerprint) : null) : null,

        step === 3 ? h('div', null,
          h('div', { style: S.note }, '公钥要放到服务器上，才能免密登录。三种办法任选一种，插件全程接触不到你的密码。'),
          h('div', { style: S.card },
            h('div', { style: S.h2 }, 'A. 服务商后台添加（新机器推荐）'),
            h('div', { style: S.muted }, '把下面这段公钥粘到服务商的「SSH 密钥」里，重装系统时勾选它。'),
            h(Copyable, { text: cmds?.pubkey ?? '', label: '复制公钥' })),
          h('div', { style: S.card },
            h('div', { style: S.h2 }, 'B. 已经能登录（网页控制台或别的终端）'),
            h('div', { style: S.muted }, '在服务器上粘贴执行这一行。'),
            h(Copyable, { text: cmds?.authorizedKeys ?? '', label: '复制命令' })),
          h('div', { style: S.card },
            h('div', { style: S.h2 }, 'C. 只有密码'),
            h('div', { style: S.muted }, '在终端里执行下面的命令，密码由你直接输给 ssh-copy-id。'),
            h(Copyable, { text: cmds?.sshCopyId ?? '', label: '复制命令' }),
            h('div', { style: { marginTop: 8 } },
              h(Btn, {
                onClick: async () => {
                  try {
                    const r = await api('onboarding/open-terminal', {
                      hostname: form.hostname,
                      port: Number(form.port) || 22,
                      user: form.user,
                    })
                    if (!r.opened) setError(r.hint || '没能自动打开终端，请复制上面的命令自己执行')
                  } catch (e) {
                    setError(e.message)
                  }
                },
              }, '在终端中打开')))) : null,

        step === 4 ? h('div', { style: S.card },
          h('div', { style: S.h2 }, result?.probe?.ok ? '添加成功' : '已保存，但还连不上'),
          h('div', null, result?.probe?.ok
            ? `${form.alias} 连接正常：${result.probe.address}（${result.probe.facts?.os_id ?? ''} ${result.probe.facts?.os_ver ?? ''}，权限 ${PRIV_LABEL[result.probe.facts?.privilege] ?? '未知'}）`
            : `原因：${result?.probe?.hint ?? '未知'}。公钥可能还没放上去，或者地址端口不对。可以在机器设置页里改了再测。`)) : null,

        h('div', { style: { ...S.row, marginTop: 12 } },
          step < 4 ? h(Btn, { kind: 'primary', onClick: next, disabled: Boolean(busy) },
            busy ? '处理中…' : step === 3 ? '保存并测试连接' : '下一步') : null,
          step === 4 ? h(Btn, { kind: 'primary', onClick: onCancel }, '完成') : h(Btn, { onClick: onCancel }, '取消')))
    }

    // ——————————————————————— 机器列表 ———————————————————————

    function MachinesTab({ overview, onReload }) {
      const [selected, setSelected] = useState('')
      const [adding, setAdding] = useState(false)
      const [importing, setImporting] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')

      if (adding) return h(AddWizard, { onDone: onReload, onCancel: () => { setAdding(false); onReload() } })
      if (selected) return h(MachineSettings, { alias: selected, onBack: () => setSelected(''), onChanged: onReload })

      const hosts = overview?.hosts ?? []
      return h('div', null,
        h(ErrorBar, { error }),
        h('div', { style: { ...S.spread, marginBottom: 10 } },
          h('div', { style: S.muted }, `${hosts.length} 台机器　★ = 当前机器（给 /vps-* 命令用）`),
          h('div', { style: S.row },
            h(Btn, {
              onClick: async () => {
                try {
                  const res = await api('import/candidates', {})
                  setImporting(res.candidates ?? [])
                } catch (e) {
                  setError(e.message)
                }
              },
            }, '从 ~/.ssh/config 导入'),
            h(Btn, { kind: 'primary', onClick: () => setAdding(true) }, '+ 添加机器'))),

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
                      onReload()
                    } catch (e) {
                      setError(e.message)
                    }
                  },
                }, '导入'))),
          h('div', { style: { marginTop: 8 } }, h(Btn, { onClick: () => setImporting(null) }, '关闭'))) : null,

        hosts.length === 0 && !importing
          ? h('div', { style: S.note }, '还没有添加机器。点右上角「+ 添加机器」，向导会一步步带你接上第一台。')
          : null,

        hosts.map((host) => h('div', { key: host.alias, style: S.card },
          h('div', { style: S.spread },
            h('div', { style: S.row },
              h('span', { style: { fontSize: 15 } }, dot(host.reachable)),
              h('span', { style: { fontWeight: 600 } }, `${host.alias}${overview.current === host.alias ? ' ★' : ''}`),
              h('span', { style: S.mono }, host.address || '未测'),
              host.group ? h(Badge, null, host.group) : null,
              h(Badge, null, PRIV_LABEL[host.privilege] ?? '权限未知'),
              h('span', { style: S.muted }, host.note || '')),
            h('div', { style: S.row },
              h(Btn, {
                onClick: async () => {
                  setBusy(host.alias)
                  setError('')
                  try {
                    await api('host/test', { alias: host.alias })
                    onReload()
                  } catch (e) {
                    setError(e.message)
                  } finally {
                    setBusy('')
                  }
                },
                disabled: busy === host.alias,
              }, busy === host.alias ? '测试中…' : '测连通'),
              overview.current === host.alias ? null : h(Btn, {
                onClick: async () => {
                  try {
                    await api('host/current', { alias: host.alias })
                    onReload()
                  } catch (e) {
                    setError(e.message)
                  }
                },
              }, '设为当前'),
              h(Btn, { kind: 'primary', onClick: () => setSelected(host.alias) }, '设置'))),
          h('div', { style: { ...S.muted, fontSize: 12, marginTop: 6 } },
            `${host.os || '系统未知'}　确认档位：${CONFIRM_LABEL[host.confirmLevel] ?? host.confirmLevel}`))))
    }

    // ——————————————————————— 应用商店 ———————————————————————

    function RecipeRunner({ recipe, hosts, current, onClose }) {
      const [alias, setAlias] = useState(current || hosts[0]?.alias || '')
      const [detail, setDetail] = useState(null)
      const [params, setParams] = useState({})
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [run, setRun] = useState(null)
      const [showScript, setShowScript] = useState(false)
      const [tick, setTick] = useState(0)
      const pollRef = useRef(null)
      const logRef = useRef(null)

      useEffect(() => () => clearTimeout(pollRef.current), [])
      // 执行中每秒跳一次，让「已用 N 秒」动起来
      useEffect(() => {
        if (!busy) return undefined
        const timer = setInterval(() => setTick((n) => n + 1), 1000)
        return () => clearInterval(timer)
      }, [busy])
      // 日志自动滚到底
      useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      }, [run?.log])

      const detect = useCallback(async () => {
        if (!alias) return
        setError('')
        try {
          setDetail(await api('recipes/show', { id: recipe.id, alias }))
        } catch (e) {
          setError(e.message)
        }
      }, [alias, recipe.id])

      useEffect(() => {
        detect()
      }, [detect])

      // 跑完一个阶段就把日志追加上来；任务结束后再单独跑一次 verify
      const poll = useCallback(async (taskId) => {
        try {
          const res = await api('tasks/status', { alias, taskId, tailBytes: 20000 })
          const state = res.task?.state ?? 'running'
          setRun((r) => ({ ...r, log: res.log || r?.log || '', task: res.task }))
          if (state === 'running') {
            pollRef.current = setTimeout(() => poll(taskId), 1500)
            return
          }
          // 任务结束 → 验证
          setRun((r) => ({ ...r, phase: 'verifying', exitCode: res.task?.exitCode ?? null }))
          let verify = null
          try {
            verify = await api('recipes/verify', { id: recipe.id, alias })
          } catch (e) {
            verify = { ok: false, hint: e.message }
          }
          setRun((r) => ({
            ...r,
            phase: res.task?.exitCode === 0 && verify?.ok ? 'done' : 'failed',
            verify,
            exitCode: res.task?.exitCode ?? null,
          }))
          setBusy(false)
          onChanged?.()
        } catch (e) {
          setError(e.message)
          setBusy(false)
        }
      }, [alias, recipe.id])

      const start = async () => {
        clearTimeout(pollRef.current)
        setBusy(true)
        setError('')
        setRun({ phase: 'starting', log: '', startedAt: Date.now() })
        try {
          // waitSeconds: 0 —— 不在 HTTP 请求里干等，立刻拿任务号，进度靠轮询
          const res = await api('recipes/run', { id: recipe.id, alias, params, waitSeconds: 0 })
          if (res.taskId) {
            setRun((r) => ({ ...r, phase: 'running', taskId: res.taskId, hint: res.hint }))
            poll(res.taskId)
            return
          }
          // 没有任务号：已经装好了、被拦下了、或者参数不对
          setRun((r) => ({
            ...r,
            phase: res.ok ? 'done' : 'failed',
            hint: res.hint,
            log: res.output || '',
            exitCode: res.exitCode ?? null,
          }))
          setBusy(false)
          detect()
        } catch (e) {
          setError(e.message)
          setBusy(false)
        }
      }

      const isInstall = recipe.kind === 'install'
      const detectLabel = isInstall
        ? {
            installed: '这台机器上已经装了（执行会跳过安装，直接验证）',
            absent: '这台机器上还没装',
            unknown: '检测说不清，先别装',
          }
        : {
            installed: '当前已经是目标状态，执行也不会有变化',
            absent: '当前不是目标状态，可以执行',
            unknown: '检测说不清，先别执行',
          }

      return h('div', { style: S.card },
        h('div', { style: S.spread },
          h('div', null,
            h('div', { style: { fontSize: 15, fontWeight: 600 } }, recipe.name),
            h('div', { style: S.muted }, recipe.desc)),
          h(Btn, { onClick: onClose }, '返回列表')),
        h(ErrorBar, { error }),

        h('div', { style: { ...S.row, marginTop: 10 } },
          h('span', { style: S.label }, isInstall ? '装到哪台：' : '在哪台执行：'),
          h('div', { style: { minWidth: 200 } },
            h(Select, {
              value: alias,
              onChange: setAlias,
              options: hosts.map((x) => ({ value: x.alias, label: `${x.alias}${x.note ? ` · ${x.note}` : ''}` })),
            }))),

        (recipe.params ?? []).length
          ? h('div', { style: { ...S.grid, marginTop: 10 } },
              recipe.params.map((p) => h(Field, { key: p.name, label: `${p.desc || p.name}${p.required ? ' *' : ''}` },
                h(Input, {
                  value: params[p.name] ?? '',
                  onChange: (v) => setParams((x) => ({ ...x, [p.name]: v })),
                }))))
          : null,

        detail ? h('div', { style: { marginTop: 10 } },
          h('div', null, detectLabel[detail.detect] ?? '未检测'),
          detail.recipe?.plan ? h('div', { style: { marginTop: 8 } },
            h('div', { style: S.label }, '将要做的事'),
            h('div', { style: S.pre }, detail.recipe.plan.trim())) : null,
          h('div', { style: { marginTop: 8 } },
            h(Btn, { onClick: () => setShowScript(!showScript) }, showScript ? '收起脚本' : '查看脚本原文'),
            showScript ? h('div', { style: { ...S.pre, marginTop: 6 } }, detail.recipe?.run?.trim()) : null)) : null,

        h('div', { style: { ...S.row, marginTop: 12 } },
          h(Btn, { kind: 'primary', onClick: start, disabled: busy || !alias }, busy ? '执行中…' : isInstall ? '开始安装' : '执行'),
          h(Btn, { onClick: detect, disabled: busy }, '重新检测')),

        run ? (() => {
          const elapsed = run.startedAt ? Math.round((Date.now() - run.startedAt) / 1000) : 0
          const phaseText = {
            starting: '正在检测并启动…',
            running: `执行中… 已用 ${elapsed} 秒`,
            verifying: '执行完了，正在验证…',
            done: '完成',
            failed: '没成功',
          }[run.phase] ?? run.phase
          const tone = run.phase === 'done' ? 'ok' : run.phase === 'failed' ? 'danger' : null
          return h('div', { style: { marginTop: 12 } },
            h('div', { style: S.row },
              h(Badge, { tone }, phaseText),
              run.exitCode !== null && run.exitCode !== undefined
                ? h('span', { style: S.muted }, `退出码 ${run.exitCode}`)
                : null,
              run.taskId ? h('span', { style: { ...S.muted, ...S.mono } }, `任务 ${run.taskId}`) : null,
              busy ? h('span', { style: S.muted }, '（可以关掉这个页面，任务在服务器上继续跑）') : null),
            run.hint ? h('div', { style: { ...S.muted, marginTop: 4 } }, run.hint) : null,
            h('div', { ref: logRef, style: { ...S.pre, marginTop: 6, minHeight: 90 } },
              run.log || (busy ? '等待第一行输出…' : '（没有输出）')),
            run.verify
              ? h('div', { style: { marginTop: 8 } },
                  h('div', { style: S.label }, run.verify.ok ? '验证通过' : '验证没通过'),
                  h('div', { style: S.pre }, run.verify.output || run.verify.hint || ''))
              : null,
            run.phase === 'failed'
              ? h('div', { style: { ...S.muted, marginTop: 6 } },
                  '想让 AI 帮忙看，就在对话里说：')
              : null,
            run.phase === 'failed' && run.taskId
              ? h(Copyable, { text: `${alias} 上执行 ${recipe.id} 失败了，任务 ${run.taskId}，帮我查原因`, label: '复制这句话' })
              : null)
        })() : null)
    }

    function RecipeTab({ overview, onReload, kind }) {
      const [tab, setTab] = useState('builtin')
      const [keyword, setKeyword] = useState('')
      const [openId, setOpenId] = useState('')
      const isInstall = kind === 'install'
      const recipes = (overview?.recipes ?? []).filter((r) => r.kind === kind)
      const list = recipes.filter((r) =>
        (tab === 'builtin' ? r.source === 'builtin' : r.source !== 'builtin')
        && (!keyword || `${r.id}${r.name}${r.desc}${(r.tags ?? []).join('')}`.toLowerCase().includes(keyword.toLowerCase())))
      const open = recipes.find((r) => r.id === openId)

      if (open) {
        return h(RecipeRunner, {
          recipe: open,
          hosts: overview.hosts ?? [],
          current: overview.current,
          onClose: () => {
            setOpenId('')
            onReload()
          },
        })
      }

      return h('div', null,
        h('div', { style: { ...S.spread, marginBottom: 10 } },
          h('div', { style: S.row },
            h('span', { style: S.tab(tab === 'builtin'), onClick: () => setTab('builtin') }, '内置'),
            h('span', { style: S.tab(tab === 'mine'), onClick: () => setTab('mine') }, '我的')),
          h('div', { style: { width: 200 } }, h(Input, { value: keyword, onChange: setKeyword, placeholder: '搜索' }))),

        (overview?.recipeConflicts ?? []).length
          ? h('div', { style: S.note }, `有 ${overview.recipeConflicts.length} 个自定义菜谱与内置重名，没有加载：` + overview.recipeConflicts.map((c) => c.id).join('、'))
          : null,
        (overview?.recipeErrors ?? []).length
          ? h('div', { style: S.err }, `有 ${overview.recipeErrors.length} 个菜谱文件解析失败：` + overview.recipeErrors.map((e) => e.message).join('；'))
          : null,

        list.length === 0
          ? h('div', { style: S.note }, tab === 'builtin'
              ? (isInstall ? '没有匹配的内置安装项' : '没有匹配的维护操作')
              : '还没有自己的菜谱。让 AI 帮你做成一件事后，它会问你要不要存成菜谱。')
          : null,

        list.map((r) => h('div', { key: r.id, style: S.card },
          h('div', { style: S.spread },
            h('div', null,
              h('div', { style: S.row },
                h('span', { style: { fontWeight: 600 } }, r.name),
                h(Badge, null, r.source === 'builtin' ? '内置' : '我的'),
                r.tier === 'danger' ? h(Badge, { tone: 'danger' }, '高危') : null,
                r.incomplete ? h(Badge, { tone: 'danger' }, '缺 detect/verify') : null),
              h('div', { style: S.muted }, r.desc),
              h('div', { style: { ...S.muted, fontSize: 11, marginTop: 2 } },
                r.source === 'builtin' ? '✓ 随插件发布' : '未验证（自己存的）',
                r.requires?.privilege === 'root' ? '　需要 root' : '',
                (r.requires?.os ?? []).length ? `　适用：${r.requires.os.join('、')}` : '')),
            h(Btn, { kind: 'primary', onClick: () => setOpenId(r.id) }, isInstall ? '安装' : '执行')))))
    }

    // ——————————————————————— 任务 ———————————————————————

    function TasksTab({ overview }) {
      const hosts = overview?.hosts ?? []
      const [alias, setAlias] = useState(overview?.current || hosts[0]?.alias || '')
      const [error, setError] = useState('')
      const [openId, setOpenId] = useState('')
      const [log, setLog] = useState('')
      const tasks = useAsync(async () => (alias ? api('tasks/list', { alias }) : { tasks: [] }), [alias])

      const showLog = async (taskId) => {
        setOpenId(taskId)
        setLog('读取中…')
        try {
          const res = await api('tasks/status', { alias, taskId, tailBytes: 20000 })
          setLog(res.log || '（没有输出）')
        } catch (e) {
          setLog(`读取失败：${e.message}`)
        }
      }

      return h('div', null,
        h(ErrorBar, { error: error || tasks.error }),
        h('div', { style: { ...S.row, marginBottom: 10 } },
          h('span', { style: S.label }, '机器：'),
          h('div', { style: { minWidth: 200 } },
            h(Select, { value: alias, onChange: setAlias, options: hosts.map((x) => ({ value: x.alias, label: x.alias })) })),
          h(Btn, { onClick: tasks.reload }, '刷新')),

        tasks.loading ? h('div', { style: S.muted }, '读取中…') : null,
        (tasks.data?.tasks ?? []).length === 0 && !tasks.loading
          ? h('div', { style: S.note }, '这台机器上没有任务记录。安装类操作会在这里留下记录，断线后也能接回来看。')
          : null,

        (tasks.data?.tasks ?? []).map((t) => h('div', { key: t.taskId, style: S.card },
          h('div', { style: S.spread },
            h('div', { style: S.row },
              h(Badge, { tone: t.state === 'done' ? 'ok' : t.state === 'running' ? null : 'danger' },
                { running: '进行中', done: '成功', failed: '失败', interrupted: '异常终止' }[t.state] ?? t.state),
              h('span', { style: S.mono }, t.taskId),
              h('span', { style: S.muted }, t.meta?.recipeId || t.meta?.action || ''),
              h('span', { style: S.muted }, t.meta?.source ? `来源 ${t.meta.source}` : '')),
            h('div', { style: S.row },
              h(Btn, { onClick: () => showLog(t.taskId) }, '看日志'),
              t.state === 'running' ? h(Btn, {
                kind: 'danger',
                onClick: async () => {
                  if (!window.confirm('中途终止可能留下装了一半的状态（比如包管理器被打断）。确定要终止吗？')) return
                  try {
                    await api('tasks/cancel', { alias, taskId: t.taskId })
                    tasks.reload()
                  } catch (e) {
                    setError(e.message)
                  }
                },
              }, '终止') : null)),
          openId === t.taskId ? h('div', { style: { ...S.pre, marginTop: 8 } }, log) : null)))
    }

    // ——————————————————————— 设置页 ———————————————————————

    function SettingsSection() {
      const overview = useAsync(() => api('overview', {}), [])
      const [selected, setSelected] = useState('')
      const [settings, setSettings] = useState(null)
      const [msg, setMsg] = useState('')
      const [error, setError] = useState('')

      useEffect(() => {
        if (overview.data?.settings) setSettings(overview.data.settings)
      }, [overview.data])

      if (selected) {
        return h('div', { style: S.root },
          h(MachineSettings, { alias: selected, onBack: () => setSelected(''), onChanged: overview.reload }))
      }

      const d = overview.data
      return h('div', { style: S.root },
        h('div', { style: S.h1 }, 'VPS 管理'),
        h(ErrorBar, { error: error || overview.error }),
        msg ? h('div', { style: S.note }, msg) : null,

        h('div', { style: S.note },
          `已登记 ${(d?.hosts ?? []).length} 台机器。机器列表、单台机器的连接与基础配置，都在左边栏「VPS 管理」面板里；`,
          '这一页只放对所有机器生效的全局设置。'),

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
              h('span', null, 'DSH 的 Web 服务绑定在 0.0.0.0（局域网可见），允许在面板里执行会改东西的操作'))) : null,
          h('div', { style: { marginTop: 10 } },
            h(Btn, {
              kind: 'primary',
              onClick: async () => {
                setError('')
                try {
                  await api('settings/save', { settings })
                  setMsg('已保存')
                  overview.reload()
                } catch (e) {
                  setError(e.message)
                }
              },
            }, '保存设置'))) : null,

        d?.paths ? h('div', { style: S.card },
          h('div', { style: S.h2 }, '数据位置'),
          h('div', { style: S.mono }, d.paths.base),
          h('div', { style: { ...S.muted, fontSize: 12 } }, 'hosts.yml 可以手工编辑；recipes/ 放自己的菜谱；audit/ 是操作记录')) : null)
    }

    // ——————————————————————— 主面板 ———————————————————————

    function Panel() {
      const [tab, setTab] = useState('machines')
      const overview = useAsync(() => api('overview', {}), [])

      return h('div', { style: S.root },
        h('div', { style: S.spread },
          h('div', { style: S.h1 }, 'VPS 管理'),
          h(Btn, { onClick: overview.reload }, '刷新')),
        h('div', { style: S.tabs },
          h('div', { style: S.tab(tab === 'machines'), onClick: () => setTab('machines') }, '机器'),
          h('div', { style: S.tab(tab === 'store'), onClick: () => setTab('store') }, '应用商店'),
          h('div', { style: S.tab(tab === 'maintain'), onClick: () => setTab('maintain') }, '系统维护'),
          h('div', { style: S.tab(tab === 'tasks'), onClick: () => setTab('tasks') }, '任务')),
        h(ErrorBar, { error: overview.error }),
        overview.loading && !overview.data ? h('div', { style: S.muted }, '读取中…') : null,
        overview.data ? (
          tab === 'machines' ? h(MachinesTab, { overview: overview.data, onReload: overview.reload })
            : tab === 'store' ? h(RecipeTab, { overview: overview.data, onReload: overview.reload, kind: 'install' })
              : tab === 'maintain' ? h(RecipeTab, { overview: overview.data, onReload: overview.reload, kind: 'config' })
                : h(TasksTab, { overview: overview.data })
        ) : null)
    }

    function PanelIcon(props) {
      const size = props?.size ?? 20
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 },
        h('rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }),
        h('rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }),
        h('circle', { cx: 7, cy: 7.5, r: 0.9, fill: 'currentColor' }),
        h('circle', { cx: 7, cy: 16.5, r: 0.9, fill: 'currentColor' }))
    }


    // ——————————————————————— 对话里的入口 ———————————————————————
    // 挂在 conversation.input.left（「专家」「工作区内修改」那一排）：
    // 干活时随手看一眼机器、跑个只读查询，不用离开对话。完整面板仍在主视区。

    // 打开就有内容：自动拉一次健康状态；有问题才显示建议行；有任务才显示任务区。
    // 查询是可搜索的全量列表，不是几个固定按钮。结果可以一键写进对话框交给 AI。

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

    /** 头部开关和输入框下方的状态条是两个组件，用事件保持同步 */
    function useBinding(sessionId) {
      const [alias, setAlias] = useState(() => readBinding(sessionId))
      useEffect(() => {
        const onChange = (e) => {
          if (e?.detail?.sessionId === sessionId) setAlias(e.detail.alias ?? '')
        }
        window.addEventListener(BIND_EVENT, onChange)
        return () => window.removeEventListener(BIND_EVENT, onChange)
      }, [sessionId])
      const bind = useCallback(async (next) => {
        await api('session/bind', { sessionId, alias: next || null })
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

    // —— 对话头部的开关 ——

    function VpsToggle(props) {
      const sessionId = props?.sessionId ? String(props.sessionId) : ''
      const { alias, bind } = useBinding(sessionId)
      const [open, setOpen] = useState(false)
      const [hosts, setHosts] = useState(null)
      const [error, setError] = useState('')
      const [anchor, setAnchor] = useState(null)
      const btnRef = useRef(null)
      const boxRef = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const onDown = (e) => {
          if (boxRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
          setOpen(false)
        }
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false)
        }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('mousedown', onDown)
          window.removeEventListener('keydown', onKey)
        }
      }, [open])

      const toggle = async () => {
        if (!open && btnRef.current) {
          const r = btnRef.current.getBoundingClientRect()
          setAnchor({ left: r.left, top: r.bottom + 6 })
          setError('')
          try {
            const res = await api('overview', {})
            setHosts(res.hosts ?? [])
          } catch (e) {
            setError(e.message)
          }
        }
        setOpen(!open)
      }

      const on = Boolean(alias)
      return h('div', { style: { display: 'inline-flex', position: 'relative' } },
        h('button', {
          ref: btnRef,
          type: 'button',
          onClick: toggle,
          title: on ? `这个对话正在操作 ${alias}，点一下切换或关闭` : '打开后，这个对话的命令和 AI 都操作你选的那台 VPS',
          style: {
            ...S.btn(null, false),
            padding: '3px 10px',
            fontSize: 12,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            borderColor: on ? T.accent : undefined,
            color: on ? T.accent : 'inherit',
            opacity: on ? 1 : 0.75,
          },
        }, h(PanelIcon, { size: 14 }), on ? alias : 'VPS'),

        open ? h('div', {
          ref: boxRef,
          style: {
            position: 'fixed',
            left: Math.max(12, anchor?.left ?? 12),
            top: anchor?.top ?? 60,
            width: 300,
            zIndex: 9999,
            border: line,
            borderRadius: 10,
            padding: 10,
            background: T.popover,
            color: T.popoverText,
            boxShadow: '0 10px 30px rgba(0,0,0,0.28)',
            fontSize: 13,
          },
        },
          h('div', { style: { ...S.label, marginBottom: 6 } },
            on ? '这个对话正在操作' : '让这个对话操作哪台机器'),
          h(ErrorBar, { error }),
          (hosts ?? []).length === 0
            ? h('div', { style: S.muted }, hosts ? '还没有机器，去左边栏「VPS 管理」添加' : '读取中…')
            : (hosts ?? []).map((host) => h('div', {
                key: host.alias,
                style: {
                  ...S.spread,
                  padding: '5px 4px',
                  cursor: 'pointer',
                  borderRadius: 6,
                  background: host.alias === alias ? 'var(--accent, rgba(127,127,127,0.14))' : 'transparent',
                },
                onClick: async () => {
                  try {
                    await bind(host.alias)
                    setOpen(false)
                  } catch (e) {
                    setError(e.message)
                  }
                },
              },
                h('span', null, `${dot(host.reachable)} ${host.alias}`,
                  host.note ? h('span', { style: S.muted }, ` ${host.note}`) : null),
                host.alias === alias ? h('span', { style: { color: T.accent } }, '✓') : null)),
          on ? h('div', { style: { marginTop: 8, borderTop: line, paddingTop: 8 } },
            h(Btn, {
              onClick: async () => {
                try {
                  await bind('')
                  setOpen(false)
                } catch (e) {
                  setError(e.message)
                }
              },
            }, '关闭 VPS 模式（这个对话不再操作服务器）')) : null,
          h('div', { style: { ...S.muted, fontSize: 11, marginTop: 8 } },
            on
              ? '打开时：命令和 AI 默认操作这台；输入框下方有状态条'
              : '只影响这个对话，别的对话不受影响')) : null)
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
        items.push({ tone: 'danger', text: `${alias} 连不上了` })
      } else {
        const facts = state?.facts ?? {}
        const pct = Number(String(facts.disk_pct ?? '').replace('%', ''))
        if (pct >= 85) items.push({ tone: 'danger', text: `${alias} 磁盘已用 ${facts.disk_pct}` })
      }
      return items
    }

    const ALERT_TTL_MS = 60_000
    const alertCache = new Map() // alias → { at, data }

    function VpsAlert(props) {
      const sessionId = props?.sessionId ? String(props.sessionId) : ''
      const { alias } = useBinding(sessionId)
      const [state, setState] = useState(null)

      useEffect(() => {
        if (!alias) {
          setState(null)
          return undefined
        }
        let alive = true
        const cached = alertCache.get(alias)
        if (cached && Date.now() - cached.at < ALERT_TTL_MS) {
          setState(cached.data)
          return undefined
        }
        ;(async () => {
          try {
            const [status, tasks] = await Promise.all([
              api('session/status', { sessionId }),
              api('tasks/list', { alias }).catch(() => ({ tasks: [] })),
            ])
            const data = {
              reachable: status.reachable,
              facts: status.facts ?? {},
              running: (tasks.tasks ?? []).filter((t) => t.state === 'running'),
            }
            alertCache.set(alias, { at: Date.now(), data })
            if (alive) setState(data)
          } catch {
            // 读不到就当没事，别为了报错占地方
          }
        })()
        return () => {
          alive = false
        }
      }, [alias, sessionId])

      if (!alias || !state) return null
      const items = alertsFor(alias, state)
      if (!items.length) return null // 没事就什么都不显示

      return h('div', {
        style: {
          marginTop: 6,
          padding: '4px 10px',
          border: line,
          borderRadius: 8,
          fontSize: 12,
          background: T.layer,
        },
      }, items.map((item, i) => h('div', {
        key: i,
        style: { color: item.tone === 'danger' ? T.danger : 'inherit', opacity: item.tone === 'ok' ? 0.85 : 1 },
      }, `• ${item.text}`)))
    }

    // ——————————————————————— 注册 ———————————————————————

    const name = 'vps-manager-client'
    const inject = ['slots']

    function apply(ctx) {
      // 插槽注册失败只降级：命令与 AI 工具不依赖面板
      try {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'vps-manager', order: 30, label: () => 'VPS 管理' }, PanelIcon))
      } catch (error) {
        console.warn('[dsh-vps-manager] 侧边栏入口注册失败', error)
      }
      try {
        // key 必须与 panellist 的 id 一致，否则点一下会抛错
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'vps-manager' }, Panel))
      } catch (error) {
        console.warn('[dsh-vps-manager] 主面板注册失败', error)
      }
      try {
        // 对话头部：VPS 开关（打开 = 这个对话在操作这台机器）
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register({ name: 'conversation.session.header.actions', id: 'vps-manager', order: 40 }, VpsToggle))
      } catch (error) {
        console.warn('[dsh-vps-manager] 对话头部开关注册失败', error)
      }
      try {
        // 输入框下方：平时不渲染，只有「不说你不知道」的事才冒一行
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'vps-manager', order: 40 }, VpsAlert))
      } catch (error) {
        console.warn('[dsh-vps-manager] 输入框状态条注册失败', error)
      }
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'vps-manager', order: 30, label: () => 'VPS 管理' }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-vps-manager] 设置页注册失败', error)
      }
    }

    // 给测试用的内部句柄（浏览器里没人碰它）
    module.exports = { name, inject, apply, __test: { api, alertsFor, readBinding, writeBinding } }
    return module.exports
  },
})
