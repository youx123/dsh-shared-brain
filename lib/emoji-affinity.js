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

/**
 * 每个 key 适合什么时候用（2026-11-10）。
 *
 * 只给图、不给「什么场合用」，模型只能靠名字猜；给一句话，
 * 它挑的时候就有依据，不至于把「拿捏了」贴在一句安慰后面。
 */
export const EMOJI_USAGE = Object.freeze({
  happy: '顺心、想笑一下',
  sad: '心累、提不起劲',
  confused: '没看懂、要问一句',
  watching: '看戏、先不插嘴',
  angry: '真生气了',
  speechless: '无话可说',
  doge: '拿捏了、有点得意',
  overloaded: '扛不住、脑子烧了',
  neutral: '平淡接一句',
  laughing: '真被逗笑',
  crying: '裂开、绷不住',
  sweating: '心虚、要缓缓',
  thinking: '在想、琢磨',
  okay: '应下、没问题',
  nodding: '明白了、照办',
  sleeping: '困、想睡',
  hurt: '有点委屈',
  peeking: '吃瓜、偷看',
  approve: '认可、点赞',
  heart: '喜欢',
  shy: '不好意思',
  'star-eyes': '期待、眼馋',
  'laugh-cry': '笑到不行',
  touched: '被戳到了',
  scared: '有点慌',
  facepalm: '麻了、服了',
  'eye-roll': '嫌弃',
  sigh: '叹气、好累',
  frustrated: '上火',
  playful: '想逗一下',
  snickering: '偷乐、看热闹',
  sarcastic: '阴阳一句',
  cool: '稳了、满血',
  celebrate: '成了、恭喜',
  cheer: '打气、加油',
  thanks: '道谢',
  sorry: '道歉',
  hug: '安慰、抱一下',
  please: '求、拜托',
  applause: '辛苦、鼓掌',
})

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

/**
 * 语义线索 → 表情（2026-11-10）。
 *
 * 以前只按心情档位挑，档位一天不变，于是每轮都是同样的三张图，看着就假。
 * 这里按**这句话在说什么**补一层：刚修好一个 bug 和刚被报错卡住，
 * 该配的表情不一样。
 */
const CUE_EMOJI = Object.freeze([
  { test: /搞定|修好|做完|通过|跑通|上线|成了|成功/, keys: ['celebrate', 'approve', 'cool', 'cheer'] },
  { test: /谢谢|感谢|辛苦了|劳驾/, keys: ['thanks', 'applause', 'touched'] },
  { test: /哈哈|笑死|好笑|乐了|绷不住/, keys: ['laughing', 'snickering', 'laugh-cry', 'playful'] },
  { test: /累了|困了|熬夜|加班|顶不住|好累/, keys: ['sigh', 'sleeping', 'sweating'] },
  { test: /报错|失败|挂了|崩了|不行|又坏/, keys: ['facepalm', 'frustrated', 'speechless', 'sigh'] },
  { test: /头疼|麻烦|这个坑|好难|棘手/, keys: ['sigh', 'hurt', 'please', 'thinking'] },
  { test: /居然|没想到|厉害|牛啊|可以啊|漂亮/, keys: ['star-eyes', 'cool', 'approve'] },
  { test: /委屈|难过|伤心|想哭|emo/i, keys: ['hug', 'touched', 'sad', 'sorry'] },
  { test: /糟了|完了|坏了|紧张|不敢/, keys: ['sweating', 'scared', 'facepalm'] },
  { test: /冲|开工|开始干|上吧|走起/, keys: ['cheer', 'cool', 'nodding'] },
  { test: /[?？]\s*$/, keys: ['confused', 'thinking', 'peeking'] },
  { test: /等你|稍等|马上|这就来/, keys: ['nodding', 'okay', 'watching'] },
  // 2026-11-10 补：常见场景再多几档，别老是「开心/笑死/明白」三件套。
  { test: /服了|绝了|离大谱|离谱/, keys: ['facepalm', 'speechless', 'snickering', 'eye-roll'] },
  { test: /无语|醉了|无语了/, keys: ['speechless', 'eye-roll', 'neutral'] },
  { test: /生气|气死|火大|怒了/, keys: ['angry', 'frustrated', 'overloaded', 'facepalm'] },
  { test: /稳了|妥了|拿下|小意思/, keys: ['cool', 'doge', 'okay', 'approve'] },
  { test: /纠结|犹豫|想不好|拿不准/, keys: ['thinking', 'confused', 'peeking'] },
  { test: /围观|看戏|吃瓜|热闹/, keys: ['watching', 'peeking', 'snickering'] },
  { test: /抱歉|对不起|我的锅|误伤/, keys: ['sorry', 'hug', 'sweating'] },
  { test: /求你|拜托|帮个忙|帮帮我/, keys: ['please', 'shy', 'hug'] },
  { test: /可爱|好萌|萌死|乖巧/, keys: ['heart', 'shy', 'touched'] },
  { test: /想你|好久不见|好一阵没/, keys: ['heart', 'hug', 'peeking', 'touched'] },
  { test: /摸鱼|划水|偷懒|歇会/, keys: ['playful', 'snickering', 'sleeping'] },
  { test: /赶|deadline|来不及|通宵/i, keys: ['sweating', 'overloaded', 'sigh'] },
  { test: /期待|想看看|什么时候好/, keys: ['star-eyes', 'thinking', 'peeking'] },
  { test: /笑一个|逗你|开玩笑/, keys: ['playful', 'laughing', 'doge'] },
])

