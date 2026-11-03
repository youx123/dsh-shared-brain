/**
 * 情绪 → 表情的亲和度表（阶段 B1）。
 *
 * 为什么要有这个文件
 * ──────────────────
 * 共享大脑原来的表情能力（`emoji.js`）只做一件事：把表情目录里的**名字**
 * 拼进提示词。模型看到一串名字，不知道该在什么心情下用哪个 —— 于是要么
 * 一个不用，要么胡用。心情低落的时候甩一个「庆祝」,比不说话还糟。
 *
 * dsh-emoji 那边已经有一套成熟的**语义协议**：40 个受控 key，模型只输出
 * Unicode 表情，宿主负责流式改写成图片。它解决的是「怎么渲染」，没解决
 * 「什么时候该用哪个」—— 那是情感模块的事，也就是这个文件。
 *
 * 所以这里**不重造渲染层**（决策见 2026-11-03 方案）：dsh-emoji 装了就由它
 * 渲染，没装就只是提示词里的一句建议。我们只负责"情绪 → key"的映射与禁忌。
 *
 * 契约：`dsh-emoji-core@1` 的 40 个 key。别自己发明 key。
 */

/** dsh-emoji-core@1 的 40 个语义 key（顺序照 EMOJI_KEYS.md）。 */
export const EMOJI_KEYS = Object.freeze([
  'happy',
  'sad',
  'confused',
  'watching',
  'angry',
  'speechless',
  'doge',
  'overloaded',
  'neutral',
  'laughing',
  'crying',
  'sweating',
  'thinking',
  'okay',
  'nodding',
  'sleeping',
  'hurt',
  'peeking',
  'approve',
  'heart',
  'shy',
  'star-eyes',
  'laugh-cry',
  'touched',
  'scared',
  'facepalm',
  'eye-roll',
  'sigh',
  'frustrated',
  'playful',
  'snickering',
  'sarcastic',
  'cool',
  'celebrate',
  'cheer',
  'thanks',
  'sorry',
  'hug',
  'please',
  'applause',
])

/** 每轮最多用几个表情（照 dsh-emoji 的档位）。 */
export const EMOJI_PER_TURN_LIMIT = Object.freeze({ off: 0, auto: 3, frequent: 4 })

/** 频率档位。 */
export const EMOJI_MODES = Object.freeze(['off', 'auto', 'frequent'])

/**
 * 情绪维度 → 表情倾向。
 *
 * `prefer` 是这个维度占主导时最贴合的几个；`avoid` 是明确不合适的。
 * 挑 key 的原则是「先像人，再像表情」：低落的人不会用 celebrate。
 */
export const DIM_EMOJI = Object.freeze({
  happy: { prefer: ['happy', 'laughing', 'star-eyes', 'cheer'], avoid: ['sad', 'crying', 'sigh'] },
  sweet: { prefer: ['heart', 'shy', 'touched', 'hug'], avoid: ['angry', 'eye-roll'] },
  calm: { prefer: ['neutral', 'nodding', 'okay'], avoid: ['overloaded', 'scared'] },
  worry: { prefer: ['sigh', 'please', 'thinking', 'peeking'], avoid: ['celebrate', 'cheer', 'applause', 'cool'] },
  sad: { prefer: ['sad', 'crying', 'sigh', 'hug'], avoid: ['celebrate', 'cheer', 'laughing', 'star-eyes', 'applause'] },
  heartache: { prefer: ['touched', 'hug', 'heart', 'please'], avoid: ['sarcastic', 'eye-roll', 'doge'] },
  jealous: { prefer: ['peeking', 'please', 'shy', 'sigh'], avoid: ['cool', 'celebrate'] },
})

/**
 * 心情档位 → 表情基调。
 *
 * 档位来自 `emotion.js` 的 `moodBand()`：delighted / happy / ok / heartache / sad。
 * `avoid` 是**硬禁忌**：这些 key 在这个档位下说出来会伤人。
 */
export const BAND_EMOJI = Object.freeze({
  delighted: {
    prefer: ['celebrate', 'star-eyes', 'cheer', 'applause', 'playful'],
    avoid: ['sad', 'crying', 'sigh', 'hurt'],
  },
  happy: {
    prefer: ['happy', 'laughing', 'nodding', 'approve', 'playful'],
    avoid: ['sad', 'crying', 'frustrated'],
  },
  ok: {
    prefer: ['neutral', 'okay', 'nodding', 'thinking', 'watching'],
    avoid: [],
  },
  heartache: {
    prefer: ['touched', 'hug', 'please', 'heart'],
    avoid: ['celebrate', 'cheer', 'applause', 'sarcastic', 'eye-roll', 'doge', 'laughing'],
  },
  sad: {
    prefer: ['sad', 'sigh', 'crying', 'hug', 'sorry'],
    avoid: ['celebrate', 'cheer', 'applause', 'laughing', 'star-eyes', 'cool', 'snickering', 'sarcastic'],
  },
})

/** 中性兜底（没有任何心情数据时）。 */
const NEUTRAL_PREFER = Object.freeze(['neutral', 'okay', 'nodding', 'thinking', 'happy'])

/** 语义化配置的默认值。 */
export const EMOJI_AFFINITY_DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'auto',
})

/** 判断一个字符串是不是合法的 dsh-emoji key。 */
export function isEmojiKey(key) {
  return typeof key === 'string' && EMOJI_KEYS.includes(key)
}

