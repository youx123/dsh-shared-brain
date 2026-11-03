/**
 * dsh-shared-brain —— 让人设与记忆在所有会话之间共享，并按「性质」分层管理。
 *
 * 核心模型：**一个大脑，七个模块**
 *
 *   记忆模块（会被召回、会被注入）
 *     底线 bottomline  操作限制、禁令、权限边界 —— 硬约束，永不协商，总是注入
 *     认知 cognition  事实、结论、决定       —— 置信度加权，相关时召回
 *     情感 emotion    关系、偏好、情绪、称呼   —— 亲密度加权，相关时召回
 *     本能 instinct   反复使用的行为习惯       —— 频次加权，高频自动触发
 *
 *   人设模块（人设与记忆合并到同一份状态）
 *     声音 voice      说话方式、语气、口头禅   —— 常驻生效
 *
 *   能力模块（行为开关，不是记忆条目）
 *     网络 network    允许对外获取信息 → 「学习」
 *     自动互动 agentive 允许主观能动性 → 「主动」
 *
 * 每一层的记忆条目都带**自己的权重**（0..1），模块本身也带权重，
 * 召回分数 = 基础相关性 × 条目权重 × 模块权重 + 模块加成。
 * 底线用「约束强度」当权重，认知用「置信度」，情感用「亲密度」，
 * 本能用「使用频次」，声音用「风格强度」。
 *
 * 数据落点（都在 DSH_HOME 下，跨 profile、跨会话共用）：
 *   ~/.dsh/storages/dsh-shared-brain/memory.json     共享记忆库（扁平条目，按模块分区）
 *   ~/.dsh/storages/dsh-shared-brain/modules.json    模块配置（权重、声音风格、能力开关）
 *   ~/.dsh/storages/dsh-persona-dafeiyu/personas.json 人设库（由人设插件拥有，本插件只守护）
 *   ~/.hindsight/coding-agent.json                    Hindsight 配置（本插件负责固定 bank）
 */
import { readStore, newId, brainFile, pruneExpired, redactStoreSecrets, isAlive, renewEntry, DEFAULT_TEMPORARY_TTL_MS, SOURCES } from './store.js'
import { recall, renderRecall } from './recall.js'
import { expandByPaths, renderPathExpansion } from './graph-expand.js'
import { summarizeTurn, isDuplicate } from './summarize.js'
import { activePersona, personaList, personaFile, adoptLegacyPersona, renderPersona } from './persona.js'
import { ensureGlobalBank, hindsightCredentialState, hindsightConfigFile, GLOBAL_BANK_ID } from './hindsight-config.js'
import { extractTurns, sessionEvents, messageText } from './transcript.js'
import { registerCommands } from './commands.js'
import { classify, topicOverlap, topicKeyOf } from './classify.js'
import { judgeLifetime } from './lifetime.js'
import { findConflicts } from './conflict.js'
import { readModules, putModuleItem, moduleSummary, ALL_MODULES, MODULE_LABELS, MEMORY_MODULES, MODULE_PROFILES, withinTimeWindow } from './modules.js'
import { createSessionCatalog } from './sessions.js'
import { ensureEmojiLoader, stopEmojiLoader, defaultEmojiDir } from './emoji.js'
import { startRemoteSync, stopRemoteSync } from './remote-sync.js'
import {
  setAgentContext,
  currentContext,
  setLastInjected,
  lastInjected,
  clearAgentContext,
  clearAll,
  trackedCount,
} from './agent-state.js'
import {
  startProactiveLoop,
  stopProactiveLoop,
  runProactiveNow,
  proactiveStatus,
  clearProactiveState,
  clampProactiveInterval,
  DEFAULT_PROACTIVE_INTERVAL_MS,
  PROACTIVE_INTERVAL_JITTER,
} from './proactive.js'
import { mkdirSync } from 'node:fs'
import { recallModules, renderModuleRecall, renderVoice, renderCapabilities } from './weighted-recall.js'
import { proposeEmoji, renderEmojiHint, normalizeEmojiAffinity } from './emoji-affinity.js'
// 2026-11-03：内置表情包（大肥鱼 100 张 GIF，CC BY-NC-SA 4.0）——
// 不装 dsh-emoji 也能让模型贴出真图，靠的是插件自己的静态路由。
import { BUILTIN_EMOJI_ROUTE, handleBuiltinEmojiRequest, renderBuiltinEmojiHint } from './emoji-builtin.js'
import {
  judgeMood,
  judgeModeOf,
  renderMoodContext,
  getMoodState,
  saveMoodState,
  readEmotionStore,
  writeEmotionStore,
  normalizeMoodConfig,
  emotionItemInScope,
  sameSessionKey,
  applyMoodDelta,
  clearMoodState,
} from './emotion.js'
import {
  BRIDGE_STATUS_PATH,
  BRIDGE_MUTATE_PATH,
  isLoopbackRequest,
  writeJson,
  readJsonBody,
  snapshotOf,
  mutateModules,
  setSessionCatalogProvider,
  setSessionRefresher,
  setBridgeContext,
  setModulesChangedHandler,
  refreshSessions,
} from './bridge.js'
import { writeStoreSynced, writeModulesSynced, startCursorBridge } from './cross-sync.js'

const name = 'dsh-shared-brain'
// 2026-11-02：加 'llm' —— 心情判定要用宿主自己的模型（ctx.llm.stream），
// 跟 dsh-feiyu-mood 一样。不声明这个服务，ctx.llm 就不存在。
const inject = ['systemPrompt', 'agents', 'commands', 'llm']

/** 注入到系统提示词里的段落名。 */
const RECALL_SECTION = 'shared-brain:memory'
/** 人设摘要段落名。 */
const PERSONA_SECTION = 'shared-brain:persona'
/** 声音段落名。 */
const VOICE_SECTION = 'shared-brain:voice'
/** 能力段落名。 */
const CAPABILITY_SECTION = 'shared-brain:capability'
/** 心情段落名（走 context，order 排在人设/记忆之前）。 */
const MOOD_CONTEXT = 'shared-brain:mood'

/** 一次最多注入多少条相关记忆。 */
const RECALL_LIMIT = 8
/** 记忆库最多留多少条，超出按时间淘汰最旧的。 */
const MAX_ENTRIES = 500

