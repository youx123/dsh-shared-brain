/**
 * 浏览器半侧的数据接口。
 *
 * 宿主侧（DSH 服务端）与浏览器侧（Web GUI）之间的桥：
 *   GET  /api/dsh-shared-brain/status   读取模块快照
 *   POST /api/dsh-shared-brain/mutate   修改模块（权重 / 开关 / 声音 / 清空）
 *
 * 只允许 loopback 调用，跟随 dsh-persona-dafeiyu 的既有做法。
 */
import {
  readModules,
  clampWeight,
  MODULE_LABELS,
  ALL_MODULES,
  MEMORY_MODULES,
  MODULE_PROFILES,
  moduleSummary,
  putModuleItem,
  setModuleItemPinned,
  setModuleItemScope,
  setAgentiveTimeWindow,
  setAgentiveMood,
  setSpeech,
  normalizeSpeech,
  AGENTIVE_SCOPES,
  clampAgentiveInterval,
  normalizeEmojiSemantic,
} from './modules.js'
import { readStore, brainFile, pruneExpired, DEFAULT_TEMPORARY_TTL_MS } from './store.js'
import { applyRemoteSync, remoteSyncStatus, runRemoteSync } from './remote-sync.js'
import { applyPersonaSync, personaSyncStatus, syncPersonaToPlugin } from './persona-sync.js'
import { redactSecrets } from './summarize.js'
import { writeStoreSynced, writeModulesSynced } from './cross-sync.js'
import {
  buildGraph,
  readGraph,
  writeGraph,
  graphFile,
  archiveCandidates,
  markArchived,
  unmarkArchived,
} from './memory-graph.js'
import { writeEmoji, defaultEmojiDir, emojiStatus, clampEmojiInterval } from './emoji.js'
import { runProactiveNow, proactiveStatus, PROACTIVE_INTERVAL_JITTER } from './proactive.js'
import {
  activePersona,
  personaList,
  selectPersona,
  savePersona,
  deletePersona,
  setSessionPersona,
  personaFile,
} from './persona.js'
import {
  readEmotionStore,
  writeEmotionStore,
  normalizeMoodConfig,
  moodStatus,
  MOOD_DEFAULTS,
  INJECT_MODES,
  emotionSemantics,
} from './emotion.js'

/** 会话目录的刷新函数，由 index.js 在 apply 时注入（bridge 自己不碰宿主服务）。 */
let sessionRefresher = null

/** 装入（或清掉）会话刷新函数。 */
export function setSessionRefresher(fn) {
  sessionRefresher = typeof fn === 'function' ? fn : null
}

/**
 * 强制重扫会话目录。
 *
 * 设置页点「刷新会话」走这里：必须等扫完再回快照，否则前端拿到的还是旧的。
 */
