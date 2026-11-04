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

import { DIMS, moodBand, SENTIMENTS } from './emotion.js'

/** 情感极性：喜欢 +1、讨厌 −1、中性 0。 */
function polarityOf(sentiment) {
  const meta = SENTIMENTS[sentiment]
  return Number(meta?.polarity) || 0
}

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
 * 搭话的动机库（2026-11-03，P1-8 重写）。
 *
 * 以前这里是 10 条**写死的成品整句**，proactive.js 把它们原样拼进提示词，
 * 模型看到一句现成的「随便聊两句——今天过得怎么样？」，于是每次主动搭话
 * 都是同一句话的复制品。人不会这么说话。
 *
 * 现在每条只给两样东西：
 *   intent —— 这次想干什么（给模型定方向）
 *   hint   —— 一点提示素材（**不是模板**，不许照抄）
 * 具体怎么说，交给模型自己组织。
 *
 * `tone` 仍然是语气档位，会被翻译成 TONE_HINTS 里的一句话。
 */
export const TOPIC_LIBRARY = [
  { key: 'progress', tone: 'upbeat', intent: '问问之前那些活儿推进到哪了', hint: '要是有卡住的地方，问一句需不需要搭把手' },
  { key: 'pending', tone: 'neutral', intent: '提醒一下之前答应过、但还没做完的事', hint: '别催，就是提一句「还记着这件事」' },
  { key: 'curious', tone: 'light', intent: '对老大手上的项目表达好奇', hint: '可以问最近有没有新想法或新发现' },
  { key: 'checkin', tone: 'warm', intent: '随便关心一下今天的状况', hint: '不用问得很正式，像顺口一问' },
  { key: 'idea', tone: 'upbeat', intent: '说自己想到一个可能有用的点子', hint: '不用讲完，先问问要不要听' },
  { key: 'smalltalk', tone: 'light', intent: '没什么要紧事，就是想搭句话', hint: '可以说得随意一点，不用有目的' },
  { key: 'weather', tone: 'light', intent: '找个轻松的话题起个头', hint: '天气、季节、时间都行，别太刻意' },
  { key: 'concern', tone: 'soft', intent: '察觉到老大最近可能有点累', hint: '别说教，也别追问到底发生了什么' },
  { key: 'proud', tone: 'warm', intent: '夸一句之前那几件事做得漂亮', hint: '具体一点，别泛泛地说「你真厉害」' },
  { key: 'question', tone: 'neutral', intent: '问一件能让老大思考一下的小事', hint: '关于手上这些事，问一个具体的取舍' },
]

/** 低落时额外能用的关心型话题。 */
export const CONCERN_TOPICS = [
  { key: 'concern-soft', tone: 'soft', intent: '关心一下老大最近的状态', hint: '是累还是事情多？想说就说，不想说也没事' },
  { key: 'concern-space', tone: 'soft', intent: '让老大知道不催他', hint: '可以主动提出帮忙把待办理一理' },
]

/** 心情好时能用的分享型话题。 */
export const SHARE_TOPICS = [
  { key: 'share-win', tone: 'upbeat', intent: '分享一个自己觉得不错的主意', hint: '带点小得意，但别自夸过头' },
  { key: 'share-tease', tone: 'warm', intent: '说有一件事想讲给老大听', hint: '留个钩子，等老大方便的时候再说' },
]

/**
 * 把话题渲染成给模型看的一行提示（P1-8）。
 *
 * 刻意写成「这次想聊的：<意图>（<素材>）」而不是一句成品话 ——
 * 模型看到的是方向，不是台词，才会用自己的话说。
 */