/** 状态，供 /shared-memory 命令与状态接口读取。 */
const state = {
  startedAt: 0,
  turnsSeen: 0,
  turnsSaved: 0,
  turnsSkipped: 0,
  recallsServed: 0,
  moodsServed: 0,
  moodsJudged: 0,
  lastError: null,
  personaNotes: [],
  hindsightNotes: [],
  moduleCounts: { bottomline: 0, cognition: 0, emotion: 0, instinct: 0 },
}

/** 每个会话已经摘要过几轮（同一轮不重复入账）。 */
const summarized = new Map()

/**
 * 当前所在会话的上下文。
 *
 * 以前这里是三个模块级变量（currentPrompt / currentSession / currentCwd），
 * 多个会话并发时互相覆盖 —— 子代理（task-board、im、ssh 等插件开的会话）
 * 会拿到父会话的提示词，记忆召回也跟着串味。现在按会话 id 分别存，
 * 见 lib/agent-state.js。
 */

/**
 * 判断某个工作区路径是否覆盖当前会话的工作目录。
 *
 * Windows 上路径大小写不敏感、分隔符也可能混用，所以两边都归一化再比。
 */
function pathMatches(scopePath, cwd) {
  const normalize = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const scope = normalize(scopePath)
  const target = normalize(cwd)
  if (!scope || !target) return false
  if (scope === target) return true
  // 父目录也算：设定了「D:/proj」的作用域，在「D:/proj/sub」里也该生效
  return target.startsWith(`${scope}/`)
}

/** 取会话 id。 */
function sessionIdOf(agent) {
  const id = agent?.session?.header?.id
  return typeof id === 'string' && id.length > 0 ? id : ''
}

/** 取会话工作目录。 */
function cwdOf(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : ''
}

/**
 * 取会话标题。
 * header 里没有标题字段，所以从 meta 里找常见的几个键；找不到就退回短 id。
 */
function sessionTitleOf(agent) {
  const meta = agent?.session?.meta
  const candidates = ['title', 'name', 'summary', 'label']
  if (meta && typeof meta === 'object') {
    for (const key of candidates) {
      const value = meta[key]
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 60)
    }
  }
  const id = sessionIdOf(agent)
  if (!id) return ''
  // 会话 id 一般是 `session-xxxx`，直接 slice 会截成「session-」，退回短名更可读
  const stripped = id.startsWith('session-') ? id.slice('session-'.length) : id
  return stripped.slice(0, 8)
}

/** 待办线索的关键词（命中任意一个就算「还没做完的承诺」）。 */
const PENDING_HINTS = [
  '还没', '没做', '待办', '稍后', '回头', '改天', '之后要', '下次要',
  '记得', '答应', '承诺', '提醒我', '别忘', '欠', '留着', '回头再',
]

/**
 * 从共享记忆里找「还没做完的承诺」，作为主动搭话的待办线索。
 *
 * 心情驱动的决策层有一条硬规则：**有真待办就一定要说**（答应过的事不能
 * 拖）。这里的「真待办」就是从记忆里认出来的承诺型条目。
 *
 * @param {string} sessionId 会话 id（用来做作用域过滤）
 * @returns {string[]} 待办线索文本（最多 5 条）
 */
function pendingHintsOf(sessionId = '') {
  try {
    const store = readStore()
    const hits = []
    for (const entry of store.entries ?? []) {
      if (!entry || typeof entry.text !== 'string') continue
      if (!isAlive(entry)) continue
      // 底线不算待办 —— 那是约束，不是「没做完的事」
      if (entry.module === 'bottomline') continue
      // 2026-11-03（P0-2）：只认老大亲口说的（source === 'manual'）。
      // 以前只看正文里的「待办」「继续」等关键词，于是本鱼自己写的
      // 工作日志快照（source='auto'）也被当成老大交代的待办 ——
      // 内部日志在偷偷决定对老大说什么。
      if (entry.source !== 'manual') continue
      const text = entry.text.trim()
      if (!text) continue
      // 权重太低的（不太确定的说法）不当真待办
      if (Number(entry.weight ?? 0) < 0.5) continue
      // 作用域：只认全局的、或者正好属于这个工作区/会话的
      const scope = entry.scope ?? 'global'
      if (scope === 'session') {
        if (!sameSessionKey(entry.sessionId ?? '', sessionId)) continue
      }
      if (!PENDING_HINTS.some((hint) => text.includes(hint))) continue
      hits.push(text)
      if (hits.length >= 5) break
    }
    return hits
  } catch {
    return []
  }
}

/**
 * 从一段消息列表里取出用户发来的文本。
 * 宿主给用户消息打 source.kind = 'user'（与 hindsight 插件读法一致），
 * 但万一路径不同、只留了 role，这里也认。
 */function userTextOf(messages) {
  return (messages ?? [])
    .filter((message) => {
      const kind = message?.source?.kind
      if (kind) return kind === 'user'
      return message?.role === 'user'
    })
    .flatMap((message) => message.content ?? [])
    .filter((block) => block?.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 取这一轮里最后一条「用户说的话」及其来源标记。
 *
 * 来源标记用来分口径：宿主注入的上下文（runtime-context 之类）不算
 * 「老大在说话」，定时任务叫起来的也不是，自己搭话又是另一回事。
 *
 * extractTurns 切出来的轮次里 user 是**纯文本**，拿不到来源标记，
 * 所以这里直接读事件流：最后一条 kind==='user' 的消息。
 */
/**
 * 取会话里最后一条「有文本的消息」。
 *
 * 宿主把所有人说的话（包括插件自己主动搭话）都记成 user/message，
 * 区别只在 source.kind：
 *   'user'                   —— 老大说的
 *   'plugin:dsh-shared-brain' —— 我们自己主动搭话说的（form:'proactive'）
 *
 * allowSelfTalk=false 时只看老大说的（老语义）；
 * allowSelfTalk=true 时也认我们自己主动搭话那条 —— 反馈闭环要用它。
 */
function lastMessageTurnOf(agent, allowSelfTalk = false) {
  try {
    const events = sessionEvents(agent?.session)
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type !== 'user/message') continue
      const message = event.data?.message ?? event.data
      const kind = message?.source?.kind
      const isSelfTalk = Boolean(kind) && kind !== 'user'
      if (isSelfTalk && !allowSelfTalk) continue
      // 没有 kind 时靠 role 兜底
      if (!kind && message?.role && message.role !== 'user') continue
      const text = messageText(message)
      if (!text) continue
      return { text, sourceKind: String(kind ?? 'user') }
    }
  } catch {
    // 取不到就退回上下文里的提示词
  }
  return null
}