export async function refreshSessions() {
  if (!sessionRefresher) return { ok: false, error: '宿主没有提供会话刷新' }
  try {
    await sessionRefresher()
    return { ok: true, note: '会话列表已刷新' }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

export const BRIDGE_STATUS_PATH = '/api/dsh-shared-brain/status'
export const BRIDGE_MUTATE_PATH = '/api/dsh-shared-brain/mutate'
/** 记忆图谱的独立读取路由：图谱有几百个节点，塞进 status 快照会把每次轮询都撑大。 */
export const BRIDGE_GRAPH_PATH = '/api/dsh-shared-brain/graph'

/**
 * 取一份记忆图谱快照（节点 + 边 + 归档候选）。
 *
 * 图谱是**派生缓存**：graph.json 坏了就从记忆库重建，不影响记忆本身。
 * 缓存是否过期看两件事：活跃条目数变了没、最新一条记忆有没有更新过。
 *
 * @param {{ rebuild?: boolean, candidateLimit?: number }} options
 */
export function graphSnapshot(options = {}) {
  const store = readStore()
  const active = store.entries.filter((entry) => entry && entry.archived !== true)
  const newest = active.reduce((max, entry) => Math.max(max, Number(entry.updatedAt) || 0), 0)
  let graph = readGraph()
  const stale = !graph
    || graph.stats?.memories !== active.length
    || (graph.stats?.newest ?? 0) < newest
  if (options.rebuild === true || stale) {
    graph = writeGraph(buildGraph(store.entries))
  }
  const stats = graph?.stats ?? {}
  const limit = Number.isFinite(options.candidateLimit)
    ? Math.min(200, Math.max(1, options.candidateLimit))
    : 40
  const candidates = archiveCandidates(store.entries, graph ?? buildGraph(store.entries))
  return {
    graph: {
      nodes: graph?.nodes ?? [],
      edges: graph?.edges ?? [],
      stats,
      updatedAt: graph?.updatedAt ?? 0,
    },
    graphFile: graphFile(),
    candidates: candidates.slice(0, limit),
    total: candidates.length,
  }
}

/**
 * 会话目录的提供方。
 *
 * 浏览器端要能列出「工作区下的会话」让用户挑，但工作区与会话都在宿主进程里，
 * 所以由 index.js 在 apply() 时把宿主服务接进来。
 *
 * @typedef {{ workspaces: Array<{ id: string, title: string, path: string, sessions: Array<{ id: string, title: string, cwd: string, createdAt: number }> }> }} SessionCatalog
 */

/** 当前接入的会话目录提供方（index.js 在 apply 里设置）。 */
let catalogProvider = null

/** 宿主上下文（index.js 在 apply 里设置），给「立刻主动一次」用。 */
let bridgeCtx = null

/**
 * 模块配置变更后的回调（index.js 用来重启自动互动定时器）。
 */
let onModulesChanged = null

/** 接入宿主上下文。 */
export function setBridgeContext(ctx) {
  bridgeCtx = ctx ?? null
}

/**
 * 注册「配置变了」的回调。
 *
 * 改了自动互动的开关或间隔后要立刻重启定时器，不然要等到下一次重启才生效。
 */
export function setModulesChangedHandler(fn) {
  onModulesChanged = typeof fn === 'function' ? fn : null
}

/** 通知外部：配置已变（定时器、段落缓存等靠这个重载）。 */
export function notifyModulesChanged() {
  if (!onModulesChanged) return
  try {
    onModulesChanged()
  } catch {
    // 回调失败不影响配置本身
  }
}

/** 取宿主上下文。 */
export function bridgeContext() {
  return bridgeCtx
}

/**
 * 接入宿主的会话目录。
 * @param {(() => SessionCatalog) | null} provider
 */
export function setSessionCatalogProvider(provider) {
  catalogProvider = typeof provider === 'function' ? provider : null
}

/** 会话目录的空结构：前端的字段都补齐，省得每处兜底。 */
function emptySessionCatalog(error = '') {
  return {
    workspaces: [],
    flat: [],
    total: 0,
    live: 0,
    current: '',
    updatedAt: 0,
    error,
    scanning: false,
  }
}

/**
 * 列出工作区与其下的会话。
 * 没有接宿主服务时返回空结构（前端据此提示「暂时拿不到会话列表」）。
 *
 * 注意：以前这里只透传 `workspaces`，把 flat / total / live / current
 * 这些字段全丢了，于是设置页拿不到总数、也看不出哪些会话是活着的，
 * 只能把每个工作区的历史会话一股脑列出来。
 */
export function sessionCatalog() {
  if (!catalogProvider) return emptySessionCatalog('还没接上宿主的会话服务')
  try {
    const value = catalogProvider()
    if (!value || !Array.isArray(value.workspaces)) return emptySessionCatalog('会话目录暂时读不到')
    const flat = Array.isArray(value.flat) ? value.flat : []
    return {
      workspaces: value.workspaces,
      flat,
      total: Number.isFinite(value.total) ? value.total : flat.length,
      live: Number.isFinite(value.live) ? value.live : flat.filter((item) => item?.live === true).length,
      current: typeof value.current === 'string' ? value.current : '',
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      error: typeof value.error === 'string' ? value.error : '',
      scanning: value.scanning === true,
    }
  } catch (error) {
    return emptySessionCatalog(String(error?.message ?? error))
  }
}

/** 只接受 loopback 请求。 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  const okAddress = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === undefined
  if (!okAddress) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return true
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/** 写一份 JSON 响应。 */
export function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end?.(body)
}

/** 读请求体（JSON），带体积上限。 */
export function readJsonBody(request, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(undefined)
        request.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return finish({})
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    request.on('error', () => finish(undefined))
  })
}

