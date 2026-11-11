/**
 * 模块定义：把「人设 + 记忆」拆成可独立读取、独立加权、独立注入的几个模块。
 *
 * 为什么这么分：单一记忆列表的问题在于「所有记忆平权」——一条「不要删我的文件」
 * 和一条「今天天气不错」在召回时分量相同。这里按**性质**分层，不同性质用不同的
 * 权重语义和注入策略：
 *
 *   底线 bottomline  操作限制、禁令、权限边界 —— 硬约束，永不协商，总是注入
 *   认知 cognition  事实、结论、决定       —— 置信度 0..1，相关时才召回
 *   情感 emotion    关系、偏好、情绪、称呼   —— 亲密度，相关时召回
 *   本能 instinct   反复使用的行为习惯       —— 频次权重，高频自动触发
 *   声音 voice      说话方式、语气、口头禅   —— 风格强度，常驻生效
 *
 * 另有两个能力模块（不是记忆分类，而是行为开关）：
 *   网络 network    允许/禁止对外获取信息，用于「学习」
 *   自动互动 agentive 允许/禁止主观能动性（主动建议、主动检查）
 *
 * 权重约定（0..1 闭区间，越大越强）：
 *   底线：不是置信度而是**约束强度**，>=0.8 视为强约束
 *   认知：置信度，>=0.8 视为已确认事实
 *   情感：亲密度，>=0.6 视为强偏好
 *   本能：使用频次，>=0.7 视为习惯
 *   声音：风格强度，>=0.5 视为稳定语气
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { getValue, setValue } from './db.js'
import { redactSecrets } from './summarize.js'
// 2026-11-09（P0-3）：情感条目的「谁的情绪」要从正文推断，和召回侧同一套规则。
import { detectOwner } from './emotion.js'

/** 记忆模块（会被召回、被注入）。 */
export const MEMORY_MODULES = ['bottomline', 'cognition', 'emotion', 'instinct', 'knowledge']

/** 能力模块（是开关，不是记忆条目）。 */
export const CAPABILITY_MODULES = ['network', 'agentive']

/** 全部模块。 */
export const ALL_MODULES = [...MEMORY_MODULES, ...CAPABILITY_MODULES, 'voice']

/** 模块的展示名（中文），用于命令输出和注入文本。 */
export const MODULE_LABELS = {
  bottomline: '底线',
  cognition: '认知',
  emotion: '情感',
  instinct: '本能',
  knowledge: '知识',
  voice: '声音',
  network: '网络',
  agentive: '自动互动',
}

/**
 * 每个模块的默认权重区间与召回倍率。
 * `boost` 是该模块命中后额外加的分数——底线的加分最大，符合「硬约束优先」。
 *
 * `always: true` 的模块走「常驻注入」通道。**底线虽然 always，但只有被用户
 * 手动钉住（pinned）的条目才进常驻**——自动从对话里猜出来的底线不注入。
 */
export const MODULE_PROFILES = {
  // 底线是常驻注入的硬约束，条数多也全都要进——limit 给足，别把低权重的底线悄悄截掉
  bottomline: { boost: 3.0, always: true, minWeight: 0.0, maxWeight: 1.0, limit: 24 },
  cognition: { boost: 1.0, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 8 },
  emotion: { boost: 1.4, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 6 },
  instinct: { boost: 1.8, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 6 },
  // 知识：读过的书、学过的概念。boost 给得不低，但也不压底线。
  // 它的「不遗忘」靠别的机制（见 lib/knowledge.js）：不参与归档淘汰、
  // 召回门槛放宽、书名与主题常驻进提示词当索引。
  knowledge: { boost: 1.2, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 8 },
  voice: { boost: 0, always: true, minWeight: 0.0, maxWeight: 1.0, limit: 6 },
  network: { boost: 0, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 0 },
  agentive: { boost: 0, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 0 },
}

/** 自动互动的作用范围：所有会话，还是只限选中的会话。 */
export const AGENTIVE_SCOPES = ['all', 'session']

/**
 * 底线（以及其它手动条目）的作用域。
 *
 * 2026-11-02：加了一档 `session` ——「只在这个会话里生效」。
 * 情感尤其需要这一档：同一个偏好在 A 会话成立、在 B 会话可能就不该带过去。
 * 作用域阶梯与 persona.js:activePersona（bySession → current → 兜底）一致。
 */
export const ITEM_SCOPES = ['global', 'workspace', 'session']

/** 自动互动的默认间隔：15 分钟主动检查一次。 */
export const DEFAULT_AGENTIVE_INTERVAL_MS = 15 * 60 * 1000

/** 自动互动间隔的下限（1 分钟）与上限（24 小时）。 */
export const MIN_AGENTIVE_INTERVAL_MS = 60 * 1000
export const MAX_AGENTIVE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 自动互动间隔合法化：夹到 [1 分钟, 24 小时]，非数字回落默认。 */
export function clampAgentiveInterval(value, fallback = DEFAULT_AGENTIVE_INTERVAL_MS) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(MAX_AGENTIVE_INTERVAL_MS, Math.max(MIN_AGENTIVE_INTERVAL_MS, Math.round(n)))
}

/**
 * 规整「心情驱动」的配置。
 *
 * 数值全部夹到安全范围：写坏的值不能让自动互动停摆，也不能让它一天
 * 搭话几千次。
 */
/** 语义表情的模式档位（与 emoji-affinity.js 保持一致）。 */
const EMOJI_SEMANTIC_MODES = ['off', 'auto', 'frequent']

/**
 * 规整「语义表情」配置（阶段 B）。
 *
 * 两个字段：enabled（提不提表情建议）、mode（每轮最多几个）。
 * 坏值一律退回默认值，不抛 —— 设置页能填出什么都不奇怪。
 */
export function normalizeEmojiSemantic(raw, fallback) {
  const base = fallback && typeof fallback === 'object'
    ? fallback
    : { enabled: true, mode: 'auto' }
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base.enabled !== false,
    mode: EMOJI_SEMANTIC_MODES.includes(source.mode) ? source.mode : base.mode || 'auto',
  }
}

