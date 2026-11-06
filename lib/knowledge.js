/**
 * 知识模块：读过的书、学过的概念。
 *
 * 为什么要单独一套机制：普通记忆（认知/情感/本能）是「老大说过的话」，
 * 靠时间衰减 + 归档淘汰来控制体量；知识不一样 —— 读过的东西十年后
 * 还该在，不能因为半年没提就被归档掉。
 *
 * 所以「不遗忘」靠三条，都不依赖额外状态：
 *   1. 不进归档候选（archiveCandidates 只收 cognition，这里再挡一次）
 *   2. 召回门槛放宽：知识条目用更低的分数线，弱匹配也进得来
 *   3. 书名与主题常驻进提示词当索引 —— 就算一个字都没召回，
 *      我也知道「我读过哪些书」，需要时能主动去找
 *
 * 另外提供 reviewQueue：很久没命中、又几乎没被用过的知识，
 * 可以按需捞出来复习（不自动往聊天里塞，免得吵）。
 */

/** 知识模块的键名。 */
export const KNOWLEDGE_MODULE = 'knowledge'

/** 知识召回用的分数线倍率：比别的模块宽松。 */
export const KNOWLEDGE_MIN_SCORE_RATIO = 0.7

/** 书名/来源字段名。 */
export const SOURCE_FIELD = 'sourceRef'

/**
 * 取一条知识属于哪本书/哪个来源。
 * @param {object} item 记忆条目
 * @returns {string} 来源名，取不到就返回空串
 */
export function bookOf(item) {
  if (!item || typeof item !== 'object') return ''
  const direct = item[SOURCE_FIELD]
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  // 兼容：有些条目把来源写在标签里，形如 `book:书名`
  if (Array.isArray(item.tags)) {
    for (const tag of item.tags) {
      if (typeof tag !== 'string') continue
      const m = /^book[:：](.+)$/.exec(tag.trim())
      if (m) return m[1].trim()
    }
  }
  return ''
}

/**
 * 把一段读书笔记切成若干要点。
 *
 * 宁可切碎一点：一条一个意思，召回时才不会「整段都相关」或「整段都不相关」。
 *
 * @param {string} text 原始文本
 * @param {{ max?: number, maxPoints?: number }} options max=单条最大字数，maxPoints=最多几条
 * @returns {string[]}
 */
export function splitPoints(text, options = {}) {
  const max = options.max ?? 260
  const maxPoints = options.maxPoints ?? 60
  if (typeof text !== 'string' || !text.trim()) return []

  const out = []
  // 先按行切（markdown 列表、空行分段都吃得住），再把过长的行按句号切开
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^\s*(?:[-*+•]|\d+[.)、])\s+/, '')
      .replace(/^#{1,6}\s+/, '')
      .trim()
    if (!line) continue
    if (line.length <= max) {
      out.push(line)
      continue
    }
    let buf = ''
    for (const sentence of line.split(/(?<=[。！？!?；;])/)) {
      if (!sentence) continue
      if (buf && (buf + sentence).length > max) {
        out.push(buf.trim())
        buf = ''
      }
      buf += sentence
    }
    if (buf.trim()) out.push(buf.trim())
  }

  // 去重（同一段笔记里重复的点没有意义）并截断
  const seen = new Set()
  const unique = []
  for (const point of out) {
    if (seen.has(point)) continue
    seen.add(point)
    unique.push(point)
    if (unique.length >= maxPoints) break
  }
  return unique
}

/**
 * 生成「我读过什么」的常驻索引。
 *
 * 只给书名、条数、几个主题词 —— 具体内容靠召回，索引只负责
 * 「让我记得自己学过这些东西，别装不认识」。
 *
 * @param {object[]} items 知识模块的条目
 * @param {{ limit?: number }} options limit=最多列几本书
 * @returns {{ source: string, count: number, topics: string[] }[]}
 */
export function buildKnowledgeIndex(items, options = {}) {
  const limit = options.limit ?? 16
  const groups = new Map()
  for (const item of items ?? []) {
    if (!item || typeof item !== 'object') continue
    if (item.archived === true) continue
    const source = bookOf(item) || '（未标注来源）'
    if (!groups.has(source)) groups.set(source, { source, count: 0, topics: [], seen: new Set() })
    const group = groups.get(source)
    group.count += 1
    for (const tag of Array.isArray(item.tags) ? item.tags : []) {
      if (typeof tag !== 'string') continue
      const t = tag.trim()
      if (!t || t.startsWith('book:') || t.startsWith('book：')) continue
      if (group.seen.has(t)) continue
      group.seen.add(t)
      if (group.topics.length < 4) group.topics.push(t)
    }
  }
  return [...groups.values()]
    .map(({ source, count, topics }) => ({ source, count, topics }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
    .slice(0, limit)
}

/**
 * 把索引渲染成提示词里的一小段。
 * @param {{ source: string, count: number, topics: string[] }[]} index
 * @returns {string} 空索引返回空串
 */
export function renderKnowledgeIndex(index) {
  if (!Array.isArray(index) || index.length === 0) return ''
  const lines = index.map((it) => {
    const topics = it.topics.length ? `（${it.topics.join('、')}）` : ''
    return `- ${it.source} · ${it.count} 条${topics}`
  })
  return [
    '【你读过的】（这些是学过的知识，不是老大说过的话；聊到相关话题就用得上，但别硬往上凑）',
    ...lines,
  ].join('\n')
}

/**
 * 该复习的知识：很久没更新、又几乎没被用过。
 *
 * 注意这是「按需捞出来」，不是自动往聊天里塞 —— 主动塞会显得吵。
 *
 * @param {object[]} items 知识条目
 * @param {{ now?: number, idleDays?: number, maxHits?: number, limit?: number }} options
 * @returns {object[]} 条目数组（原对象）
 */
export function reviewQueue(items, options = {}) {
  const now = options.now ?? Date.now()
  const idleDays = options.idleDays ?? 30
  const maxHits = options.maxHits ?? 0
  const limit = options.limit ?? 10
  const cutoff = now - idleDays * 24 * 3600 * 1000
  return (items ?? [])
    .filter((item) => {
      if (!item || typeof item !== 'object') return false
      if (item.archived === true) return false
      if (Number(item.hits ?? 0) > maxHits) return false
      const at = Number(item.updatedAt ?? item.createdAt ?? 0)
      return at > 0 && at < cutoff
    })
    .sort((a, b) => Number(a.hits ?? 0) - Number(b.hits ?? 0) || Number(a.updatedAt ?? 0) - Number(b.updatedAt ?? 0))
    .slice(0, limit)
}

/**
 * 知识条目的召回复核：低于普通分数线也算命中。
 * @param {number} score 打分
 * @param {number} minScore 普通分数线
 * @returns {boolean}
 */
export function passesKnowledgeThreshold(score, minScore) {
  return score >= minScore * KNOWLEDGE_MIN_SCORE_RATIO
}