export function renderTopic(topic) {
  if (!topic) return ''
  const intent = String(topic.intent ?? '').trim()
  const hint = String(topic.hint ?? '').trim()
  if (!intent && !hint) return ''
  const body = intent && hint ? `${intent}（${hint}）` : intent || hint
  return `（这次想聊的：${body}）`
}

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
/**
 * 把召回到的情感条目折算成一个「对老大的态度偏向」。
 *
 * 2026-11-04（E2 / 审计 P1-8）：情感记忆以前没有下游 ——
 * intimacy/sentiment/target 只影响召回排序和括号里的一行注释，
 * 「记住老大讨厌啰嗦」和「记住老大讨厌啰嗦但亲密度 0.9」对行为完全一样。
 * 现在按极性 × 亲密度累加出一个偏向值，负向到一定程度就把 level 判低
 * （于是主动搭话改用更 soft 的调子、来得更勤）。
 *
 * @param {Array} emotions 情感条目（memory.json 或 modules 里 emotion 模块的）
 * @returns {{ bias: number, hits: number }}
 */
export function emotionBiasOf(emotions = []) {
  let bias = 0
  let hits = 0
  for (const item of Array.isArray(emotions) ? emotions : []) {
    if (!item || typeof item !== 'object') continue
    // 只认「对老大」或「不限定对象」的 —— 对别的东西的好恶不该影响对老大说话
    const target = item.target
    if (target && target !== 'general' && target !== 'owner' && target !== '老大') continue
    const polarity = polarityOf(item.sentiment)
    if (polarity === 0) continue
    const intimacy = Number.isFinite(item.intimacy)
      ? Number(item.intimacy)
      : Number.isFinite(item.weight)
        ? Number(item.weight)
        : 0.5
    bias += polarity * intimacy
    hits += 1
  }
  return { bias, hits }
}

export function readMoodSignal(moodState, config = PROACTIVE_MOOD_DEFAULTS, emotions = []) {
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

  // 2026-11-03（P1-5）：关掉「按心情说话」= 不用心情决定语气，
  // 不是「连心情数据都不读」。心情数据照读（band/dims 都在），
  // 只是 level 一律中性 —— 别因为关了开关就退化成「读不到心情」。
  let level = 'neutral'
  if (cfg.enabled !== false) {
    if (mood < cfg.lowMood) level = 'low'
    else if (mood >= cfg.highMood) level = 'high'
    // 心情分不低但情绪维度压倒性地是担心/难过 —— 也算低落。
    // 「嘴上说没事，心里有事」是常态，只看 mood 分会漏掉。
    else if (dominantValue >= 25 && LOW_DIMS.has(dominant)) level = 'low'
    else if (dominantValue >= 30 && HIGH_DIMS.has(dominant)) level = 'high'
  }

  // 2026-11-04（E2）：情感记忆接进行为。
  // 对老大的负向情感（讨厌/不悦/担心）累积到 -0.9 以上 → 判低落，
  // 主动搭话改用 soft 调子。正向情感不改 level（本来就不该因为「关系好」
  // 就更亢奋），只记在 emotionBias 里供渲染用。
  const { bias: emotionBias, hits: emotionHits } = emotionBiasOf(emotions)
  if (cfg.enabled !== false && level === 'neutral' && emotionBias <= -0.9) {
    level = 'low'
  }

  return {
    band,
    mood,
    dominant,
    dominantValue,
    level,
    dims,
    emotionBias,
    emotionHits,
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
  const chosen = leastUsed[index]
  // 兼容字段：老代码和老测试还在读 topic.text。
  // 新逻辑请用 renderTopic(topic)，别直接拼 text —— text 只是素材，不是台词。
  return chosen ? { ...chosen, text: chosen.hint || chosen.intent || '' } : null
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
  // E2：把召回到的情感条目一起交给信号层（不传就是空数组，行为不变）
  const signal = readMoodSignal(config.enabled ? input.moodState : null, config, input.emotions ?? [])

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
  // 2026-11-04（P1-10）：有真待办时不走「均匀铺开」。
  // 上面第 3 条的注释写的就是「额度内优先说它」—— 可均匀间隔把
  // 「答应过的事」压到 4.7 小时一轮（3 次/天铺满 14 小时），
  // 比不提醒更容易忘。这里让它跳过 paced，但仍然受 maxPerDay 硬上限约束：
  // 最坏情况一天 3 次，不会回到 0.9.7 之前「一天 57 遍」那档。
  if (!exempt && pending.length === 0 && config.maxPerDay > 0) {
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
