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
import { readStore, newId, brainFile, pruneExpired, redactStoreSecrets, isAlive, renewEntry, DEFAULT_TEMPORARY_TTL_MS, SOURCES, notePendingHit, notePendingRenewal, hasPendingMutations, isPrunedText } from './store.js'
import { recall, renderRecall } from './recall.js'
import { expandByPaths, renderPathExpansion } from './graph-expand.js'
import { buildGraph, readGraph, writeGraph, expandWithNeighbors } from './memory-graph.js'
import { buildKnowledgeIndex } from './knowledge.js'
import { fetchPageText, buildMaterialSystem, buildMaterialUser } from './web-learn.js'
import { chunkText, coverageSummary, sourceRefForPart } from './reading-chunks.js'
import { pickModel } from './emotion.js'
import { getValue, setValue, appendChat, pruneChats } from './db.js'
import { recordEvent } from './events.js'
import {
  learningConfig,
  quotaLeft,
  bumpState,
  extractKnowledge,
  pickNewCandidates,
  parseLearned,
  KIND_SOURCE_REF,
} from './learning.js'
import { isWorthRemembering, summarizeTurn, isDuplicate } from './summarize.js'
import { activePersona, personaList, personaFile, adoptLegacyPersona, renderPersona } from './persona.js'
import { ensureGlobalBank, hindsightCredentialState, hindsightConfigFile, GLOBAL_BANK_ID } from './hindsight-config.js'
import { extractTurns, sessionEvents, messageText } from './transcript.js'
import { registerCommands, setLearnRunner, setRecallRunner } from './commands.js'
import { classify, topicOverlap, topicKeyOf } from './classify.js'
import { judgeLifetime } from './lifetime.js'
import { findConflicts } from './conflict.js'
import { readModules, putModuleItem, moduleSummary, ALL_MODULES, MODULE_LABELS, MEMORY_MODULES, MODULE_PROFILES, withinTimeWindow } from './modules.js'
import { createSessionCatalog } from './sessions.js'
import { ensureEmojiLoader, stopEmojiLoader, defaultEmojiDir, scanEmojiPacksCached } from './emoji.js'
import { startRemoteSync, stopRemoteSync } from './remote-sync.js'
import { startPersonaSync, stopPersonaSync } from './persona-sync.js'
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
  continueReasonOf,
  shouldContinueTurn,
  roundOf,
  resetContinueRound,
  noteUserTurn,
} from './proactive.js'
import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { recallModules, renderModuleRecall, renderVoice, renderCapabilities } from './weighted-recall.js'
import { readingHits, renderReading } from './reading.js'
import { fitToBudget } from './inject-budget.js'
import { mergeBucketItems } from './bucket-merge.js'
import { buildTopicPool } from './topic-pool.js'
import { extractTags, mergeTags } from './autotag.js'
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
  normalizeEmotionItem,
  ensureEmotionSemantics,
  sameSessionKey,
  applyMoodDelta,
  moodJudgeQuota,
  noteMoodJudge,
  clearMoodState,
  replyMoodMode,
} from './emotion.js'
import {
  BRIDGE_STATUS_PATH,
  BRIDGE_MUTATE_PATH,
  BRIDGE_GRAPH_PATH,
  BRIDGE_PULSE_PATH,
  proactivePulse,
  isLoopbackRequest,
  isSameSiteRequest,
  writeJson,
  readJsonBody,
  snapshotOf,
  mutateModules,
  graphSnapshot,
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
/** 联网学习抓网页时最多取多少字（以前 web-learn 默认 6000，长文后半截白丢）。 */
const LEARN_FETCH_CHARS = 24000
/** 每块送去提炼的字数；最多读几块 = 最多几次模型调用。 */
const LEARN_CHUNK_CHARS = 1200
const LEARN_MAX_CHUNKS = 3
/** 顺记忆图谱的边最多再带多少条邻居记忆（2026-11-05）。 */
const GRAPH_NEIGHBOR_LIMIT = 3
/**
 * 记忆库最多留多少条，超出才淘汰。
 *
 * 2026-11-09 从 500 提到 2000：库里当时已经 493 条，只剩 7 条余量，
 * 再多聊几句就得开始淘汰 —— 淘汰的可是记忆，不是缓存。
 * SQLite 存几千条毫无压力，JSON 镜像也就 1MB 出头。
 */
const MAX_ENTRIES = 2000

/**
 * 淘汰时的排序：越靠前越该被淘汰（2026-11-09）。
 *
 * 以前只看 updatedAt，谁最旧谁先走 —— 但「最旧」不等于「最没用」：
 * 一条从没被召回过的临时备忘，比一条天天用到的老规则更该让位。
 * 现在按「用过的次数 + 权重 + 时间」排：越没用、越旧，越先淘汰。
 */
function overflowOrder(a, b) {
  const valueOf = (entry) =>
    Number(entry?.hits ?? 0) * 10 + Number(entry?.weight ?? 0.5)
  const valueDiff = valueOf(a) - valueOf(b)
  if (valueDiff !== 0) return valueDiff
  return Number(a?.updatedAt ?? 0) - Number(b?.updatedAt ?? 0)
}

/**
 * 超出上限的条目先转存成 jsonl 再出库（2026-11-06 修）。
 *
 * 原来是直接 slice 掉的：记忆说没就没，用户还不知道。现在至少落一份文件，
 * 真要找回还能 grep。归档失败不阻断写入 —— 记忆写入比归档重要。
 */
function archiveOverflowEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return
  try {
    const file = join(dirname(brainFile()), 'memory-archive.jsonl')
    const now = Date.now()
    const lines = entries
      .map((item) => JSON.stringify({ ...item, archivedAt: now, archiveReason: 'max-entries' }))
      .join('\n')
    appendFileSync(file, lines + '\n', 'utf8')
    console.warn(`[dsh-shared-brain] 记忆超过 ${MAX_ENTRIES} 条，${entries.length} 条已转存到 ${file}`)
  } catch (error) {
    console.warn('[dsh-shared-brain] 超限条目转存失败：' + String(error?.message ?? error))
  }
}

/** 每个会话最近给过的表情 key（用来轮换，别每轮都是同一张）。 */
const emojiRecent = new Map()

/** 话题池（方案 §5.5）：十分钟内复用，别每次 tick 都翻库。 */
const TOPIC_POOL_TTL_MS = 10 * 60 * 1000
let topicPoolCache = { at: 0, pool: [] }

function topicPoolCached(now = Date.now()) {
  if (now - topicPoolCache.at < TOPIC_POOL_TTL_MS) return topicPoolCache.pool
  try {
    const store = readStore()
    const modules = readModules()
    const pool = buildTopicPool({ modules, entries: store?.entries ?? [], limit: 40 })
    topicPoolCache = { at: now, pool }
    return pool
  } catch {
    // 读不到就当没有池子，主动搭话退回内置话题
    return topicPoolCache.pool
  }
}

