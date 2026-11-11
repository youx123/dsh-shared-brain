/**
 * 话题池（方案 §5.5）。
 *
 * 主动搭话原来只能从十来个写死的话题里挑（进度、关心、闲聊…），
 * 说久了必然重复。这里把「读过的东西」变成可聊的由头：
 * 从知识条目里挑一条，给它一个 key、一个方向、一点素材，
 * 交给 renderTopic 渲染成「这次想聊的：…」，具体怎么说仍由模型自己组织。
 *
 * 只做挑选，不生成句子；不写库，纯函数。
 */
import { parseExcerpt } from './reading.js'

/** 这些是学习过程留下的配置/心得，不是「书」，别拿来当聊天由头。 */
const NOT_BOOKS = new Set(['自主学习', '表达积累'])

/** 太短的条目当话题没内容可聊。 */
const MIN_TEXT_CHARS = 12

/** 一个池子最多放多少条，免得每轮都在几百条里转。 */
const DEFAULT_LIMIT = 40

function clip(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * 从模块桶 + 扁平库里收集可聊的条目。
 *
 * @param {object} input
 * @param {object} [input.modules] 模块表（读 modules.knowledge.items）
 * @param {Array} [input.entries] 扁平库条目（补桶里没有的）
 * @param {number} [input.limit]
 * @param {number} [input.now]
 * @returns {Array<{key:string,tone:string,intent:string,hint:string}>}
 */
export function buildTopicPool(input = {}) {
  const { modules = {}, entries = [], limit = DEFAULT_LIMIT } = input
  const bucket = Array.isArray(modules?.knowledge?.items) ? modules.knowledge.items : []
  const flat = Array.isArray(entries) ? entries.filter((e) => e?.module === 'knowledge') : []
  const seen = new Set()
  const pool = []

  const push = (item) => {
    const text = String(item?.text ?? '').trim()
    if (text.length < MIN_TEXT_CHARS) return
    const book = String(item?.sourceRef ?? '').trim()
    if (book && NOT_BOOKS.has(book)) return
    const key = `read:${book || '未标注'}:${text.slice(0, 16)}`
    if (seen.has(key)) return
    seen.add(key)

    const parsed = parseExcerpt(item)
    let intent
    let hint
    if (parsed.title) {
      const who = parsed.author ? `${parsed.author}` : ''
      intent = `聊到读过的${who}《${parsed.title}》`
      hint = `原文是「${clip(parsed.quote, 30)}」${book ? `，出自《${book}》` : ''}；别背错，也别硬扯到不相干的事上`
    } else if (book) {
      intent = `聊一句从《${book}》里读到的内容`
      hint = `${clip(text, 36)}；说个大概就行，别当成任务汇报`
    } else {
      intent = '聊一句最近读到的东西'
      hint = `${clip(text, 36)}；随口一提，不用展开`
    }
    pool.push({ key, tone: 'light', intent, hint })
  }

  for (const item of bucket) push(item)
  for (const item of flat) push(item)

  // 按书轮转：一本历史纲要就几十条，直接取前 40 条会全变成「聊聊夏朝」。
  // 轮转后池子里各本书都有，聊起来才有变化。
  const groups = new Map()
  for (const item of pool) {
    const book = item.key.split(':')[1] ?? ''
    if (!groups.has(book)) groups.set(book, [])
    groups.get(book).push(item)
  }
  const ordered = []
  let moved = true
  while (moved) {
    moved = false
    for (const list of groups.values()) {
      const next = list.shift()
      if (next) {
        ordered.push(next)
        moved = true
      }
    }
  }
  return ordered.slice(0, Math.max(1, limit))
}

/**
 * 把话题池和内置话题合起来，池子在前面（挑不满才轮到内置的）。
 * 只负责拼接，去重交给 pickTopic 的 used 计数。
 */
export function mergeTopicPool(pool, library = []) {
  const safePool = Array.isArray(pool) ? pool.filter((t) => t && t.key) : []
  const lib = Array.isArray(library) ? library : []
  const keys = new Set(safePool.map((t) => t.key))
  return [...safePool, ...lib.filter((t) => !keys.has(t.key))]
}