/** 从请求 URL 里取一个查询参数。 */
export function queryParam(request, key) {
  try {
    const value = new URL(request?.url ?? '/', 'http://127.0.0.1').searchParams.get(key)
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** 解析模块键：中文名或英文 id 都认。 */
export function resolveModuleKey(input) {
  if (typeof input !== 'string') return undefined
  const key = input.trim().toLowerCase()
  if (!key) return undefined
  if (ALL_MODULES.includes(key)) return key
  for (const [id, label] of Object.entries(MODULE_LABELS)) {
    if (label === input.trim() || label.toLowerCase() === key) return id
  }
  // 常见别名
  const aliases = {
    底线: 'bottomline', 底线模块: 'bottomline', bottom: 'bottomline',
    认知: 'cognition', 认知模块: 'cognition', know: 'cognition',
    情感: 'emotion', 情感模块: 'emotion', feel: 'emotion',
    本能: 'instinct', 本能模块: 'instinct', habit: 'instinct',
    声音: 'voice', 语气: 'voice', 语气风格: 'voice',
    网络: 'network', 外网: 'network',
    自动互动: 'agentive', 主动: 'agentive', 主动性: 'agentive', 主观能动性: 'agentive',
  }
  return aliases[input.trim()] ?? aliases[key]
}

/**
 * 生成给浏览器看的完整快照。
 */
export function snapshotOf(extra = {}) {
  const modules = readModules()
  const raw = readStore()
  const { store, removed } = pruneExpired(raw)
  if (removed > 0) writeStoreSynced(store, { bump: false })
  const summary = moduleSummary(modules)
  return {
    modules: summary,
    voice: {
      enabled: modules.voice.enabled,
      weight: modules.voice.weight,
      style: modules.voice.style ?? {},
      items: (modules.voice.items ?? []).slice(0, 20),
    },
    memory: {
      file: brainFile(),
      total: store.entries.length,
      byModule: countByModule(store.entries),
      byLifetime: countByLifetime(store.entries),
      latest: store.entries.slice(-8).map((entry) => ({
        id: entry.id,
        module: entry.module,
        text: String(entry.text).slice(0, 160),
        weight: entry.weight,
        lifetime: entry.lifetime === 'temporary' ? 'temporary' : 'permanent',
        expiresAt: entry.expiresAt ?? 0,
        pinned: entry.pinned === true,
        createdAt: entry.createdAt,
      })),
    },
    profiles: MODULE_PROFILES,
    labels: MODULE_LABELS,
    memoryModules: MEMORY_MODULES,
    allModules: ALL_MODULES,
    sessions: sessionCatalog(),
    // 人设：现在由本插件自己拥有，切换后立即生效
    persona: {
      file: personaFile(),
      current: activePersona().id,
      name: activePersona().name,
      chars: activePersona().text?.length ?? 0,
      bundled: activePersona().bundled === true,
      text: activePersona().text ?? '',
      list: personaList(),
      bySession: readPersonaBySession(),
    },
    // 语音参数：给将来的语音/唱歌模块用
    speech: normalizeSpeech(modules.voice?.style?.speech),
    // 表情包：目录 + 读到的表情清单（由定时自动加载器维护缓存）
    emoji: emojiStatus(modules.voice?.style ?? {}),
    // 心情：情感模块的新维度 —— 当前心情、七根情绪、时间线、配置
    emotion: moodStatus(readEmotionStore()),
    // 自动互动：开关 + 作用范围 + 定时器实际运行状态
    // 跨机同步：私有仓库 + 上次同步结果
    remoteSync: remoteSyncStatus(),
    // 人设同步：共享大脑 → 养鱼插件（dsh-persona-dafeiyu）
    personaSync: personaSyncStatus(),
    proactive: {
      enabled: modules.agentive?.enabled === true,
      scope: modules.agentive?.scope ?? 'all',
      sessionIds: modules.agentive?.sessionIds ?? [],
      intervalMs: modules.agentive?.intervalMs ?? 0,
      timeWindow: modules.agentive?.timeWindow ?? { enabled: false, start: '09:00', end: '23:00' },
      // 心情驱动的参数（2026-11-02 新增）：低落关心 / 高涨分享 / 中性静默
      mood: modules.agentive?.mood ?? {},
      runtime: proactiveStatus(),
    },
    updatedAt: modules.updatedAt ?? 0,
    ...extra,
  }
}

/** 取「按会话指定的人设」映射（给前端渲染用）。 */
function readPersonaBySession() {
  try {
    return personaList().bySession ?? {}
  } catch {
    return {}
  }
}

function countByModule(entries) {
  const out = {}
  for (const entry of entries) {
    const key = entry.module ?? 'cognition'
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

function countByLifetime(entries) {
  const out = { permanent: 0, temporary: 0 }
  for (const entry of entries) {
    const key = entry.lifetime === 'temporary' ? 'temporary' : 'permanent'
    out[key] += 1
  }
  return out
}

/**
 * 修改模块配置。
 *
 * action:
 *   setWeight     { module, weight }
 *   setEnabled    { module, enabled, reason? }
 *   setVoice      { tone?, tics?, emoji?, address? }
 *   clear         { module? }
 *   addItem       { module, text, weight?, lifetime?, ttlMs?, pinned? }  手动加一条
 *   removeItem    { module, id }                                       删一条
 *   pinItem       { module, id, pinned }                               钉住/取消钉住
 *   setLifetime   { module, id, lifetime, ttlMs? }                     永久/临时
 *   setAgentiveScope { scope, sessionIds? }                            自动互动的作用范围
 *   setAgentiveTimeWindow { enabled, start?, end? }                    自动互动的时间窗
 *   setAgentiveInterval { intervalMs?, intervalMinutes? }              自动互动的主动检查间隔
 *   setAgentiveMood  { enabled?, lowMood?, highMood?, quietPeriodMs?, maxPerDay?, lowIntervalFactor?, highIntervalFactor?, maxConcernsPerSession?, allowConcern?, allowShare? }  心情驱动的参数
 *   runProactive    {}                                                立刻对所有活跃会话发一次主动检查
 *   setSpeech     { voiceId?, voiceName?, rate?, pitch?, volume?, sing? }    语音/唱歌参数
 *   setEmojiDir   { dir }                                                   表情包目录
 *   setEmojiAuto  { enabled?, intervalMs?, intervalMinutes? }                表情目录定时自动加载
 *   rescanEmoji   {}                                                        立刻重扫表情目录
 *   addEmoji      { name, value, dir? }                                     往目录里加一个表情
 *   setItemScope  { module, id, scope, scopePath?, scopeSession? }                条目作用域（全局/工作区/会话）
 *   setMoodConfig { enabled?, moodBase?, moodFloor?, decayHalfHours?, injectMode?, injectConfidence?, injectPerDay?, sigMood?, sigDim?, judgeProvider?, judgeModel?, aliases? }  心情配置
 *   resetMood     { sessionId? }                                                 清掉心情（不给 sessionId 就是全部）
 *   selectPersona { id }                                                    切换人设
 *   savePersona   { id?, name, text }                                       新建/覆盖人设
 *   deletePersona { id }                                                    删除人设
 *   setSessionPersona { sessionId, id }                                     给某个会话单独指定人设
 *   searchMemory  { query, limit?, module?, lifetime?, pinned?, tag? }       搜索记忆（可过滤）
 */
export function mutateModules(body) {
  const action = typeof body?.action === 'string' ? body.action : ''
  const modules = readModules()
  // 配置改完统一通知一次（让定时器之类的跟着重启）
  const done = (result) => {
    if (result?.ok) notifyModulesChanged()
    return result
  }

  if (action === 'setWeight') {
    const module = resolveModuleKey(body?.module)
    if (!module) return { ok: false, error: `不认识的模块「${body?.module ?? ''}」` }
    const weight = clampWeight(body?.weight, modules[module].weight)
    modules[module].weight = weight
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    return done({ ok: true, note: `${MODULE_LABELS[module]} 权重设为 ${weight}` })
  }

  if (action === 'setEnabled') {
    const module = resolveModuleKey(body?.module)
    if (!module) return { ok: false, error: `不认识的模块「${body?.module ?? ''}」` }
    const enabled = body?.enabled !== false
    modules[module].enabled = enabled
    if (!enabled && typeof body?.reason === 'string' && body.reason.trim()) {
      modules[module].reason = body.reason.trim().slice(0, 200)
    }
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    return done({ ok: true, note: `${MODULE_LABELS[module]} 已${enabled ? '启用' : '停用'}` })
  }

  if (action === 'setVoice') {
    const style = modules.voice.style ?? {}
    // 传空串表示清掉这一项（原来只在非空时才写，清不掉）
    if (typeof body?.tone === 'string') style.tone = body.tone.trim().slice(0, 200)
    if (typeof body?.emoji === 'string') style.emoji = body.emoji.trim().slice(0, 16)
    if (typeof body?.address === 'string') style.address = body.address.trim().slice(0, 40)
    if (Array.isArray(body?.tics)) {
      style.tics = body.tics
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => t.trim().slice(0, 40))
        .slice(0, 12)
    }
    modules.voice.style = style
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    return done({ ok: true, note: '声音风格已更新' })
  }

  if (action === 'clear') {
    const module = body?.module ? resolveModuleKey(body.module) : undefined
    if (body?.module && !module) return { ok: false, error: `不认识的模块「${body.module}」` }
    const store = readStore()
    if (module) {
      const before = store.entries.length
      store.entries = store.entries.filter((entry) => (entry.module ?? 'cognition') !== module)
      modules[module].items = []
      writeStoreSynced(store)
      writeModulesSynced(modules)
    return done({ ok: true, note: `已清空${MODULE_LABELS[module]}：${before - store.entries.length} 条` })
    }
    store.entries = []
    for (const key of ALL_MODULES) modules[key].items = []
    writeStoreSynced(store)
    writeModulesSynced(modules)
    return done({ ok: true, note: '已清空全部共享记忆' })
  }

  // ── 手动管理条目 ──────────────────────────────────────────────
  if (action === 'addItem') {
    const module = resolveModuleKey(body?.module)
    if (!module || !MEMORY_MODULES.includes(module)) {
      return { ok: false, error: `不认识的模块「${body?.module ?? ''}」` }
    }
    const text = String(body?.text ?? '').trim()
    if (!text) return { ok: false, error: '内容不能为空' }
    const lifetime = body?.lifetime === 'temporary' ? 'temporary' : 'permanent'
    const ttl = Number.isFinite(body?.ttlMs) && body.ttlMs > 0 ? body.ttlMs : DEFAULT_TEMPORARY_TTL_MS
    const pinned = body?.pinned === true
    // 手动加的条目也要脱敏——记忆是长期存储，别把密钥写进去
    const safeText = redactSecrets(text)
    // 2026-11-04（E1）：情感模块的条目要带上 intimacy / sentiment / target。
    // 以前这里只写 weight，归位时（index.js）才补默认值 —— 结果手动记的
    // 「老大讨厌啰嗦」被当成中性，亲密度也退化成通用权重。
    // 现在：调用方给了就用给的；没给就从正文自动推断。
    const emotionFields = module === 'emotion' ? emotionSemantics(body, safeText) : {}
    const item = {
      text: safeText.slice(0, 2000),
      weight: clampWeight(body?.weight, module === 'bottomline' ? 0.9 : 0.6),
      tags: [],
      pinned,
      source: 'manual',
      lifetime,
      expiresAt: lifetime === 'temporary' ? Date.now() + ttl : 0,
      ...emotionFields,
    }
    const result = putModuleItem(modules, module, item)
    if (!result.changed) return { ok: false, error: result.note }
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)

    // 同步进扁平库，浏览器端与召回层用的是同一份数据
    const store = readStore()
    store.entries.push({
      id: `mem_manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text: item.text,
      tags: [],
      module,
      weight: item.weight,
      lifetime,
      expiresAt: item.expiresAt,
      pinned,
      source: 'manual',
      sessionId: '',
      cwd: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hits: 0,
      // 情感语义字段（2026-11-04，E1）：扁平库这份以前是「残」的 ——
      // 只有 modules.json 那份有，导致召回排序按中性算。
      ...emotionFields,
    })
    writeStoreSynced(store)
    return done({ ok: true, note: `已记入${MODULE_LABELS[module]}${pinned ? '（已钉住，会一直生效）' : ''}` })
  }

  if (action === 'removeItem') {
    const module = resolveModuleKey(body?.module)
    if (!module || !MEMORY_MODULES.includes(module)) {
      return { ok: false, error: `不认识的模块「${body?.module ?? ''}」` }
    }
    const id = String(body?.id ?? '')
    const target = modules[module].items.find((it) => it.id === id)
    if (!target) return { ok: false, error: '找不到这条条目' }
    modules[module].items = modules[module].items.filter((it) => it.id !== id)
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)

    const store = readStore()
    store.entries = store.entries.filter((entry) => !(entry.module === module && entry.text === target.text))
    writeStoreSynced(store)
    return done({ ok: true, note: `已删除${MODULE_LABELS[module]}里的一条` })
  }

  if (action === 'pinItem') {
    const module = resolveModuleKey(body?.module)
    if (!module || !MEMORY_MODULES.includes(module)) {
      return { ok: false, error: `不认识的模块「${body?.module ?? ''}」` }
    }
    const id = String(body?.id ?? '')
    const pinned = body?.pinned === true
    const result = setModuleItemPinned(modules, module, id, pinned)
    if (!result.changed) return { ok: false, error: result.note }
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)

    // 扁平库同步：钉住状态要两边一致，召回时以哪边为准都不出错
    const store = readStore()
    const target = modules[module].items.find((it) => it.id === id)
    if (target) {
      store.entries = store.entries.map((entry) =>
        entry.module === module && entry.text === target.text
          ? { ...entry, pinned, source: pinned ? 'manual' : entry.source, updatedAt: Date.now() }
          : entry,
      )
      writeStoreSynced(store)
    }
    return done({ ok: true, note: result.note })
  }

  if (action === 'setLifetime') {
    const module = resolveModuleKey(body?.module)
    if (!module || !MEMORY_MODULES.includes(module)) {
      return { ok: false, error: `不认识的模块「${body?.module ?? ''}」` }
    }
    const id = String(body?.id ?? '')
    const lifetime = body?.lifetime === 'temporary' ? 'temporary' : 'permanent'
    const ttl = Number.isFinite(body?.ttlMs) && body.ttlMs > 0 ? body.ttlMs : DEFAULT_TEMPORARY_TTL_MS
    const expiresAt = lifetime === 'temporary' ? Date.now() + ttl : 0
    const item = modules[module].items.find((it) => it.id === id)
    if (!item) return { ok: false, error: '找不到这条条目' }
    item.lifetime = lifetime
    item.expiresAt = expiresAt
    item.updatedAt = Date.now()
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)

    const store = readStore()
    store.entries = store.entries.map((entry) =>
      entry.module === module && entry.text === item.text
        ? { ...entry, lifetime, expiresAt, updatedAt: Date.now() }
        : entry,
    )
    writeStoreSynced(store)
    return done({
        ok: true,
        note: lifetime === 'temporary'
          ? `已改为临时记忆（${Math.round(ttl / 3600000)} 小时后过期）`
          : '已改为永久记忆',
      })
  }

  if (action === 'setAgentiveScope') {
    const scope = body?.scope
    if (!AGENTIVE_SCOPES.includes(scope)) {
      return { ok: false, error: `不认识的作用范围「${scope ?? ''}」，只能是 all 或 session` }
    }
    const sessionIds = Array.isArray(body?.sessionIds)
      ? body.sessionIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()).slice(0, 50)
      : []
    modules.agentive.scope = scope
    modules.agentive.sessionIds = scope === 'session' ? sessionIds : []
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    return done({
        ok: true,
        note: scope === 'session'
          ? sessionIds.length > 0
            ? `自动互动已限定在 ${sessionIds.length} 个会话内`
            : '自动互动没有限定会话（等于对所有会话生效）'
          : '自动互动对所有会话生效',
      })
  }

  // ── 自动互动：主动检查的间隔 ────────────────────────────────
  if (action === 'setAgentiveInterval') {
    const minutes = Number(body?.intervalMinutes)
    const ms = Number.isFinite(minutes) && minutes > 0
      ? minutes * 60 * 1000
      : Number(body?.intervalMs)
    if (!Number.isFinite(ms) || ms <= 0) {
      return { ok: false, error: '间隔要填分钟数或毫秒数' }
    }
    const clamped = clampAgentiveInterval(ms)
    modules.agentive.intervalMs = clamped
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    const baseMin = Math.round(clamped / 60000)
    return done({
        ok: true,
        note: `自动互动基准间隔设为 ${baseMin} 分钟（实际每次在 ${Math.max(1, Math.round(baseMin * (1 - PROACTIVE_INTERVAL_JITTER)))}~${Math.round(baseMin * (1 + PROACTIVE_INTERVAL_JITTER))} 分钟之间随机）`,
      })
  }

  // ── 自动互动：心情驱动参数 ──────────────────────────────────
  if (action === 'setAgentiveMood') {
    const result = setAgentiveMood(modules, body ?? {})
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    return done({
      ok: true,
      note: result.note,
      value: { mood: modules.agentive.mood },
    })
  }

  // ── 自动互动：立刻主动一次 ──────────────────────────────────
  if (action === 'runProactive') {
    // 必须把 agentive 配置传进去：runProactiveNow 拿不到配置时会当成
    // 「开关是关的」，把所有会话都判成不在作用域内，一个都发不出去。
    const result = runProactiveNow(bridgeContext(), {
      force: true,
      getAgentive: () => readModules().agentive ?? {},
    })
    let note = ''
    if (result.sent > 0) {
      note = `已对 ${result.sent} 个会话发出主动检查（共 ${result.total} 个活跃会话）`
    } else if (result.total === 0) {
      note = '现在没有活跃会话，等你开一个会话就能主动搭话了。'
    } else if (result.enabled === false) {
      note = '自动互动开关是关的，先在设置页或用 /shared-memory agentive on 打开。'
    } else {
      // 以前只说「N 个都跳过了」，用户根本看不出是开关、作用域还是时间窗的问题
      const why = {
        scope: '不在你选中的会话里',
        window: '不在时间窗内',
        disabled: '开关关着',
        channel: '这个会话不支持主动注入',
        cooldown: '刚主动过，还在冷却',
        duplicate: '和上一次主动内容相同',
        error: '发送时报错',
        unknown: '原因未知',
      }
      const detail = (Array.isArray(result.reasons) ? result.reasons : [])
        .map((item) => why[item?.reason] ?? String(item?.reason ?? '未知原因'))
        .filter((text, index, all) => all.indexOf(text) === index)
        .join('、')
      note = `没有发出（${result.total} 个活跃会话都跳过了：${detail || `${result.skipped} 个被跳过`}${result.noSessionId > 0 ? `，${result.noSessionId} 个没有会话 id` : ''}）`
    }
    return done({
        ok: true,
        note,
        value: result,
      })
  }

  // ── 语音参数（为将来的语音/唱歌模块准备）──────────────────────
  if (action === 'setSpeech') {
    const result = setSpeech(modules, body ?? {})
    if (!result.changed) return { ok: false, error: result.note }
    // setSpeech 返回的是**新对象**（不改传入的 modules），必须写它，
    // 否则界面上提示「语速 1.15×」、磁盘上还是旧值。
    const next = result.modules ?? modules
    next.updatedAt = Date.now()
    writeModulesSynced(next)
    return done({ ok: true, note: result.note })
  }

  // ── 人设（自己拥有，不依赖别的插件）────────────────────────────
  if (action === 'selectPersona') {
    const result = selectPersona(String(body?.id ?? ''))
    if (!result.ok) return { ok: false, error: result.note }
    return done({ ok: true, note: result.note })
  }

  if (action === 'savePersona') {
    const result = savePersona({ id: body?.id, name: body?.name, text: body?.text })
    if (!result.ok) return { ok: false, error: result.note }
    return done({ ok: true, note: result.note, value: { id: result.id ?? '' } })
  }

  if (action === 'deletePersona') {
    const result = deletePersona(String(body?.id ?? ''))
    if (!result.ok) return { ok: false, error: result.note }
    return done({ ok: true, note: result.note })
  }

  // ── 搜索记忆（设置页里翻找旧记忆用）──────────────────────────
  if (action === 'searchMemory') {
    const query = String(body?.query ?? '').trim().toLowerCase()
    if (!query) return { ok: false, error: '搜索需要关键词' }
    const limit = Number.isFinite(body?.limit) ? Math.min(200, Math.max(1, body.limit)) : 30
    // 过滤条件：模块 / 寿命 / 是否钉住 / 标签
    const moduleFilter = body?.module ? resolveModuleKey(body.module) : undefined
    if (body?.module && !moduleFilter) return { ok: false, error: `不认识的模块「${body.module}」` }
    const lifetimeFilter = body?.lifetime === 'temporary' || body?.lifetime === 'permanent' ? body.lifetime : undefined
    const pinnedFilter = typeof body?.pinned === 'boolean' ? body.pinned : undefined
    const tagFilter = typeof body?.tag === 'string' && body.tag.trim() ? body.tag.trim().toLowerCase() : ''

    const store = readStore()
    const hits = store.entries.filter((entry) => {
      const text = String(entry.text ?? '').toLowerCase()
      const tags = (entry.tags ?? []).map((tag) => String(tag).toLowerCase())
      const matched = text.includes(query) || tags.some((tag) => tag.includes(query))
      if (!matched) return false
      if (moduleFilter && (entry.module ?? 'cognition') !== moduleFilter) return false
      if (lifetimeFilter && (entry.lifetime === 'temporary' ? 'temporary' : 'permanent') !== lifetimeFilter) return false
      if (pinnedFilter !== undefined && (entry.pinned === true) !== pinnedFilter) return false
      if (tagFilter && !tags.some((tag) => tag === tagFilter || tag.includes(tagFilter))) return false
      return true
    })
    return done({
        ok: true,
        note: `找到 ${hits.length} 条`,
        value: {
          total: hits.length,
          hits: hits.slice(-limit).reverse().map((entry) => ({
            id: entry.id,
            module: entry.module,
            text: String(entry.text).slice(0, 300),
            tags: entry.tags ?? [],
            weight: entry.weight,
            lifetime: entry.lifetime === 'temporary' ? 'temporary' : 'permanent',
            expiresAt: entry.expiresAt ?? 0,
            pinned: entry.pinned === true,
            source: entry.source === 'manual' ? 'manual' : 'auto',
            scope: entry.scope === 'workspace' ? 'workspace' : 'global',
            scopePath: entry.scopePath ?? '',
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            hits: entry.hits ?? 0,
            archived: entry.archived === true,
            archivedAt: Number.isFinite(entry.archivedAt) ? entry.archivedAt : 0,
            archiveReason: typeof entry.archiveReason === 'string' ? entry.archiveReason : '',
          })),
        },
      })
  }

  // ── 记忆图谱（节点 / 边 / 归档候选） ──────────────────────────────
  // 图谱是**派生缓存**：graph.json 坏了就从记忆库重建，不影响记忆本身。
  if (action === 'graphInfo') {
    const snapshot = graphSnapshot({ rebuild: body?.rebuild === true })
    return done({
      ok: true,
      note: `图谱：${snapshot.graph.stats.memories} 条记忆 · ${snapshot.graph.stats.entities} 个实体 · ${snapshot.graph.stats.edges} 条边`,
      value: snapshot,
    })
  }

  if (action === 'archiveCandidates') {
    const snapshot = graphSnapshot({ candidateLimit: body?.limit })
    return done({
      ok: true,
      note: `找到 ${snapshot.total} 条归档候选`,
      value: { candidates: snapshot.candidates, total: snapshot.total },
    })
  }

  if (action === 'archiveItems') {
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && id) : []
    if (ids.length === 0) return { ok: false, error: '没有要归档的记忆' }
    const store = readStore()
    const result = markArchived(store.entries, ids, typeof body?.reason === 'string' ? body.reason : 'graph-isolated')
    if (result.changed === 0) return { ok: false, error: '这些记忆不在库里' }
    store.entries = result.entries
    store.updatedAt = Date.now()
    writeStoreSynced(store)
    writeGraph(buildGraph(store.entries))
    return done({
      ok: true,
      note: `已归档 ${result.changed} 条（文本仍在库里，可恢复）`,
      value: { archived: result.changed },
    })
  }

  if (action === 'restoreItems') {
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && id) : []
    if (ids.length === 0) return { ok: false, error: '没有要恢复的记忆' }
    const store = readStore()
    const result = unmarkArchived(store.entries, ids)
    if (result.changed === 0) return { ok: false, error: '这些记忆没有被归档' }
    store.entries = result.entries
    store.updatedAt = Date.now()
    writeStoreSynced(store)
    writeGraph(buildGraph(store.entries))
    return done({
      ok: true,
      note: `已恢复 ${result.changed} 条`,
      value: { restored: result.changed },
    })
  }

  // ── 表情包目录（定时自动加载） ─────────────────────────────────
  if (action === 'setEmojiDir') {
    const dir = String(body?.dir ?? '').trim().slice(0, 400)
    modules.voice.style = { ...(modules.voice.style ?? {}), emojiDir: dir }
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    const status = emojiStatus(modules.voice.style, { scan: true })
    return done({
        ok: true,
        note: status.exists
          ? `表情目录已设为「${status.dir}」，自动读到 ${status.count} 个表情（每 ${Math.round((status.auto?.intervalMs ?? 0) / 60000)} 分钟自动重扫）`
          : `表情目录已设为「${status.dir}」（${status.error ?? '还没有表情'}），会每 ${Math.round((status.auto?.intervalMs ?? 0) / 60000)} 分钟自动来看一眼`,
        value: { emoji: status },
      })
  }

  if (action === 'setEmojiAuto') {
    // { enabled?, intervalMs?, intervalMinutes? }
    const style = modules.voice.style ?? {}
    const auto = { ...(style.emojiAuto ?? {}) }
    if (typeof body?.enabled === 'boolean') auto.enabled = body.enabled
    const minutes = Number(body?.intervalMinutes)
    if (Number.isFinite(minutes) && minutes > 0) auto.intervalMs = clampEmojiInterval(minutes * 60 * 1000)
    const intervalMs = Number(body?.intervalMs)
    if (Number.isFinite(intervalMs) && intervalMs > 0) auto.intervalMs = clampEmojiInterval(intervalMs)
    modules.voice.style = { ...style, emojiAuto: auto }
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    const status = emojiStatus(modules.voice.style, { scan: true })
    const every = Math.max(1, Math.round((status.auto?.intervalMs ?? 0) / 60000))
    return done({
        ok: true,
        note: status.auto.enabled
          ? `自动加载已开启：每 ${every} 分钟扫一次「${status.dir}」，现在读到 ${status.count} 个表情（文字 ${status.textCount} / 图片 ${status.imageCount}）`
          : '自动加载已关闭：表情只在你手动点「立即重扫」时更新',
        value: { emoji: status },
      })
  }

  if (action === 'setPersonaSync') {
    const result = applyPersonaSync(body ?? {})
    return done({ ok: result.ok !== false, note: result.note, value: { personaSync: personaSyncStatus() } })
  }
  if (action === 'syncPersonaNow') {
    const result = syncPersonaToPlugin({ force: true })
    if (result.reason === 'disabled') return done({ ok: false, error: '人设同步是关着的，先打开再同步', value: { personaSync: personaSyncStatus() } })
    const note = '人设已推到养鱼插件：镜像 ' + result.written + ' 条' + (result.removed ? '，清掉 ' + result.removed + ' 条旧镜像' : '') + '，当前指向 ' + (result.target || '（未变）')
    return done({ ok: true, note, value: { personaSync: personaSyncStatus(), summary: result } })
  }
  if (action === 'setRemoteSync') {
    const patch = {}
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
    if (body.repo !== undefined) patch.repo = String(body.repo)
    if (body.branch !== undefined) patch.branch = String(body.branch)
    if (body.token !== undefined) patch.token = String(body.token)
    if (body.intervalMs !== undefined) patch.intervalMs = Number(body.intervalMs)
    if (body.intervalMinutes !== undefined) patch.intervalMinutes = Number(body.intervalMinutes)
    const result = applyRemoteSync(patch)
    return done({ ok: true, note: result.note, value: { remoteSync: remoteSyncStatus() } })
  }

  if (action === 'syncNow') {
    // 唯一一个真正要等网络的分支：这里返回 Promise，调用方会 await；
    // 其余分支保持同步返回，老调用方（含离线自测）不用改。
    return runRemoteSync().then((result) => {
      if (!result.ok) return done({ ok: false, error: result.error, value: { remoteSync: remoteSyncStatus() } })
      const brief = result.summary ?? {}
      const parts = [
        "合并后 " + String(brief.merged ?? 0) + " 条记忆",
        "新增 " + String(brief.added ?? 0) + " / 更新 " + String(brief.updated ?? 0) + " / 删除 " + String(brief.deleted ?? 0),
        brief.pushed ? "已推到远端" : "远端已是最新",
      ]
      return done({ ok: true, note: "同步完成：" + parts.join("，"), value: { remoteSync: remoteSyncStatus(), summary: brief } })
    })
  }
  if (action === 'setEmojiSemantic') {
    // { enabled?, mode? } —— 阶段 B：按心情建议用哪些 dsh-emoji 语义 key
    const style = modules.voice.style ?? {}
    const next = normalizeEmojiSemantic(
      { ...(style.emojiSemantic ?? {}), ...(body ?? {}) },
      style.emojiSemantic,
    )
    modules.voice.style = { ...style, emojiSemantic: next }
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    const limit = { off: 0, auto: 3, frequent: 4 }[next.mode] ?? 3
    return done({
        ok: true,
        note: next.enabled
          ? `表情建议已开启，每轮最多 ${limit} 个（按心情挑，低落时自动避开热闹的表情）`
          : '表情建议已关闭：提示词里不再提表情',
        value: { emoji: emojiStatus(modules.voice.style) },
      })
  }

  if (action === 'rescanEmoji') {
    const status = emojiStatus(modules.voice.style, { scan: true })
    return done({
        ok: true,
        note: status.exists
          ? `已重扫「${status.dir}」：${status.count} 个表情（文字 ${status.textCount} / 图片 ${status.imageCount}）`
          : `「${status.dir}」${status.error ?? '还没有表情'}`,
        value: { emoji: status },
      })
  }

  if (action === 'addEmoji') {
    const dir = String(body?.dir ?? '').trim() || String(modules.voice.style?.emojiDir ?? '').trim() || defaultEmojiDir()
    const written = writeEmoji(dir, body?.name, body?.value)
    if (!written.ok) return { ok: false, error: written.note }
    // 顺手把这个目录记成当前目录，省得用户再设一次
    modules.voice.style = { ...(modules.voice.style ?? {}), emojiDir: dir }
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    return done({ ok: true, note: written.note, value: { emoji: emojiStatus(modules.voice.style, { scan: true }) } })
  }

  // ── 条目作用域 / 时间窗 / 按会话人设 ────────────────────────────
  if (action === 'setItemScope') {
    const module = resolveModuleKey(body?.module)
    if (!module || !MEMORY_MODULES.includes(module)) {
      return { ok: false, error: `不认识的模块「${body?.module ?? ''}」` }
    }
    const id = String(body?.id ?? '')
    const scope = body?.scope === 'workspace' ? 'workspace'
      : body?.scope === 'session' ? 'session'
        : 'global'
    const result = setModuleItemScope(modules, module, id, scope, body?.scopePath, body?.scopeSession)
    if (!result.changed) return { ok: false, error: result.note }
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    // 扁平库同步
    const target = modules[module].items.find((it) => it.id === id)
    if (target) {
      const store = readStore()
      store.entries = store.entries.map((entry) =>
        entry.module === module && entry.text === target.text
          ? { ...entry, scope: target.scope, scopePath: target.scopePath, scopeSession: target.scopeSession, updatedAt: Date.now() }
          : entry,
      )
      writeStoreSynced(store)
    }
    return done({ ok: true, note: result.note })
  }

  // ── 心情（mood）配置 ───────────────────────────────────────────
  if (action === 'setMoodConfig') {
    const store = readEmotionStore()
    const current = normalizeMoodConfig(store.config)
    const patch = {}
    if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled
    if (body?.moodBase !== undefined) patch.moodBase = Number(body.moodBase)
    if (body?.moodFloor !== undefined) patch.moodFloor = Number(body.moodFloor)
    if (body?.decayHalfHours !== undefined) patch.decayHalfHours = Number(body.decayHalfHours)
    if (body?.injectMode !== undefined) patch.injectMode = String(body.injectMode)
    if (body?.injectConfidence !== undefined) patch.injectConfidence = Number(body.injectConfidence)
    if (body?.injectPerDay !== undefined) patch.injectPerDay = Number(body.injectPerDay)
    if (body?.sigMood !== undefined) patch.sigMood = Number(body.sigMood)
    if (body?.sigDim !== undefined) patch.sigDim = Number(body.sigDim)
    if (body?.judgeProvider !== undefined) patch.judgeProvider = String(body.judgeProvider)
    if (body?.judgeModel !== undefined) patch.judgeModel = String(body.judgeModel)
    if (body?.aliases !== undefined) patch.aliases = String(body.aliases)

    const next = normalizeMoodConfig({ ...current, ...patch })
    store.config = next
    store.updatedAt = Date.now()
    writeEmotionStore(store)
    const labels = { off: '关闭', label: '只报情绪', event: '报情绪 + 发生的事' }
    return done({
      ok: true,
      note: next.enabled
        ? `心情已开启（${labels[next.injectMode] ?? next.injectMode}）`
        : '心情已关闭',
      value: { mood: moodStatus(store) },
    })
  }

  if (action === 'resetMood') {
    const store = readEmotionStore()
    const sessionId = String(body?.sessionId ?? '').trim()
    const before = Object.keys(store.states ?? {}).length
    if (sessionId) {
      // key 是去前缀后的会话 id，两种写法都认
      const key = sessionId.replace(/^session-/, '')
      if (store.states?.[key]) delete store.states[key]
    } else {
      store.states = {}
    }
    const after = Object.keys(store.states ?? {}).length
    store.updatedAt = Date.now()
    writeEmotionStore(store)
    return done({
      ok: true,
      note: sessionId
        ? (before === after ? '这个会话本来就没有心情记录' : '这个会话的心情已清空')
        : `心情已全部清空（${before} 份）`,
      value: { mood: moodStatus(store) },
    })
  }

  if (action === 'setAgentiveTimeWindow') {
    const result = setAgentiveTimeWindow(modules, {
      enabled: body?.enabled === true,
      start: body?.start,
      end: body?.end,
    })
    modules.updatedAt = Date.now()
    writeModulesSynced(modules)
    return done({ ok: true, note: result.note })
  }

  if (action === 'setSessionPersona') {
    const result = setSessionPersona(body?.sessionId, body?.id)
    if (!result.ok) return { ok: false, error: result.note }
    return done({ ok: true, note: result.note })
  }

  return { ok: false, error: `不认识的 action「${action}」` }
}
