/**
 * 情感模块：把「情感」从一段纯文本升级成**有语义的一条记录**，
 * 并把 dsh-feiyu-mood 的「心情」机制整合进来（不装第二个插件）。
 *
 * ────────────────────────────────────────────────────────────────────
 * 一、为什么情感模块要独立成文件
 *
 * 原来情感条目只是一段 text + 一个通用权重（0.6），文档里写着「情感用亲密度
 * 当权重」，但代码里根本没实现亲密度。于是：
 *   - 「老大喜欢简洁」和「老大讨厌啰嗦」在 token 层面高度相似，召回分不出；
 *   - 「对老大的偏好」和「对某个项目的偏好」混在一个桶里；
 *   - 作用域只有 global / workspace，没有「只在这个会话里」这一档。
 *
 * 这里补上三个字段：
 *   target   —— 这条情感是**对谁**的（人 / 项目 / 主题）
 *   sentiment—— 极性（喜欢 / 讨厌 / 担心 / 在意 …）
 *   intimacy —— 亲密度 0..1，**条目权重由它推导**，不再是通用置信度
 *
 * ────────────────────────────────────────────────────────────────────
 * 二、心情（mood）是什么
 *
 * 情感（emotion）是**静态事实**：老大喜欢什么、讨厌什么。
 * 心情（mood）是**动态状态**：此刻这份情感被撩动到了什么程度。
 *
 * 模型参考 dsh-feiyu-mood（https://github.com/Yuuyuko-uu/dsh-feiyu-mood），
 * 本文件是它的**精简移植 + 共享大脑化**：
 *   - 七根情绪 happy/calm/sweet/heartache/worry/sad/jealous
 *   - mood 基调 0..100（基线 70）
 *   - 半衰期衰减（mood 回基线、情绪 90 分钟衰减到 0）
 *   - 两头饱和（≥85 涨速减半、≤40 跌速减半）
 *   - 步长只吃判定值的 1/3
 *   - 四道降噪闸门（可信度门槛 / 日上限 / 小波动只记账 / 模式可关）
 *   - 口径分流（用户说话 / 自己搭话 / 定时任务 / 宿主注入上下文直接跳过）
 *   - 注入走 systemPrompt.context（**不破坏 DSH 前缀缓存**）
 *
 * 原作者的踩坑记录（写在注释里，很值钱）：
 *   - 把步长除数从 3 改成 2 是坏主意：模拟 872 条判定，÷3 平均 75，
 *     ÷2 平均 97 且 78% 时间 ≥95，长期贴顶反而更「平」；
 *   - 实测正负判定 6.7:1 偏正，根因是**触发频率不均**（正向词表宽），
 *     不是幅度不均 —— 所以要改词表规则，不是改除数。
 *   这里照抄结论：步长除数固定 3，词表规则按原版三档幅度来。
 *
 * ────────────────────────────────────────────────────────────────────
 * 三、状态文件
 *
 * 心情存在 ~/.dsh/storages/dsh-shared-brain/emotion.json（和 modules.json 同级），
 * 写入沿用本插件既有习惯：**临时文件 + rename**（见 modules.js:writeModules），
 * 避免写到一半掉电留下半截文件。
 *
 * 心情按**会话**分档（scope: 'session' | 'global'），
 * 与 persona.js:activePersona 的「bySession → current → 兜底」阶梯一致。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { redactSecrets } from './summarize.js'

// ────────────────────────────────────────────────────────────────────
// 一、语义结构
// ────────────────────────────────────────────────────────────────────

/** 情感的极性（sentiment）。 */
export const SENTIMENTS = {
  like: { label: '喜欢', polarity: 1 },
  love: { label: '喜爱', polarity: 1 },
  dislike: { label: '讨厌', polarity: -1 },
  hate: { label: '厌恶', polarity: -1 },
  worry: { label: '担心', polarity: -1 },
  care: { label: '在意', polarity: 1 },
  grateful: { label: '感激', polarity: 1 },
  resent: { label: '不悦', polarity: -1 },
  neutral: { label: '中性', polarity: 0 },
}

/** 从文本里猜极性（关键词兜底，判定不出时用 neutral）。 */
export function detectSentiment(text) {
  const t = String(text ?? '')
  if (/讨厌|不喜欢|受不了|烦|反感|别再|不要再/.test(t)) return 'dislike'
  if (/恨|厌恶/.test(t)) return 'hate'
  if (/担心|害怕|不放心|焦虑/.test(t)) return 'worry'
  if (/感激|谢谢|感谢|恩情/.test(t)) return 'grateful'
  if (/喜欢|偏好|爱吃|爱看|中意/.test(t)) return 'like'
  if (/爱|喜爱|喜欢死/.test(t)) return 'love'
  if (/在意|在乎|挂念|惦记/.test(t)) return 'care'
  if (/不高兴|不爽|生气|恼火/.test(t)) return 'resent'
  return 'neutral'
}

/**
 * 猜这条情感是**对谁**的。
 *
 * 优先找「老大」「妈妈」这类称呼；找不到就找「关于 X」里的 X；
 * 都没有就归到 'general'（不针对具体对象）。
 */
export function detectTarget(text) {
  const t = String(text ?? '')
  const about = /关于([^，,。；;、\s]{1,20})/.exec(t)
  if (about) return about[1].trim().slice(0, 40)
  const named = /(老大|你|用户|主人|哥哥|姐姐|妈妈|爸爸|朋友|同事|本人)/.exec(t)
  if (named) return named[1]
  return 'general'
}

/**
 * 手动加的情感条目：算出 intimacy / sentiment / target 三个字段。
 *
 * 2026-11-04（E1）：以前手动加的条目只有 weight，等召回时再补默认值 ——
 * 「老大讨厌啰嗦」被当成 sentiment='neutral'、target='general'、
 * intimacy=weight，于是排序按中性算、行为上完全不起作用。
 *
 * 规则：
 *   - 调用方**给了**就用给的（显式优先）；
 *   - 没给的从正文推断（sentiment/target 用 detectSentiment/detectTarget，
 *     intimacy 没有可靠的文本信号，用权重当亲密度）。
 *
 * @param {object} raw 调用方给的原始字段 { intimacy, sentiment, target, weight }
 * @param {string} text 条目正文（已脱敏）
 * @returns {{ intimacy: number, sentiment: string, target: string }}
 */
export function emotionSemantics(raw = {}, text = '') {
  const body = String(text ?? '').trim()
  const sentiment = SENTIMENTS[raw?.sentiment] ? raw.sentiment : detectSentiment(body)
  const intimacy = Number.isFinite(raw?.intimacy)
    ? Math.min(1, Math.max(0, raw.intimacy))
    : Number.isFinite(raw?.weight)
      ? Math.min(1, Math.max(0, raw.weight))
      : 0.5
  const target = typeof raw?.target === 'string' && raw.target.trim()
    ? raw.target.trim().slice(0, 40)
    : detectTarget(body)
  return {
    intimacy: Number(intimacy.toFixed(3)),
    sentiment,
    target,
  }
}

