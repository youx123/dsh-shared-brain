/**
 * 自主学习：每轮聊完，让模型自己判断「这轮有没有值得记下来的知识」。
 *
 * 和「记忆」的区别：
 *   - 记忆记的是**老大说过的话**（今天想吃什么、以后别熬夜）
 *   - 知识记的是**学到的东西**（一个概念、一条原理、一种做法）
 *   前者会随时间淘汰，后者永不过期。
 *
 * 为什么默认关闭：每轮多一次模型调用，有延迟也有成本。
 * 打开方式见 skill / README：modules.knowledge.learning.enabled = true。
 *
 * 三道闸门防污染：
 *   1. 只收「可复用的知识」——过程话、寒暄、一次性状态一律不要
 *   2. 与已有条目去重（归一化后比对 + 关键词重合度）
 *   3. 每日条数上限，超了就等明天
 */

export const LEARN_VERSION = 1

/**
 * 两类积累（2026-11-06）：
 *   fact  —— 事实、概念、原理、可迁移的做法（默认）
 *   style —— 可复用的写法：好句子、句式、修辞、行文结构
 *
 * 为什么分开：表达比事实稀缺得多，混在一起按同一额度放行，
 * 事实会把额度吃光，一辈子攒不到几句好文笔。所以表达类每轮单独限 1 条，
 * 落库时 sourceRef 也不一样（「自主学习」vs「表达积累」），索引里自然分列。
 */
export const LEARN_KINDS = ['fact', 'style']

export const KIND_SOURCE_REF = {
  fact: '自主学习',
  style: '表达积累',
}

export const KIND_LABEL = {
  fact: '知识',
  style: '表达',
}

/** 默认配置：关着。 */
export const DEFAULT_LEARNING = {
  enabled: false,
  // 每天最多记几条（防止刷屏式入库）
  perDay: 8,
  // 一轮最多抽几条
  maxPerTurn: 2,
  // 一轮最多抽几条「表达」（比事实稀有，单独限流）
  maxStylePerTurn: 1,
  // 太短的不算知识（「嗯」「好的」）
  minChars: 16,
  // 太长的不收（模型把整段话抄下来就等于没提炼）
  maxChars: 240,
}

export function learningConfig(modules) {
  const raw = modules?.knowledge?.learning
  const merged = { ...DEFAULT_LEARNING }
  if (raw && typeof raw === 'object') {
    if (raw.enabled === true) merged.enabled = true
    if (Number.isFinite(raw.perDay) && raw.perDay >= 0) merged.perDay = Math.min(100, Math.floor(raw.perDay))
    if (Number.isFinite(raw.maxPerTurn) && raw.maxPerTurn > 0) merged.maxPerTurn = Math.min(5, Math.floor(raw.maxPerTurn))
    if (Number.isFinite(raw.maxStylePerTurn) && raw.maxStylePerTurn >= 0) {
      merged.maxStylePerTurn = Math.min(3, Math.floor(raw.maxStylePerTurn))
    }
    if (Number.isFinite(raw.minChars) && raw.minChars > 0) merged.minChars = Math.floor(raw.minChars)
    if (Number.isFinite(raw.maxChars) && raw.maxChars > 40) merged.maxChars = Math.floor(raw.maxChars)
  }
  return merged
}

