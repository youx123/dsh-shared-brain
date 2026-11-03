/**
 * 心情驱动的主动决策（proactive-mood）。
 *
 * 背景：自动互动以前是「定时器一到就发一段固定模板」，模型既不知道现在
 * 什么心情，也不知道上次说了什么、更不知道该不该说话 —— 于是每次都一样，
 * 用户觉得「不够人性」。
 *
 * 这里把「要不要说话、说什么口气、聊什么」从定时器里拆出来，做成一个
 * 纯函数决策层：
 *
 *   decideProactive({ mood, history, config, now })
 *     → { action: 'speak' | 'silent', reason, tone, topics, intervalFactor }
 *
 * 设计原则：
 *   1. **心情低落 → 更关心**（老大 2026-11-02 定的策略）：缩短间隔、主动
 *      关心，措辞要轻，不要追问到底。
 *   2. **默认静默**（老大定的）：心情中性 + 没有真待办 + 距上次互动还不到
 *      一个「安静期」→ 这一轮就不说话，只记账。省 token、不打扰。
 *   3. **心情好 → 活跃**：缩短间隔，可以分享进展、撒个娇。
 *   4. **话题轮换**：记下用过的开头，换着花样问，避免每次都是同一句。
 *   5. **不替模型做决定**：这里只决定「说不说、大致什么调子」，具体说什么
 *      还是交给模型 —— 决策层只给约束和建议。
 */

import { DIMS, moodBand } from './emotion.js'

// ────────────────────────────────────────────────────────────────────
// 一、配置
// ────────────────────────────────────────────────────────────────────

/** 主动互动的默认配置（可在设置页覆盖）。 */
export const PROACTIVE_MOOD_DEFAULTS = {
  /** 关掉这个开关 = 退回「定时器一到就说话」的旧行为。 */
  enabled: true,
  /** 心情低于这个值算「低落」。 */
  lowMood: 45,
  /** 心情高于这个值算「不错」。 */
  highMood: 78,
  /** 安静期：距上次互动不到这个时长，且没有真待办 → 静默。 */
  quietPeriodMs: 30 * 60 * 1000,
  /** 一天最多主动搭话几次（防止刷屏）。 */
  maxPerDay: 3,
  /** 低落时把间隔缩到原来的多少（越小越频繁）。 */
  lowIntervalFactor: 0.5,
  /** 心情好时把间隔缩到原来的多少。 */
  highIntervalFactor: 0.7,
  /** 同一会话低落时，关心过几次就不再追问（避免显得烦）。 */
  maxConcernsPerSession: 1,
  /** 心情驱动是否允许「主动关心」。 */
  allowConcern: true,
  /** 心情驱动是否允许「分享进展」。 */
  allowShare: true,
}

/** 规整配置。 */
export function normalizeProactiveMoodConfig(raw) {
  const base = { ...PROACTIVE_MOOD_DEFAULTS }
  if (!raw || typeof raw !== 'object') return base
  if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled
  const num = (key, min, max, fallback) => {
    // null / undefined / 空串 = 没填，用默认值；
    // 只有真正的数字才拿来夹紧（否则 null 会被 Number() 变成 0）。
    if (raw[key] === null || raw[key] === undefined || raw[key] === '') return fallback
    const value = Number(raw[key])
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  }
  base.lowMood = num('lowMood', 0, 100, base.lowMood)
  base.highMood = num('highMood', 0, 100, base.highMood)
  base.quietPeriodMs = num('quietPeriodMs', 0, 24 * 3600 * 1000, base.quietPeriodMs)
  base.maxPerDay = num('maxPerDay', 0, 50, base.maxPerDay)
  base.lowIntervalFactor = num('lowIntervalFactor', 0.1, 2, base.lowIntervalFactor)
  base.highIntervalFactor = num('highIntervalFactor', 0.1, 2, base.highIntervalFactor)
  base.maxConcernsPerSession = num('maxConcernsPerSession', 0, 10, base.maxConcernsPerSession)
  if (typeof raw.allowConcern === 'boolean') base.allowConcern = raw.allowConcern
  if (typeof raw.allowShare === 'boolean') base.allowShare = raw.allowShare
  if (base.highMood < base.lowMood) base.highMood = base.lowMood
  return base
}

// ────────────────────────────────────────────────────────────────────
// 二、话题库
// ────────────────────────────────────────────────────────────────────

/**
 * 搭话的开头。
 *
 * 每一类对应一种「为什么现在搭话」的动机，轮换使用就不会显得机械。
 * `weight` 越低越少用（留点惊喜）。
 */