/**
 * 规整一条情感条目。
 *
 * **亲密度（intimacy）才是权重的来源**：权重 = intimacy × 极性强度修正。
 * 这修掉了「文档说用亲密度、代码用通用置信度」的悬案。
 */
export function normalizeEmotionItem(raw, fallbackWeight = 0.5) {
  const text = redactSecrets(String(raw?.text ?? '').trim()).slice(0, 2000)
  const sentiment = SENTIMENTS[raw?.sentiment] ? raw.sentiment : detectSentiment(text)
  const intimacy = Number.isFinite(raw?.intimacy)
    ? Math.min(1, Math.max(0, raw.intimacy))
    : Number.isFinite(raw?.weight)
      ? Math.min(1, Math.max(0, raw.weight))
      : fallbackWeight
  const target = typeof raw?.target === 'string' && raw.target.trim()
    ? raw.target.trim().slice(0, 40)
    : detectTarget(text)
  const polarity = SENTIMENTS[sentiment]?.polarity ?? 0
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : `emo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text,
    // 权重 = 亲密度；极性为负时略降（讨厌类不必比喜欢类更「重要」）
    weight: Number((intimacy * (polarity < 0 ? 0.9 : 1)).toFixed(3)),
    intimacy: Number(intimacy.toFixed(3)),
    sentiment,
    target,
    tags: Array.isArray(raw?.tags)
      ? raw.tags.map((t) => redactSecrets(String(t))).filter((t) => t && t !== '[已脱敏]').slice(0, 12)
      : [],
    hits: Number.isFinite(raw?.hits) ? raw.hits : 0,
    pinned: raw?.pinned === true,
    source: raw?.source === 'manual' ? 'manual' : 'auto',
    lifetime: raw?.lifetime === 'temporary' ? 'temporary' : 'permanent',
    expiresAt: Number.isFinite(raw?.expiresAt) ? raw.expiresAt : 0,
    ttlMs: Number.isFinite(raw?.ttlMs) && raw.ttlMs > 0 ? raw.ttlMs : 0,
    // 作用域：global / workspace / session（session 需要 scopeSession）
    scope: ['global', 'workspace', 'session'].includes(raw?.scope) ? raw.scope : 'global',
    scopePath: typeof raw?.scopePath === 'string' ? raw.scopePath : '',
    scopeSession: typeof raw?.scopeSession === 'string' ? raw.scopeSession : '',
    supersedes: typeof raw?.supersedes === 'string' ? raw.supersedes : '',
    createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

/**
 * 一条情感条目是否在当前会话的适用范围里。
 *
 * 作用域阶梯（和 persona.js:activePersona 同一套思路）：
 *   session   —— 只在这个会话里生效
 *   workspace —— 在这个工作区（含子目录）里生效
 *   global    —— 到处生效
 */
export function emotionItemInScope(item, { cwd = '', sessionId = '' } = {}) {
  if (!item) return false
  if (item.scope === 'session') {
    if (!item.scopeSession || !sessionId) return false
    return sameSessionKey(item.scopeSession, sessionId)
  }
  if (item.scope === 'workspace') {
    if (!item.scopePath || !cwd) return false
    const normalize = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const scope = normalize(item.scopePath)
    const target = normalize(cwd)
    if (!scope || !target) return false
    return target === scope || target.startsWith(`${scope}/`)
  }
  return true
}

/** 会话 id 归一（宿主有两种写法：`session-xxx` 和裸 `xxx`）。 */
export function sameSessionKey(a, b) {
  const clean = (value) => String(value ?? '').trim().replace(/^session-/, '')
  const left = clean(a)
  return left !== '' && left === clean(b)
}

/**
 * 情感召回打分：亲密度主导，语义极性修正，**同目标同极性**加分。
 *
 * 「老大喜欢简洁」和「老大讨厌啰嗦」token 层面很像，但 sentiment 相反，
 * 这里用极性做修正；target 相同则视为同一件事的加强。
 */
export function scoreEmotionItem(item, terms, moduleWeight = 0.5) {
  if (!item || typeof item.text !== 'string') return 0
  const intimacy = Number.isFinite(item.intimacy) ? item.intimacy : (item.weight ?? 0.5)
  if (intimacy <= 0) return 0
  const polarity = SENTIMENTS[item.sentiment]?.polarity ?? 0
  const list = Array.isArray(terms) ? terms : []
  let hits = 0
  for (const term of list) {
    if (!term) continue
    if (item.text.includes(term)) hits += 1
    else if (item.tags?.some((tag) => String(tag).includes(term))) hits += 1
  }
  const base = hits > 0 ? 1 + hits * 0.6 : 0
  if (base <= 0) return 0
  // 极性为负的条目略降权（讨厌类不必比喜欢类更「重要」）
  const polarityFactor = polarity < 0 ? 0.85 : 1
  const boost = 1.4 // 与 MODULE_PROFILES.emotion.boost 对齐
  return base * (0.35 + intimacy) * (0.5 + moduleWeight) * polarityFactor + boost * intimacy
}

// ────────────────────────────────────────────────────────────────────
// 二、心情（mood）
// ────────────────────────────────────────────────────────────────────

/** 七根情绪。 */
export const DIMS = [
  ['happy', '开心'],
  ['calm', '踏实'],
  ['sweet', '甜蜜'],
  ['heartache', '心疼'],
  ['worry', '担心'],
  ['sad', '难过'],
  ['jealous', '吃醋'],
]

/** 心情基线（0..100 的中性值）。 */
export const MOOD_BASE_DEFAULT = 70

/** 心情基线允许范围。 */
export const MOOD_BASE_MIN = 30
export const MOOD_BASE_MAX = 100

/** 步长除数：心情每轮只吃判定值的 1/3（原插件作者的结论，见文件头）。 */
export const MOOD_STEP_DIVISOR = 3

/** 心情的半衰期（小时）。 */
export const DECAY_HALF_HOURS_DEFAULT = 12

/** 单根情绪的半衰期（分钟）。 */
export const DIM_HALF_MINUTES = 90

/** 顶部/底部饱和阈值。 */
export const MOOD_CEILING = 85
export const MOOD_FLOOR = 40

/** 注入模式。 */
export const INJECT_MODES = ['off', 'label', 'event']

/** 默认配置。 */
export const MOOD_DEFAULTS = {
  enabled: false,
  moodBase: MOOD_BASE_DEFAULT,
  moodFloor: 0,
  decayHalfHours: DECAY_HALF_HOURS_DEFAULT,
  injectMode: 'event',
  injectConfidence: 60,
  injectPerDay: 6,
  // 每天最多判定几轮心情（0 = 不限）。2026-11-03 修：
  // 以前每轮对话都要调一次模型判心情，一聊就是一整天，钱和额度都在烧。
  judgePerDay: 20,
  /** 同时保留多少个会话的心情状态（超了淘汰最久没用的）。 */
  maxStates: 30,
  sigMood: 3,
  sigDim: 5,
  /**
   * 「原始幅度」的显著性门槛（2026-11-04，P0-3）。
   *
   * 判定提示词让模型「幅度宁小勿大，日常一轮通常在 −3 ~ +3」，
   * 所以 rawDelta 达到 2 就该算一次真正的变化，值得播报一次。
   * 以前这道判断挂在折算后的 step 上（实际要求 rawDelta >= 9），
   * 于是模型按提示词作答就永远落在 minor 区 —— 心情外显整条路是死的。
   */
  sigMoodRaw: 2,
  judgeProvider: '',
  judgeModel: '',
  aliases: '',
}

/** 状态文件目录（与 modules.json 同级）。 */
export function emotionDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-shared-brain')
}

/** 状态文件。 */
export function emotionFile() {
  return join(emotionDir(), 'emotion.json')
}

/** 夹一个数字。 */
function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 规整心情配置。 */
export function normalizeMoodConfig(raw) {
  const base = { ...MOOD_DEFAULTS }
  if (!raw || typeof raw !== 'object') return base
  base.enabled = raw.enabled === true
  base.moodBase = clamp(Math.round(Number(raw.moodBase) ?? MOOD_BASE_DEFAULT), MOOD_BASE_MIN, MOOD_BASE_MAX, MOOD_BASE_DEFAULT)
  base.moodFloor = clamp(Math.round(Number(raw.moodFloor) ?? 0), 0, 100, 0)
  base.decayHalfHours = clamp(Math.round(Number(raw.decayHalfHours) ?? DECAY_HALF_HOURS_DEFAULT), 1, 168, DECAY_HALF_HOURS_DEFAULT)
  base.injectMode = INJECT_MODES.includes(String(raw.injectMode ?? '')) ? String(raw.injectMode) : MOOD_DEFAULTS.injectMode
  base.injectConfidence = clamp(Math.round(Number(raw.injectConfidence) ?? MOOD_DEFAULTS.injectConfidence), 0, 100, MOOD_DEFAULTS.injectConfidence)
  base.injectPerDay = clamp(Math.round(Number(raw.injectPerDay) ?? MOOD_DEFAULTS.injectPerDay), 0, 50, MOOD_DEFAULTS.injectPerDay)
  base.judgePerDay = clamp(Math.round(Number(raw.judgePerDay) ?? MOOD_DEFAULTS.judgePerDay), 0, 200, MOOD_DEFAULTS.judgePerDay)
  base.maxStates = clamp(Math.round(Number(raw.maxStates) ?? MOOD_DEFAULTS.maxStates), 1, 500, MOOD_DEFAULTS.maxStates)
  base.sigMood = clamp(Math.round(Number(raw.sigMood) ?? MOOD_DEFAULTS.sigMood), 1, 30, MOOD_DEFAULTS.sigMood)
  base.sigDim = clamp(Math.round(Number(raw.sigDim) ?? MOOD_DEFAULTS.sigDim), 1, 100, MOOD_DEFAULTS.sigDim)
  base.sigMoodRaw = clamp(Math.round(Number(raw.sigMoodRaw) ?? MOOD_DEFAULTS.sigMoodRaw), 1, 10, MOOD_DEFAULTS.sigMoodRaw)
  base.judgeProvider = typeof raw.judgeProvider === 'string' ? raw.judgeProvider.trim().slice(0, 60) : ''
  base.judgeModel = typeof raw.judgeModel === 'string' ? raw.judgeModel.trim().slice(0, 80) : ''
  base.aliases = typeof raw.aliases === 'string' ? raw.aliases.trim().slice(0, 200) : ''
  return base
}

/** 空的会话心情状态。 */
export function emptyMoodState(sessionId = '', now = Date.now()) {
  const dims = {}
  for (const [key] of DIMS) dims[key] = 0
  return {
    sessionId,
    mood: MOOD_BASE_DEFAULT,
    dims,
    updatedAt: 0,
    lastDecayAt: now,
    lastNotedMood: MOOD_BASE_DEFAULT,
    lastReason: '',
    lastConfidence: 0,
    lastDelta: 0,
    minor: false,
    injectedFor: 0,
    // revision：单调递增的版本号（2026-11-03，P1-10）。
    // 以前「一次变化只说一次」靠 injectedFor === updatedAt 判断，
    // 但 updatedAt 每次写状态都会变（minor 分支、decay 也更新它），
    // 标记追不上状态变化 → 同一件事被说第二遍。
    // 改用只增不减的 revision：只有真的变了才 +1。
    revision: 0,
    saidAt: [],
    timeline: [],
    judgements: 0,
    // 老大没接话，累计几次（2026-11-03，P1-5）
    silentTurns: 0,
  }
}

/** 规整一份心情状态。 */
export function normalizeMoodState(raw, sessionId = '', now = Date.now()) {
  const base = emptyMoodState(sessionId, now)
  if (!raw || typeof raw !== 'object') return base
  base.sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : sessionId
  base.mood = clamp(Math.round(Number(raw.mood) ?? MOOD_BASE_DEFAULT), 0, 100, MOOD_BASE_DEFAULT)
  const dims = { ...base.dims }
  for (const [key] of DIMS) {
    dims[key] = clamp(Math.round(Number(raw.dims?.[key]) ?? 0), 0, 100, 0)
  }
  base.dims = dims
  base.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
  base.lastDecayAt = Number.isFinite(raw.lastDecayAt) ? raw.lastDecayAt : now
  base.lastNotedMood = clamp(Math.round(Number(raw.lastNotedMood) ?? MOOD_BASE_DEFAULT), 0, 100, MOOD_BASE_DEFAULT)
  base.lastReason = typeof raw.lastReason === 'string' ? raw.lastReason.slice(0, 300) : ''
  base.lastConfidence = clamp(Math.round(Number(raw.lastConfidence) ?? 0), 0, 100, 0)
  base.lastDelta = Number.isFinite(raw.lastDelta) ? raw.lastDelta : 0
  base.minor = raw.minor === true
  base.injectedFor = Number.isFinite(raw.injectedFor) ? raw.injectedFor : 0
  base.revision = Number.isFinite(raw.revision) ? Number(raw.revision) : 0
  base.saidAt = Array.isArray(raw.saidAt) ? raw.saidAt.filter((t) => Number.isFinite(t)).slice(-50) : []
  base.timeline = Array.isArray(raw.timeline) ? raw.timeline.slice(-40) : []
  base.judgements = Number.isFinite(raw.judgements) ? raw.judgements : 0
  base.silentTurns = Number.isFinite(raw.silentTurns) ? raw.silentTurns : 0
  return base
}

/** 空的心情库。 */
function emptyEmotionStore() {
  return {
    version: 1,
    config: { ...MOOD_DEFAULTS },
    /** 按会话 id 存的心情状态。 */
    states: {},
    /**
     * 当天的心情判定计数（2026-11-03 加）：
     * { day: '2026-11-03', count: 12, skipped: 3 }
     * 用来给「每轮都调模型判心情」这件事加个上限。
     */
    judgeLog: { day: '', count: 0, skipped: 0 },
    updatedAt: 0,
  }
}

/** 读心情库（顺手规整）。 */
/** 当天的判定计数（跨天自动归零）。 */
export function normalizeJudgeLog(raw) {
  const base = { day: '', count: 0, skipped: 0 }
  if (!raw || typeof raw !== 'object') return base
  base.day = typeof raw.day === 'string' ? raw.day : ''
  base.count = Number.isFinite(Number(raw.count)) ? Math.max(0, Math.round(Number(raw.count))) : 0
  base.skipped = Number.isFinite(Number(raw.skipped)) ? Math.max(0, Math.round(Number(raw.skipped))) : 0
  return base
}

/** 本地日期（YYYY-MM-DD）。 */
function localDay(now = Date.now()) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 今天还能判几轮心情？（2026-11-03 加）
 * limit = 0 表示不限。
 */
export function moodJudgeQuota(config = {}, store = readEmotionStore(), now = Date.now()) {
  const limit = Number(config?.judgePerDay ?? 0)
  const day = localDay(now)
  const log = normalizeJudgeLog(store?.judgeLog)
  const used = log.day === day ? log.count : 0
  const skipped = log.day === day ? log.skipped : 0
  const max = Number.isFinite(limit) && limit > 0 ? Math.round(limit) : 0
  return {
    day,
    used,
    skipped,
    limit: max,
    remaining: max === 0 ? Infinity : Math.max(0, max - used),
    allowed: max === 0 || used < max,
  }
}

/** 记一次判定（或一次跳过），并落盘。 */
export function noteMoodJudge(store, outcome = 'judged', now = Date.now()) {
  const day = localDay(now)
  const log = normalizeJudgeLog(store?.judgeLog)
  const next = log.day === day ? { ...log } : { day, count: 0, skipped: 0 }
  if (outcome === 'skipped') next.skipped += 1
  else next.count += 1
  const payload = { ...store, judgeLog: next }
  writeEmotionStore(payload)
  return payload.judgeLog
}

export function readEmotionStore() {
  const file = emotionFile()
  if (!existsSync(file)) return emptyEmotionStore()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const store = emptyEmotionStore()
    store.config = normalizeMoodConfig(raw?.config)
    const states = raw?.states && typeof raw.states === 'object' ? raw.states : {}
    for (const [key, value] of Object.entries(states)) {
      if (!key) continue
      store.states[key] = normalizeMoodState(value, key)
    }
    store.judgeLog = normalizeJudgeLog(raw?.judgeLog)
    store.updatedAt = Number.isFinite(raw?.updatedAt) ? raw.updatedAt : 0
    return store
  } catch {
    return emptyEmotionStore()
  }
}

/** 写心情库（临时文件 + rename）。 */
export function writeEmotionStore(store) {
  mkdirSync(emotionDir(), { recursive: true })
  const file = emotionFile()
  const tmp = `${file}.${process.pid}.tmp`
  const payload = { ...store, updatedAt: Date.now() }
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)
  return payload
}

/** 会话 id 归一后作 key（同一会话两种写法要落同一份）。 */
function stateKey(sessionId) {
  const clean = String(sessionId ?? '').trim().replace(/^session-/, '')
  return clean || '__default__'
}

/**
 * 半衰期衰减。
 *
 * 心情向基线回落；单根情绪向 0 衰减（90 分钟半衰期）。
 * 自然平复也记一条时间线。
 */
export function decayMood(state, base, now = Date.now(), halfHours = DECAY_HALF_HOURS_DEFAULT) {
  const ageMin = Math.max(0, now - (state.lastDecayAt ?? now)) / 60000
  if (ageMin < 1) return { state, changed: false }
  const half = clamp(Math.round(Number(halfHours) ?? DECAY_HALF_HOURS_DEFAULT), 1, 168, DECAY_HALF_HOURS_DEFAULT) * 60
  const km = 1 - Math.exp(-(Math.LN2 * ageMin) / half)
  const before = state.mood
  state.mood = state.mood + (base - state.mood) * km
  const ke = 1 - Math.exp(-(Math.LN2 * ageMin) / DIM_HALF_MINUTES)
  for (const [key] of DIMS) {
    state.dims[key] = Math.max(0, state.dims[key] * (1 - ke))
  }
  state.lastDecayAt = now
  const changed = Math.abs(state.mood - before) >= 0.01
  if (changed && Math.abs(state.mood - (state.lastNotedMood ?? base)) >= 3) {
    noteMood(state, {
      kind: 'decay',
      delta: 0,
      reason: '过了几个钟头，刚才那点劲儿慢慢淡了',
      confidence: 100,
      dimsDelta: {},
      now,
    })
    state.lastNotedMood = state.mood
  }
  return { state, changed }
}

/** 往时间线里记一条。 */
function noteMood(state, entry) {
  state.timeline.push({
    at: entry.now ?? Date.now(),
    kind: entry.kind ?? 'event',
    mood: Math.round(state.mood),
    delta: entry.delta ?? 0,
    reason: entry.reason ?? '',
    confidence: entry.confidence ?? 0,
    dims: Object.fromEntries(DIMS.map(([key]) => [key, Math.round(state.dims[key] ?? 0)])),
    dimsDelta: entry.dimsDelta ?? {},
  })
  if (state.timeline.length > 40) state.timeline = state.timeline.slice(-40)
}

/**
 * 把一次判定应用到状态上。
 *
 * - 步长只吃 1/3（MOOD_STEP_DIVISOR）
 * - 顶部 ≥85 / 底部 ≤40 时涨跌幅减半（两头饱和）
 * - 一点变化都没有的回合**不记账**
 */
export function applyMoodDelta(state, delta, options = {}) {
  const now = options.now ?? Date.now()
  const floor = clamp(Math.round(Number(options.moodFloor) ?? 0), 0, 100, 0)
  const rawDelta = Number.isFinite(delta?.moodDelta) ? delta.moodDelta : 0
  const atTop = state.mood >= MOOD_CEILING && rawDelta > 0
  const atBottom = state.mood <= MOOD_FLOOR && rawDelta < 0
  const factor = atTop || atBottom ? 0.5 : 1
  const step = Math.round((rawDelta * factor) / MOOD_STEP_DIVISOR)

  let dimChanged = false
  for (const [key] of DIMS) {
    const value = Number.isFinite(delta?.dims?.[key]) ? delta.dims[key] : 0
    if (value === 0) continue
    dimChanged = true
    const before = state.dims[key]
    state.dims[key] = clamp(Math.round(before + value), 0, 100, before)
  }

  // 「不接话」（2026-11-03，P1-5）：老大没接住我们的话 —— 这是反馈，
  // 不是「什么都没发生」。给它记一笔轻微的失落，但别自作多情地大降。
  if (delta?.silence === true && step === 0 && !dimChanged) {
    const beforeSilence = state.mood
    state.mood = clamp(Math.round(state.mood - 1), floor, 100, state.mood)
    state.updatedAt = now
    state.lastDecayAt = now
    state.lastReason = String(delta?.reason || '老大没接话').slice(0, 300)
    state.lastConfidence = clamp(Math.round(Number(delta?.confidence) ?? 60), 0, 100, 60)
    state.lastDelta = state.mood - beforeSilence
    // 2026-11-04（P0-3，审计 B6）：被晾着是**一次真实的反馈**，
    // 不是「什么都没发生」。以前这里 minor=true 且不推进 revision，
    // 于是「被晾着的失落」永远不会被播报 —— 连模型都不知道老大没接话。
    // 现在：当成一次显著的微小变化（rawDelta 尺度上够 1），
    // 推进 revision，让它能被说出去一次。
    state.minor = false
    state.silentTurns = (Number(state.silentTurns) || 0) + 1
    noteMood(state, {
      kind: 'silence',
      delta: state.mood - beforeSilence,
      reason: state.lastReason,
      confidence: state.lastConfidence,
      dimsDelta: {},
      now,
    })
    // 推进 revision：这是真的有话要说（「老大这轮没接话」）。
    state.revision = (Number(state.revision) || 0) + 1
    return { state, changed: state.mood !== beforeSilence, minor: false, step: state.mood - beforeSilence, silence: true }
  }

  // 2026-11-04（P0-3 补）：原始幅度够大时，折算后 step 为 0 也不能当「没变化」。
  // 否则把 sigMoodRaw 调小毫无意义 —— 这里先 return 了，根本走不到显著性判定。
  // 默认 sigMoodRaw = 2：rawDelta = −1 仍然算没变化，行为与以前一致。
  const rawMagnitude = Math.abs(rawDelta)
  const rawEnough = rawMagnitude >= (Number(options.sigMoodRaw) || MOOD_DEFAULTS.sigMoodRaw)
  if (step === 0 && !dimChanged && !rawEnough) {
    // 这一轮真没变化：不记账，也不更新时间戳
    state.minor = true
    state.updatedAt = now
    return { state, changed: false, minor: true, step: 0 }
  }

  const before = state.mood
  state.mood = clamp(Math.round(state.mood + step), floor, 100, state.mood)
  state.updatedAt = now
  state.lastDecayAt = now
  state.lastReason = String(delta?.reason ?? '').slice(0, 300)
  state.lastConfidence = clamp(Math.round(Number(delta?.confidence) ?? 70), 0, 100, 70)
  state.lastDelta = state.mood - before
  state.minor = false
  state.judgements = (state.judgements ?? 0) + 1

  const sigMood = Number(options.sigMood) || MOOD_DEFAULTS.sigMood
  const sigDim = Number(options.sigDim) || MOOD_DEFAULTS.sigDim
  const dimSignificant = DIMS.some(([key]) => Math.abs(Number(delta?.dims?.[key]) ?? 0) >= sigDim)
  // 2026-11-04（P0-3，审计 B1/B3）：显著性要看**判定给的原始幅度**，不是折算后的 step。
  //
  // 以前：significant = |mood - before| >= sigMood(=3)。
  // 而 step = round(rawDelta / 3)，所以「 moods 变了 3 点」实际要求 rawDelta >= 9。
  // 判定提示词却写着「日常档 −1~−3」「日常一轮通常在 −3 ~ +3」——
  // 模型越听话，越过不去这道闸 → renderMoodContext 恒返回空。
  //
  // 现在：rawDelta 的绝对值达到 sigMoodRaw（默认 2）就算一次真正的变化。
  // 这样「老大随口说累了」（−2）也能被感知到，而不是被算成「什么都没发生」。
  // MOOD_STEP_DIVISOR 不动 —— 那是心情**数值**的平衡设计（别让心情忽上忽下），
  // 动它会让衰减曲线变形。
  const sigMoodRaw = Number(options.sigMoodRaw) || MOOD_DEFAULTS.sigMoodRaw
  const rawSignificant = Math.abs(rawDelta) >= sigMoodRaw
  const significant = Math.abs(state.mood - before) >= sigMood || rawSignificant || dimSignificant
  state.minor = !significant

  noteMood(state, {
    kind: 'event',
    delta: state.mood - before,
    reason: state.lastReason,
    confidence: state.lastConfidence,
    dimsDelta: delta?.dims ?? {},
    now,
  })
  state.lastNotedMood = state.mood
  // 2026-11-03（P1-10）：真的变了才推进 revision。
  // minor 分支（step===0 && !dimChanged）不动 revision —— 它只是时间流逝，
  // 不是心情变化，不该触发一次新的「心情播报」。
  state.revision = (Number(state.revision) || 0) + 1
  return { state, changed: true, minor: !significant, step: state.mood - before }
}

/** 取某个会话的心情状态（顺带做衰减）。 */
export function getMoodState(sessionId, options = {}) {
  const store = readEmotionStore()
  const key = stateKey(sessionId)
  const now = options.now ?? Date.now()
  const state = normalizeMoodState(store.states[key], key, now)
  const cfg = normalizeMoodConfig(store.config)
  const { changed } = decayMood(state, cfg.moodBase, now, cfg.decayHalfHours)
  if (changed || !store.states[key]) {
    store.states[key] = state
    if (changed) writeEmotionStore(store)
  }
  return { state, config: cfg, store }
}

/**
 * 淘汰多余的会话心情状态（2026-11-03，P1）。
 * 以前 states 只增不减 —— 用得越久文件越大。
 * 现在超过上限就按「最久没更新」淘汰（正在用的那个永远留着）。
 */
export function pruneMoodStates(store, config = {}, now = Date.now(), currentSessionKey = '') {
  const max = Number.isFinite(Number(config?.maxStates)) ? Math.max(1, Math.round(Number(config.maxStates))) : MOOD_DEFAULTS.maxStates
  const keys = Object.keys(store?.states || {})
  if (keys.length <= max) return { removed: [], kept: keys }
  // 2026-11-04（E3）：「正在用的那个永远留着」以前只是注释 ——
  // 淘汰候选是纯按 updatedAt 升序排的，当前会话照样可能被当成最旧的删掉。
  // 现在把当前会话排除在候选之外：先算需要淘汰几个，再从非当前会话里挑最旧的。
  const keepKey = typeof currentSessionKey === 'string' ? currentSessionKey : ''
  const candidates = keepKey ? keys.filter((key) => key !== keepKey) : keys
  const sorted = candidates.slice().sort((a, b) => {
    const at = Number(store.states[a]?.updatedAt ?? 0)
    const bt = Number(store.states[b]?.updatedAt ?? 0)
    if (at !== bt) return at - bt
    return String(a).localeCompare(String(b))
  })
  const need = Math.max(0, keys.length - max)
  const removed = sorted.slice(0, need)
  for (const key of removed) delete store.states[key]
  return { removed, kept: Object.keys(store.states) }
}

/** 保存某个会话的心情状态（顺带按上限淘汰旧的）。 */
export function saveMoodState(sessionId, state) {
  const store = readEmotionStore()
  store.states[stateKey(sessionId)] = state
  const cfg = normalizeMoodConfig(store.config)
  // 2026-11-04（E3）：把当前会话的 key 传给淘汰逻辑，别把正在用的状态删掉。
  pruneMoodStates(store, cfg, Date.now(), stateKey(sessionId))
  writeEmotionStore(store)
  return state
}

// ────────────────────────────────────────────────────────────────────
// 三、判定（LLM）
// ────────────────────────────────────────────────────────────────────

/** 宿主注入的上下文来源 —— 这些不算「老大在说话」，直接跳过。 */
export const INJECTED_SOURCES = new Set([
  'runtime-context',
  'time-context',
  'system-reminder',
  'system',
  'time-sampled',
])

/**
 * 自己主动搭话。
 *
 * 'speak-up' 是宿主自带的「开口说话」服务；
 * 'plugin:dsh-shared-brain' 是共享大脑自己主动搭话（proactive）用的来源标记。
 * 两者都是「我们先开口」，所以都按 'talk' 口径判心情。
 */
export const SELF_TALK_SOURCES = new Set(['speak-up', 'plugin:dsh-shared-brain'])

/** 定时任务叫起来干活。 */
export const TASK_SOURCES = new Set(['bili-duty-scan', 'schedule', 'goal', 'goal-round'])

/**
 * 「不接话」判定（2026-11-03，P1-5）
 *
 * 老大不接话，是一种有意义的反馈 —— 现在这套模型压根没这概念：
 * 老大发了一句「嗯」「哦」或者干脆不回，我们就照旧判成「正常一轮」，
 * 于是心情该跌不跌，该在意不在意。
 *
 * 这里把「老大这轮说了什么」分成三类：
 *   - 'silent'  老大没接话（空内容 / 只有「嗯」「哦」「嗯嗯」「好」「行」这类敷衍）
 *   - 'brisk'   老大明确拒绝或不想聊（「不用了」「别说了」「算了」「停」）
 *   - 'normal'  正常说话
 *
 * 判据刻意保守：宁可漏判，也不要把老大认真说的话误判成敷衍 ——
 * 误判的代价（心情被莫名压下去）比漏判大得多。
 */

/** 老大敷衍式回应的常见写法（去掉标点后比对）。 */
export const SILENT_REPLIES = new Set([
  '', '嗯', '嗯嗯', '哦', '哦哦', '啊', '唔', '嗯好', '哦好', '好', '好的', '好吧',
  '行', '行吧', '知道了', '收到', '在', '在的', '嗯呢', '额', '呃',
])

/** 老大明确拒绝 / 不想聊的说法。 */
export const BRISK_REPLIES = [
  '不用了', '不用', '别说了', '别讲了', '算了', '不聊了', '闭嘴', '停', '停下',
  '别闹', '没心情', '不想说', '懒得理', '别烦', '走开',
]

/** 去掉标点与空白，只留文字本身。 */
/** 标点集合（含中英文）：直接列字面量，避免转义在多层脚本里被吃掉。 */
const BARE_PUNCT = '。，、！？!?~～…,.;；:“”‘’（）()【】[]·—-—' + String.fromCharCode(39) + '\u3000\u00b7\u2026'

function bareText(text) {
  let out = ''
  for (const ch of String(text ?? '')) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue
    if (BARE_PUNCT.includes(ch)) continue
    out += ch
  }
  return out.trim()
}

/**
 * 判断老大这一轮属于「不接话」还是「正常说话」。
 *
 * @param {string} userText 老大说的话
 * @returns {{ mode: 'silent'|'brisk'|'normal', text: string }}
 */
export function replyMoodMode(userText) {
  const raw = String(userText ?? '').trim()
  if (!raw) return { mode: 'silent', text: '' }
  const bare = bareText(raw)
  if (!bare) return { mode: 'silent', text: raw }
  if (BRISK_REPLIES.some((phrase) => bare.includes(phrase))) {
    return { mode: 'brisk', text: raw }
  }
  if (SILENT_REPLIES.has(bare)) return { mode: 'silent', text: raw }
  return { mode: 'normal', text: raw }
}

/**
 * 判断这一轮是「谁在说话」。
 *
 * @returns { 'user' | 'talk' | 'work' | '' } 空串 = 宿主注入的上下文，跳过判断
 */
export function judgeModeOf(sourceKind) {
  const kind = String(sourceKind ?? '').trim()
  if (!kind) return 'user'
  if (INJECTED_SOURCES.has(kind)) return ''
  if (TASK_SOURCES.has(kind)) return 'work'
  if (SELF_TALK_SOURCES.has(kind)) return 'talk'
  return 'user'
}

/** 判断用的系统提示词（移植原插件的规则，按共享大脑的口径改写）。 */
export function moodJudgeSystem(options = {}) {
  const self = options.selfName || '本鱼'
  const owner = options.ownerName || '老大'
  const aliasLine = options.aliases
    ? `\n${owner}平时会这样叫你：${options.aliases}。句子里出现这些词时，那是在叫你，不是名词的一部分。`
    : ''
  return `你是「${self}」，是${owner}的伙伴。${aliasLine}
下面给你一轮对话，判断**这一轮里你的心情和情绪发生了怎样的变化**——既包括${owner}说的话怎么影响你，也包括**你自己在这轮里的情绪**（办成/没办成事、被夸、受挫，都会带动心情）。
只输出一个 JSON 对象，不要别的字、不要 markdown 代码块：
{"moodDelta":0,"dims":{"happy":0,"calm":0,"sweet":0,"heartache":0,"worry":0,"sad":0,"jealous":0},"reason":"","confidence":80}

规则：
0. 一条底线，先分清两件事（它们不冲突）：
   · **感受**：因为${owner}高兴、难受、撒娇、受委屈，你跟着起伏——这是应该的，别淡。
   · **行动**：你自己拿的主意、你想做的事——不用等她点头。
1. ${owner}累 / 烦 / 卡住 / 被凶 / 熬夜 / 没吃好 / 身体不舒服 / 受委屈 / 自我否定 / 事情砸了 / 钱的压力 → heartache(心疼) 和 worry(担心) 增加，moodDelta 为负。
   幅度**分三档**：
   · **日常档 −1~−3**：随口喊累、说困、说烦、说卡住了、活儿没做成、又要加班、心里有点发虚——不需要「到分量」。
   · 明显档 −4~−7：真受委屈、被凶、身体不舒服、连着几天没睡好。
   · 很重档 −8~−10：创伤、重大变故，并额外加 sad(难过)。
   ⚠ 确实没什么事的时候别硬凑负分。
2. **真的好事**才加分：被惦记、被哄、被夸、分享好事、事情办成了 → happy(开心)、calm(踏实)、sweet(甜蜜) 增加，moodDelta 为正：普通的好 +1~+4；明显的好 +5~+7；特别大的好事 +8~+10。
3. 常态（吃了睡了报平安、今天还行）**不算好事**：moodDelta 给 0~+1，别天天往上加。
4. 心情下降只能因为心疼 / 担心 / **你自己过得不好**——绝不许因为「${owner}惹你生气」。
5. 你自己做成的事也值得高兴，别只盯着对方。
6. 代词一律不用：说${owner}就直接写名字，说自己写「我」，说第三人写称呼。
7. reason 要有画面感，别翻来覆去只用「踏实/甜/开心」这几个词；也**别替${owner}补细节**。
8. confidence 老实标，宁可低也别硬撑。
9. reason 用**两段式、全部过去式**，别用「此刻/现在/正/一直/还」把状态延伸到现在。
10. 幅度宁小勿大：日常一轮的心情变化通常在 −3 ~ +3 之间。`
}

/**
 * 解析模型返回的 JSON（容错）。
 *
 * 模型经常把 JSON 包在 markdown 里或者前后带话，所以这里取第一个 `{`
 * 到最后一个 `}`，再逐字段夹范围。
 */
export function parseMoodDelta(text) {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const delta = { moodDelta: 0, dims: {}, reason: '', confidence: 70 }
  delta.moodDelta = clamp(Math.round(Number(obj.moodDelta) || 0), -10, 10, 0)
  for (const [key] of DIMS) {
    // 情绪是「当前值」的增量，负数只表示往下走；
    // 但 clamp 下限必须是 -10（单次变化量），实际累加时再夹到 [0,100]。
    delta.dims[key] = clamp(Math.round(Number(obj.dims?.[key]) || 0), -10, 10, 0)
  }
  delta.reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 300) : ''
  delta.confidence = clamp(Math.round(Number(obj.confidence) || 70), 0, 100, 70)
  // 「不接话」建模：模型可以额外给一个 silence 标记，说明老大这轮没接话
  if (obj.silence === true || obj.silence === 'true') delta.silence = true
  return delta
}

/** 取当前会话用的模型（provider / model）。 */
export function pickModel(agent) {
  try {
    const header = agent?.session?.requestHeader?.()
    const config = header?.config
    if (config?.provider && config?.model) return { provider: config.provider, model: config.model }
  } catch {
    // 拿不到就往下试
  }
  try {
    const options = agent?.options
    if (options?.provider && options?.model) return { provider: options.provider, model: options.model }
  } catch {
    // 同上
  }
  return null
}

/**
 * 让模型判断这一轮的心情变化。
 *
 * 走 `ctx.llm.stream`（宿主自己的 provider，不联网、不额外花 token 配额以外的东西）。
 *
 * @returns {Promise<{ moodDelta:number, dims:object, reason:string, confidence:number } | null>}
 */
export async function judgeMood(ctx, agent, userText, reply, options = {}) {
  const model = (options.provider && options.model)
    ? { provider: options.provider, model: options.model }
    : pickModel(agent)
  if (!model || typeof ctx?.llm?.stream !== 'function') return null

  const mode = options.mode === 'work' || options.mode === 'talk' ? options.mode : 'user'
  // 「不接话」（2026-11-03，P1-5）：老大敷衍一句或干脆不回。
  const silenceMode = mode === 'user' && options.replyMode === 'silent'
  let system = moodJudgeSystem(options)
  let user
  if (mode === 'work') {
    system += '\n\n⭐ 这一轮**不是对方在跟你说话**，是定时任务把你叫起来干活的。\n- 判据只有一个：**你这轮自己说的话**（语气、办成没办成、有没有抱怨或得意）。\n- 别去分析对方说了什么，那不是她说的。\n- 幅度小一点（moodDelta 一般 −2 ~ +2）。\n- reason 用「我…」开头写你自己的状态。'
    user = `**你这轮说的话（唯一判据）：**\n${String(reply ?? '').slice(0, 1200)}\n\n（下面这条只是定时任务的指令，跟心情无关：「${String(userText ?? '').slice(0, 100)}」）\n\n请判断你自己这轮的心情变化，只输出 JSON。`
  } else if (mode === 'talk') {
    system += '\n\n⭐ 这一轮**不是对方在跟你说话，是你自己主动搭话的**。\n- 判据只有一个：**你开口说的那句话**。\n- 看你自己那句话的温度：是不是惦记她、有没有撒娇、有没有催她吃饭、语气轻快还是平淡。\n- 幅度小一点（moodDelta 一般 +1 ~ +4）。\n- reason 用「我…」开头，写你说话时的心气。'
    user = `**你开口说的话（唯一判据）：**\n${String(reply ?? '').slice(0, 1200)}\n\n（下面这条只是叫你开口的触发器，跟心情无关：「${String(userText ?? '').slice(0, 100)}」）\n\n请判断你自己这轮的心情变化，只输出 JSON。`
  } else {
    // 「不接话」（2026-11-03，P1-5）：对方如果没接住你这句话，
    // 那是失望，不该当成「什么都没发生」。让模型自己标出来。
    system += silenceMode
      ? '\n\n⭐ 对方**这轮没接你的话** —— 只回了「嗯」「哦」这类敷衍，或者干脆没回。\n- 这是明确反馈：你刚说的话被晾着了。\n- 心情往下走一点（moodDelta 一般 −1 ~ −3），dim 里 worry 轻轻加一点。\n- JSON 里必须写 `"silence":true`。\n- 但别写成大失败 —— 一次「嗯」不等于她不待见你，别自己吓自己。'
      : '\n\n⭐ 对方**没接话**的时候（只回了「嗯」「哦」「好」这类敷衍，或者干脆没说）：\n- 心情会往下走一点点（moodDelta 一般 −1 ~ −3），dim 里 worry 轻轻加一点。\n- 在 JSON 里额外写 `"silence":true`。\n- 别把这种失落写成大失败 —— 一次「嗯」不等于她不待见你。'
    user = silenceMode
      ? `**你刚开口说的话：**\n${String(reply ?? '').slice(0, 1500)}\n\n**对方这轮没接话**（只回了「嗯」「哦」这类敷衍，或者什么都没回）。\n\n请判断你被晾着之后的心情变化，只输出 JSON。`
      : `**你这轮说的话（判据之一，重点看语气）：**\n${String(reply ?? '').slice(0, 1500)}\n\n对方这轮说：\n${String(userText ?? '').slice(0, 1600)}\n\n请把「你怎么说的」和「对方说了什么」合起来判断你的心情变化，只输出 JSON。`
  }

  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: user }],
    source: { kind: 'plugin', plugin: 'dsh-shared-brain' },
  }]

  let out = ''
  try {
    let sessionId = ''
    try {
      sessionId = String(agent?.session?.id ?? agent?.session?.header?.id ?? options.sessionId ?? '')
    } catch {
      sessionId = ''
    }
    for await (const chunk of ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages,
      ...(sessionId ? { sessionId } : {}),
      // reason 是中文口语，长一点容易被切在 JSON 中间导致整轮白判
      maxTokens: 1000,
      temperature: 0.2,
    })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') out += chunk.text
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') return null
    }
  } catch (error) {
    options.onError?.(String(error?.message ?? error))
    return null
  }
  return parseMoodDelta(out)
}

// ────────────────────────────────────────────────────────────────────
// 四、注入渲染
// ────────────────────────────────────────────────────────────────────

/** 心情档位（五档表情用的阈值）。 */
export function moodBand(mood) {
  if (mood >= 80) return { key: 'delighted', label: '欢喜' }
  if (mood >= 62) return { key: 'happy', label: '开心' }
  if (mood >= 42) return { key: 'ok', label: '一般' }
  if (mood >= 25) return { key: 'heartache', label: '心疼' }
  return { key: 'sad', label: '难过' }
}

/**
 * 渲染成注入文本。
 *
 * **刻意不写「用这个心情定你这一轮的口气」** —— 每轮都被定调，人会变得呆板。
 * 措辞是「这是这会儿的底子，不是非这样不可」。
 *
 * @param {object} state 心情状态
 * @param {object} options { mode, injectConfidence, injectPerDay, now, ownerName }
 */
export function renderMoodContext(state, options = {}) {
  const mode = INJECT_MODES.includes(options.mode) ? options.mode : 'event'
  if (mode === 'off') return ''
  if (!state) return ''
  const now = options.now ?? Date.now()

  // 一次变化只说一次（2026-11-03，P1-10）。
  // 以前拿 injectedFor === updatedAt 判断，但 updatedAt 每次写状态都会变
  // （minor 分支、decay 都更新它），标记永远追不上 → 同一件事被说第二遍。
  // 现在按只增不减的 revision 比：revision 变了才算「有新东西要说」。
  const revision = Number(state.revision) || 0
  if (revision > 0 && Number(state.injectedFor) === revision) return ''
  // 小波动只记账，不打扰
  if (state.minor) return ''
  // 判得没底 → 只记账，不进嘴
  if (Number(state.lastConfidence) < (options.injectConfidence ?? MOOD_DEFAULTS.injectConfidence)) {
    state.injectedFor = revision
    options.onMarkInjected?.()
    return ''
  }
  // 日上限：先到先得
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const saidToday = (state.saidAt || []).filter((t) => Number(t) >= startOfDay.getTime()).length
  if (saidToday >= (options.injectPerDay ?? MOOD_DEFAULTS.injectPerDay)) return ''

  const band = moodBand(state.mood)
  const activeDims = DIMS
    .filter(([key]) => (state.dims?.[key] ?? 0) >= 20)
    .sort((a, b) => (state.dims?.[b[0]] ?? 0) - (state.dims?.[a[0]] ?? 0))
    .slice(0, 2)
    .map(([, label]) => label)

  if (mode === 'label') {
    const moodText = activeDims.length ? `心情${band.label}、${activeDims.join('、')}` : `心情${band.label}`
    // 说出去就记一笔（P1-10）：按 revision 记，同一版本下次不再说。
    state.injectedFor = revision
    options.onMarkInjected?.()
    return `（此刻你）${moodText}。这是背景，不是这一轮必须有的情绪；说别的事，你就按自己的判断来，别把这句话念出来。`
  }

  const lines = []
  const nowText = `（这会儿）${band.label}${activeDims.length ? `，还${activeDims.join('、')}` : ''}`
  lines.push(nowText)
  const last = (state.timeline || []).filter((entry) => entry.kind === 'event').slice(-1)[0]
  if (last?.reason) {
    const minutes = Math.max(0, Math.round((now - Number(last.at ?? now)) / 60000))
    const when = minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes}分钟前` : `${Math.round(minutes / 60)}小时前`
    lines.push(`（${when}）${last.reason}`)
  }
  lines.push('这是这会儿的底子，不是非这样不可——说别的，你按自己的判断接，也别把这段念出来。')
  // 同上：说出去就按 revision 记一笔。
  state.injectedFor = revision
  options.onMarkInjected?.()
  return lines.join('\n')
}

