/**
 * 自动互动（主观能动性）：从「一句提示词」变成真的动作。
 *
 * 以前「自动互动」只在系统提示词里写了一句「可以主动提出建议」，模型其实
 * 没有任何触发机制——用户觉得「好像没有作用」。现在有两条真正的通路：
 *
 *   1. 定时器（`agent.followup()`）：每隔一段时间，对还活着的 agent 发一条
 *      「主动检查一下」的指令。followup 会唤醒 agent，等于自己开新一轮。
 *      宿主文档明确写着：「A timer that starts work calls agent.followup()」，
 *      所以定时器是官方认可的用法。
 *
 *   2. 轮次收尾（`agent/turn-stopping`）：一轮结束时，如果这一轮还有
 *      「没说完」的念头（模型自己标记的），就 steer 一下把轮次续上。
 *
 * 安全阀：
 *   - 只对「活着且属于我们作用域」的 agent 动手；
 *   - 每个 agent 有冷却时间，不会刷屏；
 *   - 时间窗之外、开关关掉、作用域不匹配 → 什么都不做；
 *   - 定时器 unref()，宿主退出时不会挂着进程。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { recordEvent } from './events.js'
import { recentChats } from './db.js'
import {
  decideProactive,
  normalizeProactiveMoodConfig,
  pickTopic,
  readMoodSignal,
  rememberTopic,
  renderMoodHint,
  TONE_HINTS,
  renderTopic,
} from './proactive-mood.js'

/** 主动检查的默认间隔（毫秒）。 */
export const DEFAULT_PROACTIVE_INTERVAL_MS = 15 * 60 * 1000

/** 最短间隔。 */
export const MIN_PROACTIVE_INTERVAL_MS = 60 * 1000

/** 最长间隔。 */
export const MAX_PROACTIVE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 同一个 agent 两次主动之间的最短间隔（毫秒），防止刷屏。 */
export const PROACTIVE_COOLDOWN_MS = 60 * 1000

/**
 * 老大刚说过话的时候别插嘴（2026-11-11）。
 *
 * 以前的「安静期」只看主动搭话自己的节奏：十分钟前搭过一次，这十分钟里
 * 老大一直在打字，到下个 tick 照样往外冒一句 —— 他正在做事，你在旁边
 * 说话就是打扰。对话账本（chat_log）现在记着每轮的时间，5 分钟内有过
 * 一轮就当他还在忙，等停下来再说。手动触发（force）不受这条限制。
 */
export const ACTIVE_GRACE_MS = 5 * 60 * 1000

/**
 * 随机间隔的抖动幅度。
 *
 * 老大要「不要定死」，所以基准间隔不再直接用，而是每次触发时在
 * `基准 × (1 - JITTER)` ~ `基准 × (1 + JITTER)` 之间随机取一个。
 * 0.5 = 基准的 50%~150%。想更散就调大，但上限仍是 24 小时。
 */
export const PROACTIVE_INTERVAL_JITTER = 0.5

/**
 * 一轮（一次 tick）最多给几个会话发主动消息。
 *
 * 以前一轮会把**所有**活着的会话各叫一遍 —— 四个会话同一秒各收到一条，
 * 那不叫主动，叫刷屏。现在默认一轮只叫一个，会话之间轮着来，
 * 谁都不至于永远轮不上。
 */
export const DEFAULT_MAX_PER_ROUND = 1

/** 定时器句柄（自调度用 setTimeout 链，不再是 setInterval）。 */
let timer = null

/** 定时器当前基准间隔。 */
let currentIntervalMs = DEFAULT_PROACTIVE_INTERVAL_MS

/** 上一次实际用的随机间隔（毫秒）。 */
let lastIntervalMs = 0

/** 下一次实际会用的随机间隔（毫秒）。 */
let nextIntervalMs = 0

/** 下一次触发的时间戳。 */
let nextFireAt = 0

/** 生成随机间隔用的随机源（测试时可注入固定值）。 */
let randomFn = Math.random

/**
 * 在基准间隔附近随机取一个实际间隔。
 *
 * 规则：
 *   - 基准 = 老大在设置页填的分钟数（`intervalMs`）；
 *   - 实际 = 基准 × (1 ± JITTER)，下限不低于 1 分钟；
 *   - 取整到整秒，避免定时器抖动看起来很怪。
 *
 * @param {number} baseMs 基准间隔（毫秒）
 * @param {() => number} [rand] 随机源，返回 [0,1)
 * @returns {number} 实际间隔（毫秒）
 */
export function randomizeInterval(baseMs, rand = randomFn) {
  const base = clampProactiveInterval(baseMs)
  const factor = 1 - PROACTIVE_INTERVAL_JITTER + rand() * (PROACTIVE_INTERVAL_JITTER * 2)
  const value = Math.round((base * factor) / 1000) * 1000
  return Math.min(MAX_PROACTIVE_INTERVAL_MS, Math.max(MIN_PROACTIVE_INTERVAL_MS, value))
}