/**
 * 判断这一轮的心情，并更新状态。
 *
 * 流程：
 *   1. 拿到这一轮用户说的话 + 自己说的话
 *   2. 按来源分口径（用户说话 / 自己搭话 / 定时任务 / 宿主注入→跳过）
 *   3. 用宿主自己的模型判一次（ctx.llm）
 *   4. 把判定应用到心情状态上（步长 1/3、两头饱和、显著才记账）
 *
 * 全程异步，不阻塞这一轮结束；失败只记日志，不影响聊天。
 */
async function judgeMoodForTurn(ctx, agent, logger) {
  try {
    const store = readEmotionStore()
    const config = normalizeMoodConfig(store.config)
    if (!config.enabled) return
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return

    // ── 反馈闭环（P1-9，2026-11-03）────────────────────────────
    // 这一轮到底是谁在说话？事件流里长这样：
    //   老大说话  → user/message kind='user' + assistant/message
    //   我们主动  → user/message kind='plugin:dsh-shared-brain' + assistant/message
    //
    // 以前这里有两个错：
    //   1) extractTurns 会跳过插件那条消息，于是主动搭话那一轮根本没被切成
    //      turn，我们自己的回复挂到了上一轮（串味）或被丢掉；
    //   2) userText 取的是 lastMessageTurnOf(...).text —— 主动搭话时拿到的是
    //      **我们自己的提示词模板**，老大真说的话压根没进判定。
    // 现在按来源分口径：谁说的就判谁。
    const turns = extractTurns(sessionEvents(agent?.session), { includeSelfTalk: true })
    const lastTurn = turns[turns.length - 1]
    if (!lastTurn) return

    // 这一轮是「老大说的」还是「我们自己搭话说的」。
    const mode = judgeModeOf(lastTurn.sourceKind)
    if (!mode) return

    // 我们自己这一轮说了什么（判据主体）。
    const reply = String(lastTurn.assistant ?? '').trim()
    if (!reply) return

    // 判据里的「对方说了什么」：
    //   - 自己搭话那轮 → 没有对方，取触发上下文当背景（判据主体仍是 reply）
    //   - 老大说话那轮 → 取老大真说的话（不能再被插件的模板顶掉）
    const userText = lastTurn.selfTalk
      ? (currentContext(sessionId).prompt || '')
      : String(lastTurn.user ?? '').trim()

    const delta = await judgeMood(ctx, agent, userText, reply, {
      mode,
      provider: config.judgeProvider,
      model: config.judgeModel,
      aliases: config.aliases,
      ownerName: '老大',
      onError: (message) => logger?.warn?.(`心情判定失败：${message}`),
    })
    if (!delta) return
    state.moodsJudged += 1

    const { state: moodState } = getMoodState(sessionId)
    applyMoodDelta(moodState, delta, {
      moodFloor: config.moodFloor,
      sigMood: config.sigMood,
      sigDim: config.sigDim,
    })
    saveMoodState(sessionId, moodState)
  } catch (error) {
    state.lastError = String(error?.message ?? error)
    logger?.warn?.(`心情判定出错：${state.lastError}`)
  }
}

/**
 * 把这一轮的对话摘要写进共享记忆库，并路由到对应模块。
 *
 * 流程：
 *   1. 摘要 → 分类（底线 / 情感 / 本能 / 认知）
 *   2. 查重：完全重复的跳过；主题重复的强化权重（这正是「反复使用 → 本能」）
 *   3. 写回扁平库（带 module 字段）+ 同步模块配置里的条目
 */
function persistTurn(agent) {
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return
  const turns = extractTurns(sessionEvents(agent?.session))
  const done = summarized.get(sessionId) ?? 0

  for (let index = done; index < turns.length; index++) {
    const turn = turns[index]
    const summary = summarizeTurn(turn)
    if (!summary) {
      state.turnsSkipped += 1
      continue
    }
    const store = readStore()
    const candidate = { ...summary, sessionId, cwd: cwdOf(agent) }
    if (store.entries.some((entry) => isDuplicate(entry, candidate))) {
      state.turnsSkipped += 1
      continue
    }

    // 计算「同一主题已出现几次」——用来判定是否升级为本能
    const similar = store.entries.filter((entry) => topicOverlap(entry, candidate))
    const classification = classify(summary, { repeatCount: similar.length })
    const moduleKey = classification.module

    const now = Date.now()
    // 寿命自动判定：内容自带时间窗口、是易变状态、还是长期稳定，由 lifetime.js 说了算。
    const life = judgeLifetime(summary, { now })
    // 冲突检测：新说法如果推翻了旧说法（改用/换成/其实是…），记下被取代的旧条目。
    const conflicts = findConflicts(store.entries, { ...candidate, updatedAt: now })
    const entry = {
      id: newId(),
      text: candidate.text,
      tags: candidate.tags,
      // 2026-11-03（P1-11）：把话题键存下来。
      // 不存的话每次判「同一主题」都要重新抽关键词，慢且可能抖动；
      // 存下来还能在设置页让人看见「这条属于哪个话题」。
      topicKey: topicKeyOf(candidate.text),
      module: moduleKey,
      weight: classification.weight,
      lifetime: life.lifetime,
      expiresAt: life.expiresAt,
      ttlMs: life.ttlMs ?? (life.lifetime === 'temporary' ? DEFAULT_TEMPORARY_TTL_MS : 0),
      // 自动分类的一律不算钉住：底线要用户手动钉。
      pinned: false,
      source: 'auto',
      scope: 'global',
      scopePath: '',
      scopeSession: '',
      // 情感语义字段（2026-11-02）
      ...(moduleKey === 'emotion'
        ? {
            intimacy: classification.intimacy ?? classification.weight,
            sentiment: classification.sentiment ?? 'neutral',
            target: classification.target ?? 'general',
          }
        : {}),
      supersedes: conflicts.length > 0 ? conflicts[conflicts.length - 1].id : '',
      sessionId,
      cwd: candidate.cwd,
      createdAt: now,
      updatedAt: now,
      hits: 0,
    }
    store.entries.push(entry)
    if (store.entries.length > MAX_ENTRIES) {
      store.entries.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
      store.entries = store.entries.slice(store.entries.length - MAX_ENTRIES)
    }
    writeStoreSynced(store)

    // 同步进模块配置（模块里保存的是「带权重的条目副本」，方便单独调权重）
    const modules = readModules()
    putModuleItem(modules, moduleKey, {
      text: candidate.text,
      weight: classification.weight,
      // 情感条目的语义字段（亲密度 / 极性 / 对象）——2026-11-02
      ...(moduleKey === 'emotion'
        ? {
            intimacy: classification.intimacy ?? classification.weight,
            sentiment: classification.sentiment ?? 'neutral',
            target: classification.target ?? 'general',
          }
        : {}),
      tags: candidate.tags,
      pinned: false,
      source: 'auto',
      lifetime: life.lifetime,
      expiresAt: life.expiresAt,
      ttlMs: life.ttlMs ?? 0,
      supersedes: entry.supersedes,
    })
    writeModulesSynced(modules)

    state.moduleCounts[moduleKey] = (state.moduleCounts[moduleKey] ?? 0) + 1
    state.turnsSaved += 1
    if (conflicts.length > 0) {
      state.conflictsFound = (state.conflictsFound ?? 0) + conflicts.length
    }
  }
  summarized.set(sessionId, turns.length)
}