/** 规整配置（丢坏值，不抛）。 */
export function normalizeEmojiAffinity(raw, fallback = EMOJI_AFFINITY_DEFAULTS) {
  const base = fallback || EMOJI_AFFINITY_DEFAULTS
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled,
    mode: EMOJI_MODES.includes(source.mode) ? source.mode : base.mode,
  }
}

/** 取主导情绪维度（值最大的那个，太小就不算）。 */
function dominantDimOf(dims) {
  if (!dims || typeof dims !== 'object') return ''
  let key = ''
  let value = 0
  for (const [name, score] of Object.entries(dims)) {
    const num = Number(score)
    if (!Number.isFinite(num) || num <= value) continue
    key = name
    value = num
  }
  return value >= 20 ? key : ''
}

/**
 * 根据心情给一组可用的表情。
 *
 * @param {object} input
 * @param {object} [input.moodState] emotion.js 的心情状态
 * @param {object} [input.signal] proactive-mood.js 的 `readMoodSignal()` 结果（有就用它，省一次计算）
 * @param {object} [input.config] 语义化表情配置
 * @returns {{mode: string, limit: number, keys: string[], avoid: string[], mood: number, band: string, level: string, reason: string}}
 */
export function proposeEmoji(input = {}) {
  const config = normalizeEmojiAffinity(input.config)
  const signal = input.signal && typeof input.signal === 'object' ? input.signal : null
  const moodState = input.moodState && typeof input.moodState === 'object' ? input.moodState : null

  const mood = Number(signal?.mood ?? moodState?.mood ?? 70)
  const band = String(signal?.band?.key ?? signal?.band ?? bandKeyOf(mood))
  // 没有 signal 时（比如设置页预览）按档位自己推一层，否则低落到 28 分
  // 也会被说成「这会儿可以活泼一点」。
  const level = String(signal?.level ?? levelOfBand(band))
  const dims = signal?.dims ?? moodState?.dims ?? {}
  const dominant = String(signal?.dominant ?? '') || dominantDimOf(dims)

  if (!config.enabled || config.mode === 'off') {
    return {
      mode: 'off',
      limit: 0,
      keys: [],
      avoid: [],
      mood,
      band,
      level,
      reason: '表情提示已关闭',
    }
  }

  const bandRule = BAND_EMOJI[band] ?? BAND_EMOJI.ok
  const dimRule = DIM_EMOJI[dominant] ?? null

  const keys = []
  const push = (list) => {
    for (const key of list ?? []) {
      if (!isEmojiKey(key)) continue
      if (keys.includes(key)) continue
      keys.push(key)
    }
  }

  // 顺序很关键：先「这个人此刻的情绪」，再「这个档位的基调」。
  // 低落时主导维度往往是 worry/heartache，它的 prefer 比 band 的 prefer 更贴身。
  push(dimRule?.prefer)
  push(bandRule.prefer)
  push(NEUTRAL_PREFER)

  const avoid = []
  const pushAvoid = (list) => {
    for (const key of list ?? []) {
      if (!isEmojiKey(key)) continue
      if (avoid.includes(key)) continue
      avoid.push(key)
    }
  }
  pushAvoid(bandRule.avoid)
  pushAvoid(dimRule?.avoid)

  // 禁忌优先：prefer 里要是有被禁忌的，直接摘掉。
  // 心情低落时甩一个「庆祝」比不说话还糟。
  const allowed = keys.filter((key) => !avoid.includes(key))

  const limit = Math.min(
    EMOJI_PER_TURN_LIMIT[config.mode] ?? EMOJI_PER_TURN_LIMIT.auto,
    allowed.length,
  )

  return {
    mode: config.mode,
    limit,
    keys: allowed.slice(0, Math.max(limit, 4)),
    avoid,
    mood,
    band,
    level,
    reason: dimRule ? `主导情绪 ${dominant}` : '按心情档位',
  }
}

/** 档位 → 高低层（没拿到 signal 时用）。 */
function levelOfBand(band) {
  if (band === 'sad' || band === 'heartache') return 'low'
  if (band === 'delighted') return 'high'
  return 'neutral'
}

/** 没拿到 band 对象时按分数推一档（与 emotion.js 的 moodBand 阈值一致）。 */
function bandKeyOf(mood) {
  if (mood >= 80) return 'delighted'
  if (mood >= 62) return 'happy'
  if (mood >= 42) return 'ok'
  if (mood >= 25) return 'heartache'
  return 'sad'
}

/**
 * 把提案渲染成提示词里的一句话。
 *
 * 刻意写得像「建议」而不是「命令」：表情是锦上添花，不是每轮必交的作业。
 * 明确写出「低频」和「没有合适的就不放」—— 否则模型会每句都塞一个。
 */
export function renderEmojiHint(proposal) {
  if (!proposal || proposal.mode === 'off' || !proposal.limit) return ''
  const keys = (proposal.keys ?? []).slice(0, Math.max(3, proposal.limit))
  if (keys.length === 0) return ''
  const avoid = (proposal.avoid ?? []).filter((key) => isEmojiKey(key)).slice(0, 4)

  const head = proposal.level === 'low'
    ? '（表情）这会儿别用热闹的表情。'
    : proposal.level === 'high'
      ? '（表情）这会儿可以活泼一点。'
      : '（表情）有合适的就带一个，没有就算了。'

  const parts = [
    head,
    `可选：${keys.join(' / ')}。`,
  ]
  if (avoid.length) parts.push(`别用：${avoid.join(' / ')}。`)
  parts.push(`一轮最多 ${proposal.limit} 个，别每句都放，也别硬凑。`)
  return parts.join('')
}