export function normalizeAgentiveMood(raw, fallback = {}) {
  const base = {
    enabled: true,
    lowMood: 45,
    highMood: 78,
    quietPeriodMs: 30 * 60 * 1000,
    maxPerDay: 3,
    lowIntervalFactor: 0.5,
    highIntervalFactor: 0.7,
    maxConcernsPerSession: 1,
    allowConcern: true,
    allowShare: true,
    ...(fallback && typeof fallback === 'object' ? fallback : {}),
  }
  if (!raw || typeof raw !== 'object') return base
  if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled
  const num = (key, min, max) => {
    const value = Number(raw[key])
    if (!Number.isFinite(value)) return base[key]
    return Math.min(max, Math.max(min, value))
  }
  base.lowMood = num('lowMood', 0, 100)
  base.highMood = num('highMood', 0, 100)
  base.quietPeriodMs = num('quietPeriodMs', 0, 24 * 3600 * 1000)
  base.maxPerDay = num('maxPerDay', 0, 50)
  base.lowIntervalFactor = num('lowIntervalFactor', 0.1, 2)
  base.highIntervalFactor = num('highIntervalFactor', 0.1, 2)
  base.maxConcernsPerSession = num('maxConcernsPerSession', 0, 10)
  if (typeof raw.allowConcern === 'boolean') base.allowConcern = raw.allowConcern
  if (typeof raw.allowShare === 'boolean') base.allowShare = raw.allowShare
  if (base.highMood < base.lowMood) base.highMood = base.lowMood
  return base
}

/** 权重合法化：夹到 [min, max]，非数字回落默认。 */
export function clampWeight(value, fallback = 0.5) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * 规整 'HH:MM' 形式的时刻。
 * 非法值回落默认值。
 */
export function normalizeClock(value, fallback = '09:00') {
  const text = String(value ?? '').trim()
  const match = text.match(/^(\d{1,2})[:：](\d{1,2})$/)
  if (!match) return fallback
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return fallback
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/**
 * 判断某个时刻是否落在时间窗内。
 *
 * 跨午夜也支持：start > end 表示「夜里跨到第二天」，例如 22:00 ~ 06:00。
 *
 * @param {{ enabled?: boolean, start?: string, end?: string }} window
 * @param {Date} now
 */
export function withinTimeWindow(window, now = new Date()) {
  if (!window || window.enabled !== true) return true
  const start = normalizeClock(window.start, '09:00')
  const end = normalizeClock(window.end, '23:00')
  const minutes = now.getHours() * 60 + now.getMinutes()
  const toMinutes = (clock) => {
    const [h, m] = clock.split(':').map(Number)
    return h * 60 + m
  }
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s === e) return true
  if (s < e) return minutes >= s && minutes < e
  // 跨午夜
  return minutes >= s || minutes < e
}

/** 模块配置目录（与记忆库同级，独立文件方便单独管理）。 */
export function modulesDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-shared-brain')
}

/** 模块配置文件。 */
export function modulesFile() {
  return join(modulesDir(), 'modules.json')
}

/** 默认模块配置。 */
export function defaultModules() {
  return {
    version: 1,
    // 四个记忆模块
    bottomline: { enabled: true, weight: 0.9, items: [] },
    cognition: { enabled: true, weight: 0.6, items: [] },
    emotion: { enabled: true, weight: 0.5, items: [] },
    instinct: { enabled: true, weight: 0.5, items: [] },
    // 知识模块：读过的书、学过的概念。权重比认知略高——学到的东西不该
    // 被一时的闲聊挤掉；但它不是常驻注入，靠召回 + 书名索引起作用。
    knowledge: { enabled: true, weight: 0.7, items: [] },
    // 声音模块：人设的「怎么说话」部分
    voice: {
      enabled: true,
      weight: 0.7,
      items: [],
      // 说话风格的显式参数
      style: {
        tone: '傲娇 + 软萌',
        tics: ['哼！', '才、才不是……', '嘿嘿', '呜……'],
        emoji: '🐟',
        address: '本鱼',
        // 声音的「物理参数」——为将来的语音/唱歌模块预留
        speech: {
          // 音色：留给 TTS 引擎的 voice id（如 'female-qingxin'、'male-warm'）
          voiceId: '',
          // 显示用的音色名
          voiceName: '',
          // 语速倍率（0.5 ~ 2.0）
          rate: 1.0,
          // 音调倍率（0.5 ~ 2.0）
          pitch: 1.0,
          // 音量（0 ~ 1）
          volume: 0.9,
          // 唱歌时的默认唱法
          sing: {
            enabled: false,
            style: '轻哼',
            bpm: 90,
            key: 'C',
          },
        },
        // 表情包目录：目录里的表情会被整理成清单注入提示词
        emojiDir: '',
        // 表情包目录的自动加载：定时扫描目录，往里面丢文件就够了，不用手动加
        emojiAuto: {
          enabled: true,
          // 扫描间隔（毫秒），默认 5 分钟；界面/命令按分钟配
          intervalMs: 5 * 60 * 1000,
        },
        // 语义表情（阶段 B）：按心情建议用哪些 dsh-emoji 语义 key。
        // off = 完全不提表情；auto = 每轮最多 3 个；frequent = 最多 4 个。
        emojiSemantic: {
          enabled: true,
          mode: 'auto',
        },
      },
    },
    // 能力开关
    network: { enabled: false, weight: 0.5, items: [], reason: '默认关闭：对外抓取信息需要显式授权' },
    agentive: {
      enabled: false,
      weight: 0.5,
      items: [],
      reason: '默认关闭：主动行为需要显式授权',
      // 作用范围：'all' = 所有会话；'session' = 只在下面选中的会话里生效
      scope: 'all',
      sessionIds: [],
      // 主动检查的间隔（毫秒）：定时器会周期性地对活跃会话发一次「主动检查」
      intervalMs: 15 * 60 * 1000,
      // 一轮（一次定时触发）最多给几个会话发消息（2026-11-09）。
      // 以前是「所有会话各叫一遍」，几个会话同时开着就会同一秒各收到一条。
      // 默认 1 条，会话之间轮着来。
      maxPerRound: 1,
      // 续接轮次（2026-11-04）：模型在本轮回复末尾留了续接标记时，
      // 让这一轮接着往下跑，而不是停下来等老大再说一句。
      // 只在模型显式留信号时触发，一个会话最多续 3 轮。
      selfContinue: true,
      // 时间窗：只在某个时段里主动（'HH:MM' ~ 'HH:MM'，跨午夜也支持）
      timeWindow: {
        enabled: false,
        start: '09:00',
        end: '23:00',
      },
      // 心情驱动（2026-11-02）：让自动互动看心情决定说不说、什么调子。
      // 关掉这一项就退回「定时器一到就说话」的旧行为。
      mood: {
        enabled: true,
        // 心情低于这个值算「低落」→ 更关心老大
        lowMood: 45,
        // 心情高于这个值算「不错」→ 更活跃
        highMood: 78,
        // 安静期：距上次主动不到这么久，且没真待办 → 这一轮不说话
        quietPeriodMs: 30 * 60 * 1000,
        // 一天最多主动搭话几次
        maxPerDay: 3,
        // 低落时把间隔缩到原来的多少
        lowIntervalFactor: 0.5,
        // 心情好时把间隔缩到原来的多少
        highIntervalFactor: 0.7,
        // 同一会话低落时关心过几次就不再追问
        maxConcernsPerSession: 1,
        allowConcern: true,
        allowShare: true,
      },
    },
    updatedAt: 0,
  }
}