export const TOPIC_LIBRARY = [
  { key: 'progress', tone: 'upbeat', text: '看看之前说的那些活儿，有进展了吗？有卡住的地方就说一声。' },
  { key: 'pending', tone: 'neutral', text: '突然想起来，前面答应你的事还有没做完的没？有的话我现在就动手。' },
  { key: 'curious', tone: 'light', text: '我在想你那个项目最近折腾得怎么样了，有没有新的想法。' },
  { key: 'checkin', tone: 'warm', text: '随便聊两句——今天过得怎么样？' },
  { key: 'idea', tone: 'upbeat', text: '我刚想到一个可能对你有用的点子，你有空的话听我说说？' },
  { key: 'smalltalk', tone: 'light', text: '没什么要紧事，就是想跟你说句话。' },
  { key: 'weather', tone: 'light', text: '外面这会儿应该挺舒服的吧？你那边天气怎么样。' },
  { key: 'concern', tone: 'soft', text: '看你最近好像挺累的，还好吗？不用硬撑。' },
  { key: 'proud', tone: 'warm', text: '刚回看你之前做的那几件事，有几个是真做得漂亮。' },
  { key: 'question', tone: 'neutral', text: '问你个事儿：现在手上这几件事里，哪件你最不想拖到明天？' },
]

/** 低落时额外能用的关心型话题。 */
export const CONCERN_TOPICS = [
  { key: 'concern-soft', tone: 'soft', text: '看你这阵子状态不算太好，是累还是事情多？想说就说，不想说也没事。' },
  { key: 'concern-space', tone: 'soft', text: '不催你。要是想先放一放，我可以帮你把待办理顺。' },
]

/** 心情好时能用的分享型话题。 */
export const SHARE_TOPICS = [
  { key: 'share-win', tone: 'upbeat', text: '刚想到个挺妙的主意，想跟你分享一下。' },
  { key: 'share-tease', tone: 'warm', text: '有件事我还挺想跟你说的，等你方便的时候听我讲讲。' },
]

// ────────────────────────────────────────────────────────────────────
// 三、心情解读
// ────────────────────────────────────────────────────────────────────

/** 低落时最占分量的情绪维度。 */
const LOW_DIMS = new Set(['worry', 'sad', 'heartache'])

/** 好心情时最占分量的情绪维度。 */
const HIGH_DIMS = new Set(['happy', 'sweet', 'calm'])

/**
 * 解读心情状态。
 *
 * @param {object} moodState 心情状态（emotion.js 的 state 结构）
 * @param {object} config 主动互动配置
 * @returns {object} { band, mood, dominant, dominantValue, level }
 */
export function readMoodSignal(moodState, config = PROACTIVE_MOOD_DEFAULTS) {
  const cfg = normalizeProactiveMoodConfig(config)
  const mood = Number(moodState?.mood ?? 70)
  const band = moodBand(mood)
  const dims = moodState?.dims && typeof moodState.dims === 'object' ? moodState.dims : {}

  let dominant = ''
  let dominantValue = 0
  for (const [key] of DIMS) {
    const value = Number(dims[key] ?? 0)
    if (value > dominantValue) {
      dominant = key
      dominantValue = value
    }
  }

  let level = 'neutral'
  if (mood < cfg.lowMood) level = 'low'
  else if (mood >= cfg.highMood) level = 'high'
  // 心情分不低但情绪维度压倒性地是担心/难过 —— 也算低落。
  // 「嘴上说没事，心里有事」是常态，只看 mood 分会漏掉。
  else if (dominantValue >= 25 && LOW_DIMS.has(dominant)) level = 'low'
  else if (dominantValue >= 30 && HIGH_DIMS.has(dominant)) level = 'high'

  return {
    band,
    mood,
    dominant,
    dominantValue,
    level,
    dims,
  }
}

// ────────────────────────────────────────────────────────────────────
// 四、话题轮换
// ────────────────────────────────────────────────────────────────────

/**
 * 挑一个话题。
 *
 * 规则：优先没用过的；都用过了就挑用得最少的（轮换）；随机源可注入，
 * 测试时能固定。
 */
