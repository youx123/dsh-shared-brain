/**
 * 召回打分：给「当前这轮对话」从共享记忆库里挑出最相关的几条。
 *
 * 不用向量、不用网络：纯关键词 + 时间新鲜度打分。本机的算力和网络都够用，
 * 但没必要为十几条、上百条的记忆引入一个向量服务。
 */

/** 中文按字切、英文数字按词切；长度 >= 2 的词才有区分度。 */
export function tokenize(text) {
  const out = []
  const source = String(text ?? '')
  const latin = source.toLowerCase().match(/[a-z0-9_]{2,}/g)
  if (latin) out.push(...latin)
  // 中文：切成 2-4 字的滑窗片段。切出更长的片段才能命中「共享记忆」这类词，
  // 只切 2 字的话「记忆」和「忆库」互不重叠，召回会漏。
  const han = source.match(/[\u4e00-\u9fff]+/g)
  if (han) {
    for (const run of han) {
      if (run.length === 1) {
        out.push(run)
        continue
      }
      for (let len = 2; len <= 4; len++) {
        for (let i = 0; i + len <= run.length; i++) out.push(run.slice(i, i + len))
      }
    }
  }
  return out
}

/** 常见虚词，命中了也不算相关。 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'that', 'this', 'with', 'from', 'have', 'has',
  'are', 'was', 'were', 'can', 'will', 'not', '但', '的', '了', '是', '在', '我', '你',
  '他', '她', '它', '们', '这', '那', '就', '都', '也', '和', '与', '个', '要', '会',
  '可以', '一个', '什么', '怎么', '为什么', '如何', '请', '帮', '帮我', '一下',
])

/** 抽取查询词（去停用词、去重）。 */
export function queryTerms(text) {
  const seen = new Set()
  const terms = []
  for (const token of tokenize(text)) {
    if (STOPWORDS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    terms.push(token)
  }
  return terms
}

/**
 * 给一条记忆打分。分数越高越相关。
 *
 * 组成：
 *   - 命中查询词的数量（主要权重）
 *   - 命中的查询词是否出现在标签里（标签是显式主题，权重更高）
 *   - 文本相似度（Jaccard，作为命中词的补充）
 *   - 时间新鲜度（越新略微加权，防止老记忆长期霸榜）
 */
export function scoreEntry(entry, terms, now = Date.now()) {
  if (!entry || typeof entry.text !== 'string') return 0
  const text = entry.text.toLowerCase()
  const tagSet = new Set((entry.tags ?? []).map((t) => String(t).toLowerCase()))

  let termHits = 0
  let tagHits = 0
  for (const term of terms) {
    const inText = text.includes(term)
    const inTag = tagSet.has(term)
    if (!inText && !inTag) continue
    termHits += 1
    if (inTag) tagHits += 1
  }
  if (termHits === 0) return 0

  const entryTokens = new Set(tokenize(entry.text))
  let shared = 0
  for (const term of terms) if (entryTokens.has(term)) shared += 1
  const jaccard = shared / Math.max(1, terms.length + entryTokens.size - shared)

  const ageDays = Math.max(0, (now - (entry.updatedAt ?? now)) / 86_400_000)
  const freshness = 1 / (1 + ageDays / 30)

  return termHits * 1.0 + tagHits * 1.5 + jaccard * 2 + freshness * 0.4
}

/**
 * 召回：从库里挑出最相关的若干条。
 *
 * @param {Array} entries 记忆条目
 * @param {string} query 本轮对话文本
 * @param {{ limit?: number, minScore?: number, now?: number }} options
 * @returns {Array<{entry, score}>} 按分数降序
 */
export function recall(entries, query, options = {}) {
  const limit = options.limit ?? 6
  const minScore = options.minScore ?? 1.2
  const now = options.now ?? Date.now()
  const terms = queryTerms(query)
  if (terms.length === 0) return []

  const scored = []
  for (const entry of entries ?? []) {
    const score = scoreEntry(entry, terms, now)
    if (score >= minScore) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score || (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0))
  return scored.slice(0, limit)
}

/**
 * 把召回结果渲染成注入提示词的一段文字。
 * 命中过的事实直接列出，模型一眼就知道「这些以前就定过」。
 */
export function renderRecall(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return ''
  const lines = hits.map(({ entry }, index) => {
    const tags = entry.tags?.length ? ` [${entry.tags.join(', ')}]` : ''
    return `${index + 1}. ${entry.text}${tags}`
  })
  return [
    '以下是此前会话中已经记录下来的共享记忆（同一份记忆库，所有会话共用）：',
    ...lines,
    '如果与本次任务相关请直接采用；若与当前指令冲突，以当前指令为准。',
  ].join('\n')
}
