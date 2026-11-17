/**
 * 复盘：每轮聊完，让模型给自己的回答打一次分，答得差的记成「教训」。
 *
 * 和「自主学习」的分工（2026-11-16）：
 *   - 自主学习记「这轮懂了什么」（知识、表达），是加法
 *   - 复盘记「这轮哪里没做好」（教训），是减法
 *   一个攒本事，一个少犯错。
 *
 * 教训落到 knowledge.items 里，走的是同一条召回链路 —— 所以不用另开注入点，
 * 下次同类场景一召回，教训自动进提示词。这是故意偷的懒：
 * 多一条注入链路就多一处要在提示词里抢位置，还会和知识条目互相挤。
 *
 * 三道闸门：
 *   1. 只有模型自评分数低于 lessonScore 才记 —— 每轮都记等于把库当草稿纸
 *   2. 教训必须是可复用的判据（「XX 情况应该先做 YY」），不是「这轮没答好」
 *   3. 与已有条目去重 + 每日上限，超了等明天
 *
 * 为什么默认开着：它不是每轮都跑，是有额度的；而且省的是以后的错，
 * 一次教训可能省掉十次重复踩坑。
 */

import { getValue, setValue } from './db.js'
import { looksWorthKeeping, normalizeForDedupe, similarity } from './learning.js'

export const REFLECT_VERSION = 1

export const REFLECT_KEY = 'reflect'

/** 默认配置：开着，但每天最多自评 6 轮。 */
export const DEFAULT_REFLECT = {
  enabled: true,
  // 每天最多复盘几轮（每轮都是一次模型调用，别没完没了）
  perDay: 6,
  // 自评分数低于这个值才记教训（满分 100）
  lessonScore: 62,
  // 教训条目长度限制
  minChars: 12,
  maxChars: 200,
  // 和已有条目相似度阈值（超过就算重复）
  dupThreshold: 0.6,
}

/** 教训条目的标签，召回和筛选都认它。 */
export const LESSON_TAG = 'self-review'

export const LESSON_SOURCE_REF = '复盘'

/**
 * 配置存独立 kv 键（理由同 learning.js：走 modules 桶写盘丢过字段）。
 * 仓库里没有这条键时用默认值，所以升级后自动生效。
 */
export function readReflectConfig() {
  try {
    const stored = getValue(REFLECT_KEY)
    if (stored && typeof stored === 'object') return stored
  } catch {
    // 没装 db 或库坏了都当没配置
  }
  return null
}

/** 合并写盘：只覆盖给了的项。 */
export function writeReflectConfig(patch = {}) {
  const cur = readReflectConfig() ?? {}
  const next = { ...cur }
  for (const key of Object.keys(DEFAULT_REFLECT)) {
    if (patch?.[key] !== undefined) next[key] = patch[key]
  }
  setValue(REFLECT_KEY, next)
  return next
}

/** 取生效配置：库里有就用库里的，逐项回落默认值。 */
export function reflectConfig(modules, override) {
  const stored = readReflectConfig()
  const fromModules = modules?.reflect
  const merged = { ...DEFAULT_REFLECT }
  for (const src of [fromModules, stored, override]) {
    if (!src || typeof src !== 'object') continue
    for (const key of Object.keys(DEFAULT_REFLECT)) {
      if (src[key] !== undefined && src[key] !== null) merged[key] = src[key]
    }
  }
  merged.enabled = merged.enabled === true
  merged.perDay = Math.max(0, Math.floor(Number(merged.perDay) || 0))
  merged.lessonScore = clampScore(merged.lessonScore, DEFAULT_REFLECT.lessonScore)
  merged.minChars = Math.max(4, Math.floor(Number(merged.minChars) || DEFAULT_REFLECT.minChars))
  merged.maxChars = Math.max(merged.minChars, Math.floor(Number(merged.maxChars) || DEFAULT_REFLECT.maxChars))
  merged.dupThreshold = Number.isFinite(Number(merged.dupThreshold))
    ? Math.min(0.95, Math.max(0.3, Number(merged.dupThreshold)))
    : DEFAULT_REFLECT.dupThreshold
  return merged
}

export function todayOf(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今天还剩几次复盘。 */
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

export function clampScore(value, fallback = 70) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(100, Math.max(0, Math.round(n)))
}