export function todayOf(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今天的额度还剩几条。 */
export function quotaLeft(config, state, now = Date.now()) {
  const today = todayOf(now)
  const used = state && state.day === today ? Number(state.count) || 0 : 0
  return Math.max(0, (Number(config?.perDay) || 0) - used)
}

export function bumpState(state, n, now = Date.now()) {
  const today = todayOf(now)
  const used = state && state.day === today ? Number(state.count) || 0 : 0
  return { day: today, count: used + Math.max(0, Math.floor(n)), at: now }
}

/** 抽取用的系统提示。要求输出 JSON 数组，宁缺毋滥。 */
export function buildLearnSystem() {
  return [
    '你的任务：从刚才这一轮对话里，挑出**值得长期留着**的东西。有两类，分开判断。',
    '',
    '【一类：知识 kind="fact"】',
    '要：',
    '- 一个可以复用的概念、原理、公式、结论',
    '- 一条明确的因果或经验规律（「A 会导致 B」）',
    '- 一种可迁移的做法或方法论',
    '- 讲过的、不该忘的事实性内容（人物、时间、定义）',
    '不要：',
    '- 对话过程：「我这就去查」「让我看一下」「稍等」',
    '- 寒暄和情绪：「好的」「哈哈」「今天好累」',
    '- 一次性的状态：今天的天气、这次的报错文本、某个临时数字',
    '- 只对你们俩有意义的事（那属于「记忆」，不归这里）',
    '',
    '【二类：表达 kind="style"】',
    '要：',
    '- 一段写得好的句子或句式，值得以后照着用（写景、状物、转折、收束）',
    '- 一种可复用的行文手法：怎么起头、怎么递进、怎么用比喻',
    '- 一个有味道的用词或搭配',
    '不要：',
    '- 只对当前话题成立的表述（离开这段对话就没用了）',
    '- 你自己现写的普通句子 —— 只有确实值得学的才留',
    '- 整段复制。要提炼成「手法 + 一句示例」的形式，20~80 字',
    '',
    '总之：宁缺毋滥。这一轮没有值得留的，就给空数组。',
    '',
    '输出格式：只输出一个 JSON 数组，最多 12 项。',
    '每一项形如：{"kind":"fact","text":"一句话（不超过 120 字，自成一个完整的知识点）","tags":["主题词"]}',
    '表达类形如：{"kind":"style","text":"手法或句式 + 一句示例，20~80 字","tags":["写景"]}',
    'text 要写成**脱离上下文也看得懂**的陈述句，不要写「他说」「上面提到」。',
  ].join('\n')
}

export function buildLearnUser({ userText, reply }) {
  return [
    '**对方说的：**',
    String(userText ?? '').slice(0, 1200) || '（没说话）',
    '',
    '**你回的：**',
    String(reply ?? '').slice(0, 1200) || '（没回）',
    '',
    '请只输出 JSON 数组。',
  ].join('\n')
}

/** 从模型输出里抠出 JSON 数组，抠不出来就返回空。 */
export function parseLearned(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return []
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let arr
  try {
    arr = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out = []
  for (const item of arr) {
    const t = typeof item === 'string' ? item : item?.text
    if (typeof t !== 'string') continue
    const tags = Array.isArray(item?.tags)
      ? item.tags.map((x) => String(x).trim()).filter((x) => x && x.length <= 20).slice(0, 4)
      : []
    // kind 只认这两类；写错了按事实处理（事实是主路径，宁可多收一条事实）
    const kind = LEARN_KINDS.includes(item?.kind) ? item.kind : 'fact'
    out.push({ text: t.trim(), tags, kind })
  }
  return out
}

/** 过程话、寒暄、指代不明的，一律不收。 */
const PROCESS_PATTERNS = [
  /^(好的|好|嗯|哦|行|收到|明白|了解|OK|ok)/,
  /我(这就|马上|先|去|来)?(查|看|试|跑|执行|确认|检查)一?下?/,
  /稍等|待我|让我看看|我先|等会儿|稍后/,
  /\b(TODO|lorem|xxx)\b/i,
]
const NOISE_ONLY = /^[\s\p{P}\p{S}]+$/u

export function looksWorthKeeping(text, config = DEFAULT_LEARNING, kind = 'fact') {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (NOISE_ONLY.test(t)) return false
  // 表达类允许短一些（「以小见大」这种写法一句话就说完了），但也别短到没内容
  const minChars = kind === 'style' ? Math.min(8, config.minChars ?? DEFAULT_LEARNING.minChars) : config.minChars ?? DEFAULT_LEARNING.minChars
  const maxChars = kind === 'style' ? 300 : config.maxChars ?? DEFAULT_LEARNING.maxChars
  if (t.length < minChars) return false
  if (t.length > maxChars) return false
  // 必须有实际内容（字母或数字），纯符号直接丢
  if (!/[\p{L}\p{N}]/u.test(t)) return false
  // 过程话对两类都该丢
  for (const p of PROCESS_PATTERNS) {
    if (p.test(t)) return false
  }
  // 指代词开头的一般是上下文依赖的表达，脱离上下文看不懂
  if (/^(他|她|它|这个|那个|上面|刚才|前面)/.test(t)) return false
  // 表达类必须是中文（英文句子学不到汉语写法）
  if (kind === 'style' && !/[\u4e00-\u9fa5]/.test(t)) return false
  return true
}

/** 归一化后比对：去标点空白、转小写。 */
export function normalizeForDedupe(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 中文 2-gram + 英文词，用于算重合度。 */
function shingles(text) {
  const s = normalizeForDedupe(text)
  const out = new Set()
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2))
  for (const w of String(text ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) out.add(w)
  return out
}

/** 两条知识有多像（0..1）。 */
export function similarity(a, b) {
  const A = shingles(a)
  const B = shingles(b)
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const x of A) if (B.has(x)) hit += 1
  return hit / Math.min(A.size, B.size)
}

/**
 * 从候选里挑出「确实新的」。
 *
 * @param {Array<{text:string,tags?:string[]}>} candidates 模型抽出来的
 * @param {string[]} existingTexts 已有的知识正文
 * @param {{limit?:number, threshold?:number, config?:object}} options
 */
export function pickNewCandidates(candidates, existingTexts = [], options = {}) {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LEARNING.maxPerTurn))
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.6
  const config = options.config ?? DEFAULT_LEARNING
  // 表达类单独限流：混在同一个 limit 里，事实会把额度吃光，永远攒不到文笔
  const styleLimit = Number.isFinite(config.maxStylePerTurn)
    ? Math.max(0, Math.floor(config.maxStylePerTurn))
    : DEFAULT_LEARNING.maxStylePerTurn
  const existing = existingTexts.map((t) => String(t ?? ''))
  const picked = []
  let stylePicked = 0
  for (const c of candidates ?? []) {
    const text = typeof c === 'string' ? c : c?.text
    const kind = LEARN_KINDS.includes(c?.kind) ? c.kind : 'fact'
    if (picked.length >= limit) break
    if (kind === 'style' && stylePicked >= styleLimit) continue
    if (!looksWorthKeeping(text, config, kind)) continue
    const norm = normalizeForDedupe(text)
    // 和自己这批里已选的也不能重复
    const dupInBatch = picked.some((p) => normalizeForDedupe(p.text) === norm)
    if (dupInBatch) continue
    const dup = existing.some((e) => {
      if (normalizeForDedupe(e) === norm) return true
      return similarity(text, e) >= threshold
    })
    if (dup) continue
    picked.push({ text: String(text).trim(), tags: Array.isArray(c?.tags) ? c.tags : [], kind })
    if (kind === 'style') stylePicked += 1
  }
  return picked
}

/**
 * 真去问一次模型：这一轮有没有值得记下来的知识。
 *
 * 走 `ctx.llm.stream`（宿主自己的 provider），失败一律返回空数组 ——
 * 抽知识是加分项，绝不能因为它挂掉影响正常聊天。
 *
 * @returns {Promise<Array<{text:string,tags:string[]}>>}
 */
export async function extractKnowledge(ctx, model, { userText, reply, sessionId } = {}) {
  if (!model?.provider || !model?.model) return []
  if (typeof ctx?.llm?.stream !== 'function') return []
  if (!String(reply ?? '').trim()) return []

  let out = ''
  try {
    for await (const chunk of ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system: buildLearnSystem(),
      messages: [
        {
          role: 'user',
          id: `learn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          content: [{ type: 'text', text: buildLearnUser({ userText, reply }) }],
          source: { kind: 'plugin', plugin: 'dsh-shared-brain' },
        },
      ],
      ...(sessionId ? { sessionId } : {}),
      temperature: 0.2,
      maxTokens: 800,
    })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') out += chunk.text
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') return []
    }
  } catch {
    return []
  }
  return parseLearned(out)
}