/** 一轮最多给几个候选（给模型挑，但真正能用的仍是 limit 个）。 */
export const EMOJI_OFFER_LIMIT = 6

/** 从这轮说的话里捞出贴题的 key（顺序按线索表）。 */
export function cueKeysOf(text) {
  const value = String(text ?? '')
  if (!value.trim()) return []
  const out = []
  for (const item of CUE_EMOJI) {
    if (!item.test.test(value)) continue
    for (const key of item.keys) {
      if (!out.includes(key)) out.push(key)
    }
  }
  return out
}

/**
 * 这句话的场合（2026-11-10）。
 *
 * 正经事（报错、部署、合同、方案）少放表情；闲聊（吃了吗、在吗、哈哈）可以多放。
 * 以前不看场合，技术汇报里也蹦一张「笑死」，很难看。
 */
const FORMAL_CUE = /报错|日志|配置|部署|接口|数据库|代码|方案|文档|合同|报价|期限|需求|测试|版本|发布|评审|汇报|预算|账号|权限/
const CASUAL_CUE = /哈哈|笑|吃了吗|在吗|早安|晚安|摸鱼|闲聊|无聊|累了|好烦|开心|想你/

export function toneOf(text) {
  const value = String(text ?? '')
  if (!value.trim()) return 'neutral'
  if (FORMAL_CUE.test(value)) return 'formal'
  if (CASUAL_CUE.test(value)) return 'casual'
  return 'neutral'
}


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

/**
 * 情绪维度的绝对下限（与 emotion.js 的 DIM_FLOOR 同一把尺）。
 *
 * 2026-11-12：七维名义量程是 0~100，但真值常年只有 0~5（每 90 分钟衰减
 * 一半，见 emotion.js 的 DIM_HALF_MINUTES）—— 以前这里写死「值 >= 20」
 * 是按名义量程拍的门槛，真实数据一个都够不到，于是「按主导情绪挑表情」
 * 这条规则一次都没生效过。
 */
const DIM_FLOOR = 2

/**
 * 取主导情绪维度（相对量纲）。
 *
 * 规则：先过绝对下限（低于 2 分不算「有这回事」），再要明显高过第二名
 * （相对量纲，不是写死的 20 分）。平手不算主导 —— 七维都一样高的时候，
 * 硬挑一个反而是在编。
 *
 * 这里不 import emotion.js（那个文件拖着 node:fs 一堆宿主依赖），规则
 * 跟 emotion.js 的 topMoodDims 保持一致。
 */