/**
 * 同一轮里的召回结果缓存（P0-3，2026-11-03）。
 *
 * 以前 RECALL_SECTION（systemPrompt 段落）和 agent/pre-step 钩子
 * 各跑一次 recallFor —— 同一批记忆被渲染两遍、塞进提示词两遍，
 * 模型读两遍，召回开销也翻倍。
 * 现在算一次，两边共用同一份渲染文本。
 */
const recallCache = new Map()

/** 缓存键：会话 + 工作目录 + 本轮提示词。 */
function recallCacheKey(sessionId, prompt, cwd) {
  return `${sessionId} ${cwd} ${prompt}`
}

/**
 * 取本轮的召回文本（带缓存）。
 *
 * @returns {{ rendered: string, fresh: boolean }} rendered 是渲染好的提示词；
 *   fresh 表示这次是真算出来的（不是命中缓存）。
 */
function recallRendered(prompt, cwd, sessionId) {
  const key = recallCacheKey(sessionId, prompt, cwd)
  const cached = recallCache.get(key)
  if (cached !== undefined) return { rendered: cached, fresh: false }
  const result = recallFor(prompt, cwd, sessionId)
  const rendered = result.hits.length === 0 && result.always.length === 0 ? '' : renderModuleRecall(result)
  // 简单上限：最多缓存 32 条，先进先出。
  if (recallCache.size >= 32) {
    const oldest = recallCache.keys().next()
    if (!oldest.done) recallCache.delete(oldest.value)
  }
  recallCache.set(key, rendered)
  return { rendered, fresh: true }
}

/**
 * 跨模块召回：把扁平库里属于各模块的条目收集起来，交给加权召回。
 *
 * 同时做两件维护工作：
 *   1. 清理已过期的临时记忆（顺手写回磁盘，别让垃圾一直堆着）
 *   2. 归位时带上 lifetime / pinned / expiresAt，让召回层能判断有效性
 *
 * @param {string} text 本轮提示词，用来做相关度打分
 * @param {string} cwd 当前会话的工作目录（用于「限定工作区」的条目过滤）
 * @param {string} sessionId 当前会话 id（用于「限定会话」的条目过滤）
 */
function recallFor(text, cwd = '', sessionId = '') {
  const raw = readStore()
  const { store, removed } = pruneExpired(raw)
  // 脱敏是后加的，库里可能还躺着老版本存进去的密钥，清一次
  const { cleaned } = redactStoreSecrets(store)
  if (removed > 0 || cleaned > 0) writeStoreSynced(store)
  const modules = readModules()

  // 把扁平库的条目按模块归位（模块配置里的条目是权威副本，这里做一次合并）
  const byModule = {}
  for (const key of MEMORY_MODULES) byModule[key] = []
  for (const entry of store.entries) {
    const key = MEMORY_MODULES.includes(entry.module) ? entry.module : 'cognition'
    byModule[key].push({
      id: entry.id,
      text: entry.text,
      tags: entry.tags,
      weight: Number.isFinite(entry.weight) ? entry.weight : 0.5,
      lifetime: entry.lifetime === 'temporary' ? 'temporary' : 'permanent',
      expiresAt: entry.expiresAt ?? 0,
      pinned: entry.pinned === true,
      // 2026-11-03（P0-2）：跟 store.js 一样保住来源，别把 sync 变成 auto。
      source: SOURCES.includes(entry.source) ? entry.source : 'auto',
      scope: ['global', 'workspace', 'session'].includes(entry.scope) ? entry.scope : 'global',
      scopePath: entry.scopePath ?? '',
      scopeSession: entry.scopeSession ?? '',
      // 情感语义字段（2026-11-02）：亲密度 / 极性 / 对象
      ...(key === 'emotion'
        ? {
            intimacy: Number.isFinite(entry.intimacy) ? entry.intimacy : entry.weight,
            sentiment: entry.sentiment ?? 'neutral',
            target: entry.target ?? 'general',
          }
        : {}),
      supersedes: entry.supersedes ?? '',
      hits: entry.hits ?? 0,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })
  }

  // 模块配置里手工加的条目（没在扁平库里的）也要算进来
  for (const key of MEMORY_MODULES) {
    const bucket = modules[key]
    if (!bucket?.enabled) continue
    for (const item of bucket.items ?? []) {
      if (!byModule[key].some((e) => e.text.slice(0, 40) === item.text.slice(0, 40))) {
        byModule[key].push(item)
      }
    }
  }

  const merged = { ...modules }
  for (const key of MEMORY_MODULES) merged[key] = { ...modules[key], items: byModule[key] }

  // 作用域过滤：
  //   workspace —— 只在该工作区的会话里生效
  //   session   —— 只在指定会话里生效（2026-11-02 新增）
  const inScope = (item) => {
    if (!item) return false
    if (item.scope === 'workspace') {
      if (!item.scopePath) return false
      if (!cwd) return false
      return pathMatches(item.scopePath, cwd)
    }
    if (item.scope === 'session') {
      if (!item.scopeSession) return false
      if (!sessionId) return false
      return sameSessionKey(item.scopeSession, sessionId)
    }
    return true
  }
  for (const key of MEMORY_MODULES) {
    merged[key].items = merged[key].items.filter(inScope)
  }

  const result = recallModules(merged, text, { limit: RECALL_LIMIT })

  // 路径扩展：命中记忆里带了文件/目录路径时，顺着目录图谱把相关文件带出来。
  // 图谱插件不在或索引为空时，这里什么都不做（不影响召回本身）。
  let expansion = { paths: [], related: [] }
  try {
    expansion = expandByPaths([...result.hits, ...result.always], { limit: 6 })
  } catch (error) {
    logger?.warn?.(`路径扩展失败：${String(error?.message ?? error)}`)
  }
  result.expansion = expansion

  // 记一次热度；临时记忆被召回就**续期**（滑动窗口：还在用就不急着过期）
  if (result.hits.length > 0 || result.always.length > 0) {
    const hitIds = new Set([...result.hits, ...result.always].map((hit) => hit.item.id))
    const now = Date.now()
    let touched = false
    store.entries = store.entries.map((entry) => {
      if (!hitIds.has(entry.id)) return entry
      touched = true
      const renewed = renewEntry(entry, now)
      return { ...renewed, hits: (entry.hits ?? 0) + 1 }
    })
    if (touched) writeStoreSynced(store)
  }
  return result
}

