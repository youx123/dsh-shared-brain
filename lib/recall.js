/**
 * 召回打分：给「当前这轮对话」从共享记忆库里挑出最相关的几条。
 *
 * 不用向量、不用网络：纯关键词 + 时间新鲜度打分。本机的算力和网络都够用，
 * 但没必要为十几条、上百条的记忆引入一个向量服务。
 */

/** 打分时超过这个长度的正文，命中词要按 sqrt 打折（见 scoreEntry）。 */
const LEN_NORM_CHARS = 400

/** 中文按字切、英文数字按词切；长度 >= 2 的词才有区分度。 */
export function tokenize(text) {  const out = []
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

  // 2026-11-11：长条目以前靠「命中词多」霸榜 —— 一条两千字的记录能同时命中几十个
  // 常见 2-gram，把真正对题的两三句话压到后面。这里做一次温和的长度归一：
  // 400 字以内不打折，越长的命中按 sqrt(400/长度) 折。只折 termHits，
  // 标签和相似度本来就是归一过的量，不动。
  const lengthFactor = Math.min(1, Math.sqrt(LEN_NORM_CHARS / Math.max(LEN_NORM_CHARS, text.length)))

  return termHits * lengthFactor * 1.0 + tagHits * 1.5 + jaccard * 2 + freshness * 0.4
}

/**
 * PERF-3：打分缓存 + 倒排索引。
 *
 * 原实现每一轮对每条记忆都要：全文 toLowerCase、对每个 term 做 text.includes
 * （128 条 × 80 词 ≈ 9520 次）、命中时才重新 tokenize、算完就丢、再对 Jaccard
 * 做 9520 次 Set 查询。这里：
 *   - 按条目缓存小写正文 / token 集合 / 标签集合（id + 原文 + updatedAt + tags
 *     全一致才复用，任何一项变了就重建）
 *   - 维护 token → 条目 id 的倒排索引，用来快速算 Jaccard 的 shared
 *
 * ⚠️ 语义必须和 scoreEntry 完全一致：includes 是**子串**匹配（term「记忆」能
 * 命中「记忆库」），倒排是精确 token 匹配。所以 termHits 依然以 includes 为准，
 * 倒排只做（a）shared 计数、（b）跳过必然命中的「token 精确命中」的 includes。
 * 绝不能拿倒排计数直接当 termHits —— 那会改变召回结果。
 */
const profileCache = new Map() // id -> profile
const tokenIndex = new Map() // token -> Set<id>

function tagsKeyOf(tags) {
  if (!Array.isArray(tags)) return ''
  return tags.map((tag) => String(tag)).join('\u0001')
}

function buildProfile(entry) {
  const rawText = typeof entry?.text === 'string' ? entry.text : ''
  const tags = Array.isArray(entry?.tags) ? entry.tags : []
  return {
    rawText,
    updatedAt: Number.isFinite(entry?.updatedAt) ? entry.updatedAt : 0,
    tagsKey: tagsKeyOf(tags),
    lower: rawText.toLowerCase(),
    tokens: new Set(tokenize(rawText)),
    tagSet: new Set(tags.map((tag) => String(tag).toLowerCase())),
  }
}

function dropProfile(id) {
  const profile = profileCache.get(id)
  if (!profile) return
  for (const token of profile.tokens) {
    const bucket = tokenIndex.get(token)
    if (!bucket) continue
    bucket.delete(id)
    if (bucket.size === 0) tokenIndex.delete(token)
  }
  profileCache.delete(id)
}

function addProfile(id, profile) {
  for (const token of profile.tokens) {
    let bucket = tokenIndex.get(token)
    if (!bucket) {
      bucket = new Set()
      tokenIndex.set(token, bucket)
    }
    bucket.add(id)
  }
}

function profileFor(entry) {
  const id = typeof entry?.id === 'string' ? entry.id : ''
  if (!id) return buildProfile(entry)
  const rawText = typeof entry.text === 'string' ? entry.text : ''
  const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0
  const tagsKey = tagsKeyOf(entry.tags)
  const cached = profileCache.get(id)
  if (cached && cached.rawText === rawText && cached.updatedAt === updatedAt && cached.tagsKey === tagsKey) {
    return cached
  }
  if (cached) dropProfile(id)
  const profile = buildProfile(entry)
  profileCache.set(id, profile)
  addProfile(id, profile)
  return profile
}

/** 把这一批里已经不存在的条目从缓存/索引里清掉。 */
function pruneProfiles(entries) {
  if (profileCache.size === 0) return
  const alive = new Set()
  for (const entry of entries) {
    if (typeof entry?.id === 'string' && entry.id) alive.add(entry.id)
  }
  for (const id of [...profileCache.keys()]) {
    if (!alive.has(id)) dropProfile(id)
  }
}

function countShared(tokens, terms) {
  let shared = 0
  for (const term of terms) if (tokens.has(term)) shared += 1
  return shared
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

  const list = (Array.isArray(entries) ? entries : []).filter(
    // 归档的记忆不再进入召回池（2026-11-05，记忆图谱）。
    // 归档只是打标记，文本还在库里、随时能恢复。
    (entry) => entry && typeof entry.text === 'string' && entry.archived !== true,
  )
  pruneProfiles(list)

  // 先把这一批的 profile 同步进缓存/索引
  const profiles = new Map()
  const idCounts = new Map()
  for (const entry of list) {
    profiles.set(entry, profileFor(entry))
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }

  // 倒排：shared = 查询词里有几个精确落在该条目的 token 集合里
  const sharedById = new Map()
  for (const term of terms) {
    const bucket = tokenIndex.get(term)
    if (!bucket) continue
    for (const id of bucket) sharedById.set(id, (sharedById.get(id) ?? 0) + 1)
  }

  const scored = []
  for (const entry of list) {
    const profile = profiles.get(entry)
    const id = typeof entry.id === 'string' ? entry.id : ''
    let termHits = 0
    let tagHits = 0
    for (const term of terms) {
      if (profile.tagSet.has(term)) {
        // 标签命中一定计入 termHits，跟正文里有没有这个词无关
        termHits += 1
        tagHits += 1
        continue
      }
      // token 精确命中必然也满足 includes；其余退回子串判断，语义不变
      if (profile.tokens.has(term) || profile.lower.includes(term)) termHits += 1
    }
    if (termHits === 0) continue

    // id 重复（理论上不会，防御性处理）时退回逐条计数，避免索引串味
    const shared =
      id && idCounts.get(id) === 1 ? sharedById.get(id) ?? 0 : countShared(profile.tokens, terms)
    const jaccard = shared / Math.max(1, terms.length + profile.tokens.size - shared)
    const ageDays = Math.max(0, (now - (entry.updatedAt ?? now)) / 86_400_000)
    const freshness = 1 / (1 + ageDays / 30)
    // 长度归一：必须和 scoreEntry 里的系数完全一致（perf 测试要求两路结果相同）。
    const lengthFactor = Math.min(1, Math.sqrt(LEN_NORM_CHARS / Math.max(LEN_NORM_CHARS, profile.lower.length)))
    const score = termHits * lengthFactor * 1.0 + tagHits * 1.5 + jaccard * 2 + freshness * 0.4
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
