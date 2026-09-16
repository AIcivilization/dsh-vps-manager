// lib/recipe-store.js — 「存成菜谱」（设计 10.5）
//
// 用户扩充菜谱库的主要方式：AI 把刚做成的一件事改写成幂等菜谱，用户确认后落盘。
// 落盘前做三件事：id 加 my- 前缀（不许冒充内置）、格式校验、疑似凭据扫描。

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { ensureDirs, trustHash } from './config.js'
import { loadRecipes, validateRecipe } from './recipes.js'
import { buildSummary, gate } from './safety.js'

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/\b(password|passwd|pwd)\s*[:=]\s*\S+/i, '密码'],
  [/\b(api[_-]?key|secret|token)\s*[:=]\s*\S{8,}/i, '密钥或 Token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS Access Key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub Token'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/, '疑似密钥的长随机串'],
]

export function scanForSecrets(text) {
  const hits = []
  for (const [re, what] of SECRET_PATTERNS) {
    const m = re.exec(String(text ?? ''))
    if (m) hits.push({ what, sample: m[0].slice(0, 24) })
  }
  return hits
}

export async function saveUserRecipe({ ctx, recipe: draft, agent, callId, signal, env = process.env, source = 'ai' }) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, status: 'invalid', hint: '要提供菜谱内容' }
  }
  const rawId = String(draft.id ?? '').trim()
  const id = rawId.startsWith('my-') ? rawId : `my-${rawId || 'recipe'}`

  let recipe
  try {
    recipe = validateRecipe({ ...draft, id }, { source: 'mine', file: '' })
  } catch (error) {
    return { ok: false, status: 'invalid', hint: `菜谱格式不合格：${error.message}` }
  }
  if (recipe.kind !== 'query' && (!recipe.detect || !recipe.verify)) {
    return { ok: false, status: 'invalid', hint: '安装 / 配置类菜谱必须写 detect（判断装没装）和 verify（证明能用）' }
  }

  const { byId } = await loadRecipes({ env })
  const existing = byId.get(id)
  if (existing && existing.source === 'builtin') {
    return { ok: false, status: 'invalid', hint: `${id} 与内置菜谱重名，换一个 id` }
  }

  const secrets = scanForSecrets([recipe.run, recipe.detect, recipe.verify].join('\n'))
  if (secrets.length) {
    return {
      ok: false,
      status: 'invalid',
      hint: `菜谱里有疑似凭据（${secrets.map((s) => s.what).join('、')}），改成参数传入或在服务器上生成后再保存`,
      secrets,
    }
  }

  const summary = buildSummary({
    label: '[本机]',
    tier: 'change',
    action: `保存菜谱「${recipe.name}」到「我的」`,
    detail: `${recipe.kind} · ${existing ? '覆盖同名自定义菜谱' : '新增'}`,
    hash: recipe.hash,
  })
  const decision = await gate({
    ctx,
    tier: 'change',
    confirmLevel: 'careful', // 落盘到菜谱目录一律问一次
    summary,
    agent,
    tool: 'vps_recipe',
    callId,
    signal,
    audit: { source, action: 'recipe_save', recipeId: id, script: recipe.run },
    env,
  })
  if (!decision.allowed) {
    return { ok: false, status: 'denied', hint: decision.hint ?? '未获确认', summary }
  }

  const p = await ensureDirs(env)
  const file = join(p.recipesDir, `${id}.yml`)
  const body = YAML.stringify({
    schema: 1,
    recipes: [
      {
        id,
        kind: recipe.kind,
        name: recipe.name,
        desc: recipe.desc,
        tags: recipe.tags.length ? recipe.tags : undefined,
        shell: recipe.shell,
        risk: recipe.risk,
        timeout: recipe.timeout,
        requires: recipe.requires,
        params: recipe.params.length ? recipe.params : undefined,
        detect: recipe.detect || undefined,
        plan: recipe.plan || undefined,
        run: recipe.run,
        verify: recipe.verify || undefined,
      },
    ],
  })
  const header = [
    '# 由 dsh-vps-manager 保存的自定义菜谱',
    `# 来源：${source}　保存时间：${new Date().toISOString()}`,
    '# 未经验证管线实测，面板里会标「未验证」',
    '',
  ].join('\n')
  await writeFile(file, header + body, { mode: 0o600 })
  await trustHash(recipe.hash, { id, source: 'mine' }, env).catch(() => {})

  return {
    ok: true,
    id,
    file,
    tier: recipe.tier,
    hint: `已保存到「我的」菜谱：${id}。面板里会标「未验证」，因为它没经过多系统实测`,
  }
}
