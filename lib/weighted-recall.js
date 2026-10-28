/**
 * 加权召回：跨模块挑选相关记忆，并按模块性质决定注入策略。
 *
 * 与旧版 recall() 的区别：
 *   - 记忆分散在多个模块里，各自有**自己的权重**（不是所有记忆平权）
 *   - 打分时乘上「条目权重 × 模块权重」，让高权重记忆天然靠前
 *   - **底线永远注入**（硬约束不能靠相关性来决定要不要生效）
 *   - **本能**按频次自动触发：权重够高、且主题沾边时才自动带出来
 *   - **声音**常驻，单独渲染成「怎么说话」的指令
 */
import { tokenize, queryTerms, scoreEntry } from './recall.js'
import { MEMORY_MODULES, MODULE_PROFILES, MODULE_LABELS, withinTimeWindow } from './modules.js'
import { isAlive } from './store.js'
import { readEmojiDir, renderEmoji, defaultEmojiDir, emojiStatus } from './emoji.js'

/**
 * 给一个模块里的条目打分。
 *
 * finalScore = 基础相关性 × 条目权重 × 模块权重 × 模块加成
 * 权重为 0 的模块（被禁用）不参与召回。
 */
function scoreModuleItem(item, terms, moduleKey, moduleWeight, now) {
  if (!item || typeof item.text !== 'string') return 0
  const profile = MODULE_PROFILES[moduleKey]
  const base = scoreEntry({ text: item.text, tags: item.tags, updatedAt: item.updatedAt }, terms, now)
  if (base <= 0) return 0
  const itemWeight = Number.isFinite(item.weight) ? item.weight : 0.5
  // 权重为 0 表示这条被显式降权，几乎不参与召回
  if (itemWeight <= 0) return 0
  const boost = profile?.boost ?? 1
  return base * (0.35 + itemWeight) * (0.5 + moduleWeight) + boost * itemWeight
}

/**
 * 跨模块召回。
 *
 * @param {object} modules 模块配置（readModules() 的结果）
 * @param {string} query 本轮查询文本
 * @param {{ limit?: number, minScore?: number, now?: number, includeAlways?: boolean }} options
 * @returns {{ hits: Array, always: Array, byModule: object }}
 *   hits   —— 与查询相关的条目（按模块分组标记）
 *   always —— 永远注入的条目（**只有被用户钉住的底线**）
 */
export function recallModules(modules, query, options = {}) {
  const limit = options.limit ?? 6
  const minScore = options.minScore ?? 1.2
  const now = options.now ?? Date.now()
  const terms = queryTerms(query)

  const always = []
  const scored = []
  const byModule = {}

  for (const moduleKey of MEMORY_MODULES) {
    const bucket = modules?.[moduleKey]
    if (!bucket || !bucket.enabled) continue
    const profile = MODULE_PROFILES[moduleKey]
    byModule[moduleKey] = []

    for (const item of bucket.items ?? []) {
      // 临时记忆过期了就不该再被召回
      if (!isAlive(item, now)) continue
      const moduleWeight = Number.isFinite(bucket.weight) ? bucket.weight : 0.5
      if (moduleWeight <= 0) continue

      if (profile?.always) {
        // 底线：**只有手动钉住的才常驻**。自动分类的底线不注入。
        if (item.pinned !== true) continue
        always.push({ module: moduleKey, label: MODULE_LABELS[moduleKey], item, score: item.weight ?? 0.5 })
        continue
      }

      if (terms.length === 0) {
        // 没有查询词时，本能类的高权重习惯可以凭权重直接触发
        if (moduleKey === 'instinct' && (item.weight ?? 0) >= 0.7) {
          scored.push({ module: moduleKey, label: MODULE_LABELS[moduleKey], item, score: (item.weight ?? 0.5) * 2 })
        }
        continue
      }

      const score = scoreModuleItem(item, terms, moduleKey, moduleWeight, now)
      if (score >= minScore) scored.push({ module: moduleKey, label: MODULE_LABELS[moduleKey], item, score })
    }
  }

  scored.sort((a, b) => b.score - a.score || (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0))

  // 每个模块按自己的 limit 截断，再合并
  const perModuleCount = {}
  const kept = []
  for (const hit of scored) {
    const cap = MODULE_PROFILES[hit.module]?.limit ?? limit
    perModuleCount[hit.module] = (perModuleCount[hit.module] ?? 0) + 1
    if (perModuleCount[hit.module] > cap) continue
    kept.push(hit)
    if (kept.length >= limit) break
  }

  return { hits: kept, always: always.slice(0, MODULE_PROFILES.bottomline.limit), byModule }
}

/**
 * 渲染成注入提示词的一段文字。
 * 底线在最前面（不可协商），然后是相关模块，标注清楚来源模块。
 */
export function renderModuleRecall(result) {
  const { hits = [], always = [] } = result ?? {}
  if (always.length === 0 && hits.length === 0) return ''

  const lines = []

  if (always.length > 0) {
    lines.push('【底线】以下是不可协商的硬约束，任何时候都必须遵守：')
    for (const hit of always) {
      lines.push(`- ${hit.item.text}（权重 ${Number(hit.item.weight ?? 0.5).toFixed(2)}）`)
    }
  }

  if (hits.length > 0) {
    const groups = new Map()
    for (const hit of hits) {
      if (!groups.has(hit.module)) groups.set(hit.module, [])
      groups.get(hit.module).push(hit)
    }
    for (const [moduleKey, group] of groups) {
      const label = MODULE_LABELS[moduleKey] ?? moduleKey
      lines.push(`【${label}】以下是与本次相关、此前已记录的记忆：`)
      for (const hit of group) {
        const tags = hit.item.tags?.length ? ` [${hit.item.tags.join(', ')}]` : ''
        lines.push(`- ${hit.item.text}（权重 ${Number(hit.item.weight ?? 0.5).toFixed(2)}${tags}）`)
      }
    }
  }

  lines.push('若以上记忆与当前指令冲突，以当前指令为准；底线条目仅在被用户明确撤销时才可忽略。')
  return lines.join('\n')
}