/** 把毫秒说成「3 小时」「25 分钟」这样的人话。 */
export function formatDuration(ms) {
  const value = Math.max(0, Math.round(Number(ms) ?? 0))
  // 用 floor 而不是 round：30 秒不该被说成「1 分钟」，该说「不到一分钟」。
  const minutes = Math.floor(value / 60000)
  if (minutes < 1) return '不到一分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

/** 每个 agent 最近一次主动的时间。 */
const lastFired = new Map()

/** 每个 agent 最近一次主动的内容（避免重复发同样的）。 */
const lastPayload = new Map()

/**
 * 每个会话的主动互动历史（心情驱动用）。
 *
 * 记的是「这个会话最近说过什么、用过哪些话题、今天说过几次、低落时关心
 * 过几次」—— 决策层靠它决定这次说不说话、聊什么。
 */
const proactiveHistory = new Map()

/**
 * 互动历史的存放位置（P1-7，2026-11-03）。
 *
 * 以前这份历史只在内存里，宿主一重启就全归零：今天已经说了几次、
 * 关心过几次、用过哪些话题，统统忘光 —— 每日上限形同虚设
 * （重启一次就能再刷一轮），话题轮换也重新来过。
 * 现在落盘。
 */
function proactiveHistoryFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-shared-brain', 'proactive-history.json')
}

