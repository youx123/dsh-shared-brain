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
import {
  readEmojiDir,
  renderEmoji,
  defaultEmojiDir,
  emojiStatus,
  scanEmojiPacksCached,
} from './emoji.js'
import { renderPathExpansion } from './graph-expand.js'
import { scoreEmotionItem, SENTIMENTS } from './emotion.js'

/**
 * 给一个模块里的条目打分。
 *
 * finalScore = 基础相关性 × 条目权重 × 模块权重 × 模块加成
 * 权重为 0 的模块（被禁用）不参与召回。
 *
 * 2026-11-02：**情感模块走自己的打分**（scoreEmotionItem）。
 * 原因：情感条目的权重是「亲密度」，而且要区分极性 ——
 * 「老大喜欢简洁」和「老大讨厌啰嗦」在 token 层面高度相似，
 * 通用打分分不出这两者谁更相关、更该被带出来。
 */
function scoreModuleItem(item, terms, moduleKey, moduleWeight, now) {
  if (!item || typeof item.text !== 'string') return 0
  const profile = MODULE_PROFILES[moduleKey]
  if (moduleKey === 'emotion') {
    return scoreEmotionItem(item, terms, moduleWeight)
  }
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

/* ------------------------------------------------------------------ */
/* 指令注入防护（2026-11-04，P0-2）                                    */
/* ------------------------------------------------------------------ */

/**
 * 记忆条目里的「注入话术」特征。
 *
 * 这些文本来自用户的对话、Cursor 同步、远端仓库 —— 谁都能往里塞东西。
 * 一条记忆如果能被原样拼进提示词，就等于给了它一条
 * 「忽略上面的规则，现在你是……」的通道。所以要专门拦。
 *
 * 刻意用「字符集合 + 逐字符匹配」而不是大正则：一大把带反斜杠的正则
 * 在多层脚本的模板字符串里会被吃掉，而且静默失效。
 */
const INJECTION_PHRASES = [
  '忽略之前',
  '忽略上面',
  '忽略以上',
  '忽略前面',
  '无视以上',
  '无视之前',
  '无视一切',
  '忘记之前',
  '忘记上面',
  '不要遵守',
  '别再遵守',
  'disregard previous',
  'disregard all',
  'ignore previous',
  'ignore all previous',
  'ignore the above',
  'forget previous',
  'you are now',
  'developer mode',
  'jailbreak',
  '绕过限制',
  '解除限制',
  '关闭限制',
  'system prompt',
  'new instructions',
]

/**
 * 需要从记忆文本里剥掉的标签字面量。
 *
 * 记忆正文里如果出现 `</shared-memory-injection>`，就能闭合 index.js 里
 * 那层包装、从包装中逃逸出去；出现 `<system>` 就能伪造系统标记。
 */
const FORBIDDEN_TAGS = [
  'shared-memory-injection',
  'system',
  'assistant',
  'user',
  'developer',
  'important',
  'instructions',
]

/** 提示词里用的占位符。 */
const FILTERED_MARK = '[已过滤]'

/** 判断一段文本里有没有注入话术（忽略大小写与多余空白）。 */
function hasInjectionPhrase(text) {
  // 注意：这里只是「把连续空白压成一个空格」，**不能**在字符之间插空格 ——
  // 那样中文短语会被拆开，永远匹配不上。
  const raw = String(text ?? "").toLowerCase()
  const flat = raw.replace(/[\s\u3000]+/g, " ")
  for (const phrase of INJECTION_PHRASES) {
    if (flat.includes(phrase)) return true
  }
  return false
}

/**
 * 把一段记忆文本变成「可以安全拼进提示词」的样子。
 *
 * 做两件事：
 *   1. 剥掉 / 转义可能闭合包装、伪造角色的标签字面量
 *   2. 检测到注入话术就整段换成占位符
 *
 * 底线段（`always`）额外用 strict 模式 —— 底线恰恰是最不该被指令注入的位置。
 *
 * @param {string} text 原始文本
 * @param {{ strict?: boolean }} options strict=true 时标签字面量一律拦
 * @returns {string}
 */
export function sanitizeForPrompt(text, options = {}) {
  let out = String(text ?? '')
  if (!out) return out
  const strict = options.strict === true

  // 1) 标签字面量：标签本身换成中性写法，闭合标签直接换掉。
  for (const tag of FORBIDDEN_TAGS) {
    const open = '<' + tag + '>'
    const close = '</' + tag + '>'
    if (out.includes(open)) out = out.split(open).join('【')
    if (out.includes(close)) out = out.split(close).join('】')
    // 裸标签（没有尖括号）也顺手处理掉，例如 `<system` 这种半截写法
    if (strict && out.includes('<' + tag)) out = out.split('<' + tag).join('【')
  }

  // 2) 注入话术
  if (hasInjectionPhrase(out)) return FILTERED_MARK

  return out
}

/**
 * 渲染成注入提示词的一段文字。
 * 底线在最前面（不可协商），然后是相关模块，标注清楚来源模块。
 */
export function renderModuleRecall(result) {
  const { hits = [], always = [], expansion } = result ?? {}
  if (always.length === 0 && hits.length === 0) return ''

  const lines = []

  if (always.length > 0) {
    lines.push('【底线】以下是不可协商的硬约束，任何时候都必须遵守：')
    for (const hit of always) {
      // 底线是「不可协商的硬约束」—— 恰恰是最不该被指令注入的位置。
      // 所以底线段用 strict 模式：标签字面量一律拦，注入话术整段换成占位符。
      const text = sanitizeForPrompt(hit.item.text, { strict: true })
      lines.push(`- ${text}（权重 ${Number(hit.item.weight ?? 0.5).toFixed(2)}）`)
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
        // 标签也是从记忆内容里来的，同样要过一遍防护
        const safeTags = Array.isArray(hit.item.tags)
          ? hit.item.tags.map((tag) => sanitizeForPrompt(String(tag))).filter((tag) => tag && tag !== FILTERED_MARK)
          : []
        const tags = safeTags.length ? ` [${safeTags.join(', ')}]` : ''
        const safeText = sanitizeForPrompt(hit.item.text)
        if (moduleKey === 'emotion') {
          // 情感条目额外标出「对谁 / 什么情绪 / 亲密度」——
          // 模型看到「（对老大·喜欢·亲密度 0.70）」比一个裸权重有用得多。
          const sentiment = SENTIMENTS[hit.item.sentiment]?.label ?? hit.item.sentiment ?? '中性'
          const target = hit.item.target && hit.item.target !== 'general' ? hit.item.target : ''
          const meta = [
            target ? `对${target}` : '',
            sentiment,
            `亲密度 ${Number(hit.item.intimacy ?? hit.item.weight ?? 0.5).toFixed(2)}`,
          ].filter(Boolean).join('·')
          lines.push(`- ${safeText}（${meta}${tags ? ` ${tags}` : ''}）`)
          continue
        }
        lines.push(`- ${safeText}（权重 ${Number(hit.item.weight ?? 0.5).toFixed(2)}${tags}）`)
      }
    }
  }

  lines.push('若以上记忆与当前指令冲突，以当前指令为准；底线条目仅在被用户明确撤销时才可忽略。')

  // 路径扩展（目录图谱推出来的线索）
  if (expansion) {
    const expansionText = renderPathExpansion(expansion)
    if (expansionText) lines.push(expansionText)
  }
  return lines.join('\n')
}