function dominantDimOf(dims) {
  if (!dims || typeof dims !== 'object') return ''
  const rows = []
  for (const [name, score] of Object.entries(dims)) {
    const num = Number(score)
    if (!Number.isFinite(num) || num <= 0) continue
    rows.push({ name, value: num })
  }
  if (!rows.length) return ''
  rows.sort((a, b) => b.value - a.value)
  const top = rows[0]
  if (top.value < DIM_FLOOR) return ''
  const second = rows[1]?.value ?? 0
  if (second > 0 && top.value <= second * 1.2) return ''
  return top.name
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
  // 2026-11-10：这轮在说什么、最近用过什么，都参与挑图 —— 不然档位不变，
  // 每轮都是同样三张，看着像复读。
  const cue = cueKeysOf(input.text)
  const recent = Array.isArray(input.recent) ? input.recent.filter((k) => isEmojiKey(k)) : []
  const turn = Number.isFinite(Number(input.turn)) ? Math.max(0, Math.floor(Number(input.turn))) : 0

  const keys = []
  const push = (list) => {
    for (const key of list ?? []) {
      if (!isEmojiKey(key)) continue
      if (keys.includes(key)) continue
      keys.push(key)
    }
  }

  // 顺序很关键：先「这句话在说什么」，再「这个人此刻的情绪」，最后「档位基调」。
  push(cue)
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

  // 轮转：贴题的、没用过的排前面；最近几轮给过的往后挪，
  // 除非这轮的话正好贴着它（贴题的不参与轮转）。
  const cueSet = new Set(cue.filter((key) => allowed.includes(key)))
  const fresh = allowed.filter((key) => !cueSet.has(key) && !recent.includes(key))
  const stale = allowed.filter((key) => !cueSet.has(key) && recent.includes(key))
  const rest = [...fresh, ...stale]
  const offset = rest.length > 0 ? turn % rest.length : 0
  const rotated = [...rest.slice(offset), ...rest.slice(0, offset)]
  const offered = []
  for (const key of [...cueSet, ...rotated]) {
    if (offered.includes(key)) continue
    offered.push(key)
  }

  const limit = Math.min(
    EMOJI_PER_TURN_LIMIT[config.mode] ?? EMOJI_PER_TURN_LIMIT.auto,
    offered.length,
  )
  // 2026-11-10：心情低的时候，一个就够。这时候堆三个表情反而像敷衍。
  // 正经事（部署、合同、报错）也压到一个，甚至不放。
  const tone = toneOf(input.text)
  let capped = level === 'low' ? Math.min(limit, 1) : limit
  if (tone === 'formal') capped = Math.min(capped, 1)

  return {
    mode: config.mode,
    limit: capped,
    keys: offered.slice(0, Math.max(capped, EMOJI_OFFER_LIMIT)),
    avoid,
    mood,
    band,
    level,
    tone,
    reason: cueSet.size > 0
      ? '按这句话的内容'
      : tone === 'formal'
        ? '正事，少放'
        : dimRule
          ? `主导情绪 ${dominant}`
          : '按心情档位',
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
  // 2026-11-10：候选跟图片保持一致（最多 6 个），真正用几个仍看 limit。
  const keys = (proposal.keys ?? []).slice(0, Math.max(3, EMOJI_OFFER_LIMIT))
  if (keys.length === 0) return ''
  const avoid = (proposal.avoid ?? []).filter((key) => isEmojiKey(key)).slice(0, 4)

  const head = proposal.level === 'low'
    ? '（表情）这会儿别用热闹的表情。'
    : proposal.level === 'high'
      ? '（表情）这会儿可以活泼一点。'
      : '（表情）有合适的就带一个，没有就算了。'

  const parts = [
    head,
    // 2026-11-10：每个 key 后面带一句「什么时候用」，光给名字它只会挑最眼熟的那个。
    `可选：${keys.map((key) => (EMOJI_USAGE[key] ? `${key}（${EMOJI_USAGE[key]}）` : key)).join(' / ')}。`,
  ]
  if (avoid.length) parts.push(`别用：${avoid.join(' / ')}。`)
  parts.push(`一轮最多 ${proposal.limit} 个，别每句都放，也别硬凑。`)
  return parts.join('')
}