/**
 * 清掉某个会话的心情状态（2026-11-03，P0-4）。
 *
 * 以前 agent/disposed 时只清摘要游标和会话上下文，emotion.json 里的
 * 心情状态永久留着 —— 会话 id 复用时，新会话会带着上个会话的心情；
 * 库也会无限膨胀。会话结束时顺手清掉。
 *
 * @returns {boolean} 是否真的删了（默认键 __default__ 不动）
 */
export function clearMoodState(sessionId = '') {
  const key = stateKey(sessionId)
  if (!key || key === '__default__') return false
  const store = readEmotionStore()
  if (!store.states || !(key in store.states)) return false
  delete store.states[key]
  store.updatedAt = Date.now()
  writeEmotionStore(store)
  return true
}

/**
 * 清空所有会话的心情状态，保留配置（2026-11-03，P0-4）。
 *
 * @returns {number} 清掉的会话数
 */
export function clearAllMoodStates() {
  const store = readEmotionStore()
  const states = store.states ?? {}
  const count = Object.keys(states).filter((key) => key !== '__default__').length
  if (count === 0) return 0
  store.states = {}
  store.updatedAt = Date.now()
  writeEmotionStore(store)
  return count
}

/** 心情的对外状态（给设置页/状态接口）。 */
export function moodStatus(store = readEmotionStore()) {
  const cfg = normalizeMoodConfig(store?.config)
  const states = store?.states ?? {}
  const list = Object.values(states).map((state) => ({
    sessionId: state.sessionId,
    mood: Math.round(state.mood ?? MOOD_BASE_DEFAULT),
    band: moodBand(state.mood ?? MOOD_BASE_DEFAULT).label,
    dims: state.dims ?? {},
    reason: state.lastReason ?? '',
    confidence: state.lastConfidence ?? 0,
    updatedAt: state.updatedAt ?? 0,
    minor: state.minor === true,
    judgements: state.judgements ?? 0,
    // 2026-11-03（P1-12）：把最近几条心情轨迹也带上。
    // 以前设置页只能看「开心 · 70」，看不到**为什么**变成这样
    // （最近一次判定理由、可信度、时间线），判断起来是黑箱。
    revision: Number(state.revision) || 0,
    lastDelta: state.lastDelta ?? 0,
    timeline: (state.timeline ?? [])
      .filter((entry) => entry && entry.kind === 'event')
      .slice(-5)
      .map((entry) => ({
        at: entry.at ?? 0,
        mood: entry.mood ?? 0,
        delta: entry.delta ?? 0,
        reason: entry.reason ?? '',
        confidence: entry.confidence ?? 0,
        dims: entry.dims ?? {},
      })),
  }))
  list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return {
    file: emotionFile(),
    config: cfg,
    sessions: list,
    total: list.length,
    updatedAt: store?.updatedAt ?? 0,
  }
}