/**
 * 渲染声音模块：说话方式的指令。
 *
 * 表情部分支持两种：
 *   - 单个表情 `style.emoji`（老做法，仍兼容）
 *   - 表情包目录 `style.emojiDir`（把目录里的表情整理成清单，让模型按语境挑）
 */
export function renderVoice(modules, options = {}) {
  const voice = modules?.voice
  if (!voice || !voice.enabled) return ''
  const style = voice.style ?? {}
  const parts = []
  if (style.tone) parts.push(`语气：${style.tone}`)
  if (style.tics?.length) parts.push(`口头禅：${style.tics.join('、')}`)
  if (style.address) parts.push(`自称：${style.address}`)
  const head = `【声音】当前说话风格（权重 ${Number(voice.weight ?? 0.5).toFixed(2)}）：${parts.join('；')}`
  const lines = [head]

  // 表情：单个 emoji + 表情包目录（目录由定时器自动扫描，这里只读缓存）
  const emojiDir = String(style.emojiDir ?? '').trim() || defaultEmojiDir()
  let dirInfo = options.emoji ?? null
  if (!dirInfo) {
    try {
      dirInfo = emojiStatus(style)
    } catch {
      dirInfo = { dir: emojiDir, exists: false, items: [], count: 0 }
    }
  }
  const emojiLine = renderEmoji(style, dirInfo)
  if (emojiLine) lines.push(emojiLine)

  // 语音参数：给将来的语音/唱歌模块用。文字表达的部分照常读，
  // 物理参数（音色、语速、音调、音量、唱法）单独列出来，避免被念出来。
  const speech = style.speech
  if (
    speech &&
    (speech.voiceId ||
      speech.voiceName ||
      speech.rate !== 1 ||
      speech.pitch !== 1 ||
      speech.volume !== 0.9 ||
      speech.sing?.enabled)
  ) {
    const voiceLabel = speech.voiceName || speech.voiceId || '未指定'
    const bits = [
      `音色 ${voiceLabel}`,
      `语速 ${speech.rate}×`,
      `音调 ${speech.pitch}×`,
      `音量 ${speech.volume}`,
    ]
    lines.push(`【语音参数】${bits.join('，')}（这是给语音/唱歌模块用的物理参数，不要念出来）`)
    if (speech.sing?.enabled) {
      lines.push(`【唱法】唱歌时用「${speech.sing.style}」的方式，${speech.sing.bpm} BPM，调 ${speech.sing.key}`)
    }
  }

  const items = (voice.items ?? []).filter((it) => (it.weight ?? 0) > 0).map((it) => `- ${it.text}`)
  if (items.length) lines.push(...items)
  return lines.join('\n')
}

/**
 * 渲染能力模块：网络（对外获取信息）与自动互动（主观能动性）。
 *
 * @param {object} modules 模块配置
 * @param {{ sessionId?: string, sessionTitle?: string, now?: Date }} scope 当前会话（用于判断作用域）
 */
export function renderCapabilities(modules, scope = {}) {
  const lines = []
  const network = modules?.network
  if (network?.enabled) {
    lines.push('【网络】已允许对外获取信息：遇到需要外部事实、文档、行情、报错原文等问题时，主动去查，而不是靠猜。查到的来源要说明。')
  } else {
    lines.push('【网络】未授权对外获取信息：不要主动联网或调用外部检索；需要外部信息时先问用户。')
  }
  const agentive = modules?.agentive
  if (agentive?.enabled) {
    // 时间窗：设了窗口就只在窗口内主动，窗外老老实实听令
    const window = agentive.timeWindow ?? { enabled: false }
    const inWindow = withinTimeWindow(window, scope.now ?? new Date())
    if (!inWindow) {
      lines.push(
        `【自动互动】主观能动性有时间窗（${window.start} ~ ${window.end}），现在不在窗口内，所以只回应用户明确交代的事。`,
      )
      return lines.join('\n')
    }
    const windowNote = window.enabled ? `（时间窗 ${window.start} ~ ${window.end} 内）` : ''
    const sessionIds = Array.isArray(agentive.sessionIds) ? agentive.sessionIds : []
    if (agentive.scope === 'session' && sessionIds.length > 0) {
      const current = scope.sessionId
      const inScope = typeof current === 'string' && sessionIds.includes(current)
      if (inScope) {
        const title = scope.sessionTitle ? `「${scope.sessionTitle}」` : ''
        lines.push(`【自动互动】已开启主观能动性：可以主动提出建议、主动检查未完成的事、主动提醒风险，不必每一步都等用户下令。（仅在会话 ${title} 内生效${windowNote}）`)
      } else {
        lines.push('【自动互动】主观能动性只在你指定的会话里开启；当前会话不在范围内，所以只回应用户明确交代的事。')
      }
    } else {
      lines.push(`【自动互动】已开启主观能动性：可以主动提出建议、主动检查未完成的事、主动提醒风险，不必每一步都等用户下令。${windowNote}`)
    }
  } else {
    lines.push('【自动互动】未开启主观能动性：只回应用户明确交代的事，不要自作主张。')
  }
  return lines.join('\n')
}