export function pickTopic(options = {}) {
  const {
    pool = TOPIC_LIBRARY,
    used = [],
    rand = Math.random,
    exclude = [],
  } = options

  const excluded = new Set(exclude)
  const candidates = pool.filter((item) => !excluded.has(item.key))
  if (candidates.length === 0) return null

  const usedCounts = new Map()
  for (const item of candidates) usedCounts.set(item.key, 0)
  for (const key of used) usedCounts.set(key, (usedCounts.get(key) ?? 0) + 1)

  const fresh = candidates.filter((item) => (usedCounts.get(item.key) ?? 0) === 0)
  const pool2 = fresh.length > 0 ? fresh : candidates
  const minCount = Math.min(...pool2.map((item) => usedCounts.get(item.key) ?? 0))
  const leastUsed = pool2.filter((item) => (usedCounts.get(item.key) ?? 0) === minCount)
  const index = Math.min(leastUsed.length - 1, Math.floor(rand() * leastUsed.length))
  return leastUsed[index]
}

/** 记一次用过的话题（保持在最近 12 个）。 */
export function rememberTopic(used, key) {
  const list = Array.isArray(used) ? used.filter(Boolean) : []
  list.push(key)
  return list.slice(-12)
}

// ────────────────────────────────────────────────────────────────────
// 五、决策
// ────────────────────────────────────────────────────────────────────

/**
 * 决定这一轮主动互动说不说话。
 *
 * @param {object} input
 * @param {object} input.moodState 心情状态（可为 null）
 * @param {object} input.history 会话历史 { lastSpokeAt, spokeToday, concerns, usedTopics, pending }
 * @param {object} input.config 配置
 * @param {number} input.now 当前时间戳
 * @returns {object} { action, reason, tone, topic, intervalFactor, signal }
 */