/** 给 /status 看的复盘状态：开了没、今天用了几次、剩几次。 */
export function reflectStatus(now = Date.now()) {
  const config = reflectConfig(null)
  let state = null
  try {
    state = getValue('reflectState') ?? readReflectConfig() ?? null
  } catch {
    state = null
  }
  const used = state && state.day === todayOf(now) ? Number(state.count) || 0 : 0
  return {
    enabled: config.enabled,
    perDay: config.perDay,
    used,
    left: Math.max(0, config.perDay - used),
    lessonScore: config.lessonScore,
    lastAt: Number(state?.at) || 0,
  }
}

/** 复盘用的系统提示。要模型说实话，且只说可复用的判据。 */
export function buildReflectSystem() {
  return [
    '你的任务：给你刚才那一轮回答打分，并在答得不好时提炼一条教训。',
    '',
    '【打分】score 0~100：',
    '- 90+：答对了、说清了、没废话',
    '- 70~89：基本可用，小毛病',
    '- 50~69：有实质问题（答偏了、漏了关键、瞎猜、绕圈子）',
    '- 50 以下：答错了或没答',
    '',
    '【挑毛病 issues】最多 3 条，每条一句话，说具体行为，不评价情绪。',
    '例如：「没查就跟我说了结论」「把两个概念混着用」「只说了不行，没说怎么改」。',
    '',
    '【教训 lesson】只在「下次遇到同类情况该怎么做得更好」说得清时才写：',
    '- 要写成判据：什么情况下，先做什么，再做什么',
    '- 不要写「要更认真」「注意准确性」这种废话',
    '- 不要重复对方的话，不要复述这一轮的具体内容',
    '- 30~80 字，脱离上下文也看得懂',
    '- 没什么可学的就留空字符串，别硬凑',
    '',
    '【改进建议 improve】答得不完美时，顺带想一条「这个插件本身还能改哪」：',
    '- 说具体的一条，指到哪块逻辑/哪个阈值/哪条链路，别写「要更聪明」这种空话',
    '- 只能提改进，不许提「删数据」「关掉某项防护」这类破坏性动作',
    '- 120 字以内，脱离上下文也看得懂；想不到就留空字符串',
    '',
    '输出格式：只输出一个 JSON 对象。',
    '{"score":75,"issues":["…"],"lesson":"…","improve":"…"}',
  ].join('\n')
}

export function buildReflectUser({ userText, reply }) {
  return [
    '**对方说的：**',
    String(userText ?? '').slice(0, 1200) || '（没说话）',
    '',
    '**你回的：**',
    String(reply ?? '').slice(0, 1600) || '（没回）',
    '',
    '请只输出 JSON 对象。',
  ].join('\n')
}

/** 从模型输出里抠 JSON 对象，抠不出来返回 null。 */
export function parseReflect(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const issues = Array.isArray(obj.issues)
    ? obj.issues.map((x) => String(x ?? '').trim()).filter((x) => x).slice(0, 3)
    : []
  return {
    score: clampScore(obj.score, 70),
    issues,
    lesson: String(obj.lesson ?? '').trim(),
    // 2026-11-17：模型顺带想的「插件自己还能改哪」，可选。
    improve: String(obj.improve ?? '').trim().slice(0, 240),
  }
}

/** 改进建议的 kv 键（「产出」，和复盘配置分开存）。 */
export const PROPOSALS_KEY = 'proposals'

/**
 * 把一条改进建议并进清单。纯函数，不读盘不写盘。
 *
 * 同一条说法反复出现时只把 count 加一，不再堆重复项 ——
 * 「同一个毛病被反复提」本身是信号，比多存十行同样的字有用。
 */
export function mergeProposals(existing, item, options = {}) {
  const max = Number(options.max) > 0 ? Number(options.max) : 30
  const threshold = Number(options.dupThreshold) || DEFAULT_REFLECT.dupThreshold
  const list = Array.isArray(existing)
    ? existing.filter((x) => x && typeof x.text === 'string' && x.text.trim()).slice(0, max)
    : []
  const text = String(item?.text ?? '').trim()
  if (!text) return list
  const key = normalizeForDedupe(text)
  for (const old of list) {
    if (normalizeForDedupe(old.text) === key) return list
    if (similarity(text, old.text) >= threshold) {
      old.count = (Number(old.count) || 1) + 1
      old.lastAt = Number(item?.at) || Date.now()
      return list
    }
  }
  const fresh = {
    text,
    at: Number(item?.at) || Date.now(),
    count: 1,
    sessionId: String(item?.sessionId ?? ''),
  }
  return [fresh, ...list].slice(0, max)
}

