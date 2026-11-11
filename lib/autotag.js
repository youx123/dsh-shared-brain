/**
 * 自动打标。
 *
 * 为什么需要：召回打分里 `tagHits * 1.5` 是仅次于正文命中的一档权重，
 * 但库里 541 条记忆有 532 条 `tags` 是空的 —— 这一档等于从没生效过。
 * 一条「李白《将进酒》」的条目被问起「李白」时，正文里也许只有诗本身，
 * 标签里有「李白」「将进酒」就能稳稳命中。
 *
 * 这里只抽**有据可依**的标签，不硬凑主题词：
 *   - 《书名》/《篇名》里的名字
 *   - 破折号后的作者（「——王之涣《登鹳雀楼》」→ 王之涣）
 *   - 出处（sourceRef），比如「唐宋诗词精选」
 *   - 代码里常见的技术词：文件名、命令、选项、标识符
 *   - 很短的整句短语（2~6 字、被标点包住的那种，多半是名词短语）
 *
 * 宁缺毋滥：抽不出来就返回空数组，别拿「这个」「然后」充数。
 */

/** 这些词做标签没有区分度，出现也不收。 */
const TAG_STOPWORDS = new Set([
  '这个', '那个', '我们', '他们', '你们', '什么', '怎么', '因为', '所以', '但是',
  '然后', '现在', '今天', '明天', '昨天', '可以', '需要', '应该', '可能', '如果',
  '就是', '不是', '没有', '一个', '一些', '这样', '那样', '时候', '东西', '事情',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'are', 'was', 'not',
  'const', 'function', 'return', 'import', 'export', 'true', 'false', 'null',
])

/** 最大标签数、单个标签最大长度。 */
const MAX_TAGS = 6
const MAX_TAG_CHARS = 20

/** 短句里允许当标签的最大长度（再长就不像名词了）。 */
const MAX_PHRASE_CHARS = 6

/** 短语里出现这些字，多半是动词短语/半句话，当标签没意义。 */
const PHRASE_REJECT = /[把被让别要就都也还再很太更最了着过的是在给对从和与及]/

function pushTag(out, value) {
  const tag = String(value ?? '').trim().replace(/^[「『"'（(]+|[」』"'）)]+$/g, '')
  if (!tag || tag.length > MAX_TAG_CHARS) return
  if (TAG_STOPWORDS.has(tag.toLowerCase())) return
  if (/^\d+$/.test(tag)) return
  if (out.includes(tag)) return
  out.push(tag)
}

/** 中文按标点切成短语，取短的那几段当候选名词。 */
function phrasesOf(text) {
  return text
    .split(/[。！？；\n，,、：:（）()「」『』"'“”…]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= MAX_PHRASE_CHARS)
}

/**
 * 从一段文本里抽标签。
 * @param {string} text
 * @param {{limit?: number, sourceRef?: string}} options
 * @returns {string[]}
 */
export function extractTags(text, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.min(12, options.limit) : MAX_TAGS
  const raw = String(text ?? '')
  const out = []
  if (!raw.trim()) return out

  // 1) 《篇名》《书名》
  for (const match of raw.matchAll(/《([^》]{1,40})》/g)) pushTag(out, match[1])

  // 2) 作者：「——王之涣《登鹳雀楼》」
  for (const match of raw.matchAll(/——\s*([^《》。，,\n]{1,24})\s*《/g)) pushTag(out, match[1])

  // 3) 出处（书名）
  if (options.sourceRef) pushTag(out, options.sourceRef)

  // 4) 技术词：文件名、命令、选项、带下划线/驼峰/全大写的标识符。
  //    普通英文单词（Now / let / the）不算 —— 老记忆里混着英文思考片段，
  //    照单全收会把「Now」「let」也变成标签，纯噪音。
  for (const match of raw.matchAll(/[A-Za-z][A-Za-z0-9_.\-/]{2,}/g)) {
    const word = match[0].replace(/[.\-/]+$/, '')
    if (word.length < 3) continue
    if (/^https?$/i.test(word)) continue
    const identifierLike =
      /[._/]/.test(word) || /^[A-Z]{2,}$/.test(word) || /[A-Z]/.test(word.slice(1)) || /-/.test(word)
    if (!identifierLike) continue
    pushTag(out, word)
  }

  // 5) 短中文短语（2~4 字）——只收很干净的，避免把「老大让我把」这种整段收进来
  for (const phrase of phrasesOf(raw)) {
    if (!/^[\u4e00-\u9fa5]{2,4}$/.test(phrase)) continue
    if (PHRASE_REJECT.test(phrase)) continue
    pushTag(out, phrase)
  }

  return out.slice(0, limit)
}

/** 合并多组标签，去重、保序。 */
export function mergeTags(...groups) {
  const out = []
  for (const group of groups) {
    const list = Array.isArray(group) ? group : String(group ?? '').split(/[,，]/)
    for (const tag of list) pushTag(out, tag)
  }
  return out.slice(0, MAX_TAGS)
}

/** 一条记忆该有哪些标签：原有 + 正文抽的 + 出处。 */
export function tagsForEntry(entry) {
  return mergeTags(entry?.tags ?? [], extractTags(entry?.text ?? '', { sourceRef: entry?.sourceRef }))
}