export function decideProactive(input = {}) {
  const config = normalizeProactiveMoodConfig(input.config)
  const now = Number(input.now ?? Date.now())
  const history = input.history && typeof input.history === 'object' ? input.history : {}

  // 0. 关掉心情驱动 → **不看心情**，但基本的礼貌（安静期、每日额度、
  //    均匀铺开）必须留着。早先在这里直接 return speak，等于
  //    「关掉人性化 = 恢复每 15 分钟刷一次」，那才是最原始的毛病。
  const signal = readMoodSignal(config.enabled ? input.moodState : null, config)

  // 1. 先算这一轮的待办和「距上次说话多久」。
  //    —— 安静期必须是**所有**主动说话的闸门（包括关心和分享）。
  //    旧写法把 quietPeriod 只放在最后的中性分支，结果关心/分享分支
  //    完全绕过它：心情一高涨就每 15 分钟连着说三次，像复读机。
  const pending = Array.isArray(history.pending) ? history.pending.filter(Boolean) : []
  const lastSpokeAt = Number(history.lastSpokeAt ?? 0)
  const sinceLast = lastSpokeAt > 0 ? now - lastSpokeAt : Infinity
  const concerns = Number(history.concerns ?? 0)
  const hasConcern = config.allowConcern && concerns < config.maxConcernsPerSession

  // 安静期按「这轮最想说什么」缩放：待办最宽容；低落时首次关心也放宽，
  // 但**已经关心过**就拉开到 4 倍安静期（2 小时），免得连着追着问。
  const concernGapFactor = concerns > 0 ? 4 : 0.5
  const quietFactor =
    pending.length > 0 ? 0.5 : signal.level === 'low' ? concernGapFactor : signal.level === 'high' ? 0.7 : 1
  const quietThreshold = config.quietPeriodMs * quietFactor
  if (sinceLast < quietThreshold) {
    return {
      action: 'silent',
      reason: 'quiet-period',
      tone: signal.level === 'low' ? 'soft' : signal.level === 'high' ? 'upbeat' : 'neutral',
      topic: null,
      intervalFactor:
        signal.level === 'low' ? config.lowIntervalFactor : signal.level === 'high' ? config.highIntervalFactor : 1,
      signal,
    }
  }

  // 3. 每日上限 —— 只有「低落时的关心」可以突破日常额度：
  //    关心另有一套上限（maxConcernsPerSession），不跟日常搭话抢名额。
  //    ⚠️ 待办**不**豁免：早先试过让 pending 豁免，结果每 15 分钟检查一次
  //    就提醒一次，一天刷 57 遍同一件事，比不提醒还糟。待办的做法是
  //    「额度内优先说它」，而不是「突破额度」。
  const spokeToday = Number(history.spokeToday ?? 0)
  const exempt = signal.level === 'low' && hasConcern
  const overDaily = config.maxPerDay > 0 && spokeToday >= config.maxPerDay
  if (overDaily && !exempt) {
    return {
      action: 'silent',
      reason: 'daily-limit',
      tone: 'neutral',
      topic: null,
      intervalFactor: 1,
      signal,
    }
  }

  // 3.5 每日额度要「均匀铺开」，不能上午一口气说完、下午到夜里彻底哑火。
  //     旧实现只数次数，结果 3 次额度常在头一小时用完，剩下十几个小时
  //     一句不说 —— 老大体感就是「要么连珠炮、要么死寂」。
  //     现在按「今天还剩几次 / 今天还剩多久」算一个均匀间隔当闸门。
  if (!exempt && config.maxPerDay > 0) {
    const remainingQuota = config.maxPerDay - spokeToday
    const dayEndTs = Number(input.dayEnd ?? 0)
    if (remainingQuota > 0 && dayEndTs > now) {
      const evenGap = Math.max(config.quietPeriodMs, (dayEndTs - now) / remainingQuota)
      if (sinceLast < evenGap) {
        return {
          action: 'silent',
          reason: 'paced',
          tone: 'neutral',
          topic: null,
          intervalFactor: 1,
          signal,
        }
      }
    }
  }

  // 4. 有真待办 → 一定要说（答应过的事不能拖）。
  if (pending.length > 0) {
    const topic = pickTopic({
      pool: TOPIC_LIBRARY.filter((item) => item.key === 'pending' || item.key === 'progress'),
      used: history.usedTopics ?? [],
      exclude: ['pending'],
    }) ?? TOPIC_LIBRARY.find((item) => item.key === 'pending')
    return {
      action: 'speak',
      reason: 'pending',
      tone: 'neutral',
      topic,
      intervalFactor: 1,
      signal,
    }
  }

  // 5. 低落 → 关心（老大定的：更关心、更主动）。
  if (signal.level === 'low') {
    if (hasConcern) {
      const topic = pickTopic({
        pool: CONCERN_TOPICS,
        used: history.usedTopics ?? [],
      })
      return {
        action: 'speak',
        reason: 'concern',
        tone: 'soft',
        topic,
        intervalFactor: config.lowIntervalFactor,
        signal,
      }
    }
    // 关心额度用完了 → **不闭嘴**，退回中性节奏（语气仍然放软）。
    // 旧写法在这里直接 silent，结果低落期间关心过一次就再也不说话 ——
    // 和老大约定的「低落时更关心、更主动」正好相反。
  }

  // 6. 心情好 → 可以活跃一下。
  if (signal.level === 'high' && config.allowShare) {
    const topic = pickTopic({
      pool: SHARE_TOPICS.length > 0 ? [...SHARE_TOPICS, ...TOPIC_LIBRARY] : TOPIC_LIBRARY,
      used: history.usedTopics ?? [],
    })
    return {
      action: 'speak',
      reason: 'share',
      tone: 'upbeat',
      topic,
      intervalFactor: config.highIntervalFactor,
      signal,
    }
  }

  // 7. 中性（或关心/分享额度已用完）→ 安静期已经过了，说一句。
  const moodFactor =
    signal.level === 'low'
      ? config.lowIntervalFactor
      : signal.level === 'high'
        ? config.highIntervalFactor
        : 1
  const topic = pickTopic({ pool: TOPIC_LIBRARY, used: history.usedTopics ?? [] })
  return {
    action: 'speak',
    reason: signal.level === 'low' ? 'concern-already' : 'routine',
    tone: signal.level === 'low' ? 'soft' : 'light',
    topic,
    intervalFactor: moodFactor,
    signal,
  }
}

// ────────────────────────────────────────────────────────────────────
// 六、措辞
// ────────────────────────────────────────────────────────────────────

/** 语气 → 对模型的一句说明（不写死具体内容，只给调子）。 */
export const TONE_HINTS = {
  soft: '语气放轻一点，像随口关心一句，不要追问到底。',
  upbeat: '语气轻快一点，可以带点小得意。',
  warm: '语气温和，像老朋友。',
  light: '语气轻松，别一本正经。',
  neutral: '语气平常。',
}

/**
 * 渲染心情那一句话（给模型看，不给用户看）。
 *
 * 「此刻你」这种提示只在心情确实有话说的时候才给，否则会把模型钉死。
 */
export function renderMoodHint(signal) {
  if (!signal) return ''
  const { band, level, dominant, dominantValue } = signal
  const dimLabel = DIMS.find(([key]) => key === dominant)?.[1] ?? ''
  if (level === 'low') {
    return `（状态）你这会儿${band.label}，${dimLabel && dominantValue >= 20 ? `主要是${dimLabel}` : '情绪有点沉'}。`
  }
  if (level === 'high') {
    return `（状态）你这会儿${band.label}，${dimLabel && dominantValue >= 25 ? `${dimLabel}味挺足` : '心情不错'}。`
  }
  return ''
}