/** 从磁盘读回互动历史（读不到 / 坏文件 → 空对象，不崩）。 */
function loadProactiveHistory() {
  try {
    const file = proactiveHistoryFile()
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const source = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object'
      ? raw.sessions
      : raw && typeof raw === 'object'
        ? raw
        : {}
    const out = {}
    for (const [key, value] of Object.entries(source)) {
      if (!value || typeof value !== 'object') continue
      out[key] = {
        lastSpokeAt: Number.isFinite(value.lastSpokeAt) ? Number(value.lastSpokeAt) : 0,
        spokeToday: Number.isFinite(value.spokeToday) ? Number(value.spokeToday) : 0,
        dayStamp: typeof value.dayStamp === 'string' ? value.dayStamp : '',
        concerns: Number.isFinite(value.concerns) ? Number(value.concerns) : 0,
        usedTopics: Array.isArray(value.usedTopics)
          ? value.usedTopics.filter((k) => typeof k === 'string').slice(-12)
          : [],
        lastTopicKey: typeof value.lastTopicKey === 'string' ? value.lastTopicKey : '',
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 把互动历史写回磁盘（先写临时文件再 rename，避免写一半断电）。 */
function saveProactiveHistory() {
  try {
    const file = proactiveHistoryFile()
    mkdirSync(dirname(file), { recursive: true })
    const sessions = {}
    for (const [key, value] of proactiveHistory.entries()) {
      if (!key) continue
      sessions[key] = value
    }
    const payload = JSON.stringify({
      version: 1,
      sessions,
      updatedAt: Date.now(),
    }, null, 2)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, file)
  } catch {
    // 存不下就算了，不该因为记账失败把自动互动带崩
  }
}

/** 拿到（并在需要时初始化）某个会话的互动历史。 */
function historyOf(sessionId) {
  const key = String(sessionId ?? '').trim()
  let item = proactiveHistory.get(key)
  if (!item) {
    item = {
      lastSpokeAt: 0,
      spokeToday: 0,
      dayStamp: '',
      concerns: 0,
      usedTopics: [],
      lastTopicKey: '',
    }
    proactiveHistory.set(key, item)
  }
  return item
}

/** 今天过了就清零「今天说了几次」。 */
function rollDay(history, now = Date.now()) {
  // 2026-11-04（P1-10 审计 B17）：用**本地日期**，不用 UTC。
  // 以前这里 toISOString().slice(0,10) 是 UTC 日期，而 emotion.js 的
  // localDay 用的是本地日期 —— UTC+8 的凌晨 0:00-08:00 两边差一天，
  // 「今天说了几次」会在错误的时间点清零（额度算错、深夜里额度突然回来）。
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (history.dayStamp !== stamp) {
    history.dayStamp = stamp
    history.spokeToday = 0
  }
  return history
}

/** 每个 agent 上一次续接的轮次序号。 */
const lastRound = new Map()

/**
 * 今天这份额度用到的截止时刻。
 *
 * 时间窗开着就用今天时间窗的结束点，没开就用今天 24:00。
 * 决策层拿它把「每天最多 N 次」均匀铺开 —— 否则上午三次说完，
 * 下午到夜里就彻底哑火，体感比不说话还怪。
 *
 * @param {object} agentive 主观能动性配置
 * @param {number} now 当前时间戳
 * @returns {number} 截止时间戳
 */
function dayEndOf(agentive, now = Date.now()) {
  const win = agentive?.timeWindow ?? {}
  const end = new Date(now)
  if (win.enabled && typeof win.end === 'string' && /^\d{1,2}:\d{2}$/.test(win.end)) {
    const [hour, minute] = win.end.split(':').map(Number)
    end.setHours(hour, minute, 0, 0)
    // 时间窗跨零点（例如 22:00~02:00）时，结束点落在明天。
    if (end.getTime() <= now) end.setDate(end.getDate() + 1)
    return end.getTime()
  }
  end.setHours(24, 0, 0, 0)
  return end.getTime()
}

/** 统计。 */
const stats = {
  fired: 0,
  skipped: 0,
  lastFiredAt: 0,
  lastError: null,
  tracked: 0,
  /** 心情驱动判定为「该安静」而没说话的次数。 */
  silenced: 0,
  /** 最近一次决策的原因（pending / concern / share / routine / quiet-period …）。 */
  lastDecisionReason: '',
  /** 最近一次决策的心情档位。 */
  lastMoodBand: '',
}

/**
 * 最近一次「为什么没发出去」。
 *
 * 以前界面上只会说「N 个会话都跳过了」，用户根本不知道是开关关着、
 * 不在作用域、还是不在时间窗里。这里把原因记下来，方便原样告诉用户。
 */
let lastSkipReason = ''

/**
 * 轮转指针：这一轮从第几个会话开始。
 *
 * 有了跨会话限流以后，如果每轮都从第一个会话开始，排在后面的会话永远轮不上。
 * 发成功一条就把指针挪到它的下一个，于是机会轮流给。
 */
let roundCursor = 0

/** 跳过的原因码。 */
export const SKIP_REASON = {
  scope: 'scope',
  window: 'window',
  cooldown: 'cooldown',
  duplicate: 'duplicate',
  channel: 'channel',
  error: 'error',
  disabled: 'disabled',
  /** 心情驱动判定这一轮该安静（quiet-period / daily-limit / concern-already）。 */
  silent: 'silent',
  /** 这一轮的额度用完了（跨会话限流，见 DEFAULT_MAX_PER_ROUND）。 */
  budget: 'budget',
  /** 老大刚说过话，正忙着（见 ACTIVE_GRACE_MS）。 */
  active: 'active',
}

/**
 * 最近几轮「真的有人在说话」的时刻。
 * 2026-11-11 加：chat_log 只记「值得记的轮」，普通闲聊根本不进表，
 * 只靠它判断「老大刚说过话」会漏得很厉害（人家正说着，这边照发）。
 */
const LIVE_TURNS = []
const LIVE_TURN_KEEP = 20

/** 每轮拿到用户提示词时调一次。主动搭话自己插的话也走这里，算「刚说过」不算错。 */
export function noteUserTurn(at = Date.now()) {
  const stamp = Number(at)
  if (!Number.isFinite(stamp) || stamp <= 0) return
  if (stamp > Date.now() + 60 * 1000) return
  LIVE_TURNS.push(stamp)
  if (LIVE_TURNS.length > LIVE_TURN_KEEP) LIVE_TURNS.splice(0, LIVE_TURNS.length - LIVE_TURN_KEEP)
}

/** 最近一轮对话是什么时候（拿不到就当很久以前）。 */
function lastTurnAt(now = Date.now()) {
  let newest = 0
  try {
    const rows = recentChats(3)
    for (const row of rows) {
      const at = Number(row?.at ?? 0)
      if (Number.isFinite(at) && at > newest && at <= now + 60 * 1000) newest = at
    }
  } catch {
    // 库读不出来就用内存里那几轮，别把宽限期整个失效
  }
  for (const at of LIVE_TURNS) {
    if (Number.isFinite(at) && at > newest && at <= now + 60 * 1000) newest = at
  }
  return newest
}

/** 老大是不是正在跟我说话（宽限期内）。 */
export function recentlyActive(graceMs = ACTIVE_GRACE_MS, now = Date.now()) {
  const grace = Number(graceMs)
  if (!(grace > 0)) return false
  return now - lastTurnAt(now) < grace
}

/** 记一次跳过并返回 false，省得每处都写两行。 */
function skip(reason) {
  lastSkipReason = reason
  stats.skipped += 1
  return false
}

/** 读最近一次跳过原因（没有跳过时为空字符串）。 */
export function lastSkip() {
  return lastSkipReason
}

/** 把间隔夹到合法范围。 */
export function clampProactiveInterval(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PROACTIVE_INTERVAL_MS
  return Math.min(MAX_PROACTIVE_INTERVAL_MS, Math.max(MIN_PROACTIVE_INTERVAL_MS, Math.round(value)))
}

/**
 * 把「一轮最多发几条」夹到合法范围。
 *
 * 0 或非法值 → 回到默认（1 条）；上限 20 条，再多就是往聊天里倒垃圾了。
 */
export function clampMaxPerRound(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_MAX_PER_ROUND
  return Math.min(20, Math.max(1, Math.round(num)))
}

/** 取宿主里的 agents 服务（AgentRegistry）。 */
function pickAgents(ctx) {
  for (const owner of [ctx, ctx?.root]) {
    if (!owner) continue
    try {
      if (typeof owner.get === 'function') {
        const value = owner.get('agents')
        if (value) return value
      }
    } catch {
      // ctx.get 对未知服务可能抛错
    }
    try {
      const value = owner.agents
      if (value) return value
    } catch {
      // 属性访问也可能抛错
    }
  }
  return undefined
}

/**
 * 判断这个 agent 在不在「自动互动」的作用域里。
 *
 * @param {object} agent
 * @param {object} agentive agentive 模块配置
 * @param {string} sessionId
 */
/**
 * 比较两个会话 id 是不是同一个。
 *
 * 宿主里会话 id 有两种写法：`session-xxxx` 和裸的 `xxxx`（不同来源各写一种），
 * 直接 includes / === 会把同一个会话判成两个，用户勾了「指定会话」却永远不生效。
 *
 * @param {string} a
 * @param {string} b
 */
export function sameSessionId(a, b) {
  const clean = (value) => String(value ?? '').trim().replace(/^session-/, '')
  const left = clean(a)
  return left !== '' && left === clean(b)
}

/**
 * 判断这个 agent 在不在「自动互动」的作用域里。
 *
 * @param {object} agent
 * @param {object} agentive agentive 模块配置
 * @param {string} sessionId
 */
export function inProactiveScope(agent, agentive, sessionId = '') {
  if (!agentive?.enabled) return false
  const scope = agentive.scope ?? 'all'
  if (scope !== 'session') return true
  const sessionIds = Array.isArray(agentive.sessionIds) ? agentive.sessionIds : []
  // 2026-11-10：以前「选了 session 但一个都没挑」= 不限定，于是所有会话都会收到
  // 主动搭话。老大反馈的正是这个：只关联了桌宠，别的会话也在发。改成「没挑就谁都不发」，
  // 想发就把会话勾上；宁可不吭声，也别到处插嘴。
  if (sessionIds.length === 0) return false
  if (typeof sessionId !== 'string' || sessionId === '') return false
  return sessionIds.some((id) => sameSessionId(id, sessionId))
}

/** 现在是不是在时间窗里。 */
export function inTimeWindow(agentive, now = new Date()) {
  const window = agentive?.timeWindow
  if (!window?.enabled) return true
  const start = String(window.start ?? '09:00')
  const end = String(window.end ?? '23:00')
  const parse = (text) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim())
    if (!match) return null
    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
    return hours * 60 + minutes
  }
  const startMin = parse(start)
  const endMin = parse(end)
  if (startMin === null || endMin === null) return true
  const current = now.getHours() * 60 + now.getMinutes()
  if (startMin === endMin) return true
  if (startMin < endMin) return current >= startMin && current <= endMin
  // 跨午夜
  return current >= startMin || current <= endMin
}

/**
 * 生成给 agent 的主动指令文本。
 *
 * 注意措辞：明确说「如果没什么要做的，就一句话收尾」，不然模型会一直自说自话。
 *
 * `context.nonce` 会写进提示词：以前这段文本只依赖 cwd，所以每次生成的
 * 内容一模一样，于是 `nudgeAgent` 里的「和上次一样就跳过」判定会把
 * **第二次之后的每一次主动都挡掉**（SKIP_REASON.duplicate）——定时器明明在跑，
 * 用户却永远只看到第一条。加一个每次都不同的标记就绕开了。
 */
export function buildProactivePrompt(context = {}) {
  const cwd = context.cwd ? `\n当前工作目录：${context.cwd}` : ''
  const nonce = context.nonce ? `\n（本次检查编号：${context.nonce}）` : ''
  const title = context.title ? `\n当前会话：${context.title}` : ''

  // 心情那一行（2026-11-02）：以前自动互动完全不看心情，模型每次收到的
  // 都是同一段干巴巴的模板，于是「自动互动」= 机械打卡。现在把当下的
  // 心情底子交给它，让语气跟着状态走。
  const mood = context.moodHint ? `\n${context.moodHint}` : ''

  // 这次搭话的主题（由 proactive-mood 轮换选出来，避免每次同一个开头）。
  const topic = context.topicText ? `\n${context.topicText}` : ''

  // 语气提示。
  const tone = context.toneHint ? `\n${context.toneHint}` : ''

  // 距上次主动隔了多久 —— 让模型知道「好久没聊了」还是「刚聊过」。
  const since = context.sinceLastText ? `\n${context.sinceLastText}` : ''

  return [
    '【主动搭话】这是共享大脑自己找上门的时刻，不是老大发的消息。',
    '你现在想主动说句话，不是被点名交作业。',
    topic || '',
    mood,
    since,
    '',
    '看看这个会话有没有下面这些事：',
    '1. 老大交代的任务还没做完 / 做了一半；',
    '2. 之前提到的风险、承诺、待办还没处理；',
    '3. 有值得主动告诉老大的新进展。',
    '',
    '有就自然地说一句（像人搭话那样，别写成汇报，别列条目）；',
    '没什么事就只回一句「暂时没有需要主动做的事」。',
    // P1-8：以前话题是现成的整句，模型直接照抄 → 每次主动搭话都一模一样。
    // 现在只给意图，明确要求它自己组织语言，并且别跟上一次重复。
    '用你自己的话说，别照抄上面那句；也别重复你上一次主动搭话说过的话。' + tone,
    cwd + title + nonce,
  ].join('\n')
}

/**
 * 对一个 agent 发主动指令。
 *
 * @returns {boolean} 是否真的发了
 */
export function nudgeAgent(agent, options = {}) {
  const agentive = options.agentive ?? {}
  const sessionId = options.sessionId ?? agent?.session?.header?.id ?? ''
  const now = Date.now()

  // 先分清「开关关着」和「不在作用域」：都判成 scope 的话，
  // 用户看到「不在你选中的会话里」会一脸问号，其实开关根本没开。
  if (!agentive?.enabled) {
    return skip(SKIP_REASON.disabled)
  }
  if (!inProactiveScope(agent, agentive, sessionId)) {
    return skip(SKIP_REASON.scope)
  }
  if (!inTimeWindow(agentive, options.now ?? new Date())) {
    return skip(SKIP_REASON.window)
  }

  const last = lastFired.get(sessionId) ?? 0
  if (options.force !== true && now - last < (options.cooldownMs ?? PROACTIVE_COOLDOWN_MS)) {
    return skip(SKIP_REASON.cooldown)
  }

  // 老大刚说过话就先别插嘴（2026-11-11）：安静期只管我们自己说过的话，
  // 管不了「他正在忙」。手动触发不受这条限制。
  if (options.force !== true) {
    const grace = Number(options.activeGraceMs ?? ACTIVE_GRACE_MS)
    if (recentlyActive(grace, now)) return skip(SKIP_REASON.active)
  }

  // ── 心情驱动的决策层（2026-11-02）────────────────────────────
  // 以前这里是「定时器一到就发一段固定模板」，模型不知道现在什么心情、
  // 上次说了什么、该不该说话 —— 于是每次都一样，机械得像打卡。
  // 现在先过一遍决策层：这一轮说不说话、用什么调子、聊什么。
  const history = rollDay(historyOf(sessionId), now)
  const decision = decideProactive({
    moodState: options.moodState ?? null,
    history: {
      lastSpokeAt: history.lastSpokeAt,
      spokeToday: history.spokeToday,
      concerns: history.concerns,
      usedTopics: history.usedTopics,
      pending: options.pending ?? [],
    },
    config: options.moodConfig ?? {},
    // 2026-11-04（E2）：情感条目 → readMoodSignal → level 偏向
    emotions: options.emotions ?? [],
    // 2026-11-11（方案 §5.5）：话题池，从读过的书里挑由头；拿不到就用内置话题。
    topicPool: options.topicPool ?? options.getTopicPool?.() ?? [],
    now,
    dayEnd: dayEndOf(agentive, now),
  })
  stats.lastDecisionReason = decision.reason
  stats.lastMoodBand = decision.signal?.band?.key ?? ''

  // 决策为「安静」→ 这一轮不发消息，只记账。
  // 注意：`force`（界面上「立刻主动一次」）不受静默限制 —— 用户手动点的
  // 就该有回应。
  if (decision.action === 'silent' && options.force !== true) {
    stats.silenced += 1
    lastSkipReason = SKIP_REASON.silent
    stats.skipped += 1
    return false
  }

  // 距上次主动多久（给模型一个「好久没聊」的实感）。
  const sinceLast = history.lastSpokeAt > 0 ? now - history.lastSpokeAt : 0
  const sinceLastText = sinceLast > 0
    ? `（距离上次主动搭话已经过了${formatDuration(sinceLast)}）`
    : ''

  // 每次主动的提示词都带一个唯一编号：内容不再重复，
  // 下面「和上次一样就跳过」的判定就不会把第二次之后的主动全挡掉。
  const prompt = buildProactivePrompt({
    cwd: options.cwd ?? agent?.session?.header?.cwd ?? '',
    nonce: options.nonce ?? now,
    title: options.title ?? '',
    moodHint: renderMoodHint(decision.signal),
    // P1-8：不拼成品句，把「这次想聊什么」交给模型自己组织语言
    topicText: renderTopic(decision.topic),
    toneHint: TONE_HINTS[decision.tone] ?? '',
    sinceLastText,
  })
  if (lastPayload.get(sessionId) === prompt && options.force !== true) {
    return skip(SKIP_REASON.duplicate)
  }

  // 宿主的收件箱用 `message.id` 做去重（Agent#send → inbox.splice：
  // 同一个 id 出现两次就抛 `message "..." is already pending`）。
  // 以前这里没带 id，等于 id 是 undefined：第一条主动消息进去后一直待着，
  // 第二条一插就撞上，于是「自动互动只有第一次可能成功，之后全报错」。
  // 每次主动都生成唯一 id。
  const message = {
    id: `proactive-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin:dsh-shared-brain', form: 'proactive' },
  }

  try {
    if (typeof agent?.followup === 'function') {
      agent.followup(message)
    } else if (typeof agent?.inject === 'function') {
      agent.inject(message)
    } else {
      return skip(SKIP_REASON.channel)
    }
    lastFired.set(sessionId, now)
    lastPayload.set(sessionId, prompt)
    stats.fired += 1
    stats.lastFiredAt = now
    // 2026-11-11：主动搭话也进事件环 —— 桌宠要跟着接一句，靠的就是
    // 「刚刚有人开口了」这条信号，别让它去轮询聊天记录。
    recordEvent('proactive', decision.topic?.label || '主动搭话（没指定由头）', { sessionId })

    // 记账（心情驱动要用）：
    //   - 记下这次用的话题，下次换个花样；
    //   - 低落时关心过一次就记一次，免得反复追问显得烦；
    //   - 记下今天说了几次（每日上限用）。
    //     注意：**关心不占日常额度**，「每天最多 N 次」说的是平时的搭话次数。
    //     不然低落时关心一次就把额度吃掉一份，「更主动」等于没做。
    history.lastSpokeAt = now
    if (decision.reason !== 'concern') history.spokeToday += 1
    if (decision.topic?.key) {
      history.usedTopics = rememberTopic(history.usedTopics, decision.topic.key)
      history.lastTopicKey = decision.topic.key
    }
    if (decision.reason === 'concern') {
      history.concerns += 1
    }
    // P1-7：记完就落盘，重启后额度不会白送
    saveProactiveHistory()
    return true
  } catch (error) {
    stats.lastError = String(error?.message ?? error)
    return skip(SKIP_REASON.error)
  }
}

/**
 * 启动自动互动的定时器。
 *
 * 用的是**自调度**（setTimeout 链）而不是 setInterval：间隔要随机，
 * 固定周期的 setInterval 做不到「每次间隔都不一样」——每次自己算出
 * 下一个间隔再排一次，才是真的随机。
 *
 * @param {object} ctx 插件上下文
 * @param {object} options { intervalMs, agentive, getCwd }
 */
export function startProactiveLoop(ctx, options = {}) {
  stopProactiveLoop()
  // P1-7：先把上次的历史读回来，再开始计时
  try {
    for (const [key, value] of Object.entries(loadProactiveHistory())) {
      proactiveHistory.set(key, value)
    }
  } catch {
    // 读不回来就从零开始
  }
  const intervalMs = clampProactiveInterval(options.intervalMs ?? DEFAULT_PROACTIVE_INTERVAL_MS)
  currentIntervalMs = intervalMs

  /**
   * 本轮用的心情状态。
   *
   * 心情来源有两个：宿主自己给的 `options.getMoodState?.(sessionId)`，
   * 或者插件内部从情绪库读（index.js 会把 getMoodState 接好）。
   * 没有心情数据时决策层会走中性分支，不影响老行为。
   */
  const moodOf = (sessionId) => {
    try {
      if (typeof options.getMoodState === 'function') {
        return options.getMoodState(sessionId) ?? null
      }
    } catch {
      // 读心情失败不该拖垮主动互动
    }
    return null
  }

  /**
   * 本轮要用的间隔系数。
   *
   * 心情低落 → 缩短间隔（更关心老大）；心情好 → 也稍微缩短（更活跃）。
   * 系数由决策层给出，这里只负责应用。
   */
  // 2026-11-03（P1-6）：每个会话各自的间隔系数。
  // 以前是一个共享的 intervalFactor，循环里谁心情最差就把它拉到最小，
  // 于是「一个会话低落」会让**所有**会话都被叫得更勤 —— 会话之间串味。
  // 现在按会话记账，schedule 时取本轮参与者的最小值。
  const intervalFactors = new Map()

  const tick = () => {
    try {
      const agents = pickAgents(ctx)
      const list = typeof agents?.list === 'function' ? agents.list() : []
      const agentive = options.getAgentive?.() ?? options.agentive ?? {}
      if (!agentive?.enabled) {
        skip(SKIP_REASON.disabled)
        return
      }
      intervalFactors.clear()
      const moodConfig = normalizeProactiveMoodConfig(options.getMoodConfig?.() ?? options.moodConfig)
      // 2026-11-09：跨会话限流。一轮最多给 maxPerRound 个会话发消息。
      // 以前这里是「每个活着的会话各叫一遍」，四个会话同一秒各收到一条，
      // 那不是主动，是刷屏。现在一轮只叫一个（默认），会话之间轮着来。
      const maxPerRound = clampMaxPerRound(agentive?.maxPerRound)
      const total = (list ?? []).length
      const start = total > 0 ? roundCursor % total : 0
      const ordered = total > 0 ? [...(list ?? []).slice(start), ...(list ?? []).slice(0, start)] : []
      let sentThisRound = 0
      for (let index = 0; index < ordered.length; index += 1) {
        const agent = ordered[index]
        const sessionId = agent?.session?.header?.id ?? ''
        if (!sessionId) continue
        const moodState = moodOf(sessionId)
        // 心情影响节奏：每轮都按**当前**心情算，不管这一轮说没说话。
        // 旧写法只在「说出了话」之后才调系数 —— 结果静默轮次不影响间隔，
        // 而且低落时关心额度一用完就永远不再加速，「更主动」直接落空。
        if (moodState) {
          const sig = readMoodSignal(moodState, moodConfig)
          const factor =
            sig.level === 'low'
              ? moodConfig.lowIntervalFactor
              : sig.level === 'high'
                ? moodConfig.highIntervalFactor
                : 1
          intervalFactors.set(sessionId, factor)
        }
        // 额度用完了就不再打扰后面的会话（心情系数照样算，间隔节奏不受影响）。
        if (sentThisRound >= maxPerRound) {
          skip(SKIP_REASON.budget)
          continue
        }
        const sent = nudgeAgent(agent, {
          agentive,
          sessionId,
          cwd: agent?.session?.header?.cwd ?? '',
          title: options.getTitle?.(sessionId) ?? '',
          moodState,
          moodConfig: options.getMoodConfig?.() ?? options.moodConfig ?? {},
          pending: options.getPending?.(sessionId) ?? [],
          // 2026-11-04（E2）：把对这个会话成立的情感条目一起带下去，
          // 让「老大讨厌啰嗦」这类记忆真的影响搭话的调子。
          emotions: options.getEmotions?.(sessionId) ?? [],
        })
        if (sent) {
          sentThisRound += 1
          // 下一轮从这条的下一个会话开始，机会轮流给。
          roundCursor = total > 0 ? (start + index + 1) % total : 0
        }
      }
      stats.tracked = total
    } catch (error) {
      stats.lastError = String(error?.message ?? error)
    }
  }

  // 排下一次触发：间隔在基准附近随机，每次都重新算。
  const schedule = () => {
    // 心情系数作用在基准上：低落时来得更勤快。
    // 取本轮参与过评估的会话里最小的系数：有会话低落就整体来勤一点，
    // 但只由真正参与本轮的那些会话决定，不再全局共享一个变量。
    const factors = [...intervalFactors.values()].filter((v) => Number.isFinite(v) && v > 0)
    const worstFactor = factors.length > 0 ? Math.min(...factors) : 1
    const base = Math.round(currentIntervalMs * (Number(worstFactor) || 1))
    const actual = randomizeInterval(base)
    lastIntervalMs = actual
    nextIntervalMs = actual
    nextFireAt = Date.now() + actual
    timer = setTimeout(() => {
      tick()
      // 2026-11-04（P1-10 审计）：开关关掉时**照样排下一次**。
      // 以前这里 enabled=false 就把定时器停了 —— 用户重新打开开关，
      // 要等宿主重启才会恢复自动互动，看起来像「开了也没用」。
      // tick 在关掉时只记一次 skip，成本可以忽略。
      schedule()
    }, actual)
    if (typeof timer.unref === 'function') timer.unref()
  }

  schedule()
  return { intervalMs, timer }
}

/** 停掉定时器。 */
export function stopProactiveLoop() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  nextFireAt = 0
  return currentIntervalMs
}

/** 定时器当前状态。 */
export function proactiveStatus() {
  return {
    running: timer !== null,
    intervalMs: currentIntervalMs,
    lastIntervalMs,
    nextIntervalMs,
    nextFireAt,
    jitter: PROACTIVE_INTERVAL_JITTER,
    fired: stats.fired,
    skipped: stats.skipped,
    lastFiredAt: stats.lastFiredAt,
    lastError: stats.lastError,
    lastSkipReason,
    trackedAgents: Math.max(stats.tracked, lastFired.size),
    /** 心情驱动的统计（2026-11-02）。 */
    silenced: stats.silenced,
    lastDecisionReason: stats.lastDecisionReason,
    lastMoodBand: stats.lastMoodBand,
  }
}

/** 立刻对所有活着的 agent 发一次主动检查。 */
export function runProactiveNow(ctx, options = {}) {
  const agents = pickAgents(ctx)
  const list = typeof agents?.list === 'function' ? agents.list() : []
  const agentive = options.getAgentive?.() ?? options.agentive ?? {}
  let sent = 0
  let skipped = 0
  let noSessionId = 0
  /** 每个被跳过的会话和原因，界面能直接说清楚「为什么没发」。 */
  const reasons = []
  // 2026-11-09：可以点名只叫某一个会话（界面上「就对这个会话主动一次」）。
  const target = String(options.sessionId ?? '').trim()
  // 手动触发默认不限条数（老大点了就是想听回应）；传了 maxPerRound 就照办。
  const maxPerRound = options.maxPerRound === undefined ? 0 : clampMaxPerRound(options.maxPerRound)
  for (const agent of list ?? []) {
    const sessionId = agent?.session?.header?.id ?? ''
    if (!sessionId) {
      noSessionId += 1
      continue
    }
    if (target && !sameSessionId(sessionId, target)) continue
    if (maxPerRound > 0 && sent >= maxPerRound) {
      skipped += 1
      reasons.push({ sessionId, reason: SKIP_REASON.budget })
      continue
    }
    const ok = nudgeAgent(agent, {
      agentive,
      sessionId,
      force: options.force === true,
      cooldownMs: 0,
      title: options.getTitle?.(sessionId) ?? '',
      moodState: options.getMoodState?.(sessionId) ?? null,
      moodConfig: options.getMoodConfig?.() ?? options.moodConfig ?? {},
      pending: options.getPending?.(sessionId) ?? [],
    })
    if (ok) sent += 1
    else {
      skipped += 1
      reasons.push({ sessionId, reason: lastSkipReason || 'unknown' })
    }
  }
  // 记下刚才盯着几个会话，界面上显示「盯着 N 个会话」比显示「已发过几次」直观
  stats.tracked = (list ?? []).length
  return {
    sent,
    total: (list ?? []).length,
    skipped,
    noSessionId,
    reasons,
    enabled: agentive?.enabled === true,
    scope: agentive?.scope ?? 'all',
  }
}

/** 清掉跟踪状态（插件卸载时调用）。 */
export function clearProactiveState() {
  stopProactiveLoop()
  lastFired.clear()
  lastPayload.clear()
  lastRound.clear()
  stats.fired = 0
  stats.skipped = 0
  stats.lastFiredAt = 0
  stats.lastError = null
  stats.tracked = 0
  stats.silenced = 0
  stats.lastDecisionReason = ''
  stats.lastMoodBand = ''
  proactiveHistory.clear()
  // P1-7：清内存就等于清磁盘，别留半份
  saveProactiveHistory()
  lastIntervalMs = 0
  nextIntervalMs = 0
  nextFireAt = 0
}

/**
 * 续接标记：HTML 注释，渲染 markdown 时看不见，不会出现在老大眼里。
 *
 * 之所以要用「标记」而不是去猜「这句话好像没说完」：
 * 猜错的代价是 AI 自己跟自己聊起来，那个比不续接烦人得多。
 * 让模型自己声明「我这轮还没做完」，误判的概率就只取决于它诚不诚实。
 */
const CONTINUE_MARKS = [
  // <!-- 继续：把测试跑完 -->
  /<!--\s*继续\s*[：:]\s*([^<>\n]{1,120}?)\s*-->/,
  // 兜底：有些地方会把 HTML 注释吃掉，留一个纯文本形态
  /\[\[继续\s*[：:]\s*([^\]\n]{1,120}?)\]\]/,
]

/**
 * 从一段助手文本里取出续接理由；没有标记返回空串。
 *
 * 只看**末尾**（最后 400 字符）—— 标记本来就该写在回复最后一行，
 * 正文中间提到「继续」两个字不该触发。
 */
export function continueReasonOf(text) {
  const raw = String(text ?? '')
  if (!raw) return ''
  const tail = raw.slice(-400)
  for (const re of CONTINUE_MARKS) {
    const m = re.exec(tail)
    if (m && m[1]) return m[1].trim()
  }
  return ''
}

/** 老大真的说话了：续接轮次从头开始算。 */
export function resetContinueRound(sessionId) {
  if (sessionId) lastRound.delete(sessionId)
}

/**
 * 轮次收尾时判断要不要续接。
 *
 * `agent/turn-stopping` 会在「一轮即将结束」时触发，此时可以 steer 把轮次留住。
 * 我们只在模型明确留下了「还有事没说完」的信号时才续接。
 *
 * @param {object} agent
 * @param {string} sessionId
 * @param {object} agentive
 * @param {string} reason 模型留下的续接理由
 */
export function shouldContinueTurn(sessionId, agentive, reason) {
  const text = String(reason ?? '').trim()
  if (!text) return false
  if (!inProactiveScope(null, agentive, sessionId)) return false
  if (!inTimeWindow(agentive, new Date())) return false
  const round = Number(lastRound.get(sessionId) ?? 0) + 1
  // 一个会话最多续接 3 轮，别无限自问自答
  if (round > 3) return false
  lastRound.set(sessionId, round)
  return true
}

/** 记下一个会话已经续接过几轮。 */
export function roundOf(sessionId) {
  return Number(lastRound.get(sessionId) ?? 0)
}
