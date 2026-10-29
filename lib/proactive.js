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

/** 主动检查的默认间隔（毫秒）。 */
export const DEFAULT_PROACTIVE_INTERVAL_MS = 15 * 60 * 1000

/** 最短间隔。 */
export const MIN_PROACTIVE_INTERVAL_MS = 60 * 1000

/** 最长间隔。 */
export const MAX_PROACTIVE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 同一个 agent 两次主动之间的最短间隔（毫秒），防止刷屏。 */
export const PROACTIVE_COOLDOWN_MS = 60 * 1000

/** 定时器句柄。 */
let timer = null

/** 定时器当前间隔。 */
let currentIntervalMs = DEFAULT_PROACTIVE_INTERVAL_MS

/** 每个 agent 最近一次主动的时间。 */
const lastFired = new Map()

/** 每个 agent 最近一次主动的内容（避免重复发同样的）。 */
const lastPayload = new Map()

/** 每个 agent 上一次续接的轮次序号。 */
const lastRound = new Map()

/** 统计。 */
const stats = {
  fired: 0,
  skipped: 0,
  lastFiredAt: 0,
  lastError: null,
  tracked: 0,
}

/** 把间隔夹到合法范围。 */
export function clampProactiveInterval(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PROACTIVE_INTERVAL_MS
  return Math.min(MAX_PROACTIVE_INTERVAL_MS, Math.max(MIN_PROACTIVE_INTERVAL_MS, Math.round(value)))
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
export function inProactiveScope(agent, agentive, sessionId = '') {
  if (!agentive?.enabled) return false
  const scope = agentive.scope ?? 'all'
  if (scope !== 'session') return true
  const sessionIds = Array.isArray(agentive.sessionIds) ? agentive.sessionIds : []
  // 没挑任何会话 = 不限定（这才是「选了 session 但一个都没选」该有的语义）
  if (sessionIds.length === 0) return true
  return typeof sessionId === 'string' && sessionIds.includes(sessionId)
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
 */
export function buildProactivePrompt(context = {}) {
  const cwd = context.cwd ? `\n当前工作目录：${context.cwd}` : ''
  return [
    '【自动互动】这是共享大脑的主动检查时间（不是你用户发的消息）。',
    '请快速看一眼当前会话有没有下面这些事：',
    '1. 用户交代的任务还没做完 / 做了一半；',
    '2. 之前提到的风险、承诺、待办还没处理；',
    '3. 有值得主动提醒用户的新进展。',
    '有就补一句进展或提醒；什么都没有就只回一句「暂时没有需要主动做的事」，不要重复已经说过的话。' + cwd,
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

  if (!inProactiveScope(agent, agentive, sessionId)) {
    stats.skipped += 1
    return false
  }
  if (!inTimeWindow(agentive, options.now ?? new Date())) {
    stats.skipped += 1
    return false
  }

  const last = lastFired.get(sessionId) ?? 0
  if (options.force !== true && now - last < (options.cooldownMs ?? PROACTIVE_COOLDOWN_MS)) {
    stats.skipped += 1
    return false
  }

  const prompt = buildProactivePrompt({ cwd: options.cwd ?? agent?.session?.header?.cwd ?? '' })
  if (lastPayload.get(sessionId) === prompt && options.force !== true) {
    stats.skipped += 1
    return false
  }

  try {
    if (typeof agent?.followup === 'function') {
      agent.followup({
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:dsh-shared-brain', form: 'proactive' },
      })
    } else if (typeof agent?.inject === 'function') {
      agent.inject({
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:dsh-shared-brain', form: 'proactive' },
      })
    } else {
      stats.skipped += 1
      return false
    }
    lastFired.set(sessionId, now)
    lastPayload.set(sessionId, prompt)
    stats.fired += 1
    stats.lastFiredAt = now
    return true
  } catch (error) {
    stats.lastError = String(error?.message ?? error)
    stats.skipped += 1
    return false
  }
}

/**
 * 启动自动互动的定时器。
 *
 * @param {object} ctx 插件上下文
 * @param {object} options { intervalMs, agentive, getCwd }
 */
export function startProactiveLoop(ctx, options = {}) {
  stopProactiveLoop()
  const intervalMs = clampProactiveInterval(options.intervalMs ?? DEFAULT_PROACTIVE_INTERVAL_MS)
  currentIntervalMs = intervalMs

  const tick = () => {
    try {
      const agents = pickAgents(ctx)
      const list = typeof agents?.list === 'function' ? agents.list() : []
      const agentive = options.getAgentive?.() ?? options.agentive ?? {}
      if (!agentive?.enabled) {
        stats.skipped += 1
        return
      }
      for (const agent of list ?? []) {
        const sessionId = agent?.session?.header?.id ?? ''
        if (!sessionId) continue
        nudgeAgent(agent, {
          agentive,
          sessionId,
          cwd: agent?.session?.header?.cwd ?? '',
        })
      }
      stats.tracked = (list ?? []).length
    } catch (error) {
      stats.lastError = String(error?.message ?? error)
    }
  }

  timer = setInterval(tick, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return { intervalMs, timer }
}

/** 停掉定时器。 */
export function stopProactiveLoop() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  return currentIntervalMs
}

/** 定时器当前状态。 */
export function proactiveStatus() {
  return {
    running: timer !== null,
    intervalMs: currentIntervalMs,
    fired: stats.fired,
    skipped: stats.skipped,
    lastFiredAt: stats.lastFiredAt,
    lastError: stats.lastError,
    trackedAgents: Math.max(stats.tracked, lastFired.size),
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
  for (const agent of list ?? []) {
    const sessionId = agent?.session?.header?.id ?? ''
    if (!sessionId) {
      noSessionId += 1
      continue
    }
    const ok = nudgeAgent(agent, {
      agentive,
      sessionId,
      force: options.force === true,
      cooldownMs: 0,
    })
    if (ok) sent += 1
    else skipped += 1
  }
  // 记下刚才盯着几个会话，界面上显示「盯着 N 个会话」比显示「已发过几次」直观
  stats.tracked = (list ?? []).length
  return {
    sent,
    total: (list ?? []).length,
    skipped,
    noSessionId,
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
