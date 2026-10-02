// lib/i18n.js — 服务端说什么语言：跟着 DSH 界面走
//
// DSH 的语言设置只交给浏览器那一层，插件的服务端读不到。所以由界面在每个请求里带上当前语言
// （请求头 x-dsh-vps-lang，终端连接是网址里的 lang），服务端在处理这个请求期间照它回话：
// 报错、提示、卸载每一步的结果都用这个语言。
//
// 没有请求可依的场合（/vps- 命令的输出、审批弹窗、后台任务）用最近一次请求带来的语言；
// 一次都没有过，看环境变量 DSH_VPS_LANG（测试固定成中文用），再看电脑的系统语言。
//
// 只分中文、英文两种：DSH 自带的就是这两种，别的语言包最终都退回其中一种（界面那一层算好再发过来）。
// 写法：L('中文', 'English')，两种文字挨着写，改一处时另一处就在眼前。

import { AsyncLocalStorage } from 'node:async_hooks'

/** 界面在每个请求里带当前语言用的请求头 */
export const LANG_HEADER = 'x-dsh-vps-lang'

const store = new AsyncLocalStorage()
let lastLang = ''

/** 'zh' / 'en'；认不出来返回 '' */
export function normalizeLang(value) {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s) return ''
  return s === 'zh' || s.startsWith('zh-') || s.startsWith('zh_') ? 'zh' : 'en'
}

/** 电脑的系统语言（LANG 之类，或 Intl 给的） */
export function systemLang(env = process.env) {
  const fromEnv = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  if (fromEnv && !/^(C|POSIX)(\.|$)/i.test(fromEnv)) return normalizeLang(fromEnv)
  try {
    return normalizeLang(Intl.DateTimeFormat().resolvedOptions().locale) || 'zh'
  } catch {
    return 'zh'
  }
}

/** 现在该说哪种语言 */
export function currentLang() {
  return store.getStore() || lastLang || normalizeLang(process.env.DSH_VPS_LANG) || systemLang()
}

/**
 * 在某个语言下处理一件事（一个请求、一个终端连接）。lang 认不出来就照默认。
 * 同时记成「最近一次的语言」，给没有请求可依的命令输出用。
 */
export function withLang(lang, fn) {
  const l = normalizeLang(lang)
  if (!l) return fn()
  if (l !== lastLang) {
    const changed = lastLang !== '' || l !== currentLang()
    lastLang = l
    // 界面换了语言：通知要跟着换的东西（命令说明是启动时交给 DSH 的，要重新登记）。
    // 放到下一轮做，不在这个请求中间改注册表
    if (changed) {
      const listeners = [...langListeners] // 通知变化那一刻在场的
      setTimeout(() => {
        for (const fn of listeners) {
          try {
            fn(l)
          } catch {
            // 一个失败不影响别的
          }
        }
      }, 0)
    }
  }
  return store.run(l, fn)
}

const langListeners = new Set()

/** 界面语言变了（和启动时用的、或上一次的不一样）时叫一下 fn。返回取消函数 */
export function onLangChange(fn) {
  langListeners.add(fn)
  return () => langListeners.delete(fn)
}

/** 中英两份文字，按当前语言挑一份 */
export function L(zh, en) {
  return currentLang() === 'zh' ? zh : en
}

/** 测试用：忘掉最近一次的语言 */
export function _resetLang() {
  lastLang = ''
}
