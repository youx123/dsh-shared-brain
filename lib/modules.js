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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

/** 记忆模块（会被召回、被注入）。 */
export const MEMORY_MODULES = ['bottomline', 'cognition', 'emotion', 'instinct']

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
  bottomline: { boost: 3.0, always: true, minWeight: 0.0, maxWeight: 1.0, limit: 12 },
  cognition: { boost: 1.0, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 8 },
  emotion: { boost: 1.4, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 6 },
  instinct: { boost: 1.8, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 6 },
  voice: { boost: 0, always: true, minWeight: 0.0, maxWeight: 1.0, limit: 6 },
  network: { boost: 0, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 0 },
  agentive: { boost: 0, always: false, minWeight: 0.0, maxWeight: 1.0, limit: 0 },
}

/** 自动互动的作用范围：所有会话，还是只限选中的会话。 */
export const AGENTIVE_SCOPES = ['all', 'session']

/** 底线（以及其它手动条目）的作用域：到处生效，还是只限某个工作区。 */
export const ITEM_SCOPES = ['global', 'workspace']

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
      // 时间窗：只在某个时段里主动（'HH:MM' ~ 'HH:MM'，跨午夜也支持）
      timeWindow: {
        enabled: false,
        start: '09:00',
        end: '23:00',
      },
    },
    updatedAt: 0,
  }
}

/** 规整磁盘上的模块配置。 */
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
          text: String(item.text).trim().slice(0, 2000),
          weight: clampWeight(item.weight, 0.5),
          tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 12) : [],
          hits: Number.isFinite(item.hits) ? item.hits : 0,
          // 手动钉住的底线才注入；来源区分手动/自动
          pinned: item.pinned === true,
          source: item.source === 'manual' ? 'manual' : 'auto',
          // 寿命：永久或临时
          lifetime: item.lifetime === 'temporary' ? 'temporary' : 'permanent',
          expiresAt: Number.isFinite(item.expiresAt) ? item.expiresAt : 0,
          ttlMs: Number.isFinite(item.ttlMs) && item.ttlMs > 0 ? item.ttlMs : 0,
          // 作用域：global（到处生效）/ workspace（只在该工作区生效）
          scope: item.scope === 'workspace' ? 'workspace' : 'global',
          scopePath: typeof item.scopePath === 'string' ? item.scopePath : '',
          // 被这条取代的旧条目
          supersedes: typeof item.supersedes === 'string' ? item.supersedes : '',
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
      base[key].style = merged
    }
    if (typeof incoming.reason === 'string') base[key].reason = incoming.reason
    if (key === 'agentive') {
      if (AGENTIVE_SCOPES.includes(incoming.scope)) base.agentive.scope = incoming.scope
      if (Array.isArray(incoming.sessionIds)) {
        base.agentive.sessionIds = incoming.sessionIds
          .filter((id) => typeof id === 'string' && id.trim())
          .map((id) => id.trim())
          .slice(0, 50)
      }
      if (incoming.timeWindow && typeof incoming.timeWindow === 'object') {
        base.agentive.timeWindow = {
          enabled: incoming.timeWindow.enabled === true,
          start: normalizeClock(incoming.timeWindow.start, '09:00'),
          end: normalizeClock(incoming.timeWindow.end, '23:00'),
        }
      }
    }
  }
  base.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
  return base
}

/** 读模块配置。 */
export function readModules() {
  const file = modulesFile()
  if (!existsSync(file)) return defaultModules()
  try {
    return normalizeModules(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return defaultModules()
  }
}

/** 写模块配置（先写临时文件再 rename）。 */
export function writeModules(modules) {
  mkdirSync(modulesDir(), { recursive: true })
  const file = modulesFile()
  const tmp = `${file}.${process.pid}.tmp`
  const payload = { ...modules, updatedAt: Date.now() }
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)
  return payload
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
    text: String(item.text ?? '').trim().slice(0, 2000),
    weight: clampWeight(item.weight, 0.5),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 12) : [],
    hits: 0,
    pinned: item.pinned === true,
    source: item.source === 'manual' ? 'manual' : 'auto',
    lifetime: item.lifetime === 'temporary' ? 'temporary' : 'permanent',
    expiresAt: Number.isFinite(item.expiresAt) ? item.expiresAt : 0,
    ttlMs: Number.isFinite(item.ttlMs) && item.ttlMs > 0 ? item.ttlMs : 0,
    scope: item.scope === 'workspace' ? 'workspace' : 'global',
    scopePath: typeof item.scopePath === 'string' ? item.scopePath : '',
    supersedes: typeof item.supersedes === 'string' ? item.supersedes : '',
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
      scope: normalized.scope === 'workspace' || old.scope === 'workspace' ? 'workspace' : 'global',
      scopePath: normalized.scopePath || old.scopePath || '',
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
 * @returns {{ changed: boolean, modules: object, note: string }}
 */
export function setModuleItemScope(modules, module, itemId, scope, scopePath = '') {
  if (!MEMORY_MODULES.includes(module)) return { changed: false, modules, note: `未知模块 ${module}` }
  if (!ITEM_SCOPES.includes(scope)) return { changed: false, modules, note: `不认识的作用域「${scope}」` }
  const bucket = modules[module]
  const item = (bucket.items ?? []).find((it) => it.id === itemId)
  if (!item) return { changed: false, modules, note: '找不到这条条目' }
  item.scope = scope
  item.scopePath = scope === 'workspace' ? String(scopePath ?? '').trim().slice(0, 400) : ''
  item.updatedAt = Date.now()
  return {
    changed: true,
    modules,
    note: scope === 'workspace'
      ? `已限定在「${item.scopePath || '（未指定工作区）'}」内生效`
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
        scope: it.scope === 'workspace' ? 'workspace' : 'global',
        scopePath: it.scopePath ?? '',
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