/** 状态，供 /shared-memory 命令与状态接口读取。 */
const state = {  startedAt: 0,
  turnsSeen: 0,
  turnsSaved: 0,
  turnsSkipped: 0,
  recallsServed: 0,
  moodsServed: 0,
  moodsJudged: 0,
  /** 因超出每日判定上限而跳过的轮数。 */
  moodJudgeSkipped: 0,
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
    const cwd = currentContext(sessionId).cwd || ''
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
      //
      // 2026-11-04（P1-7 审计）：放宽到 manual **或** sync。
      // 老大在别的机器上亲口说的承诺（同步过来的 source='sync'）也是承诺。
      // 但仍然排除 'auto' —— 那是我们自己的工作日志，不该替老大决定说什么。
      if (entry.source !== 'manual' && entry.source !== 'sync') continue
      const text = entry.text.trim()
      if (!text) continue
      // 2026-11-04（P1-7 补）：source 放宽到 sync 之后，跨机同步过来的
      // **本鱼自己的工作日志**（原本是 auto，同步时 source 被刷成 sync）
      // 也会被当成老大交代的待办 —— 实测能选中 1 条。
      // 这正是 0.9.8 修过的「内部日志偷偷决定对老大说什么」那类问题。
      // 再加一道：助手过程播报（「找到关键线索了」「现在就改」…）不算待办。
      if (!isWorthRemembering(text)) continue
      // 权重太低的（不太确定的说法）不当真待办
      if (Number(entry.weight ?? 0) < 0.5) continue
      // 作用域：只认全局的、或者正好属于这个工作区/会话的
      const scope = entry.scope ?? 'global'
      // 2026-11-09 补：以前这里只挡 session，workspace 条目不看目录就进待办清单了 ——
      // 结果是 A 目录里答应的事，跑到 B 目录的会话里被当成「还没做完」。
      if (scope === 'workspace') {
        if (!entry.scopePath || !cwd || !pathMatches(entry.scopePath, cwd)) continue
      }
      if (scope === 'session') {
        if (!sameSessionKey(entry.scopeSession ?? entry.sessionId ?? '', sessionId)) continue
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
 * 取对某个会话成立的情感条目（主动搭话决策层要用）。
 *
 * 2026-11-04（E2）：情感记忆以前没有下游 —— intimacy/sentiment/target
 * 只影响召回排序和括号注释，不影响任何决策。现在把这份清单交给
 * proactive-mood 的 emotionBiasOf，让它能影响搭话的调子。
 *
 * @param {string} sessionId 会话 id（用来做作用域过滤）
 * @returns {Array} 情感条目（最多 20 条，按亲密度降序）
 */
function emotionEntriesOf(sessionId = '') {
  try {
    const store = readStore()
    const cwd = currentContext(sessionId).cwd || ''
    const out = []
    for (const entry of store.entries ?? []) {
      if (!entry || entry.module !== 'emotion') continue
      if (!isAlive(entry)) continue
      const scope = entry.scope ?? 'global'
      // 2026-11-09 补：和待办清单同一个漏 —— workspace 情感条目不分目录，
      // 别处攒下的情绪会影响这个目录里搭话的调子。
      if (scope === 'workspace') {
        if (!entry.scopePath || !cwd || !pathMatches(entry.scopePath, cwd)) continue
      }
      if (scope === 'session' && !sameSessionKey(entry.scopeSession ?? entry.sessionId ?? '', sessionId)) continue
      out.push(entry)
    }
    out.sort((a, b) => (Number(b.intimacy ?? b.weight ?? 0) - Number(a.intimacy ?? a.weight ?? 0)))
    return out.slice(0, 20)
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
    // 每日判定上限（2026-11-03）：以前每一轮都要调一次模型判心情，
    // 一聊就是一整天 —— 额度烧得飞快。现在先看今天还剩几次，
    // 超了就直接跳过这次判定（心情照样按时间衰减，不影响其它功能）。
    const quota = moodJudgeQuota(config, store)
    if (!quota.allowed) {
      noteMoodJudge(readEmotionStore(), 'skipped')
      state.moodJudgeSkipped = (state.moodJudgeSkipped ?? 0) + 1
      logger?.info?.(`心情判定：今天已判 ${quota.used}/${quota.limit} 次，这轮跳过`)
      return
    }

    const turns = extractTurns(sessionEvents(agent?.session), { includeSelfTalk: true })
    // 2026-11-12 修（线上取证：judgeLog = failed:3，lastError 是「来源 runtime-context 不参与判定」）：
    // 宿主每轮都会往事件流里插一条运行时上下文，`extractTurns` 把它也切成了一轮 ——
    // 原来直接取 turns[last]，于是永远拿到那条注入内容，判定一次都没真跑过。
    // 改成从后往前找「能判的那一轮」，并优先挑有回复的那一轮。
    let lastTurn = null
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i]
      if (!judgeModeOf(turn.sourceKind)) continue
      if (!lastTurn) lastTurn = turn
      if (String(turn.assistant ?? '').trim()) {
        lastTurn = turn
        break
      }
    }
    // 2026-11-12：下面几个 return 以前全是**静默**的 ——
    // 「判定压根没跑」在磁盘上看不出来（judgeLog 只记成功次数），
    // 这个坑真踩过：线上 judgeLog 停在 count=1，谁也看不出断在哪一环。
    // 现在每一处都留下原因。
    if (!lastTurn) {
      noteMoodJudge(readEmotionStore(), 'failed:这一轮没切出对话（事件流里没有可判的轮次）')
      logger?.info?.('心情判定：这一轮没切出对话，跳过')
      return
    }

    // 这一轮是「老大说的」还是「我们自己搭话说的」。
    const mode = judgeModeOf(lastTurn.sourceKind)
    if (!mode) {
      noteMoodJudge(readEmotionStore(), `failed:这一轮的来源「${lastTurn.sourceKind || '空'}」不参与判定`)
      return
    }

    // 老大真说话了 → 续接轮次重新计数。
    // 不然一个会话续满 3 轮之后，这台机器上它就永远不能再续接了。
    if (mode === 'user') resetContinueRound(sessionIdOf(agent))

    // 我们自己这一轮说了什么（判据主体）。
    const reply = String(lastTurn.assistant ?? '').trim()
    if (!reply) {
      noteMoodJudge(readEmotionStore(), 'failed:这一轮没有可判定的回复内容')
      return
    }

    // 判据里的「对方说了什么」：
    //   - 自己搭话那轮 → 没有对方，取触发上下文当背景（判据主体仍是 reply）
    //   - 老大说话那轮 → 取老大真说的话（不能再被插件的模板顶掉）
    const userText = lastTurn.selfTalk
      ? (currentContext(sessionId).prompt || '')
      : String(lastTurn.user ?? '').trim()

    // 「不接话」（2026-11-03，P1-5）：老大敷衍一句或干脆不回，
    // 这本身就是反馈。先判出来，判定时带着这个口径走。
    const replyMode = lastTurn.selfTalk ? 'normal' : replyMoodMode(userText).mode
    if (replyMode === 'silent') {
      logger?.info?.('心情判定：老大这轮没接话（敷衍或没回），按失落记一笔')
    }

    let judgeError = ''
    const delta = await judgeMood(ctx, agent, userText, reply, {
      mode,
      replyMode,
      provider: config.judgeProvider,
      model: config.judgeModel,
      aliases: config.aliases,
      ownerName: '老大',
      onError: (message) => {
        judgeError = String(message ?? '')
        logger?.warn?.(`心情判定失败：${judgeError}`)
      },
    })
    if (!delta) {
      // 2026-11-12：这里以前是静默 return —— 判定没成功和「压根没判定」
      // 在磁盘上完全一样。现在把原因记下来。
      noteMoodJudge(readEmotionStore(), `failed:${judgeError || '模型没给出可用的判定结果'}`)
      return
    }
    // 2026-11-12：顺序调换 + 补 sigMoodRaw。
    //  ① 以前是「先记 judged、再写回 state」。写回那一步只要抛错
    //    （getMoodState / applyMoodDelta / saveMoodState 都可能），
    //    judgeLog 上就显示「判定成功 3 次」，可 state 一个字没变 ——
    //    桌宠读到的还是三天前的心情，磁盘上也看不出哪里错了。
    //    现在先写回，成功了才记 judged；失败记 failed + 原因。
    //  ② 以前 applyMoodDelta 没拿到 sigMoodRaw，永远吃默认值 2，
    //    设置里把它调到 1 等于白调 —— 小幅情绪永远被判成「没变化」。
    try {
      const { state: moodState } = getMoodState(sessionId)
      applyMoodDelta(moodState, delta, {
        moodFloor: config.moodFloor,
        sigMood: config.sigMood,
        sigDim: config.sigDim,
        sigMoodRaw: config.sigMoodRaw,
      })
      saveMoodState(sessionId, moodState)
    } catch (error) {
      const reason = String(error?.message ?? error)
      noteMoodJudge(readEmotionStore(), `failed:写回心情出错：${reason}`)
      logger?.warn?.(`心情判定写回出错：${reason}`)
      return
    }
    state.moodsJudged += 1
    // 记账要用「刚写过盘的那份」当底。
    // saveMoodState 是自己读-改-写的，它写下去的文件里已经有新 state；
    // 这里若还拿函数开头读的 store，整份写回就会把刚写好的 state 冲掉 ——
    // 线上就是这么演的：judgeLog.count 一路涨到 5，states 最新还停在 72 小时前。
    noteMoodJudge(readEmotionStore(), 'judged')
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
/**
 * 续接轮次：模型在本轮回复末尾留了 `<!-- 继续：理由 -->` 就再续一轮。
 *
 * 这里刻意做得很保守：
 *  - 只有模型**自己声明**还有事没做完才续（不猜）；
 *  - `agentive.enabled` 关着就完全不动 —— 续接也是「主动性」，得受同一个开关管；
 *  - 作用范围 / 时间窗 / 3 轮上限由 shouldContinueTurn 判。
 *
 * 理由同时也写进日志，方便事后看「它到底自己续着干了什么」。
 */
function tryContinueTurn(agent, logger) {
  try {
    const agentive = readModules().agentive ?? {}
    if (!agentive.enabled) return
    if (agentive.selfContinue === false) return
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return
    const turns = extractTurns(sessionEvents(agent?.session))
    const last = turns[turns.length - 1]
    const reason = continueReasonOf(last?.assistant ?? '')
    if (!reason) return
    if (!shouldContinueTurn(sessionId, agentive, reason)) return
    const round = roundOf(sessionId)
    // 2026-11-04（P0）：以前这里把 `继续：…` 当**字符串**交给 followup/inject，
    // 宿主会原样写进 session 日志的 agent/inbox/spliced.inserted；而读取时
    // mapEventMessages 要求 inserted 里每一项都是 message 对象，于是整份历史
    // 报 SessionFormatError 读不出来（session-7f79e84f 就是这么坏掉的）。
    // 跟 proactive.js 一样，塞完整的消息对象。
    const message = {
      id: `self-continue-${newId()}`,
      role: 'user',
      content: [{ type: 'text', text: `继续：${reason}` }],
      source: { kind: 'plugin:dsh-shared-brain', form: 'self-continue' },
    }
    if (typeof agent?.followup === 'function') agent.followup(message)
    else if (typeof agent?.inject === 'function') agent.inject(message)
    else return
    state.turnsContinued = (Number(state.turnsContinued) || 0) + 1
    logger?.info?.(`续接第 ${round} 轮：${reason}`)
  } catch (error) {
    state.lastError = String(error?.message ?? error)
    logger?.warn?.(`续接轮次失败：${state.lastError}`)
  }
}

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
      // 2026-11-11：自动打标。tags 在打分里是 1.5 的权重，可库里九成条目
      // 标签是空的 —— 这一档等于没生效。这里把《书名》、作者、文件名之类
      // 有据可依的词补上，抽不出来就还是空数组，不硬凑。
      tags: mergeTags(candidate.tags ?? [], extractTags(candidate.text, { sourceRef: candidate.sourceRef })),
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
      // 2026-11-09（P0-4）：以前一律 global，一个会话干的活儿会被原样带进
      // 另一个会话（问「上次那个脚本」时把你的聊天记录当自己的记忆复述）。
      // 现在默认按工作区隔离：同一目录下的会话照样共享，换目录互不串味；
      // 拿不到 cwd 就退回会话级 —— 宁窄勿宽。
      scope: candidate.cwd ? 'workspace' : 'session',
      scopePath: candidate.cwd ? String(candidate.cwd) : '',
      scopeSession: candidate.cwd ? '' : sessionId,
      // 情感语义字段（2026-11-02）
      ...(moduleKey === 'emotion'
        ? {
            intimacy: classification.intimacy ?? classification.weight,
            sentiment: classification.sentiment ?? 'neutral',
            target: classification.target ?? 'general',
            // 2026-11-09（P0-3）：谁的情绪（user = 老大自己的状态）
            owner: ['user', 'self', 'general'].includes(classification.owner) ? classification.owner : 'general',
          }
        : {}),
      supersedes: conflicts.length > 0 ? conflicts[conflicts.length - 1].id : '',
      sessionId,
      cwd: candidate.cwd,
      createdAt: now,
      updatedAt: now,
      hits: 0,
    }
    // 2026-11-04（E5）：情感条目走 emotion.js 的规整函数。
    // 以前这里直接写 classification.intimacy 原值，emotion.js 文档承诺的
    // 「权重 = 亲密度 × 极性修正（负向 ×0.9）」从来没生效过 ——
    // normalizeEmotionItem 是个从没被调用的死代码。
    // 现在负向情感不再和正向一样重（讨厌类不该比喜欢类更「重要」）。
    let emoNorm = null
    if (moduleKey === 'emotion') {
      emoNorm = normalizeEmotionItem(entry, classification.weight)
      entry.weight = emoNorm.weight
      entry.intimacy = emoNorm.intimacy
      entry.sentiment = emoNorm.sentiment
      entry.target = emoNorm.target
    }
    store.entries.push(entry)
    if (store.entries.length > MAX_ENTRIES) {
      // 2026-11-06 修：以前超出上限直接 slice 掉 = 静默删记忆。
      // 现在先把要淘汰的转存成 jsonl 再从库里摘掉，至少能翻回来。
      // 2026-11-09 再修两处：钉住的和底线模块的条目不参与淘汰；
      // 淘汰顺序从「最旧」改成「最没用」（没被召回过、权重低的先走）。
      const keepable = (item) => item?.pinned !== true && item?.module !== 'bottomline'
      const evictable = store.entries.filter((item) => !keepable(item))
      const need = store.entries.length - MAX_ENTRIES
      if (need > 0 && evictable.length > 0) {
        const overflow = [...evictable].sort(overflowOrder).slice(0, Math.min(need, evictable.length))
        const overflowIds = new Set(overflow.map((item) => item?.id))
        archiveOverflowEntries(overflow)
        store.entries = store.entries.filter((item) => !overflowIds.has(item?.id))
      }
    }
    writeStoreSynced(store)

    // 同步进模块配置（模块里保存的是「带权重的条目副本」，方便单独调权重）
    const modules = readModules()
    putModuleItem(modules, moduleKey, {
      text: candidate.text,
      // 2026-11-04（E5）：用跟扁平库同一份规整结果，
      // 否则模块副本有降权、扁平库没有，两份数据对不上。
      weight: emoNorm ? emoNorm.weight : classification.weight,
      // 情感条目的语义字段（亲密度 / 极性 / 对象）——2026-11-02
      ...(moduleKey === 'emotion'
        ? {
            intimacy: emoNorm ? emoNorm.intimacy : (classification.intimacy ?? classification.weight),
            sentiment: emoNorm ? emoNorm.sentiment : (classification.sentiment ?? 'neutral'),
            target: emoNorm ? emoNorm.target : (classification.target ?? 'general'),
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

    // 2026-11-11（P1-3）：对话账本接线。表一直建着、写入函数也写好了，
    // 但从来没人调用，chat_log 永远是空的。这里只记「这一轮存了什么」：
    // 模块 + 前 120 字，不存全文 —— 全文在会话事件里，账本是给
    // 「最近聊过什么」用的，不该变成第二份聊天记录。
    try {
      const brief = String(candidate.text ?? '').replace(/\s+/g, ' ').slice(0, 120)
      appendChat('user', moduleKey, brief, now, sessionId)
      pruneChats(400)
      // 2026-11-11：同一份摘要顺手进事件环，桌宠/排障看「刚刚记了什么」，
      // 不用再去翻 chat_log 表。
      recordEvent('turn', `${moduleKey}：${brief}`, { module: moduleKey })
    } catch (error) {
      console.warn('[dsh-shared-brain] 对话账本写入失败：' + String(error?.message ?? error))
    }
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

/**
 * 记忆库的"内容指纹"：模块条目总数 + 扁平库条数 + 最新更新时间。
 *
 * 为什么要它：召回缓存原来只按「会话 + 目录 + 本轮提示词」做键 ——
 * 同一句话问两次，第二次拿到的是上一次渲染好的提示词，**中间新写入的记忆看不见**。
 * 这跟 modulesCache 不校验 __savedAt 是同一类毛病：缓存不看内容变没变。
 */
function recallVersion() {
  try {
    const modules = readModules()
    const store = readStore()
    let count = 0
    for (const key of MEMORY_MODULES) count += modules?.[key]?.items?.length ?? 0
    const entries = store?.entries ?? []
    const last = entries.reduce((mx, e) => Math.max(mx, Number(e?.updatedAt ?? 0)), 0)
    return `${count}:${entries.length}:${last}`
  } catch {
    return 'unknown'
  }
}

/** 缓存键：会话 + 工作目录 + 记忆库指纹 + 本轮提示词。 */
function recallCacheKey(sessionId, prompt, cwd) {
  return `${sessionId} ${cwd} ${recallVersion()} ${prompt}`
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
  const base = result.hits.length === 0 && result.always.length === 0 ? '' : renderModuleRecall(result)
  // 阅读层单独成段，挂在记忆段后面（2026-11-11）。
  let readingText = ''
  try {
    readingText = renderReading(result.reading ?? [])
  } catch {
    readingText = ''
  }
  const joined = [base, readingText].filter(Boolean).join('\n\n')
  // 2026-11-11：记忆段落一直没有长度上限。八条命中、每条几百字，再加书目索引
  // 与知识索引，一段能顶掉几千字上下文；长段落还会把真正要紧的指令往后挤。
  // 超过预算就按行截短，末尾注明少了多少行——宁可少说两句，也别把上下文吃光。
  const fitted = fitToBudget(joined)
  if (fitted.trimmed) {
    state.lastInjectTrim = {
      at: Date.now(),
      droppedLines: fitted.droppedLines,
      originalChars: joined.length,
      keptChars: fitted.text.length,
    }
  }
  const rendered = fitted.text
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
/**
 * 把被取代的旧条目压下去（2026-11-09）。
 *
 * 写入时 `findConflicts` 会给新条目记上 `supersedes: 旧条目 id`，
 * 但召回端一直没人消费 —— 于是「改用 React」和「以前用 Vue」两条
 * 同时进提示词，模型自己都犯迷糊。
 *
 * 现在召回前先剔掉被取代的那些：
 *   - 按 id 剔（扁平库里新旧两条的 id 是同一套）；
 *   - 也按正文前 40 字剔（模块桶里那条副本 id 是另一套，只能靠正文对上）。
 *
 * 声明了 supersedes 的新条目自己不会被剔掉。
 *
 * @param {Record<string, {items: any[]}>} byModule 按模块归位后的条目
 * @returns {number} 被压下去的条数
 */
export function dropSuperseded(byModule) {
  /** id → 条目，用来把「被取代的 id」翻译成正文 */
  const byId = new Map()
  for (const key of MEMORY_MODULES) {
    for (const item of byModule[key] ?? []) {
      if (item?.id) byId.set(item.id, item)
    }
  }
  /** 被取代的旧条目 id */
  const supersededIds = new Set()
  /** 声明了取代关系的新条目 id（它们自己不能被剔） */
  const supersedingIds = new Set()
  for (const key of MEMORY_MODULES) {
    for (const item of byModule[key] ?? []) {
      const target = typeof item?.supersedes === 'string' ? item.supersedes.trim() : ''
      if (!target) continue
      supersededIds.add(target)
      if (item?.id) supersedingIds.add(item.id)
    }
  }
  if (supersededIds.size === 0) return 0
  /** 被取代条目的正文前 40 字，用来对上模块桶里的另一份副本 */
  const supersededTexts = new Set()
  for (const id of supersededIds) {
    const old = byId.get(id)
    const text = typeof old?.text === 'string' ? old.text.trim().slice(0, 40) : ''
    if (text) supersededTexts.add(text)
  }
  let dropped = 0
  for (const key of MEMORY_MODULES) {
    const items = byModule[key] ?? []
    byModule[key] = items.filter((item) => {
      const id = typeof item?.id === 'string' ? item.id : ''
      if (id && supersedingIds.has(id)) return true
      if (id && supersededIds.has(id)) {
        dropped += 1
        return false
      }
      const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 40) : ''
      if (text && supersededTexts.has(text)) {
        dropped += 1
        return false
      }
      return true
    })
  }
  return dropped
}

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
      // 情感语义字段（2026-11-02）：亲密度 / 极性 / 对象 / 谁的情绪（2026-11-09）
      // 2026-11-12：云端同步进来的情感条目是原始形状（sentiment/intimacy/target 全空），
      // 以前这里只写 `?? 'neutral'` / `?? 'general'`，于是渲染成「对general·中性」，
      // 方向整个反了。现在缺的字段按正文现算（只改内存里的这条副本，不回写库）。
      ...(key === 'emotion' ? ensureEmotionSemantics(entry) : {}),
      supersedes: entry.supersedes ?? '',
      hits: entry.hits ?? 0,
      // 2026-11-06 修：这里少拷了几个字段，等于每轮召回都把出处和归档标记抹掉 ——
      // 知识索引因此塌成「(未标注来源)」，归档的条目也照样被召回。
      sourceRef: typeof entry.sourceRef === 'string' ? entry.sourceRef : '',
      topicKey: typeof entry.topicKey === 'string' ? entry.topicKey : '',
      archived: entry.archived === true,
      archivedAt: Number.isFinite(entry.archivedAt) ? entry.archivedAt : 0,
      archiveReason: typeof entry.archiveReason === 'string' ? entry.archiveReason : '',
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })
  }

  // 模块配置里手工加的条目（没在扁平库里的）也要算进来。
  // 2026-11-11：去重改成先建表再查（原来每条都把整桶扫两遍，560 条时一轮几万次比较）。
  for (const key of MEMORY_MODULES) {
    const bucket = modules[key]
    if (!bucket?.enabled) continue
    byModule[key] = mergeBucketItems(byModule[key], bucket.items ?? [], {
      // 2026-11-11：过期删掉的正文，别让桶里的副本把它「复活」回来。
      // 桶条目不带 expiresAt，只靠 isAlive 拦不住，所以按正文指纹挡一道。
      accept: (item) => !isPrunedText(item?.text),
    }).items
  }

  // 被更正过的旧说法别再往提示词里塞（2026-11-09）。
  const supersededDropped = dropSuperseded(byModule)

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
  // 这次压掉了几条被更正过的旧说法（只是留个账，不进提示词）
  result.supersededDropped = supersededDropped

  // 知识索引：书名 + 条数 + 主题，常驻进提示词（2026-11-06）。
  // 全量索引而不是只看命中 —— 读过的东西不能因为「这轮没聊到」就隐身。
  try {
    result.knowledgeIndex = buildKnowledgeIndex(merged.knowledge?.items ?? [], { limit: 16 })
  } catch (error) {
    result.knowledgeIndex = []
    logger?.warn?.(`知识索引生成失败：${String(error?.message ?? error)}`)
  }

  // 阅读层（2026-11-11，方案 §5.1）：诗词/历史这些「原文」单独给 3 个名额，
  // 不跟工作记忆抢 RECALL_LIMIT —— 以前它们被挤到提示词外面，等于没读过。
  try {
    result.reading = readingHits(merged.knowledge?.items ?? [], text, { limit: 3 })
  } catch (error) {
    result.reading = []
    logger?.warn?.(`阅读层召回失败：${String(error?.message ?? error)}`)
  }

  // 路径扩展：命中记忆里带了文件/目录路径时，顺着目录图谱把相关文件带出来。
  // 图谱插件不在或索引为空时，这里什么都不做（不影响召回本身）。
  let expansion = { paths: [], related: [] }
  try {
    expansion = expandByPaths([...result.hits, ...result.always], { limit: 6 })
  } catch (error) {
    logger?.warn?.(`路径扩展失败：${String(error?.message ?? error)}`)
  }
  result.expansion = expansion

  // 记忆图谱顺边召回（2026-11-05）：命中一条记忆后，把它在图上的邻居也带回来。
  //
  // 为什么要有这一步：以前召回只看「这一轮文本像不像」，语义相近但用词不同的
  // 记忆会被漏掉。图谱把「共现 / 取代 / 提及同实体」这些关系提前算好，
  // 命中一条就能顺着边捞出邻居——相当于给召回加了一层关系网。
  //
  // 失败不影响主召回：图谱坏了就当没这一段。
  try {
    const flat = [...result.hits, ...result.always]
      .map((hit) => ({ entry: hit?.item, score: Number(hit?.score ?? 0) }))
      .filter((hit) => hit.entry && typeof hit.entry.id === 'string')
    if (flat.length > 0) {
      // 图谱文件缺失时现场建一张并落盘：否则每轮召回都要重建一次，
      // 落盘后 readGraph 有 mtime+size 缓存，后续几乎零成本。
      let graph = readGraph()
      if (!graph) graph = writeGraph(buildGraph(store.entries))
      const entryIndex = new Map(store.entries.map((entry) => [entry.id, entry]))
      const expansionGraph = expandWithNeighbors(flat, graph, entryIndex, { limit: GRAPH_NEIGHBOR_LIMIT })
      const known = new Set(flat.map((hit) => hit.entry.id))
      for (const neighbor of expansionGraph.neighbors) {
        const id = neighbor?.entry?.id
        if (!id || known.has(id)) continue
        // 图谱可能是归档之前建的缓存：归档条目一律不许从图这边再溜回提示词
        if (neighbor.entry.archived === true) continue
        known.add(id)
        result.hits.push({
          module: neighbor.entry.module ?? 'cognition',
          label: MODULE_LABELS[neighbor.entry.module ?? 'cognition'] ?? neighbor.entry.module,
          item: neighbor.entry,
          score: neighbor.score,
          viaGraph: true,
        })
      }
      result.graphRecall = {
        neighbors: expansionGraph.neighbors.length,
        entities: expansionGraph.entities.map((entity) => entity.label).slice(0, 5),
      }
    }
  } catch (error) {
    logger?.warn?.(`记忆图谱召回失败：${String(error?.message ?? error)}`)
  }

  // 记一次热度；临时记忆被召回就**续期**（滑动窗口：还在用就不急着过期）。
  // PERF-1：只记内存增量 + 5 秒 debounce 合并写，不再每轮全量重写库。
  if (result.hits.length > 0 || result.always.length > 0) {
    const now = Date.now()
    const seen = new Set()
    for (const hit of [...result.hits, ...result.always]) {
      const id = hit?.item?.id
      if (typeof id !== 'string' || !id || seen.has(id)) continue
      seen.add(id)
      notePendingHit(id, 1)
      const entry = store.entries.find((item) => item.id === id)
      if (entry) notePendingRenewal(id, renewEntry(entry, now))
    }
    if (seen.size > 0) schedulePendingMemoryWrite()
  }
  return result
}

/**
 * 召回预览（2026-11-11）：给定一句话，看看此刻会往提示词里塞哪些记忆。
 * 命令行 `/shared-memory recall <文本>` 用它，排查「这条为什么没被召回」也有用。
 * 只读，不写库（recallFor 内部该续期的照常续期，和正常轮次一致）。
 */
export function recallPreview(text, cwd = '', sessionId = '') {
  try {
    const result = recallFor(String(text ?? ''), String(cwd ?? ''), String(sessionId ?? ''))
    return {
      rendered: result.rendered,
      hits: [...(result.hits ?? []), ...(result.always ?? [])].map((hit) => ({
        id: hit?.item?.id ?? '',
        module: hit?.module ?? '',
        text: String(hit?.item?.text ?? '').slice(0, 80),
        score: Number(hit?.score ?? 0),
      })),
      supersededDropped: Number(result.supersededDropped ?? 0),
    }
  } catch (error) {
    return { rendered: `召回预览失败：${error?.message ?? error}`, hits: [], supersededDropped: 0 }
  }
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
 * PERF-1：召回热度（hits+1）与临时记忆续期改成「攒着合并写」。
 *
 * hits 不参与召回打分，没必要每轮为它全量重写 ~108KB（实测 6.69ms，还要为
 * 跨机同步跑 4 次坐标 I/O）。这里 5 秒 debounce 合并成一次 writeStoreSynced，
 * 增量本身记在 store.js 的 pending 缓冲里 —— 任何别的写路径（persistTurn、
 * bridge、commands）落盘时都会顺手带上，不会被冲掉。
 *
 * 真正改记忆库的操作（新增/删除条目）不经过这里，仍然立刻落盘。
 */
const PENDING_WRITE_DELAY_MS = 5000
let pendingWriteTimer = null
let exitFlushRegistered = false

/** 立刻把攒着的热度/续期写盘（没有增量就什么都不做）。 */
export function flushPendingMemoryWrites() {
  if (pendingWriteTimer) {
    clearTimeout(pendingWriteTimer)
    pendingWriteTimer = null
  }
  if (!hasPendingMutations()) return false
  try {
    writeStoreSynced(readStore())
    return true
  } catch {
    // 写不进去就留着，下次写路径还会带上
    return false
  }
}

function schedulePendingMemoryWrite() {
  if (pendingWriteTimer) return
  if (!exitFlushRegistered) {
    exitFlushRegistered = true
    // 进程退出兜底：写盘都是同步的，exit 里还来得及落。
    process.once('exit', () => {
      flushPendingMemoryWrites()
    })
  }
  pendingWriteTimer = setTimeout(() => {
    pendingWriteTimer = null
    flushPendingMemoryWrites()
  }, PENDING_WRITE_DELAY_MS)
  // 定时器不该吊住宿主进程退出
  pendingWriteTimer.unref?.()
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
  // 2026-11-04（P2-2）：这只是一次「把默认值落盘」，磁盘满 / 目录只读 / 杀软锁文件
  // 都不该让整个插件 apply 失败（那会让设置页直接空白）。内存里那份已经是对的，
  // 下次真改动时还会再写一次，所以这里记一笔就继续。
  try {
    writeModulesSynced(modules)
  } catch (error) {
    logger?.warn?.(`模块配置初始化写盘失败（不影响运行）：${error?.message ?? error}`)
  }
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
        text: (context) => {
          const sessionId = context?.agent?.session?.header?.id ?? ''
          // PERF-5：把人设正文传进去，人设里已经写过的整行不再重复注入
          return renderVoice(readModules(), { personaText: activePersona(sessionId)?.text ?? '' })
        },
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
          return renderCapabilities(readModules(), {
            sessionId,
            sessionTitle: title,
            // PERF-5：同上，人设里已写过的整行不重复
            personaText: activePersona(sessionId)?.text ?? '',
          })
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
          // 2026-11-06 修（第四路审计）：这一段已经把完整召回交给模型了，
          // pre-step 那边再塞一份同样的内容是纯浪费（每轮白烧一份上下文）。
          // 这里记个时间戳，pre-step 用它判断「段落通道还活着吗」。
          state.lastRecallSectionAt = Date.now()
          return rendered
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
            // 阶段 B3：同一段心情上下文里带上「这会儿适合什么表情」。
            // 表情提示跟心情绑在一起是有意的 —— 心情低落时甩一个「庆祝」，
            // 比不说话还糟。禁忌由 emoji-affinity.js 的 avoid 表负责。
            //
            // 2026-11-04（P0-4，审计 B2）：表情提示**不再挂在心情文字的闸门后面**。
            // 以前这里是 `if (!rendered) return ''`，在 proposeEmoji 之前就返回了 ——
            // 心情文字一空（而它因为 P0-3 几乎总是空），表情提示也一起躺平，
            // 于是 proposeEmoji（整个插件里唯一一处「心情真的改变行为」的代码）
            // 一次都没跑过。现在：表情是独立的，文字是可选的。
            let emojiHint = ''
            try {
              const style = readModules().voice?.style ?? {}
              // 2026-11-10：把「这轮说了什么」和「最近给过哪几张」也带上，
              // 否则档位不变就每轮都是同样三张，表情看着像复读。
              const emojiRecentState = emojiRecent.get(sessionId) ?? { keys: [], turn: 0 }
              // 2026-11-11：内置包多映射了 35 张日常表情，但那些 key 只有内置包
              // 认得出。装了外部 dsh-emoji 包时只用契约 40 个，免得给出渲染不了的 key。
              let externalPacks = 0
              try {
                externalPacks = (scanEmojiPacksCached()?.packs ?? []).length
              } catch {
                externalPacks = 0
              }
              const proposal = proposeEmoji({
                moodState,
                text: currentContext(sessionId).prompt || '',
                recent: emojiRecentState.keys,
                turn: emojiRecentState.turn,
                config: normalizeEmojiAffinity(style.emojiSemantic),
                extended: externalPacks === 0,
              })
              emojiHint = renderEmojiHint(proposal)
              // 内置表情包：直接给现成的 markdown 图片，模型照抄就能出图，
              // 不依赖 dsh-emoji 插件。拿不到端口（比如宿主没 webServer）就跳过。
              const port = ctx?.get?.('webServer')?.port
              const builtin = renderBuiltinEmojiHint(proposal, port)
              if (builtin) emojiHint = emojiHint ? `${emojiHint}\n${builtin}` : builtin
              emojiRecent.set(sessionId, {
                // 2026-11-10：记 6 个（不是 3 个），轮换的池子大一点才不会两轮就转回来。
                keys: (proposal.keys ?? []).slice(0, 6),
                turn: emojiRecentState.turn + 1,
              })
            } catch {
              // 表情提示算附加信息，出错就当没有
            }
            if (!rendered) {
              // 心情文字这一轮没什么可说的，但表情提示照样可以给。
              // 表情提示不参与「一次变化只说一次」的记账：它跟着心情一起说，
              // 心情不变就不再重复说，够了。
              return emojiHint
            }
            // 说出去之前先记账：这一轮算「已经告诉过它了」（同样按 revision）
            moodState.injectedFor = Number(moodState.revision) || 0
            moodState.saidAt = [...(moodState.saidAt || []), Date.now()].slice(-50)
            saveMoodState(sessionId, moodState)
            state.moodsServed += 1
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
  // 启动时先自愈一次模块桶：旧版本进程可能把某个模块写没了
  try {
    healMissedBuckets(logger)
  } catch {
    /* 自愈是加分项，失败不影响加载 */
  }

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

      // 记一笔「这一刻有人在说话」，供主动搭话的「别插嘴」判断用。
      // chat_log 只收值得记的轮，闲聊不进表，光靠它会把宽限期判漏。
      // 2026-11-12：带上 sessionId —— 宽限期改成按会话算。
      noteUserTurn(Date.now(), sessionId)

      // 会话目录按需刷新（内部节流），设置页打开时就能看到当前会话
      sessionCatalog.setCurrent(sessionId)
      void sessionCatalog.refresh()

      const { rendered } = recallRendered(prompt, cwdOf(agent), sessionId)
      if (!rendered) return decision

      // 2026-11-06 修（第四路审计）：system prompt 的 RECALL_SECTION 已经把
      // **同一份 rendered** 交给模型了，这里再包一条 role:'user' 就是重复注入。
      // 只有当段落通道明显没跑（比如宿主没接 systemPrompt.section）时才兜底注入。
      const sectionAlive = Number(state.lastRecallSectionAt ?? 0) > Date.now() - 10 * 60 * 1000
      if (sectionAlive) return decision

      // 去重：同一会话里召回内容没变就不重复注入
      if (lastInjected(sessionId) === rendered) return decision
      setLastInjected(sessionId, rendered)

      // 2026-11-04（P0-2）：注入正文要转义。
      // rendered 是召回结果的拼接，里面可能有 `</shared-memory-injection>`
      // （记忆正文里带的）—— 那会闭合这层包装、从包装里逃出去。
      // 也有 `<system>` —— 那能伪造系统标记。
      // 所以正文里的尖括号一律转成实体，包装标签才闭得严实。
      const safeRendered = String(rendered)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const injection = {
        id: `shared-memory-${sessionId || 'x'}-${Date.now().toString(36)}`,
        role: 'user',
        content: [{ type: 'text', text: `<shared-memory-injection>\n${safeRendered}\n</shared-memory-injection>` }],
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

  /**
   * 启动自愈：模块桶空了但记忆库里有 → 从库里补回模块桶。
   *
   * 只补不删。旧版本进程会把不认识的模块写没，重启后如果不管，
   * 那批条目就永远进不了召回（明明躺在 memories 表里）。
   */
  function healMissedBuckets(logger) {
    try {
      const modules = readModules()
      const store = readStore()
      const byModule = new Map()
      for (const entry of store.entries ?? []) {
        const key = entry?.module
        if (!key) continue
        if (!byModule.has(key)) byModule.set(key, [])
        byModule.get(key).push(entry)
      }
      let healed = 0
      for (const [key, entries] of byModule) {
        const bucket = modules[key]
        if (!bucket || !Array.isArray(bucket.items)) continue
        if (bucket.items.length > 0) continue
        if (entries.length === 0) continue
        bucket.items = entries.map((e) => ({
          id: e.id,
          text: e.text,
          weight: Number.isFinite(e.weight) ? e.weight : 0.6,
          tags: Array.isArray(e.tags) ? e.tags : [],
          hits: Number.isFinite(e.hits) ? e.hits : 0,
          pinned: e.pinned === true,
          source: e.source === 'manual' ? 'manual' : 'auto',
          lifetime: e.lifetime === 'temporary' ? 'temporary' : 'permanent',
          expiresAt: Number.isFinite(e.expiresAt) ? e.expiresAt : 0,
          ttlMs: Number.isFinite(e.ttlMs) ? e.ttlMs : 0,
          scope: e.scope ?? 'global',
          scopePath: e.scopePath ?? '',
          scopeSession: e.scopeSession ?? '',
          supersedes: e.supersedes ?? '',
          createdAt: Number.isFinite(e.createdAt) ? e.createdAt : Date.now(),
          updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : Date.now(),
          ...(e.sourceRef ? { sourceRef: e.sourceRef } : {}),
        }))
        healed += bucket.items.length
        logger?.warn?.(`模块桶自愈：${key} 从记忆库补回 ${bucket.items.length} 条`)
      }
      if (healed > 0) {
        modules.updatedAt = Date.now()
        writeModulesSynced(modules)
      }
      return healed
    } catch (error) {
      logger?.warn?.(`模块桶自愈失败：${String(error?.message ?? error)}`)
      return 0
    }
  }

  /**
   * 联网学习：抓网页 / 给一段文字 → 提炼知识 → 去重入库。
   * 原来这段只写在 /learn 的 HTTP handler 里，命令行和界面都用不上；
   * 2026-11-11 抽成函数，HTTP 与 /shared-memory learn 共用一份。
   */
  async function runMaterialLearn({ url = '', text: rawText = '', source: rawSource = '', logger } = {}) {
    let text = String(rawText ?? '').trim()
    let fetched = null
    let source = String(rawSource ?? '').trim()
    if (!text && url) {
      if (readModules()?.network?.enabled !== true) {
        return { ok: false, error: '网络模块是关着的，先在设置里打开再抓网页' }
      }
      const page = await fetchPageText(url, { maxChars: LEARN_FETCH_CHARS })
      if (!page.ok) return { ok: false, error: '抓取失败：' + page.error }
      text = page.text
      fetched = { host: page.host, title: page.title, chars: text.length, bytes: page.bytes }
      source = source || page.title || page.host
    }
    if (!text) return { ok: false, error: '得给 url 或 text' }
    const firstAgent = ctx.agents?.list?.()?.[0]
    const model = pickModel(firstAgent)
    if (!model) return { ok: false, error: '这会儿拿不到可用模型（没有活跃会话）' }
    const sessionId = currentContext().sessionId
    // 2026-11-11：长文分块。以前整篇只留前 6000 字、一次提炼，后半截等于没读。
    // 现在按 1200 字切块，最多读 3 块（= 最多三次模型调用，用户是手动点的，能接受），
    // 返回里如实给出「读了多少 / 原文多长 / 有没有截断」。
    const chunks = chunkText(text, { size: LEARN_CHUNK_CHARS, maxChunks: LEARN_MAX_CHUNKS })
    const parts = chunks.length > 0 ? chunks : [{ index: 0, text, chars: text.length, offset: 0 }]
    const collected = []
    for (const part of parts) {
      const got = await extractFromMaterial(model, { source, text: part.text, sessionId })
      // 2026-11-11：记下这条是从第几段抽出来的。长文分块之后，
      // 「这句话出自原文哪一节」是回查时最想问的问题，光有书名不够。
      for (const item of got) collected.push({ ...item, __part: part.index })
    }
    // 同一条资料分块提炼后，同一句话可能被两遍抽出来
    const seenText = new Set()
    const items = collected.filter((item) => {
      const key = String(item?.text ?? '').trim()
      if (!key || seenText.has(key)) return false
      seenText.add(key)
      return true
    })
    const covered = coverageSummary(parts, text.length)
    const existing = readStore()
      .entries.filter((e) => e.module === 'knowledge')
      .map((e) => e.text)
    const picked = pickNewCandidates(items, existing, { limit: 8 })
    const added = saveLearned(
      picked.map((item) => {
        const { __part, ...rest } = item
        return { ...rest, sourceRef: sourceRefForPart(rest.sourceRef ?? source ?? '', __part ?? 0, parts.length) }
      }),
      sessionId,
      logger,
    )
    return {
      ok: true,
      fetched,
      source,
      chunks: covered.chunks,
      covered,
      extracted: items.length,
      added,
      skipped: items.length - picked.length,
      preview: picked.slice(0, 8).map((i) => (i.kind === 'style' ? '[表达] ' : '[知识] ') + i.text),
    }
  }

  /**
   * 自主学习：这一轮聊完，让模型判断有没有值得长期记住的知识。
   *
   * 默认关闭（modules.knowledge.learning.enabled）。异步跑，不阻塞这一轮结束；
   * 任何失败都只 warn —— 抽知识挂了绝不影响正常对话。
   */
  /**
   * 从一份资料里提炼知识（联网学习用）。
   * 跟 extractKnowledge 同形状，只是把 system/user 换成"读文章"那套提示。
   */
  async function extractFromMaterial(model, { source, text, sessionId } = {}) {
    if (!model?.provider || !model?.model) return []
    if (typeof ctx?.llm?.stream !== 'function') return []
    if (!String(text ?? '').trim()) return []

    let out = ''
    try {
      for await (const chunk of ctx.llm.stream({
        provider: model.provider,
        model: model.model,
        system: buildMaterialSystem(),
        messages: [
          {
            role: 'user',
            id: `material_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            content: [{ type: 'text', text: buildMaterialUser({ source, text }) }],
            source: { kind: 'plugin', plugin: 'dsh-shared-brain' },
          },
        ],
        ...(sessionId ? { sessionId } : {}),
        temperature: 0.2,
        maxTokens: 1600,
      })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') out += chunk.text
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') return []
      }
    } catch {
      return []
    }
    return parseLearned(out)
  }

  /**
   * 把提炼出来的条目写进知识库（模块桶 + 扁平库各一份）。
   * 对话学习和联网学习共用这一个入库口径，免得两处慢慢长歪。
   */
  function saveLearned(picked, sessionId, logger) {
    if (!Array.isArray(picked) || picked.length === 0) return 0
    // 写盘前重新读：调用方可能刚等过模型，手上那份快照已经旧了
    const latest = readModules()
    for (const item of picked) {
      putModuleItem(latest, 'knowledge', {
        text: item.text,
        weight: item.kind === 'style' ? 0.55 : 0.6,
        tags: [...(item.tags ?? []), item.kind === 'style' ? 'auto-style' : 'auto-learn'],
        pinned: false,
        source: 'auto',
        lifetime: 'permanent',
        sourceRef: item.sourceRef || KIND_SOURCE_REF[item.kind] || '自主学习',
      })
    }
    latest.updatedAt = Date.now()
    writeModulesSynced(latest)

    // 扁平库同步一份（召回与图谱都读这份）
    const store = readStore()
    for (const item of picked) {
      store.entries.push({
        id: `mem_learn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        text: item.text,
        tags: [...(item.tags ?? []), item.kind === 'style' ? 'auto-style' : 'auto-learn'],
        module: 'knowledge',
        weight: item.kind === 'style' ? 0.55 : 0.6,
        lifetime: 'permanent',
        expiresAt: 0,
        pinned: false,
        source: 'auto',
        sessionId: sessionId ?? '',
        cwd: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hits: 0,
        sourceRef: item.sourceRef || KIND_SOURCE_REF[item.kind] || '自主学习',
      })
    }
    store.updatedAt = Date.now()
    writeStoreSynced(store)
    logger?.info?.(`知识入库 ${picked.length} 条`)
    return picked.length
  }

  async function learnForTurn(ctx, agent, logger) {
    try {
      const modules = readModules()
      const config = learningConfig(modules)
      if (!config.enabled) return

      // 每日额度：超了等明天，别没完没了地往库里塞
      const state = getValue('learnState') ?? null
      if (quotaLeft(config, state, Date.now()) <= 0) {
        return
      }

      const turns = extractTurns(sessionEvents(agent?.session), { includeSelfTalk: true })
      const last = turns[turns.length - 1]
      if (!last) return
      const userText = String(last.text ?? '').trim()
      const reply = String(last.assistant ?? '').trim()
      if (!reply) return

      const model = pickModel(agent)
      const raw = await extractKnowledge(ctx, model, { userText, reply, sessionId: sessionIdOf(agent) })
      if (raw.length === 0) return

      // 等模型这几十秒里，别的路径（心情判定 / 设置页 / 桶自愈）可能已经写过 modules。
      // 拿开头那份快照写回会把它们的改动全盖掉 —— 「自主学习开关自己关回去」真因就是它。
      // 所以这里重读一次，并以最新配置为准（期间被关掉就不再写）。
      const latest = readModules()
      const latestConfig = learningConfig(latest) // 内部优先读独立 kv 键
      if (!latestConfig.enabled) return
      const latestState = getValue('learnState') ?? null
      const left = quotaLeft(latestConfig, latestState, Date.now())
      if (left <= 0) return

      const existing = (latest.knowledge?.items ?? []).map((i) => String(i.text ?? ''))
      const limit = Math.min(latestConfig.maxPerTurn, left)
      const picked = pickNewCandidates(raw, existing, { limit, config: latestConfig })
      if (picked.length === 0) {
        return
      }

      saveLearned(picked, sessionIdOf(agent), logger)

      // 扁平库同步一份（召回与图谱都读这份）
      const store = readStore()
      for (const item of picked) {
        store.entries.push({
          id: `mem_learn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          text: item.text,
          tags: [...(item.tags ?? []), item.kind === 'style' ? 'auto-style' : 'auto-learn'],
          module: 'knowledge',
          weight: item.kind === 'style' ? 0.55 : 0.6,
          lifetime: 'permanent',
          expiresAt: 0,
          pinned: false,
          source: 'auto',
          sessionId: sessionIdOf(agent) ?? '',
          cwd: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          hits: 0,
          sourceRef: KIND_SOURCE_REF[item.kind] ?? '自主学习',
        })
      }
      store.updatedAt = Date.now()
      writeStoreSynced(store)

      setValue('learnState', bumpState(state, picked.length, Date.now()))
      logger?.info?.(`自主学习：记下 ${picked.length} 条 —— ${picked.map((p) => p.text.slice(0, 20)).join(' / ')}`)
    } catch (error) {
      logger?.warn?.(`自主学习失败：${String(error?.message ?? error)}`)
    }
  }

  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      state.turnsSeen += 1
      persistTurn(agent)
    } catch (error) {
      state.lastError = String(error?.message ?? error)
      logger?.warn?.(`写入共享记忆失败：${state.lastError}`)
    }
    // 续接轮次：模型在这一轮回复末尾留了续接标记，就把这一轮接着跑下去。
    // 门槛在 shouldContinueTurn 里（作用范围 / 时间窗 / 最多 3 轮）。
    tryContinueTurn(agent, logger)
    // 心情判定：这一轮说完了，才知道心情怎么变的。
    // 异步跑，不阻塞这一轮结束。
    void judgeMoodForTurn(ctx, agent, logger)
    // 自主学习：这一轮聊完，看看有没有值得记下来的知识（默认关闭）
    void learnForTurn(ctx, agent, logger)
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
    // PERF-1：会话结束把攒着的热度/续期落盘，别等 debounce。
    flushPendingMemoryWrites()
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
      // 2026-11-04（E2）：这个会话成立的情感条目（情感模块 + 扁平库里 module=emotion 的）。
      // 主动搭话的决策层用它判断「老大最近对这个话题是什么态度」，
      // 以前这些字段只影响召回排序，不影响任何行为。
      getEmotions: (sessionId) => emotionEntriesOf(sessionId),
      // 2026-11-11（方案 §5.5）：话题池。从读过的书里挑由头，
      // 十分钟内复用同一份，免得每次 tick 都去读盘。
      getTopicPool: () => topicPoolCached(),
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
  // 人设同步：共享大脑里切人设 / 改正文，养鱼那个人设插件（dsh-persona-dafeiyu）跟着变
  try {
    const personaSync = startPersonaSync()
    logger?.info?.(`人设同步：每 ${Math.round(personaSync.intervalMs / 1000)} 秒对一次养鱼插件`)
  } catch (error) {
    logger?.warn?.(`人设同步启动失败：${error instanceof Error ? error.message : String(error)}`)
  }
  ctx.effect(() => () => stopPersonaSync(), 'dsh-shared-brain: persona sync')
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
  // 2026-11-11：把「联网学习」接给命令行用。不这么做的话，
  // /learn 只有 HTTP 一条路，老大在会话里根本够不着。
  setLearnRunner((options) => runMaterialLearn(options))
  // 2026-11-11：召回预览接给命令行（/shared-memory recall <文本>）。
  // 「这条为什么没被召回」一直只能靠猜，给个能直接看的地方。
  setRecallRunner((text) => {
    const context = currentContext() ?? {}
    return recallPreview(text, context.cwd ?? '', context.sessionId ?? '')
  })

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
              // 2026-11-06 修：GET 不再顺手清理过期条目 → 读接口没有写副作用。
              writeJson(response, 200, { ok: true, value: snapshotWithRuntime({ persist: false }) })
            },
          }),
        'dsh-shared-brain: status bridge',
      )
      scope.effect(
        () =>
          scope.webServer.register({
            kind: 'exact',
            path: BRIDGE_PULSE_PATH,
            handler: (request, response) => {
              if (!isLoopbackRequest(request)) {
                writeJson(response, 403, { ok: false, error: 'loopback requests only' })
                return
              }
              if ((request.method ?? 'GET') !== 'GET') {
                writeJson(response, 405, { ok: false, error: 'method not allowed' })
                return
              }
              // 只回内存里的统计，几十字节；桌宠每 20 秒拉一次也不心疼。
              writeJson(response, 200, { ok: true, value: proactivePulse() })
            },
          }),
        'dsh-shared-brain: pulse bridge',
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
              // 2026-11-06 修：拒绝跨站写（CSRF）。
              if (!isSameSiteRequest(request)) {
                writeJson(response, 403, { ok: false, error: 'cross-site request blocked' })
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
                  value: snapshotWithRuntime(),
                })
                return
              }
              const result = await mutateModules(body)
              if (!result.ok) {
                writeJson(response, 200, { ok: false, error: result.error })
                return
              }
              writeJson(response, 200, { ok: true, note: result.note, value: snapshotWithRuntime() })
            },
          }),
        'dsh-shared-brain: mutate bridge',
      )
      // 记忆图谱：独立 GET 路由。
      // 为什么不让 mutate 顺带返回：mutate 的返回体是 snapshotOf()，
      // 而图谱有几百个节点，塞进每次轮询的快照会把负载撑大。
      scope.effect(
        () =>
          scope.webServer.register({
            kind: 'exact',
            path: BRIDGE_GRAPH_PATH,
            handler: (request, response) => {
              if (!isLoopbackRequest(request)) {
                writeJson(response, 403, { ok: false, error: 'loopback requests only' })
                return
              }
              if ((request.method ?? '') !== 'GET') {
                writeJson(response, 405, { ok: false, error: 'method not allowed' })
                return
              }
              try {
                const url = request.url || ''
                // 2026-11-12 修：`?rebuild=1` 会写 graph.json，但这是个 GET ——
                // 跨站放一个 <img src="…/graph?rebuild=1"> 就能让插件替它重算并落盘，
                // 属于「读接口带写副作用」。这里给写盘那一路加同源闸门：
                // 浏览器同源请求会带 Sec-Fetch-Site / Origin，跨站的 <img> 两样都没有。
                const askedRebuild = /[?&]rebuild=1/.test(url)
                const rebuild = askedRebuild && isSameSiteRequest(request)
                writeJson(response, 200, { ok: true, value: graphSnapshot({ rebuild, candidateLimit: 40 }) })
              } catch (error) {
                writeJson(response, 500, { ok: false, error: String(error?.message ?? error) })
              }
            },
          }),
        'dsh-shared-brain: memory graph bridge',
      )
      // 联网学习（2026-11-06）：抓一页资料 → 提炼 → 入库。
      // 不自动乱爬：只处理明确给的 URL 或正文。
      scope.effect(
        () =>
          scope.webServer.register({
            kind: 'exact',
            path: '/api/dsh-shared-brain/learn',
            handler: async (request, response) => {
              if (!isLoopbackRequest(request)) {
                writeJson(response, 403, { ok: false, error: 'loopback requests only' })
                return
              }
              // 2026-11-06 修：/learn 会联网并写库，同样只收同站请求。
              if (!isSameSiteRequest(request)) {
                writeJson(response, 403, { ok: false, error: 'cross-site request blocked' })
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
              try {
                const body2 = body ?? {}
                const result = await runMaterialLearn({
                  url: body2.url ? String(body2.url) : '',
                  text: body2.text ? String(body2.text) : '',
                  source: body2.source ? String(body2.source) : '',
                  logger,
                })
                writeJson(response, 200, result)
              } catch (error) {
                writeJson(response, 500, { ok: false, error: String(error?.message ?? error) })
              }
            },
          }),
        'dsh-shared-brain: web learn',
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
/**
 * 桥接快照 + 只有 index 才知道的运行时信息。
 *
 * 2026-11-12：注入预算（「这一轮记忆被砍掉几行」）以前只写进 state、全库零读取方，
 * bridge 又拿不到 index 的 state（反向 import 会成环），所以在这里统一补一层再给出去。
 */
function snapshotWithRuntime(extra = {}) {
  const trim = state.lastInjectTrim
  return snapshotOf({
    ...extra,
    injectTrim: trim
      ? {
        at: trim.at,
        droppedLines: trim.droppedLines,
        originalChars: trim.originalChars,
        keptChars: trim.keptChars,
      }
      : null,
  })
}

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
    // 2026-11-12：注入预算以前只写不读，谁也不知道记忆被砍了几行。放出来给界面看。
    injectTrim: state.lastInjectTrim
      ? {
        at: state.lastInjectTrim.at,
        droppedLines: state.lastInjectTrim.droppedLines,
        originalChars: state.lastInjectTrim.originalChars,
        keptChars: state.lastInjectTrim.keptChars,
      }
      : null,
  }
}

export { name, inject }
export default { name, inject, apply }
