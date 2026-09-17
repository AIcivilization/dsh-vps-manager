// lib/uninstall.js — 设置页「卸载」
//
// 插件在三个地方留过东西，用户逐项勾选要清哪些：
//   服务器上：~/.cache/dsh-vps（任务目录、改文件前的备份）；authorized_keys 里插件专用钥匙的公钥
//   本机：~/.ssh/config 顶部的 Include 行 + ~/.ssh/config.d/dsh-vps.conf；专用钥匙；$DSH_HOME/vps-manager
//   插件本身：DSH Desktop 经宿主的 desktopPnpm 服务执行 `dsh plugin remove`；普通 dsh 给出命令让用户自己跑
//
// 顺序有讲究：服务器上的事必须先做——本机的连接配置和钥匙一删，就连不上服务器了。
// 插件本身放最后：它会把这些代码文件从磁盘上删掉，所以本文件只用顶部的静态 import，不做懒加载。

import { copyFile, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { atomicWrite, dshHome, paths, readHosts } from './config.js'
import { runRemote } from './engine.js'
import { sshCloseMaster } from './ssh.js'

export const PACKAGE_NAME = 'dsh-vps-manager'
const INCLUDE_LINE = 'include config.d/dsh-vps.conf'
const INCLUDE_COMMENT = '# added by dsh-vps-manager'

/** 卸载选项。default 只给能找回来的操作打勾 */
export const OPTIONS = [
  { id: 'plugin', group: 'plugin', default: true, label: '移除插件本身' },
  { id: 'remoteCache', group: 'remote', default: false, label: '清理服务器上的插件目录' },
  { id: 'revokeKey', group: 'remote', default: false, label: '撤销插件钥匙在服务器上的登录权限' },
  { id: 'sshConfig', group: 'local', default: true, label: '移除 SSH 连接配置' },
  { id: 'key', group: 'local', default: false, label: '删除插件专用钥匙' },
  { id: 'data', group: 'local', default: false, label: '删除插件数据' },
]

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

function hasIncludeLine(text) {
  return text.split('\n').some((line) => line.trim().toLowerCase() === INCLUDE_LINE)
}

/** 卸载前看一眼：哪些东西真的存在，界面只列存在的 */
export async function uninstallPreview({ env = process.env, desktop } = {}) {
  const p = paths(env)
  const doc = await readHosts(env)
  const sshConfigText = (await exists(p.sshConfig)) ? await readFile(p.sshConfig, 'utf8') : ''
  return {
    packageName: PACKAGE_NAME,
    hosts: Object.keys(doc.hosts),
    present: {
      sshConfig: hasIncludeLine(sshConfigText) || (await exists(p.sshDropin)),
      key: await exists(p.defaultKey),
      data: await exists(p.base),
    },
    paths: { sshConfig: p.sshConfig, sshDropin: p.sshDropin, key: p.defaultKey, data: p.base },
    desktop: { canRemove: Boolean(desktop?.pnpm && desktop?.profileDir), canRestart: Boolean(desktop?.actions) },
    removeCommand: `dsh plugin remove ${PACKAGE_NAME}`,
  }
}

const REMOTE_CACHE_SCRIPT = [
  'D="$HOME/.cache/dsh-vps"',
  '[ -d "$D" ] || { echo "absent"; exit 0; }',
  // 有改动任务在跑就不删：删掉正在写日志的任务目录，任务结果就丢了
  'p=$(cat "$D/lock/pid" 2>/dev/null)',
  'if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "busy"; exit 0; fi',
  'rm -rf "$D" && echo "removed"',
].join('\n')

const REVOKE_SCRIPT = [
  'F="$HOME/.ssh/authorized_keys"',
  '[ -f "$F" ] || { echo "absent"; exit 0; }',
  'grep -qF "$P_KEY" "$F" || { echo "absent"; exit 0; }',
  // 先备份；用 cat > 写回，保留原文件的属主和权限
  'cp "$F" "$F.dsh-vps-bak" || exit 1',
  'grep -vF "$P_KEY" "$F.dsh-vps-bak" > "$F.dsh-vps-tmp" || true',
  'cat "$F.dsh-vps-tmp" > "$F" && rm -f "$F.dsh-vps-tmp" && echo "revoked"',
].join('\n')

async function remoteStep({ alias, body, params, specs, env, runner, signal }) {
  const res = await runRemote({ alias, body, params, specs, mode: 'read', withPrelude: false, timeoutMs: 30_000, env, runner, signal })
  return { res, word: String(res.stdout ?? '').trim().split('\n').pop() }
}

/**
 * 执行卸载。返回每一步的结果；一步失败不影响后面（除了明确依赖它的步骤）。
 * @param {object} o
 * @param {Record<string, boolean>} o.choices  选项 id → 是否执行
 * @param {{ pnpm?: object, actions?: object, profileDir?: string }} [o.desktop] DSH Desktop 宿主服务
 */
export async function runUninstall({ choices = {}, env = process.env, runner, signal, desktop } = {}) {
  const p = paths(env)
  const doc = await readHosts(env)
  const aliases = Object.keys(doc.hosts)
  const steps = []
  const step = (id, ok, text) => steps.push({ id, ok, text })

  // —— 服务器上（必须在删本机连接配置和钥匙之前）——
  if (choices.remoteCache) {
    for (const alias of aliases) {
      const { res, word } = await remoteStep({ alias, body: REMOTE_CACHE_SCRIPT, env, runner, signal })
      if (!res.ok) step('remoteCache', false, `${alias}：连不上，没清（${res.hint ?? res.status}）`)
      else if (word === 'busy') step('remoteCache', false, `${alias}：有任务正在跑，没清。等任务结束后可以手动删 ~/.cache/dsh-vps`)
      else if (word === 'absent') step('remoteCache', true, `${alias}：服务器上没有插件目录`)
      else step('remoteCache', true, `${alias}：已删除 ~/.cache/dsh-vps`)
    }
  }
  if (choices.revokeKey) {
    const pub = (await exists(`${p.defaultKey}.pub`)) ? (await readFile(`${p.defaultKey}.pub`, 'utf8')).trim() : ''
    const body = pub.split(/\s+/)[1] ?? ''
    if (!/^[A-Za-z0-9+/=]{40,}$/.test(body)) {
      step('revokeKey', false, '本机找不到插件专用钥匙的公钥，没法判断服务器上哪一行是它，没撤销')
    } else {
      const specs = [{ name: 'key', pattern: '[A-Za-z0-9+/=]{40,}', required: true }]
      for (const alias of aliases) {
        const { res, word } = await remoteStep({ alias, body: REVOKE_SCRIPT, params: { key: body }, specs, env, runner, signal })
        if (!res.ok) step('revokeKey', false, `${alias}：连不上，没撤销（${res.hint ?? res.status}）`)
        else if (word === 'revoked') step('revokeKey', true, `${alias}：已从 authorized_keys 删掉插件钥匙（原文件备份为 authorized_keys.dsh-vps-bak）`)
        else step('revokeKey', true, `${alias}：服务器上没有登记这把钥匙`)
      }
    }
  }

  // 断开复用连接：配置和钥匙马上要删，留着的主连接会让人误以为还连得上
  for (const alias of aliases) await sshCloseMaster(alias).catch(() => {})

  // —— 本机 ——
  if (choices.sshConfig) {
    try {
      const done = []
      if (await exists(p.sshConfig)) {
        const text = await readFile(p.sshConfig, 'utf8')
        if (hasIncludeLine(text)) {
          await copyFile(p.sshConfig, `${p.sshConfig}.dsh-uninstall-bak`)
          const lines = text.split('\n')
          const kept = lines.filter((line) => {
            const t = line.trim().toLowerCase()
            return t !== INCLUDE_LINE && t !== INCLUDE_COMMENT
          })
          // 插件加 Include 时在后面留了一个空行，去掉它，别让文件开头多出空行
          if (kept.length && kept[0].trim() === '' && lines[0].trim().toLowerCase() === INCLUDE_COMMENT) kept.shift()
          await atomicWrite(p.sshConfig, kept.join('\n'), 0o600)
          done.push(`去掉了 ${p.sshConfig} 里的 Include 行（原文件备份为 config.dsh-uninstall-bak）`)
        }
      }
      if (await exists(p.sshDropin)) {
        await rename(p.sshDropin, `${p.sshDropin}.uninstall-bak`)
        done.push(`${p.sshDropin} 已改名为 dsh-vps.conf.uninstall-bak`)
      }
      step('sshConfig', true, done.join('；') || '没有找到插件加的 SSH 配置')
    } catch (error) {
      step('sshConfig', false, `移除 SSH 配置失败：${error.message}`)
    }
  }
  if (choices.key) {
    try {
      await rm(p.defaultKey, { force: true })
      await rm(`${p.defaultKey}.pub`, { force: true })
      step('key', true, `已删除 ${p.defaultKey} 和 .pub`)
    } catch (error) {
      step('key', false, `删除钥匙失败：${error.message}`)
    }
  }
  if (choices.data) {
    // 只删插件自己的目录：路径必须正好是 $DSH_HOME/vps-manager
    const expected = join(dshHome(env), 'vps-manager')
    if (p.base !== expected || !p.base.endsWith(`${sep}vps-manager`)) {
      step('data', false, `数据目录路径异常（${p.base}），为安全起见没删`)
    } else {
      try {
        await rm(p.base, { recursive: true, force: true })
        step('data', true, `已删除 ${p.base}`)
      } catch (error) {
        step('data', false, `删除数据失败：${error.message}`)
      }
    }
  }

  // —— 插件本身（最后做）——
  if (choices.plugin) {
    if (desktop?.pnpm && desktop?.profileDir) {
      try {
        const handle = desktop.pnpm.runPlugin(['remove', PACKAGE_NAME], desktop.profileDir, signal)
        let output = ''
        const collect = (chunk) => { output = (output + chunk.toString()).slice(-4000) }
        handle.stdout?.on?.('data', collect)
        handle.stderr?.on?.('data', collect)
        const outcome = await handle.done
        if (outcome?.exitCode === 0) step('plugin', true, '插件已从 DSH 移除，重启 DSH 后生效')
        else step('plugin', false, `移除插件失败（退出码 ${outcome?.exitCode ?? '?'}）：${output.trim().split('\n').slice(-3).join(' ')}`)
      } catch (error) {
        step('plugin', false, `移除插件失败：${error.message}`)
      }
    } else {
      step('plugin', false, `这里没法直接移除插件。请在终端执行：dsh plugin remove ${PACKAGE_NAME}（DSH Desktop 用「打开 DSH 终端」），然后重启 DSH`)
    }
  }

  return { ok: steps.every((s) => s.ok), steps, canRestart: Boolean(desktop?.actions) }
}
