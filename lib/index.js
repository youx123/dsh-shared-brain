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
import { readStore, writeStore, newId, brainFile, pruneExpired, isAlive, renewEntry, DEFAULT_TEMPORARY_TTL_MS } from './store.js'
import { recall, renderRecall } from './recall.js'
import { summarizeTurn, isDuplicate } from './summarize.js'
import { activePersona, personaList, personaFile, adoptLegacyPersona, renderPersona } from './persona.js'
import { ensureGlobalBank, hindsightCredentialState, hindsightConfigFile, GLOBAL_BANK_ID } from './hindsight-config.js'
import { extractTurns, sessionEvents } from './transcript.js'
import { registerCommands } from './commands.js'
import { classify, topicOverlap } from './classify.js'
import { judgeLifetime } from './lifetime.js'
import { findConflicts } from './conflict.js'
import { readModules, writeModules, putModuleItem, moduleSummary, ALL_MODULES, MODULE_LABELS, MEMORY_MODULES, MODULE_PROFILES, withinTimeWindow } from './modules.js'
import { createSessionCatalog } from './sessions.js'
import { ensureEmojiLoader, stopEmojiLoader, defaultEmojiDir } from './emoji.js'
import { mkdirSync } from 'node:fs'
import { recallModules, renderModuleRecall, renderVoice, renderCapabilities } from './weighted-recall.js'
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
  refreshSessions,
} from './bridge.js'

const name = 'dsh-shared-brain'
const inject = ['systemPrompt', 'agents', 'commands']

/** 注入到系统提示词里的段落名。 */
const RECALL_SECTION = 'shared-brain:memory'
/** 人设摘要段落名。 */
const PERSONA_SECTION = 'shared-brain:persona'
/** 声音段落名。 */
const VOICE_SECTION = 'shared-brain:voice'
/** 能力段落名。 */
const CAPABILITY_SECTION = 'shared-brain:capability'

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
  lastError: null,
  personaNotes: [],
  hindsightNotes: [],
  moduleCounts: { bottomline: 0, cognition: 0, emotion: 0, instinct: 0 },
}

/** 每个会话已经摘要过几轮（同一轮不重复入账）。 */
const summarized = new Map()

/** 本轮提示词：组装系统提示词时用来做召回查询。 */
let currentPrompt = ''

/** 当前所在的会话（用于「自动互动」的作用域判断）。 */
let currentSession = { id: '', title: '' }

/** 当前会话的工作目录（用于「底线作用域」判断）。 */
let currentCwd = ''

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
  return id ? id.slice(0, 8) : ''
}

/**
 * 从一段消息列表里取出用户发来的文本。
 * 宿主给用户消息打 source.kind = 'user'（与 hindsight 插件读法一致），
 * 但万一路径不同、只留了 role，这里也认。
 */
function userTextOf(messages) {
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
    writeStore(store)

    // 同步进模块配置（模块里保存的是「带权重的条目副本」，方便单独调权重）
    const modules = readModules()
    putModuleItem(modules, moduleKey, {
      text: candidate.text,
      weight: classification.weight,
      tags: candidate.tags,
      pinned: false,
      source: 'auto',
      lifetime: life.lifetime,
      expiresAt: life.expiresAt,
      ttlMs: life.ttlMs ?? 0,
      supersedes: entry.supersedes,
    })
    writeModules(modules)

    state.moduleCounts[moduleKey] = (state.moduleCounts[moduleKey] ?? 0) + 1
    state.turnsSaved += 1
    if (conflicts.length > 0) {
      state.conflictsFound = (state.conflictsFound ?? 0) + conflicts.length
    }
  }
  summarized.set(sessionId, turns.length)
}

/**
 * 跨模块召回：把扁平库里属于各模块的条目收集起来，交给加权召回。
 *
 * 同时做两件维护工作：
 *   1. 清理已过期的临时记忆（顺手写回磁盘，别让垃圾一直堆着）
 *   2. 归位时带上 lifetime / pinned / expiresAt，让召回层能判断有效性
 */
