/**
 * 每轮对话的摘要生成：把一轮往返压成一条可存下来的记忆。
 *
 * 用户选择的是「自动把每轮对话摘要入库」（方案 B）。摘要要满足三点：
 *   - 短（一两句话，不能把提示词撑爆）
 *   - 有信息量（记结论、记决定，不记流水账）
 *   - 可检索（抽出标签，召回时能命中）
 */

/** 一条摘要最多留这么多字。 */
const MAX_SUMMARY_CHARS = 600

/** 太短的对话不入库（"嗯"、"好" 之类）。 */
const MIN_SUMMARY_CHARS = 12

/** 从一句话里抽出可作标签的词。 */
function extractTags(text, limit = 6) {
  const tags = []
  const seen = new Set()
  // 英文/数字词
  for (const token of String(text).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    if (seen.has(token)) continue
    seen.add(token)
    tags.push(token)
  }
  // 中文：优先抓 2-4 字的连续片段里出现次数高的（粗略的关键词抽取）
  const runs = String(text).match(/[\u4e00-\u9fff]{2,}/g) ?? []
  const freq = new Map()
  for (const run of runs) {
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const gram = run.slice(i, i + len)
        freq.set(gram, (freq.get(gram) ?? 0) + 1)
      }
    }
  }
  const ranked = [...freq.entries()]
    .filter(([gram, count]) => count >= 2 || gram.length >= 3)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
  for (const [gram] of ranked) {
    if (tags.length >= limit) break
    if (seen.has(gram)) continue
    seen.add(gram)
    tags.push(gram)
  }
  return tags.slice(0, limit)
}

/** 把过长的文本截断在句子边界上。 */
function clamp(text) {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_SUMMARY_CHARS) return trimmed
  const slice = trimmed.slice(0, MAX_SUMMARY_CHARS)
  const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('. '))
  return (cut > MAX_SUMMARY_CHARS * 0.5 ? slice.slice(0, cut + 1) : slice).trim()
}

/**
 * 从一轮对话（用户消息 + 助手回复）生成摘要。
 *
 * @param {{ user?: string, assistant?: string }} turn
 * @returns {{ text: string, tags: string[] } | null} 不值得记的时候返回 null
 */
export function summarizeTurn(turn) {
  const user = String(turn?.user ?? '').trim()
  const assistant = String(turn?.assistant ?? '').trim()
  if (!user && !assistant) return null

  // 摘要的主干：用户问的是什么 + 助手答了什么（各取一句）
  const userPart = firstSentence(user)
  const assistantPart = firstSentence(assistant)
  const body = [userPart, assistantPart].filter(Boolean).join(' → ')

  if (body.length < MIN_SUMMARY_CHARS) return null

  const tags = extractTags(`${user} ${assistant}`)
  return { text: clamp(body), tags }
}

/** 取第一句（中文句号/问号/感叹号或英文句点）。 */
function firstSentence(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return ''
  const m = trimmed.match(/^[\s\S]{1,300}?([。！？.!?]\s|$)/)
  if (!m) return trimmed.slice(0, 300).trim()
  return m[0].trim()
}

/**
 * 判断这条记忆和库里已有的某条是不是同一件事，避免重复堆积。
 * 判据：标签重合度高，或正文高度相似。
 */
export function isDuplicate(entry, candidate) {
  if (!entry || !candidate) return false
  const a = new Set((entry.tags ?? []).map((t) => String(t).toLowerCase()))
  const b = new Set((candidate.tags ?? []).map((t) => String(t).toLowerCase()))
  if (a.size > 0 && b.size > 0) {
    let shared = 0
    for (const tag of b) if (a.has(tag)) shared += 1
    if (shared / Math.min(a.size, b.size) >= 0.7) return true
  }
  // 正文前 120 字完全相同 → 同一件事
  const prefixA = entry.text.slice(0, 120)
  const prefixB = candidate.text.slice(0, 120)
  return prefixA.length > 20 && prefixA === prefixB
}