/**
 * 人设段落：**注入人设正文**。
 *
 * 人设由本插件自己拥有（~/.dsh/storages/dsh-shared-brain/persona.json），
 * 不再依赖别的人设插件；切换人设后，下一个请求立即用新正文，无需重启。
 *
 * 支持「按会话指定」：某个会话单独指定了人设就用那个，否则用全局的。
 */
function personaText(sessionId = '') {
  const persona = activePersona(sessionId)
  if (!persona?.text) return ''
  return renderPersona(persona)
}

/**
 * 会话目录（工作区 → 会话）走 lib/sessions.js：它同时读活跃会话、持久化快照与
 * 工作区注册表，后台刷新 + 读缓存，不会让设置页每次都去翻磁盘。
 */
export function apply(ctx) {
  const logger = ctx.logger ? ctx.logger(name) : null
  state.startedAt = Date.now()
  const sessionCatalog = createSessionCatalog(ctx)

  // ── 阶段 1：准备人设与 Hindsight 的全局设定 ──────────────────────
  // 人设现在由本插件自己拥有：先看有没有旧人设插件的库，有就一次性导入过来当初始值。
  const adopt = adoptLegacyPersona()
  state.personaNotes = adopt.imported ? [adopt.note] : []
  if (adopt.imported) {
    logger?.info?.(adopt.note)
  }
  const persona = activePersona()
  logger?.info?.(`当前人设：${persona.name}（${persona.id}），库：${personaFile()}`)

  const credential = hindsightCredentialState()
  const hindsightResult = ensureGlobalBank({ enable: credential.usable })
  state.hindsightNotes = hindsightResult.notes
  if (hindsightResult.changed) {
    logger?.info?.(`记忆库已统一：${hindsightResult.notes.join('；')}`)
  }
  if (!credential.usable) {
    logger?.info?.(`Hindsight 未启用（${credential.reason}），改用本地共享记忆：${brainFile()}`)
  }

  // 初始化模块配置（第一次会写入默认的声音风格与能力开关）
  const modules = readModules()
  writeModulesSynced(modules)
  const summary = moduleSummary(modules)
  logger?.info?.(
    `大脑模块已就绪：底线 ${summary.bottomline.count} 条、认知 ${summary.cognition.count} 条、情感 ${summary.emotion.count} 条、本能 ${summary.instinct.count} 条；` +
    `网络${modules.network.enabled ? '开' : '关'}、自动互动${modules.agentive.enabled ? '开' : '关'}`,
  )

  // 表情包目录：按配置起一个定时扫描器，往目录里丢文件就够了
  // 默认目录先建出来，省得用户「想放表情却找不到目录」
  if (!String(modules.voice?.style?.emojiDir ?? '').trim()) {
    try {
      mkdirSync(defaultEmojiDir(), { recursive: true })
    } catch {
      // 建不出来也不影响插件跑，界面会显示目录状态
    }
  }
  const emojiAuto = ensureEmojiLoader(modules.voice?.style ?? {})
  logger?.info?.(
    emojiAuto.enabled
      ? `表情包自动加载已启动：每 ${Math.max(1, Math.round(emojiAuto.intervalMs / 60000))} 分钟扫一次「${emojiAuto.dir}」，现在读到 ${emojiAuto.count} 个表情` +
        (emojiAuto.error ? `（${emojiAuto.error}）` : '')
      : `表情包自动加载已关闭（「${emojiAuto.dir}」），只在手动重扫时更新`,
  )
  // 插件卸载时把定时器收掉，别留个幽灵在宿主里
  ctx.effect(() => () => stopEmojiLoader(), 'dsh-shared-brain: emoji auto loader')

  // ── 阶段 2：注册提示词段落 ──────────────────────────────────────
  // 注意：这几段是**全局注册**的（ctx.systemPrompt.section），所以所有 agent
  // 都会拿到 —— 包括 task-board、im、ssh 等插件自己开的会话和子代理。
  // `text(context)` 回调里带 `context.agent`，所以能按会话区分人设与作用域。

  // 人设段落：注入当前人设正文（支持按会话指定的人设）。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PERSONA_SECTION,
        order: 1501,
        text: (context) => {
          const sessionId = context?.agent?.session?.header?.id ?? ''
          return personaText(sessionId)
        },
        interpolate: false,
      }),
    'dsh-shared-brain: persona section',
  )

  // 声音段落：常驻，规定「怎么说话」。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: VOICE_SECTION,
        order: 1502,
        text: () => renderVoice(readModules()),
        interpolate: false,
      }),
    'dsh-shared-brain: voice section',
  )

  // 能力段落：网络与自动互动的开关说明。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: CAPABILITY_SECTION,
        order: 1503,
        text: (context) => {
          const sessionId = context?.agent?.session?.header?.id ?? ''
          const title = sessionTitleOf(context?.agent)
          return renderCapabilities(readModules(), { sessionId, sessionTitle: title })
        },
        interpolate: false,
      }),
    'dsh-shared-brain: capability section',
  )

  // 记忆段落：每轮组装提示词时重新召回，命中什么给什么。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: RECALL_SECTION,
        order: 1500,
        text: (context) => {
          const sessionId = context?.agent?.session?.header?.id ?? ''
          const scope = currentContext(sessionId)
          const prompt = scope.prompt
          if (!prompt) return ''
          const { rendered, fresh } = recallRendered(prompt, scope.cwd, sessionId)
          if (!rendered) return ''
          if (fresh) state.recallsServed += 1
          return rendered
          if (result.hits.length === 0 && result.always.length === 0) return ''
          state.recallsServed += 1
          return renderModuleRecall(result)
        },
        interpolate: false,
      }),
    'dsh-shared-brain: memory section',
  )

  // ── 心情段落（2026-11-02）───────────────────────────────────────
  // 心情是**动态状态**：这一轮说完之后才知道涨跌，所以不能像记忆那样在
  // 「组装提示词时」就算好 —— 必须等这一轮结束、模型回了话，才判一次。
  //
  // 注入走 `systemPrompt.context`（不是 section）：
  //   context 参与**前缀缓存**，section 每次都会改写提示词前缀。
  //   心情每轮都可能变，走 section 会把前缀缓存打散，聊天一长就多花钱。
  //
  // 「一次变化只说一次」：injectedFor === updatedAt 时不再重复说。
  // 每轮都带同样一句话，会变成背景音，把说话口气定死。
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: MOOD_CONTEXT,
        order: 900,
        text: (context) => {
          try {
            const sessionId = context?.agent?.session?.header?.id ?? ''
            if (!sessionId) return ''
            const { state: moodState, config } = getMoodState(sessionId)
            if (!config.enabled) return ''
            const rendered = renderMoodContext(moodState, {
              mode: config.injectMode,
              injectConfidence: config.injectConfidence,
              injectPerDay: config.injectPerDay,
              onMarkInjected: () => {
                // 判得没底 / 小波动 —— 标记成「处理过了」，免得每轮都重复记一条。
                // 2026-11-03（P1-10）：按 revision 记，不按 updatedAt ——
                // updatedAt 每次写状态都会变，标记永远追不上。
                moodState.injectedFor = Number(moodState.revision) || 0
                saveMoodState(sessionId, moodState)
              },
            })
            if (!rendered) return ''
            // 说出去之前先记账：这一轮算「已经告诉过它了」（同样按 revision）
            moodState.injectedFor = Number(moodState.revision) || 0
            moodState.saidAt = [...(moodState.saidAt || []), Date.now()].slice(-50)
            saveMoodState(sessionId, moodState)
            state.moodsServed += 1
            // 阶段 B3：同一段心情上下文里带上「这会儿适合什么表情」。
            // 表情提示跟心情绑在一起是有意的 —— 心情低落时甩一个「庆祝」，
            // 比不说话还糟。禁忌由 emoji-affinity.js 的 avoid 表负责。
            // 表情提示**不参与**「一次变化只说一次」的记账：它跟着心情一起说，
            // 心情不变就不再重复说，够了。
            let emojiHint = ''
            try {
              const style = readModules().voice?.style ?? {}
              const proposal = proposeEmoji({
                moodState,
                config: normalizeEmojiAffinity(style.emojiSemantic),
              })
              emojiHint = renderEmojiHint(proposal)
              // 内置表情包：直接给现成的 markdown 图片，模型照抄就能出图，
              // 不依赖 dsh-emoji 插件。拿不到端口（比如宿主没 webServer）就跳过。
              const port = ctx?.get?.('webServer')?.port
              const builtin = renderBuiltinEmojiHint(proposal, port)
              if (builtin) emojiHint = emojiHint ? `${emojiHint}\n${builtin}` : builtin
            } catch {
              // 表情提示算附加信息，出错就当没有
            }
            return emojiHint ? `${rendered}
${emojiHint}` : rendered
          } catch (error) {
            state.lastError = String(error?.message ?? error)
            return ''
          }
        },
      }),
    'dsh-shared-brain: mood context',
  )

  // ── 阶段 3：会话钩子 ────────────────────────────────────────────
  // pre-step：在模型看到本轮提示词之前召回记忆；拿到回复之后由 turn-stopping 入库。
  //
  // 这里有两处关键改动：
  //   1. 上下文按 agent 取（context.agent.session.header.id），不再用模块级变量，
  //      所以并发会话不会互相污染；
  //   2. 改写 decision 时用 `{ ...decision, messages }`（宿主文档要求 spread，
  //      否则会丢掉 startsRequestSeries 之类的字段），并且按会话去重，
  //      避免同一个召回内容在每一步都塞一遍。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal?.aborted) return decision
    try {
      const sessionId = sessionIdOf(agent)
      const prompt = userTextOf(decision.messages)
      // 记住这个会话的上下文（提示词 / 工作目录 / 标题），供提示词段落与作用域判断使用
      setAgentContext(sessionId, {
        sessionId,
        title: sessionTitleOf(agent),
        cwd: cwdOf(agent),
        prompt,
      })
      if (!prompt) return decision

      // 会话目录按需刷新（内部节流），设置页打开时就能看到当前会话
      sessionCatalog.setCurrent(sessionId)
      void sessionCatalog.refresh()

      const { rendered } = recallRendered(prompt, cwdOf(agent), sessionId)
      if (!rendered) return decision

      // 去重：同一会话里召回内容没变就不重复注入
      if (lastInjected(sessionId) === rendered) return decision
      setLastInjected(sessionId, rendered)

      const injection = {
        id: `shared-memory-${sessionId || 'x'}-${Date.now().toString(36)}`,
        role: 'user',
        content: [{ type: 'text', text: `<shared-memory-injection>\n${rendered}\n</shared-memory-injection>` }],
        source: { kind: `plugin:${name}`, form: 'recall' },
      }
      // 插在「刚领取的用户消息」之后，而不是整个列表末尾——末尾可能被
      // runtime-context 之类占着，插在后面更贴近模型读到的顺序。
      const claimed = Array.isArray(messages) ? messages : []
      const lastClaimedIndex = decision.messages.findLastIndex((message) => claimed.includes(message))
      const at = lastClaimedIndex >= 0 ? lastClaimedIndex + 1 : decision.messages.length
      return { ...decision, messages: decision.messages.toSpliced(at, 0, injection) }
    } catch (error) {
      state.lastError = String(error?.message ?? error)
      logger?.warn?.(`召回共享记忆失败：${state.lastError}`)
      return decision
    }
  }, { prepend: true })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      state.turnsSeen += 1
      persistTurn(agent)
    } catch (error) {
      state.lastError = String(error?.message ?? error)
      logger?.warn?.(`写入共享记忆失败：${state.lastError}`)
    }
    // 心情判定：这一轮说完了，才知道心情怎么变的。
    // 异步跑，不阻塞这一轮结束。
    void judgeMoodForTurn(ctx, agent, logger)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId) {
      summarized.delete(sessionId)
      clearAgentContext(sessionId)
      // 2026-11-03（P0-4）：会话结束顺手清掉它的心情状态。
      // 以前只清摘要游标和上下文，emotion.json 里的心情永久留着 ——
      // 会话 id 复用时新会话带着上个会话的心情，库也无限膨胀。
      try {
        clearMoodState(sessionId)
      } catch {
        // 清不掉就算了，不该因为清心情失败把宿主带崩
      }
    }
  })

  // ── 阶段 3.5：自动互动真的动起来 ────────────────────────────────
  // 「自动互动」以前只是一句提示词，用户看不到任何反应。现在起一个定时器，
  // 定期对还活着的会话发一条「主动搭话」的指令（agent.followup 会唤醒会话）。
  // 间隔、开关都在 agentive 模块里配，改完立即生效（重起定时器即可）。
  //
  // 2026-11-02：接上心情驱动 —— 自动互动不再是「定时器一到就发同一段模板」，
  // 而是先看这个会话现在什么心情、什么状态，再决定说不说、什么调子、聊什么。
  const restartProactive = () => {
    const modules = readModules()
    const agentive = modules.agentive ?? {}
    if (!agentive.enabled) {
      stopProactiveLoop()
      return
    }
    startProactiveLoop(ctx, {
      intervalMs: clampProactiveInterval(agentive.intervalMs ?? DEFAULT_PROACTIVE_INTERVAL_MS),
      getAgentive: () => readModules().agentive ?? {},
      // 心情驱动的配置（在设置页「自动互动」里调）
      getMoodConfig: () => readModules().agentive?.mood ?? {},
      // 这个会话现在的心情状态（读情绪库，失败就返回 null，决策层会走中性分支）
      getMoodState: (sessionId) => {
        try {
          const { state, config } = getMoodState(sessionId)
          // 心情功能整体关着时，就不要用心情驱动（但也别因此关掉自动互动）
          if (!config?.enabled) return null
          return state
        } catch {
          return null
        }
      },
      // 会话标题（让搭话知道自己在跟谁说话）
      getTitle: (sessionId) => {
        try {
          const flat = sessionCatalog.snapshot()?.flat ?? []
          const key = String(sessionId ?? '').trim().replace(/^session-/, '')
          const hit = flat.find((item) => String(item?.id ?? '').trim().replace(/^session-/, '') === key)
          return hit?.title ?? ''
        } catch {
          return ''
        }
      },
      // 待办线索：共享记忆里带「承诺 / 待办 / 还没做完」这类词的高权重条目
      getPending: (sessionId) => pendingHintsOf(sessionId),
    })
  }
  // 跨机同步：把记忆 / 人设 / 设置放到一个私有 Git 仓库里，多台机器共用一个大脑
  try {
    const remote = startRemoteSync()
    if (remote.running) logger?.info?.(`跨机同步：已开启，每 ${Math.round(remote.intervalMs / 60000)} 分钟一次`)
    else if (remote.reason && remote.reason !== 'disabled') logger?.info?.(`跨机同步：未运行（${remote.reason}）`)
  } catch (error) {
    logger?.warn?.(`跨机同步启动失败：${error instanceof Error ? error.message : String(error)}`)
  }
  ctx.effect(() => () => stopRemoteSync(), 'dsh-shared-brain: remote sync')
  restartProactive()
  // 设置页改了自动互动的开关/间隔后，立刻重启定时器，不用等下次重启
  setModulesChangedHandler(() => restartProactive())
  // 「modules.json」也可能被插件以外的进程改写（例如 Cursor 共享大脑扩展的同步），
  // 那种写入收不到 notify，插件里就会出现「配置里已经是开的，进程里定时器还停着」。
  // 这里每 30 秒廉价地对一次账，不一致才重启，让开关最终总是生效。
  //
  // 注意：间隔现在是**随机**的，定时器每次自己算下一个实际间隔，
  // 所以这里只能拿「基准间隔」去对账，不能拿实际间隔去比——
  // 否则每 30 秒都会觉得「不一致」而重启定时器，随机间隔就被钉死在第一次的值了。
  const syncProactive = () => {
    const agentive = readModules().agentive ?? {}
    const wanted = Boolean(agentive.enabled)
    const interval = clampProactiveInterval(agentive.intervalMs ?? DEFAULT_PROACTIVE_INTERVAL_MS)
    const status = proactiveStatus()
    if (wanted === status.running && (!wanted || status.intervalMs === interval)) return
    restartProactive()
  }
  const proactiveWatchdog = setInterval(syncProactive, 30_000)
  proactiveWatchdog.unref?.()
  ctx.effect(() => () => {
    clearInterval(proactiveWatchdog)
    stopProactiveLoop()
    clearProactiveState()
    clearAll()
  }, 'dsh-shared-brain: proactive loop')
  logger?.info?.(
    `自动互动：${readModules().agentive?.enabled ? '已开启' : '已关闭'}，基准间隔 ${Math.round(proactiveStatus().intervalMs / 60000)} 分钟（实际每次在 ${Math.round(proactiveStatus().intervalMs / 60000 * (1 - PROACTIVE_INTERVAL_JITTER))}~${Math.round(proactiveStatus().intervalMs / 60000 * (1 + PROACTIVE_INTERVAL_JITTER))} 分钟之间随机）`,
  )

  // ── 阶段 3.9：与 Cursor 共享大脑扩展双向同步（registry + 协调锁）──
  ctx.effect(() => startCursorBridge(logger), 'dsh-shared-brain: cursor cross-sync')

  // ── 阶段 4：/shared-memory 命令 ──────────────────────────────────
  registerCommands(ctx)

  // ── 阶段 5：浏览器半侧的数据桥（设置页 / 侧边栏读写模块配置）─────
  // 把宿主的会话目录接进来，设置页才能列出工作区下的会话。
  // 启动后先在后台扫一次，设置页第一次打开就有东西可选。
  setSessionCatalogProvider(() => {
    sessionCatalog.setCurrent(currentContext().sessionId)
    return sessionCatalog.snapshot()
  })
  void sessionCatalog.refresh({ force: true })
  setSessionRefresher(() => sessionCatalog.refresh({ force: true }))
  setBridgeContext(ctx)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      scope.effect(
        () =>
          scope.webServer.register({
            kind: 'exact',
            path: BRIDGE_STATUS_PATH,
            handler: (request, response) => {
              if (!isLoopbackRequest(request)) {
                writeJson(response, 403, { ok: false, error: 'loopback requests only' })
                return
              }
              if ((request.method ?? 'GET') !== 'GET') {
                writeJson(response, 405, { ok: false, error: 'method not allowed' })
                return
              }
              void sessionCatalog.refresh()
              writeJson(response, 200, { ok: true, value: snapshotOf() })
            },
          }),
        'dsh-shared-brain: status bridge',
      )
      scope.effect(
        () =>
          scope.webServer.register({
            kind: 'exact',
            path: BRIDGE_MUTATE_PATH,
            handler: async (request, response) => {
              if (!isLoopbackRequest(request)) {
                writeJson(response, 403, { ok: false, error: 'loopback requests only' })
                return
              }
              if ((request.method ?? '') !== 'POST') {
                writeJson(response, 405, { ok: false, error: 'method not allowed' })
                return
              }
              const body = await readJsonBody(request)
              if (body === undefined) {
                writeJson(response, 400, { ok: false, error: 'malformed JSON body' })
                return
              }
              if (body?.action === 'refreshSessions') {
                const refreshed = await refreshSessions()
                writeJson(response, 200, {
                  ok: refreshed.ok,
                  error: refreshed.ok ? undefined : refreshed.error,
                  note: refreshed.note,
                  value: snapshotOf(),
                })
                return
              }
              const result = await mutateModules(body)
              if (!result.ok) {
                writeJson(response, 200, { ok: false, error: result.error })
                return
              }
              writeJson(response, 200, { ok: true, note: result.note, value: snapshotOf() })
            },
          }),
        'dsh-shared-brain: mutate bridge',
      )
      // 内置表情素材：/api/dsh-shared-brain/emoji/<key>.gif
      // 用 prefix 路由是因为要按名字发任意一张，exact 只能挂一个固定路径。
      scope.effect(
        () =>
          scope.webServer.register({
            kind: 'prefix',
            path: BUILTIN_EMOJI_ROUTE,
            handler: (request, response) => handleBuiltinEmojiRequest(request, response),
          }),
        'dsh-shared-brain: builtin emoji assets',
      )
    })
  }

  logger?.info?.(
    `共享记忆已就绪：${brainFile()}；人设库：${personaFile()}；Hindsight bank：${GLOBAL_BANK_ID}（配置：${hindsightConfigFile()}）`,
  )
}

