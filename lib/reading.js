/**
 * 阅读层（2026-11-11，方案 §5.1）。
 *
 * 知识库现在是「结论」不是「原文」：一条诗词条目长这样——
 *   「欲穷千里目，更上一层楼。——王之涣《登鹳雀楼》。要看得更远，就得站得更高。」
 * 它和「端口 59604」这类工作记忆混在同一个 knowledge 桶里，靠加权召回抢名额，
 * 结果就是被一堆工作条目挤下去，提示词里几乎见不到「读过的书」。
 *
 * 阅读层做三件事：
 *   1. 认出哪些条目是「书里的」——按 sourceRef 分书（唐宋诗词精选 / 中国历史纲要 / 毛选概要…）；
 *   2. 把一条拆成 原文 / 作者 / 篇名 / 短评 / 书名，召回时按「摘录 + 出处」渲染；
 *   3. 单独给名额（默认 3 条），不跟工作记忆抢 RECALL_LIMIT。
 *
 * 以后接真正的长文分块（800~1200 字一块 + 每块摘要 + 页码）时，
 * 只要让 parseExcerpt 认得新的 sourceRef 形状，上层不用动。
 */
import { queryTerms } from './recall.js'

/** 算作「读过的书」的来源。自主学习/表达积累是学来的话，不算书。 */
export const READING_BOOKS = [
  '唐宋诗词精选',
  '中国历史纲要',
  '毛选核心观点概要',
  '都江堰',
  '敦煌莫高窟',
  '泰山攻略（一篇游记）',
  '苏州园林笔记（手工整理）',
  '数理化',
  '生物',
  '地理',
]

/** 一条最多渲染这么长，别让一首长诗把提示词占满。 */
const MAX_QUOTE_CHARS = 120

/**
 * 把一条知识拆成「原文 + 出处」。
 *
 * 诗词条目形如 `原文。——作者《篇名》。短评。`；
 * 历史/科普条目没有破折号，就整条当摘录，书名当出处。
 *
 * @param {{ text?: string, sourceRef?: string, source_ref?: string }} entry
 * @returns {{ quote: string, author: string, title: string, note: string, book: string } | null}
 */
export function parseExcerpt(entry) {
  const text = String(entry?.text ?? '').trim()
  if (!text) return null
  const book = String(entry?.sourceRef ?? entry?.source_ref ?? '').trim()
  const dashAt = text.indexOf('——')
  if (dashAt < 0) {
    return {
      quote: text.slice(0, MAX_QUOTE_CHARS),
      author: '',
      title: '',
      note: '',
      book,
    }
  }
  const quote = text.slice(0, dashAt).trim()
  const rest = text.slice(dashAt + 2).trim()
  // 常见形状：王之涣《登鹳雀楼》。要看得更远，就得站得更高。
  const m = rest.match(/^([^《》。]{0,24})《([^》]{1,40})》([\s\S]*)$/)
  if (!m) {
    return { quote: quote.slice(0, MAX_QUOTE_CHARS), author: '', title: '', note: rest.slice(0, MAX_QUOTE_CHARS), book }
  }
  const author = m[1].replace(/[，,、\s]+$/, '').trim()
  const title = m[2].trim()
  const note = m[3].replace(/^[。；;，,\s]+/, '').trim()
  return { quote: quote.slice(0, MAX_QUOTE_CHARS), author, title, note: note.slice(0, MAX_QUOTE_CHARS), book }
}

/** 这条知识算不算「书里的」。 */
export function isReadingItem(item) {
  const book = String(item?.sourceRef ?? item?.source_ref ?? '').trim()
  if (!book) return false
  if (READING_BOOKS.includes(book)) return true
  // 以后新增的书不用改代码：只要带了出处、且不是学来的话，就当书。
  return !['自主学习', '表达积累'].includes(book)
}

/**
 * 从 knowledge 条目里挑出与本轮相关的那几条。
 *
 * 只认命中：一句都没对上的书不硬塞 —— 提示词里塞无关的诗比不塞更糟。
 *
 * @param {Array} items knowledge 条目（模块桶那份，带 sourceRef）
 * @param {string} query 本轮提示词
 * @param {{ limit?: number, minScore?: number }} options
 */
export function readingHits(items, query, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.round(options.limit)) : 3
  if (limit === 0) return []
  const terms = queryTerms(String(query ?? ''))
  if (terms.length === 0) return []
  const termSet = new Set(terms)
  const scored = []
  for (const item of items ?? []) {
    if (!item || item.archived === true) continue
    if (!isReadingItem(item)) continue
    const text = String(item.text ?? '')
    if (!text) continue
    let hits = 0
    for (const term of termSet) if (text.includes(term)) hits += 1
    if (hits === 0) continue
    const parsed = parseExcerpt(item)
    if (!parsed) continue
    scored.push({ ...parsed, hits, weight: Number(item.weight ?? 0), item })
  }
  if (scored.length === 0) return []
  scored.sort((a, b) => b.hits - a.hits || b.weight - a.weight)
  // 同一句原文可能有多份副本（同步/镜像），按「书名 + 篇名 + 前 20 字」去重。
  const seen = new Set()
  const out = []
  for (const hit of scored) {
    const key = `${hit.book}\u0000${hit.title}\u0000${hit.quote.slice(0, 20)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 渲染成提示词里的一段。
 * 诗词给「「原文」——作者《篇名》」，其它给「摘录（书名）」。
 */
export function renderReading(hits) {
  const list = Array.isArray(hits) ? hits.filter(Boolean) : []
  if (list.length === 0) return ''
  const lines = ['【读过的书】']
  for (const hit of list) {
    const book = hit.book ? `（${hit.book}）` : ''
    if (hit.title) {
      const who = hit.author ? `${hit.author}` : ''
      lines.push(`- 「${hit.quote}」——${who}《${hit.title}》${book}`)
    } else {
      lines.push(`- ${hit.quote}${book}`)
    }
  }
  lines.push('（这些是读过的原文与出处，引用时别改写原文；跟当前事情无关就别硬引。）')
  return lines.join('\n')
}