function recallFor(text) {
  const raw = readStore()
  const { store, removed } = pruneExpired(raw)
  if (removed > 0) writeStore(store)
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
      source: entry.source === 'manual' ? 'manual' : 'auto',
      scope: entry.scope === 'workspace' ? 'workspace' : 'global',
      scopePath: entry.scopePath ?? '',
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

  // 作用域过滤：限定在某个工作区的条目，只在那个工作区的会话里生效。
  const cwd = currentCwd
  const inScope = (item) => {
    if (!item || item.scope !== 'workspace') return true
    if (!item.scopePath) return false
    if (!cwd) return false
    return pathMatches(item.scopePath, cwd)
  }
  for (const key of MEMORY_MODULES) {
    merged[key].items = merged[key].items.filter(inScope)
  }

  const result = recallModules(merged, text, { limit: RECALL_LIMIT })

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
    if (touched) writeStore(store)
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
  writeModules(modules)
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
  // 人设段落：注入当前人设正文（支持按会话指定的人设）。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PERSONA_SECTION,
        order: 1501,
        text: () => personaText(currentSession.id),
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
        text: () => renderCapabilities(readModules(), { sessionId: currentSession.id, sessionTitle: currentSession.title }),
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
        text: () => {
          const prompt = currentPrompt
          if (!prompt) return ''
          const result = recallFor(prompt)
          if (result.hits.length === 0 && result.always.length === 0) return ''
          state.recallsServed += 1
          return renderModuleRecall(result)
        },
        interpolate: false,
      }),
    'dsh-shared-brain: memory section',
  )

  // ── 阶段 3：会话钩子 ────────────────────────────────────────────
  // pre-step：在模型看到本轮提示词之前召回记忆；拿到回复之后由 turn-stopping 入库。
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal?.aborted) return decision
    try {
      const prompt = userTextOf(decision.messages)
      if (!prompt) return decision
      currentPrompt = prompt
      // 记住当前会话与它的工作目录，供「自动互动」与「底线作用域」判断
      currentSession = {
        id: sessionIdOf(agent),
        title: sessionTitleOf(agent),
      }
      currentCwd = cwdOf(agent)
      // 会话目录按需刷新（内部节流），设置页打开时就能看到当前会话
      sessionCatalog.setCurrent(currentSession.id)
      void sessionCatalog.refresh()

      const result = recallFor(prompt)
      const rendered = renderModuleRecall(result)
      if (!rendered) return decision

      const injection = {
        id: `shared-memory-${Date.now().toString(36)}`,
        role: 'user',
        content: [{ type: 'text', text: `<shared-memory-injection>\n${rendered}\n</shared-memory-injection>` }],
        source: { kind: `plugin:${name}`, form: 'recall' },
      }
      return { kind: 'enter', messages: [...decision.messages, injection] }
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
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId) summarized.delete(sessionId)
  })

  // ── 阶段 4：/shared-memory 命令 ──────────────────────────────────
  registerCommands(ctx)

  // ── 阶段 5：浏览器半侧的数据桥（设置页 / 侧边栏读写模块配置）─────
  // 把宿主的会话目录接进来，设置页才能列出工作区下的会话。
  // 启动后先在后台扫一次，设置页第一次打开就有东西可选。
  setSessionCatalogProvider(() => {
    sessionCatalog.setCurrent(currentSession.id)
    return sessionCatalog.snapshot()
  })
  void sessionCatalog.refresh({ force: true })
  setSessionRefresher(() => sessionCatalog.refresh({ force: true }))
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
              const result = mutateModules(body)
              if (!result.ok) {
                writeJson(response, 200, { ok: false, error: result.error })
                return
              }
              writeJson(response, 200, { ok: true, note: result.note, value: snapshotOf() })
            },
          }),
        'dsh-shared-brain: mutate bridge',
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