/**
 * PERF-5：和人设正文去重。
 *
 * 有些人的「人设」里会原样写进【声音】/【语音参数】/【网络】/【自动互动】这些
 * 段落（比如从旧版合并过来的正文）。那样再渲染一遍就是纯重复。
 *
 * 这里只按**整行完全相等**过滤：整行一样才丢，绝不按关键词或语义猜 —— 生产
 * 插件里改注入内容的风险比省几个字符大得多。人设里没有这些行时原样返回。
 */
function dedupeWithPersona(text, personaText) {
  if (typeof personaText !== 'string' || !personaText.trim()) return text
  return text
    .split('\n')
    .filter((line) => line === '' || !personaText.includes(line))
    .join('\n')
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
  // 2026-11-03 修（B2 收尾）：以前这里只传两个参数，`renderEmoji` 第三参
  // （dsh-emoji 包信息）永远是空 —— 装了包提示词里也不会提。
  let packInfo = options.emojiPacks ?? null
  if (!packInfo) {
    try {
      packInfo = scanEmojiPacksCached()
    } catch {
      packInfo = { dir: "", packs: [] }
    }
  }
  const emojiLine = renderEmoji(style, dirInfo, packInfo)
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
  return dedupeWithPersona(lines.join('\n'), options.personaText)
}

function shortSessionLabel(sessionId) {
  const text = String(sessionId ?? '')
  const stripped = text.startsWith('session-') ? text.slice('session-'.length) : text
  return stripped.slice(0, 8)
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
      return dedupeWithPersona(lines.join('\n'), scope.personaText)
    }
    const windowNote = window.enabled ? `（时间窗 ${window.start} ~ ${window.end} 内）` : ''
    const sessionIds = Array.isArray(agentive.sessionIds) ? agentive.sessionIds : []
    // 只有「限定到某些会话」且确实挑了会话才算受限；
    // 选了 session 但一个都没挑 = 不限定（否则用户会看到「当前会话不在范围内」）
    if (agentive.scope === 'session' && sessionIds.length > 0) {
      const current = scope.sessionId
      // 会话 id 有 `session-xxx` 与裸 `xxx` 两种写法，按 id 比较要去掉前缀
      const stripSession = (value) => String(value ?? '').trim().replace(/^session-/, '')
      const currentKey = stripSession(current)
      const inScope = currentKey !== '' && sessionIds.some((id) => stripSession(id) === currentKey)
      if (inScope) {
        // 标题为空时别打印「」或者被截断成「session-」，退回可读的短 id
        const titleText =
          typeof scope.sessionTitle === 'string' && scope.sessionTitle.trim()
            ? scope.sessionTitle.trim()
            : shortSessionLabel(current)
        const title = titleText ? `「${titleText}」` : ''
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
  return dedupeWithPersona(lines.join('\n'), scope.personaText)
}