/** 读现存改进建议（没装库或坏了都返回空数组）。 */
export function readProposals() {
  try {
    const value = getValue(PROPOSALS_KEY)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

/** 记一条改进建议，返回合并后的清单。 */
export function proposeImprovement(item) {
  const next = mergeProposals(readProposals(), item)
  setValue(PROPOSALS_KEY, next)
  return next
}

/**
 * 教训里常见的「过程话」开头。
 *
 * learning.js 的 PROCESS_PATTERNS 要求「我」和动词紧挨着，拦不住
 * 「我这就去查一下」这种中间插了副词的写法 —— 而复盘最容易写出来的
 * 恰恰是这种口气。这里补一条：只拦**第一人称开头**的过程话，
 * 「先查再答，别凭印象」这种正常判据不受影响。
 */
const LESSON_PROCESS = /^我(们)?(这就|马上|先|去|来|赶紧|立刻)*(去|来)?(查|看|试|跑|执行|确认|检查|问)一?下?/

/**
 * 这一轮该不该记教训。纯函数，方便单测。
 *
 * @returns {{text:string,tags:string[],kind:string}|null}
 */
export function keepLesson(parsed, config = DEFAULT_REFLECT, existingTexts = []) {
  if (!parsed || typeof parsed !== 'object') return null
  const score = clampScore(parsed.score, 100)
  // 答得好就不记 —— 只记错题
  if (score > (Number(config.lessonScore) || DEFAULT_REFLECT.lessonScore)) return null
  const lesson = String(parsed.lesson ?? '').trim()
  if (!lesson) return null
  if (lesson.length < (Number(config.minChars) || DEFAULT_REFLECT.minChars)) return null
  if (lesson.length > (Number(config.maxChars) || DEFAULT_REFLECT.maxChars)) return null
  // 同样的闸门：过程话、寒暄、指代不明的都不算教训
  if (!looksWorthKeeping(lesson, { minChars: config.minChars, maxChars: config.maxChars }, 'fact')) return null
  if (LESSON_PROCESS.test(lesson)) return null

  const norm = normalizeForDedupe(lesson)
  const threshold = Number(config.dupThreshold) || DEFAULT_REFLECT.dupThreshold
  for (const old of existingTexts ?? []) {
    const e = String(old ?? '')
    if (!e) continue
    if (normalizeForDedupe(e) === norm) return null
    if (similarity(lesson, e) >= threshold) return null
  }

  const tags = [LESSON_TAG]
  for (const issue of parsed.issues ?? []) {
    const tag = String(issue ?? '').trim().slice(0, 12)
    if (tag && !tags.includes(tag)) tags.push(tag)
    if (tags.length >= 4) break
  }
  return { text: lesson, tags, kind: 'lesson' }
}

/**
 * 真去问一次模型：这一轮答得怎么样。
 *
 * 走 `ctx.llm.stream`，任何异常都返回 null —— 复盘是加分项，
 * 绝不能因为它挂掉影响正常聊天。
 */
export async function extractReflection(ctx, model, { userText, reply, sessionId } = {}) {
  if (!model?.provider || !model?.model) return null
  if (typeof ctx?.llm?.stream !== 'function') return null
  if (!String(reply ?? '').trim()) return null

  let out = ''
  try {
    for await (const chunk of ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system: buildReflectSystem(),
      messages: [
        {
          role: 'user',
          id: `reflect_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          content: [{ type: 'text', text: buildReflectUser({ userText, reply }) }],
          source: { kind: 'plugin', plugin: 'dsh-shared-brain' },
        },
      ],
      ...(sessionId ? { sessionId } : {}),
      temperature: 0.1,
      maxTokens: 400,
    })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') out += chunk.text
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') return null
    }
  } catch {
    return null
  }
  return parseReflect(out)
}