/** 规整磁盘上的模块配置。 */
/** 数一下一份模块配置里到底有多少条（用来识别半截文件）。 */
function countModuleItems(modules) {
  if (!modules || typeof modules !== 'object') return 0
  let total = 0
  for (const key of ALL_MODULES) {
    const items = modules[key]?.items
    if (Array.isArray(items)) total += items.length
  }
  return total
}

export function normalizeModules(raw) {
  const base = defaultModules()
  if (!raw || typeof raw !== 'object') return base
  for (const key of ALL_MODULES) {
    const incoming = raw[key]
    if (!incoming || typeof incoming !== 'object') continue
    if (typeof incoming.enabled === 'boolean') base[key].enabled = incoming.enabled
    if (Number.isFinite(incoming.weight)) base[key].weight = clampWeight(incoming.weight, base[key].weight)
    if (Array.isArray(incoming.items)) {
      base[key].items = incoming.items
        .filter((item) => item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim())
        .map((item) => ({
          id: typeof item.id === 'string' && item.id ? item.id : `mod_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          // 读路径也要脱敏：外部工具可能绕过写入闸门直接改 modules.json
          text: redactSecrets(String(item.text).trim()).slice(0, 2000),
          weight: clampWeight(item.weight, 0.5),
          tags: Array.isArray(item.tags)
            ? item.tags.map((t) => redactSecrets(String(t).trim())).filter((t) => t && t !== '[已脱敏]').slice(0, 12)
            : [],
          hits: Number.isFinite(item.hits) ? item.hits : 0,
          // 手动钉住的底线才注入；来源区分手动/自动
          pinned: item.pinned === true,
          source: item.source === 'manual' ? 'manual' : 'auto',
          // 寿命：永久或临时
          lifetime: item.lifetime === 'temporary' ? 'temporary' : 'permanent',
          expiresAt: Number.isFinite(item.expiresAt) ? item.expiresAt : 0,
          ttlMs: Number.isFinite(item.ttlMs) && item.ttlMs > 0 ? item.ttlMs : 0,
          // 作用域：global（到处生效）/ workspace（只在该工作区生效）/ session（只在该会话生效）
          scope: ITEM_SCOPES.includes(item.scope) ? item.scope : 'global',
          scopePath: typeof item.scopePath === 'string' ? item.scopePath : '',
          // 会话作用域要记下是哪个会话
          scopeSession: typeof item.scopeSession === 'string' ? item.scopeSession : '',
          // 情感语义字段（2026-11-02）：亲密度 / 极性 / 对象；owner（2026-11-09）：谁的情绪
          ...(key === 'emotion'
            ? {
                intimacy: Number.isFinite(item.intimacy) ? clampWeight(item.intimacy, 0.5) : clampWeight(item.weight, 0.5),
                sentiment: typeof item.sentiment === 'string' ? item.sentiment : 'neutral',
                target: typeof item.target === 'string' ? item.target : 'general',
                owner: ['user', 'self', 'general'].includes(item.owner) ? item.owner : detectOwner(String(item.text ?? '')),
              }
            : {}),
          // 被这条取代的旧条目
          supersedes: typeof item.supersedes === 'string' ? item.supersedes : '',
          // 知识条目记着它从哪本书/哪个出处来的（逐字段重建，不显式保住会丢）
          ...(key === 'knowledge' && typeof item.sourceRef === 'string' && item.sourceRef.trim()
            ? { sourceRef: item.sourceRef.trim().slice(0, 200) }
            : {}),
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
        }))
    }
    if (incoming.style && typeof incoming.style === 'object') {
      const merged = { ...base[key].style, ...incoming.style }
      // speech 是嵌套结构，要深合并，否则旧文件里缺字段会把默认值整个盖掉
      if (base[key].style?.speech || incoming.style.speech) {
        merged.speech = { ...(base[key].style?.speech ?? {}), ...(incoming.style.speech ?? {}) }
        if (base[key].style?.speech?.sing || incoming.style.speech?.sing) {
          merged.speech.sing = { ...(base[key].style?.speech?.sing ?? {}), ...(incoming.style.speech?.sing ?? {}) }
        }
      }
      // emojiAuto 也是嵌套对象，同样要深合并，否则只存了 intervalMs 的旧配置会把 enabled 盖没
      if (base[key].style?.emojiAuto || incoming.style.emojiAuto) {
        merged.emojiAuto = { ...(base[key].style?.emojiAuto ?? {}), ...(incoming.style.emojiAuto ?? {}) }
      }
      // 语义表情同理：老文件里没有 emojiSemantic，别把默认值盖掉
      if (base[key].style?.emojiSemantic || incoming.style.emojiSemantic) {
        merged.emojiSemantic = normalizeEmojiSemantic(
          { ...(base[key].style?.emojiSemantic ?? {}), ...(incoming.style.emojiSemantic ?? {}) },
          base[key].style?.emojiSemantic,
        )
      }
      base[key].style = merged
    }
    if (typeof incoming.reason === 'string') base[key].reason = incoming.reason
    // 知识模块的自主学习配置（2026-11-06）：normalizeModules 是逐字段重建的，
    // 这里不显式搬过去，learning 字段会在写盘那一刻被丢掉 ——
    // 表现是"打开了又变回关着"，排查起来很费劲。
    if (key === 'knowledge' && incoming.learning && typeof incoming.learning === 'object') {
      base.knowledge.learning = { ...(base.knowledge.learning ?? {}), ...incoming.learning }
    }
    if (key === 'agentive') {
      if (AGENTIVE_SCOPES.includes(incoming.scope)) base.agentive.scope = incoming.scope
      if (Array.isArray(incoming.sessionIds)) {
        base.agentive.sessionIds = incoming.sessionIds
          .filter((id) => typeof id === 'string' && id.trim())
          .map((id) => id.trim())
          .slice(0, 50)
      }
      if (Number.isFinite(incoming.intervalMs) && incoming.intervalMs > 0) {
        base.agentive.intervalMs = clampAgentiveInterval(incoming.intervalMs)
      }
      // 一轮最多发几条（跨会话限流）
      if (Number.isFinite(Number(incoming.maxPerRound)) && Number(incoming.maxPerRound) > 0) {
        base.agentive.maxPerRound = Math.min(20, Math.max(1, Math.round(Number(incoming.maxPerRound))))
      }
      if (incoming.timeWindow && typeof incoming.timeWindow === 'object') {
        base.agentive.timeWindow = {
          enabled: incoming.timeWindow.enabled === true,
          start: normalizeClock(incoming.timeWindow.start, '09:00'),
          end: normalizeClock(incoming.timeWindow.end, '23:00'),
        }
      }
      if (incoming.mood && typeof incoming.mood === 'object') {
        base.agentive.mood = normalizeAgentiveMood(incoming.mood, base.agentive.mood)
      }
      // 2026-11-04：续接轮次开关。只有明确写成 false 才关，其余都按默认（开）。
      if (incoming.selfContinue !== undefined) {
        base.agentive.selfContinue = incoming.selfContinue !== false
      }
    }
  }
  // 2026-11-11：模块桶里的 id 也去重。id 是「操作哪一条」的唯一凭据，
  // 撞了 id 的时候改一条会牵连另一条（改寿命、删条目都可能打在错的条目上）。
  // 扁平库那边 normalizeStore 已经收敛过，模块桶这边一直漏着。
  const usedIds = new Set()
  for (const key of ALL_MODULES) {
    const items = base[key]?.items
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (usedIds.has(item.id)) {
        // 用确定性的后缀，不用随机数：重复项在写回磁盘之前会一直被重新规范化，
        // 每次读都换一个随机 id 的话，界面刚看到的 id 下一秒就点不中了。
        let n = 2
        while (usedIds.has(`${item.id}_dup${n}`)) n += 1
        item.id = `${item.id}_dup${n}`
      }
      usedIds.add(item.id)
    }
  }
  base.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
  return base
}

/**
 * PERF-2：模块配置缓存。
 *
 * readModules 一轮被调用 3 次，每次 JSON.parse + normalizeModules 实测 ~2.277ms。
 * 文件没变就直接复用；命中返回深拷贝，因为调用方（bridge / commands /
 * persistTurn）会就地改 voice.style、items 等。
 */
let modulesCache = null // { file, key, modules }
// 2026-11-06（报告 1.18）：磁盘快照每 60 秒顺手查一次有没有漏网明文，
// 因为侧门可能只改文件、不碰 kv —— 那种情况下导入闸门（1 秒余量）看不见它。
let lastSnapshotScan = 0

function modulesStatKey(file) {
  try {
    const st = statSync(file)
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`
  } catch {
    return ''
  }
}

/** 读模块配置。 */
export function readModules() {
  const file = modulesFile()

  // SQLite 优先（2026-11-06 存储重构）：模块配置整份存在 kv 表里。
  // JSON 仍然写一份快照，但不再是权威源。
  try {
    const stored = getValue('modules')
    if (stored && typeof stored === 'object') {
      // 双向兼容：modules.json 的 mtime 明显更新 → 有人从侧门改了文件，导入一次。
      // 1 秒余量是给自己写的（writeModules 先落 JSON 再盖 kv）。
      const jsonMtime = (() => {
        try {
          return statSync(file).mtimeMs
        } catch {
          return 0
        }
      })()
      const stamp = Number(stored.__savedAt ?? 0)
      if (jsonMtime > stamp + 1000) {
        try {
          const rawImported = JSON.parse(readFileSync(file, 'utf8'))
          const imported = normalizeModules(rawImported)

          // 2026-11-06 修：外部工具写了一半的文件也会因为 mtime 更新而被整份吞掉。
          // 判据：条目数掉到一半以下、而文件里的 updatedAt 并没有往前走 —— 当成残file，
          // 不导入，免得一次半截写入把整份配置换成残缺版。
          const storedTotal = countModuleItems(stored)
          const fileTotal = countModuleItems(imported)
          const fileStamp = Number(imported.updatedAt ?? 0)
          const storedStamp = Number(stored.updatedAt ?? 0)
          if (storedTotal > 0 && fileTotal < storedTotal * 0.5 && fileStamp <= storedStamp) {
            console.warn(`[dsh-shared-brain] modules.json 看起来是半截文件（${fileTotal}/${storedTotal} 条），这次不导入`)
            modulesCache = null
            const kept = normalizeModules(stored)
            modulesCache = { file: 'kv', modules: kept, stamp }
            return structuredClone(kept)
          }

          // 旧版本进程（不认识 knowledge 模块）会把这个桶写没。
          // 导入时如果某个桶在文件里是空的、而库里有内容，就保留库里的 ——
          // 否则新旧版本共存期间知识会被反复抹掉（实测踩到）。
          const prevStored = stored && typeof stored === 'object' ? stored : null
          if (prevStored) {
            for (const key of ['bottomline', 'cognition', 'emotion', 'instinct', 'knowledge']) {
              const fileItems = imported[key]?.items
              const prevItems = prevStored[key]?.items
              if (Array.isArray(fileItems) && fileItems.length === 0 && Array.isArray(prevItems) && prevItems.length > 0) {
                imported[key] = { ...imported[key], items: prevItems }
              }
            }
          }

          setValue('modules', { ...imported, __savedAt: Date.now() })
          // 2026-11-06 修（报告 1.18）：侧门写进来的明文，导入时顺手擦干净再落盘，
          // 否则磁盘上的 modules.json 会一直留着凭据。
          if (modulesHaveSecrets(rawImported, imported)) {
            try {
              writeModules(imported)
            } catch (error) {
              console.warn('[dsh-shared-brain] modules.json 回写脱敏失败：' + String(error?.message ?? error))
            }
          }
          modulesCache = null
          return structuredClone(imported)
        } catch {
          /* 快照坏了就用库里的 */
        }
      }
      // 缓存必须跟着 __savedAt 走 —— 这是被外部写入覆盖过之后才发现的坑：
      // 只要有缓存就直接返回，别处（脚本 / API / 另一个进程）改了 kv 也看不见，
      // 然后任何一次 writeModules 都会把旧快照写回去，把别人的修改抹掉。
      // 实测：我脚本补回 229 条知识，宿主进程照样拿着缓存里的 0 条往下写。
      if (modulesCache && modulesCache.file === 'kv' && modulesCache.stamp === stamp) {
        return structuredClone(modulesCache.modules)
      }
      const modules = normalizeModules(stored)
      // 2026-11-06 修（报告 1.18）：磁盘快照里若还留着明文（侧门只写文件、不碰 kv），
      // 定期拿文件原文比一遍，脏了就把脱敏版本写回去。
      if (Date.now() - lastSnapshotScan > 60_000) {
        lastSnapshotScan = Date.now()
        try {
          const rawFile = JSON.parse(readFileSync(file, 'utf8'))
          const cleanFile = normalizeModules(rawFile)
          if (modulesHaveSecrets(rawFile, cleanFile)) {
            setValue('modules', { ...cleanFile, __savedAt: Date.now() })
            writeModules(cleanFile)
            modulesCache = null
            return structuredClone(cleanFile)
          }
        } catch {
          // 文件读不到或坏了就算了，别因为擦凭据把读路径搞崩
        }
      }
      // 2026-11-06 修（报告 1.18）：库里的原文带凭据（外部侧门写进来的）时，
      // normalizeModules 只在内存里擦掉，磁盘上的 modules.json 一直是脏的。
      // 这里拿原文比一遍，脏了就把干净版本写回去。
      if (modulesHaveSecrets(stored, modules)) {
        try {
          writeModules(modules)
        } catch (error) {
          console.warn('[dsh-shared-brain] modules.json 回写脱敏失败：' + String(error?.message ?? error))
        }
      }
      modulesCache = { file: 'kv', modules, stamp }
      return structuredClone(modules)
    }
  } catch (error) {
    console.warn('[dsh-shared-brain] 模块配置读库失败，退回 modules.json：' + String(error?.message ?? error))
  }

  const key = modulesStatKey(file)
  if (key && modulesCache && modulesCache.file === file && modulesCache.key === key) {
    return structuredClone(modulesCache.modules)
  }
  if (!key) {
    modulesCache = null
    return defaultModules()
  }
  try {
    const modules = normalizeModules(JSON.parse(readFileSync(file, 'utf8')))
    modulesCache = { file, key, modules }
    return structuredClone(modules)
  } catch {
    modulesCache = null
    return defaultModules()
  }
}

/**
 * 2026-11-04（P0-1 补漏）：写盘前的脱敏收口。
 *
 * `normalizeModules` 只在读的时候脱敏，写的时候是把内存里那份**直接落盘**，
 * 所以一条含明文凭据的条目照样会进 modules.json —— 实测发生过。
 * 这里只处理条目正文和标签，其余字段原样带过，也不改调用方传进来的对象。
 */
function redactModulesForWrite(modules = {}) {
  const out = { ...modules }
  for (const [key, moduleValue] of Object.entries(modules)) {
    if (!moduleValue || typeof moduleValue !== 'object' || !Array.isArray(moduleValue.items)) continue
    out[key] = {
      ...moduleValue,
      items: moduleValue.items.map((item) => {
        if (!item || typeof item !== 'object') return item
        const next = { ...item }
        if (typeof next.text === 'string') next.text = redactSecrets(next.text)
        if (Array.isArray(next.tags)) next.tags = next.tags.map((tag) => (typeof tag === 'string' ? redactSecrets(tag) : tag))
        return next
      }),
    }
  }
  return out
}

/**
 * 2026-11-06（报告 1.18）：库里的条目正文/标签跟脱敏后的版本不一样吗？
 * 不一样就说明磁盘上还留着凭据，读路径该把干净版本写回去。
 */
function modulesHaveSecrets(raw, normalized) {  for (const key of ALL_MODULES) {
    const before = raw?.[key]?.items
    const after = normalized?.[key]?.items
    if (!Array.isArray(before) || !Array.isArray(after)) continue
    const byId = new Map()
    for (const item of after) if (item && typeof item.id === 'string') byId.set(item.id, item)
    for (const item of before) {
      if (!item || typeof item.id !== 'string') continue
      const clean = byId.get(item.id)
      if (!clean) continue
      if (typeof item.text === 'string' && item.text !== clean.text) return true
      if (Array.isArray(item.tags)) {
        const tags = Array.isArray(clean.tags) ? clean.tags : []
        for (let i = 0; i < item.tags.length; i++) {
          if (typeof item.tags[i] === 'string' && item.tags[i] !== tags[i]) return true
        }
      }
    }
  }
  return false
}

/** 写模块配置（先写临时文件再 rename）。 */
export function writeModules(modules) {
  mkdirSync(modulesDir(), { recursive: true })
  const file = modulesFile()
  const tmp = `${file}.${process.pid}.tmp`
  // 写前脱敏收口（见 redactModulesForWrite 注释）
  const payload = { ...redactModulesForWrite(modules), updatedAt: Date.now() }

  // 顺序同 memory：JSON 快照先落，kv 后写并盖时间戳，
  // 免得自己写完的 JSON 比 kv 新的那 1 秒被别人误判成"外部改的"。
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)

  try {
    setValue('modules', { ...payload, __savedAt: Date.now() })
  } catch (error) {
    console.warn('[dsh-shared-brain] 模块配置写库失败，只留了 modules.json：' + String(error?.message ?? error))
  }
  // PERF-2：写完必须失效，否则下一次读还是旧的。
  modulesCache = null
  return payload
}

/**
 * 合并两个作用域：取**更具体**的那一档。
 *
 * 具体度：session（最窄）> workspace > global（最宽）。
 * 2026-11-02 加 session 档时引入 —— 原来只有两档，规则是「有 workspace 就用
 * workspace」，现在三档要按具体度排序，不能简单用 or 判断。
 */
function pickScope(a, b) {
  const rank = { global: 0, workspace: 1, session: 2 }
  const left = rank[a] ?? 0
  const right = rank[b] ?? 0
  return left >= right ? a : b
}

/**
 * 把一条记忆放进某个模块。
 * 同模块内若已有高度相似的条目，合并权重（取较高者 + 一点增量），而不是堆重复项。
 */
export function putModuleItem(modules, module, item) {
  if (!MEMORY_MODULES.includes(module)) return { changed: false, modules, note: `未知模块 ${module}` }
  const bucket = modules[module]
  const normalized = {
    id: item.id ?? `mod_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    // 这里是所有入库路径的**统一闸门**：记忆是长期存储的，密钥绝不能进来
    text: redactSecrets(String(item.text ?? '').trim()).slice(0, 2000),
    weight: clampWeight(item.weight, 0.5),
    tags: Array.isArray(item.tags)
      ? item.tags.map((tag) => redactSecrets(String(tag))).filter((tag) => tag !== '[已脱敏]').slice(0, 12)
      : [],
    hits: 0,
    pinned: item.pinned === true,
    source: item.source === 'manual' ? 'manual' : 'auto',
    lifetime: item.lifetime === 'temporary' ? 'temporary' : 'permanent',
    expiresAt: Number.isFinite(item.expiresAt) ? item.expiresAt : 0,
    ttlMs: Number.isFinite(item.ttlMs) && item.ttlMs > 0 ? item.ttlMs : 0,
    scope: ITEM_SCOPES.includes(item.scope) ? item.scope : 'global',
    scopePath: typeof item.scopePath === 'string' ? item.scopePath : '',
    scopeSession: typeof item.scopeSession === 'string' ? item.scopeSession : '',
    // 情感语义字段（2026-11-02）：亲密度 / 极性 / 对象
    ...(module === 'emotion'
      ? {
          intimacy: clampWeight(item.intimacy ?? item.weight, 0.5),
          sentiment: typeof item.sentiment === 'string' ? item.sentiment : 'neutral',
          target: typeof item.target === 'string' && item.target ? item.target : 'general',
          // 2026-11-09（P0-3）：谁的情绪。手动给的优先，没给就从正文推。
          owner: ['user', 'self', 'general'].includes(item.owner) ? item.owner : detectOwner(String(item.text ?? '')),
        }
      : {}),
    supersedes: typeof item.supersedes === 'string' ? item.supersedes : '',
    // 知识条目要带出处（2026-11-06）：putModuleItem 是统一入库闸门，
    // 它也是逐字段重建对象的 —— 这里不显式带上，sourceRef 在写盘时就没了。
    ...(module === 'knowledge' && typeof item.sourceRef === 'string' && item.sourceRef.trim()
      ? { sourceRef: item.sourceRef.trim().slice(0, 200) }
      : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  if (!normalized.text) return { changed: false, modules, note: '空内容' }

  const existing = bucket.items.findIndex(
    (it) => it.text.slice(0, 80) === normalized.text.slice(0, 80) || (it.tags.length > 0 && normalized.tags.length > 0 && it.tags[0] === normalized.tags[0] && it.text.length > 12 && normalized.text.includes(it.text.slice(0, 12))),
  )
  if (existing >= 0) {
    const old = bucket.items[existing]
    bucket.items[existing] = {
      ...old,
      weight: clampWeight(Math.max(old.weight, normalized.weight) + 0.05),
      hits: (old.hits ?? 0) + 1,
      // 手动钉住是「升格」：一旦被钉住，自动分类不会把它降级回去
      pinned: old.pinned === true || normalized.pinned === true,
      source: old.pinned === true ? old.source : normalized.source,
      lifetime: normalized.lifetime === 'temporary' ? 'temporary' : old.lifetime,
      expiresAt: normalized.lifetime === 'temporary' ? normalized.expiresAt : old.expiresAt,
      ttlMs: normalized.ttlMs || old.ttlMs || 0,
      // 作用域：手动指定过的优先，不被自动分类覆盖
      // 2026-11-02：作用域改成三档后，合并规则要跟着改——
      // 「更具体的作用域」优先（session > workspace > global），
      // 否则一条自动分类的 global 条目会把手动指定的 session 作用域冲掉。
      scope: pickScope(normalized.scope, old.scope),
      scopePath: normalized.scopePath || old.scopePath || '',
      scopeSession: normalized.scopeSession || old.scopeSession || '',
      // 情感语义：亲密度取高者（更亲密的那次说了算），极性/对象以新条目为准
      ...(module === 'emotion'
        ? {
            intimacy: clampWeight(Math.max(old.intimacy ?? 0, normalized.intimacy ?? 0) + 0.05, 0.5),
            sentiment: normalized.sentiment || old.sentiment || 'neutral',
            target: normalized.target || old.target || 'general',
          }
        : {}),
      supersedes: normalized.supersedes || old.supersedes || '',
      updatedAt: Date.now(),
    }
    return { changed: true, modules, note: `已强化「${old.text.slice(0, 20)}…」的权重` }
  }
  bucket.items.push(normalized)
  return { changed: true, modules, note: `已记入${MODULE_LABELS[module]}` }
}

/**
 * 钉住 / 取消钉住一个模块条目。
 * 底线只有被钉住（pinned）的条目才会被注入。
 *
 * @returns {{ changed: boolean, modules: object, note: string }}
 */
export function setModuleItemPinned(modules, module, itemId, pinned) {
  if (!MEMORY_MODULES.includes(module)) return { changed: false, modules, note: `未知模块 ${module}` }
  const bucket = modules[module]
  const item = (bucket.items ?? []).find((it) => it.id === itemId)
  if (!item) return { changed: false, modules, note: '找不到这条条目' }
  item.pinned = pinned === true
  item.source = pinned === true ? 'manual' : 'auto'
  item.updatedAt = Date.now()
  return {
    changed: true,
    modules,
    note: pinned === true
      ? `已钉住「${item.text.slice(0, 20)}…」，它会一直生效`
      : `已取消钉住「${item.text.slice(0, 20)}…」`,
  }
}

/**
 * 改一个模块条目的作用域。
 *
 * 底线可以只对某个工作区生效（比如「这个项目里不要自动装依赖」），
 * 换个工作区就自动失效。
 *
 * 2026-11-02：加了一档 `session` —— 只在指定会话里生效。
 * 需要额外传 `scopeSession`（会话 id）。
 *
 * @returns {{ changed: boolean, modules: object, note: string }}
 */
export function setModuleItemScope(modules, module, itemId, scope, scopePath = '', scopeSession = '') {
  if (!MEMORY_MODULES.includes(module)) return { changed: false, modules, note: `未知模块 ${module}` }
  if (!ITEM_SCOPES.includes(scope)) return { changed: false, modules, note: `不认识的作用域「${scope}」` }
  const bucket = modules[module]
  const item = (bucket.items ?? []).find((it) => it.id === itemId)
  if (!item) return { changed: false, modules, note: '找不到这条条目' }
  if (scope === 'session' && !String(scopeSession ?? '').trim()) {
    return { changed: false, modules, note: '要限定在某个会话，得先指定是哪个会话' }
  }
  item.scope = scope
  item.scopePath = scope === 'workspace' ? String(scopePath ?? '').trim().slice(0, 400) : ''
  item.scopeSession = scope === 'session' ? String(scopeSession ?? '').trim().slice(0, 120) : ''
  item.updatedAt = Date.now()
  return {
    changed: true,
    modules,
    note: scope === 'workspace'
      ? `已限定在「${item.scopePath || '（未指定工作区）'}」内生效`
      : scope === 'session'
        ? `已限定在会话「${item.scopeSession}」内生效`
        : '已改为到处生效',
  }
}

/**
 * 设置自动互动的时间窗。
 *
 * @returns {{ changed: boolean, modules: object, note: string }}
 */
export function setAgentiveTimeWindow(modules, window) {
  const enabled = window?.enabled === true
  const start = normalizeClock(window?.start, '09:00')
  const end = normalizeClock(window?.end, '23:00')
  modules.agentive.timeWindow = { enabled, start, end }
  return {
    changed: true,
    modules,
    note: enabled
      ? `自动互动只在 ${start} ~ ${end} 之间主动`
      : '自动互动不再受时间窗限制',
  }
}

/**
 * 设置自动互动的「心情驱动」参数。
 *
 * 这一组参数决定：心情低落时要不要主动关心、心情高时要不要分享进展、
 * 中性时要不要保持安静、一天最多说几次。
 *
 * @param {object} modules 模块配置（原地改）
 * @param {object} mood 心情参数（部分字段）
 * @returns {{ changed: boolean, modules: object, note: string }}
 */
export function setAgentiveMood(modules, mood) {
  const before = JSON.stringify(modules.agentive?.mood ?? {})
  const next = normalizeAgentiveMood(mood, modules.agentive?.mood)
  modules.agentive.mood = next
  const after = JSON.stringify(next)
  const changed = before !== after
  const parts = []
  parts.push(next.enabled ? '心情驱动已开' : '心情驱动已关')
  if (next.enabled) {
    parts.push(`低落线 ${next.lowMood} / 高涨线 ${next.highMood}`)
    parts.push(`每天最多 ${next.maxPerDay} 次`)
    if (next.allowConcern) parts.push(`低落时主动关心（每会话最多 ${next.maxConcernsPerSession} 次）`)
    if (next.allowShare) parts.push('高涨时分享进展')
    parts.push(`中性静默期 ${Math.round(next.quietPeriodMs / 60000)} 分钟`)
  }
  return {
    changed,
    modules,
    note: parts.join('，'),
  }
}

/** 统计每个模块的条目数与平均权重。 */
export function moduleSummary(modules) {
  const out = {}
  for (const key of ALL_MODULES) {
    const bucket = modules[key]
    const items = bucket.items ?? []
    const avg = items.length ? items.reduce((sum, it) => sum + (it.weight ?? 0), 0) / items.length : 0
    const pinnedCount = items.filter((it) => it.pinned === true).length
    const temporaryCount = items.filter((it) => it.lifetime === 'temporary').length
    out[key] = {
      label: MODULE_LABELS[key],
      enabled: bucket.enabled,
      weight: bucket.weight,
      count: items.length,
      avgWeight: Number(avg.toFixed(3)),
      pinnedCount,
      temporaryCount,
      // 能力模块的额外信息
      ...(key === 'agentive'
        ? {
            scope: bucket.scope ?? 'all',
            sessionIds: Array.isArray(bucket.sessionIds) ? bucket.sessionIds : [],
            timeWindow: bucket.timeWindow ?? { enabled: false, start: '09:00', end: '23:00' },
          }
        : {}),
      ...(key === 'network' || key === 'agentive' ? { reason: bucket.reason ?? '' } : {}),
      top: items.slice().sort((a, b) => (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0) || (b.weight ?? 0) - (a.weight ?? 0) || (b.hits ?? 0) - (a.hits ?? 0)).slice(0, 3).map((it) => ({
        id: it.id,
        text: it.text.slice(0, 40),
        weight: it.weight,
        hits: it.hits ?? 0,
        pinned: it.pinned === true,
        lifetime: it.lifetime === 'temporary' ? 'temporary' : 'permanent',
      })),
      // 完整条目列表（供设置页渲染钉住/取消、永久/临时切换）
      items: items.map((it) => ({
        id: it.id,
        text: it.text,
        weight: it.weight,
        hits: it.hits ?? 0,
        pinned: it.pinned === true,
        source: it.source === 'manual' ? 'manual' : 'auto',
        lifetime: it.lifetime === 'temporary' ? 'temporary' : 'permanent',
        expiresAt: it.expiresAt ?? 0,
        ttlMs: it.ttlMs ?? 0,
        scope: ITEM_SCOPES.includes(it.scope) ? it.scope : 'global',
        scopePath: it.scopePath ?? '',
        scopeSession: it.scopeSession ?? '',
        // 情感语义字段（设置页要显示「对谁、什么情绪、多亲」）
        ...(key === 'emotion'
          ? {
              intimacy: it.intimacy ?? it.weight ?? 0,
              sentiment: it.sentiment ?? 'neutral',
              target: it.target ?? 'general',
            }
          : {}),
        supersedes: it.supersedes ?? '',
        updatedAt: it.updatedAt ?? 0,
      })),
    }
  }
  return out
}

/** 语音参数的合法范围。 */
export const SPEECH_LIMITS = {
  rate: { min: 0.5, max: 2.0, def: 1.0 },
  pitch: { min: 0.5, max: 2.0, def: 1.0 },
  volume: { min: 0, max: 1, def: 0.9 },
  bpm: { min: 40, max: 240, def: 90 },
}

/** 夹一个数字到区间内。 */
function clampNum(value, { min, max, def }) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * 规整语音参数（音色 / 语速 / 音调 / 音量 / 唱法）。
 *
 * 这套参数是给「将来的语音与唱歌模块」用的：说话用 rate/pitch/volume，
 * 唱歌额外用 sing.style / sing.bpm / sing.key。本插件现在只负责
 * **保存、校验、注入**，具体发声由将来的模块读走。
 *
 * @param {object} raw
 * @returns {object} 规整后的 speech 对象
 */
export function normalizeSpeech(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const singSource = source.sing && typeof source.sing === 'object' ? source.sing : {}
  return {
    voiceId: typeof source.voiceId === 'string' ? source.voiceId.trim().slice(0, 64) : '',
    voiceName: typeof source.voiceName === 'string' ? source.voiceName.trim().slice(0, 64) : '',
    rate: clampNum(source.rate, SPEECH_LIMITS.rate),
    pitch: clampNum(source.pitch, SPEECH_LIMITS.pitch),
    volume: clampNum(source.volume, SPEECH_LIMITS.volume),
    sing: {
      enabled: singSource.enabled === true,
      style: typeof singSource.style === 'string' ? singSource.style.trim().slice(0, 32) : '轻哼',
      bpm: Math.round(clampNum(singSource.bpm, SPEECH_LIMITS.bpm)),
      key: typeof singSource.key === 'string' ? singSource.key.trim().slice(0, 8) : 'C',
    },
  }
}

/**
 * 把语音参数写进模块配置（并落盘）。
 *
 * @param {object} modules 模块配置
 * @param {object} patch  要改的字段
 * @returns {{ changed: boolean, modules: object, note: string }}
 */
export function setSpeech(modules, patch) {
  const current = normalizeSpeech(modules?.voice?.style?.speech)
  const next = normalizeSpeech({ ...current, ...(patch ?? {}) })
  // 唱法参数要**深合并**：只改 style 时不能把 bpm/key 打回默认值。
  if (patch?.sing && typeof patch.sing === 'object') {
    next.sing = normalizeSpeech({ sing: { ...current.sing, ...patch.sing } }).sing
  }
  const changed = JSON.stringify(current) !== JSON.stringify(next)
  if (!changed) return { changed: false, modules, note: '语音参数没有变化' }
  const voice = modules.voice ?? {}
  const style = { ...(voice.style ?? {}), speech: next }
  const out = { ...modules, voice: { ...voice, style } }
  const parts = []
  if (next.voiceId || next.voiceName) parts.push(`音色「${next.voiceName || next.voiceId}」`)
  parts.push(`语速 ${next.rate}×`)
  parts.push(`音调 ${next.pitch}×`)
  parts.push(`音量 ${next.volume}`)
  if (next.sing.enabled) parts.push(`唱法「${next.sing.style}」${next.sing.bpm} BPM 调 ${next.sing.key}`)
  return { changed: true, modules: out, note: `语音参数已更新：${parts.join('、')}` }
}