/** 对外暴露的状态（/shared-memory 命令会读它）。 */
export function status() {
  const store = readStore()
  const persona = activePersona()
  const credential = hindsightCredentialState()
  const modules = readModules()
  const summary = moduleSummary(modules)
  return {
    memory: {
      file: brainFile(),
      entries: store.entries.length,
      updatedAt: store.updatedAt,
      latest: store.entries
        .slice()
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 5)
        .map((entry) => ({ text: entry.text, tags: entry.tags, module: entry.module, weight: entry.weight, at: entry.updatedAt })),
    },
    persona: {
      file: personaFile(),
      current: persona.id,
      name: persona.name,
      available: Boolean(persona.text),
      chars: persona.text?.length ?? 0,
      bundled: persona.bundled === true,
      list: personaList(),
      notes: state.personaNotes,
    },
    modules: {
      file: `${brainFile().replace(/memory\.json$/, 'modules.json')}`,
      summary,
      labels: MODULE_LABELS,
    },
    hindsight: {
      file: hindsightConfigFile(),
      bankId: GLOBAL_BANK_ID,
      usable: credential.usable,
      reason: credential.reason,
      notes: state.hindsightNotes,
    },
    proactive: {
      enabled: modules.agentive?.enabled === true,
      scope: modules.agentive?.scope ?? 'all',
      sessionIds: modules.agentive?.sessionIds ?? [],
      intervalMs: modules.agentive?.intervalMs ?? 0,
      timeWindow: modules.agentive?.timeWindow ?? { enabled: false, start: '09:00', end: '23:00' },
      runtime: proactiveStatus(),
    },
    counters: {
      turnsSeen: state.turnsSeen,
      turnsSaved: state.turnsSaved,
      turnsSkipped: state.turnsSkipped,
      recallsServed: state.recallsServed,
      lastError: state.lastError,
      byModule: state.moduleCounts,
    },
  }
}

export { name, inject }
export default { name, inject, apply }
