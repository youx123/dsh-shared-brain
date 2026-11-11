/**
 * 跨机同步：把共享大脑的数据放到一个**私有 Git 仓库**里，几台机器共用一个大脑。
 *
 * 为什么不是「同步文件夹」：
 *   1. 整文件覆盖会让 A 机删掉的条目被 B 机那份盖回来（Cursor 那边踩过一模一样的坑）；
 *   2. 两台同时写会互相覆盖；
 *   3. 会话级记忆换台机器根本召回不到，同步过去只是垃圾。
 * 所以这里的做法是：
 *   · 记忆按条目 id 合并，谁改得晚听谁的；
 *   · 删除记墓碑（tombstone），删除时间晚的赢，删了就是删了；
 *   · 只同步 scope !== 'session' 的条目，以及人设、模块设置；
 *   · 用 GitHub Contents API 读写（不依赖本机 git），遇到并发冲突重新拉取再合并。
 *
 * 凭证：fine-grained PAT，只勾这个仓库的 Contents 读写。可以写在 sync.json 里，
 * 也可以用环境变量 DSH_SHARED_BRAIN_TOKEN（推荐，不落盘）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { brainDir, isAlive, readStore, writeStore } from './store.js'
import { normalizeModules, readModules } from './modules.js'
import { writeModulesSynced } from './cross-sync.js'
import { readPersona, writePersonaStore, BUNDLED_PERSONAS } from './persona.js'
import { redactSecrets } from './summarize.js'

/** 内置人设的 id 集合：current 指向内置人设时不要求它在 personas 里。 */
const BUNDLED_PERSONA_IDS = new Set(BUNDLED_PERSONAS.map((p) => p.id))

const API_BASE = 'https://api.github.com'
const REMOTE_MEMORY = 'brain/memory.json'
const REMOTE_PERSONA = 'brain/persona.json'
const REMOTE_MODULES = 'brain/modules.json'

export const REMOTE_SYNC_DEFAULTS = {
  enabled: false,
  repo: '',
  branch: 'main',
  intervalMs: 10 * 60 * 1000,
  token: '',
}

export const MIN_REMOTE_INTERVAL_MS = 60 * 1000
export const MAX_REMOTE_INTERVAL_MS = 24 * 60 * 60 * 1000
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ATTEMPTS = 3

/** sync.json 的位置（和 memory.json 同一个目录）。 */
export function syncFile() {
  return join(brainDir(), 'sync.json')
}

/**
 * token 单独存一个文件（2026-11-03 修）。
 *
 * 以前 token 和其它配置一起写在 sync.json 里 —— 那文件是明文 JSON，
 * 备份一下、随手一 cat，访问令牌就漏了。
 * 现在 token 只落在 sync-token.json，权限收紧到 600（只有本人能读），
 * sync.json 里只留一个「有 token」的标记。
 */
export function syncTokenFile() {
  return join(brainDir(), 'sync-token.json')
}

/** 读 token：优先环境变量，其次独立的 token 文件。 */
function readStoredToken() {
  const file = syncTokenFile()
  try {
    if (!existsSync(file)) return ''
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return cleanToken(raw?.token)
  } catch {
    return ''
  }
}

/** 写 token 到独立文件（0600），返回值不落到 sync.json 里。 */
function writeStoredToken(token) {
  const value = cleanToken(token)
  const file = syncTokenFile()
  if (!value) {
    try { if (existsSync(file)) rmSync(file, { force: true }) } catch { /* 删不掉就算了 */ }
    return ''
  }
  mkdirSync(brainDir(), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ token: value, updatedAt: Date.now() }, null, 2), 'utf8')
  try { chmodSync(tmp, 0o600) } catch { /* Windows 上没有权限位，忽略 */ }
  renameSync(tmp, file)
  return value
}

function num(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 规整 token：空串表示「用环境变量」。 */
function cleanToken(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

/** 规整 repo：接受 owner/name 或整条 URL。 */
export function normalizeRepo(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (!text) return ''
  text = text.replace(/^https?:\/\/github\.com\//i, '')
  text = text.replace(/^git@github\.com:/i, '')
  text = text.replace(/\.git$/i, '')
  text = text.replace(/\/+$/, '')
  return /^[\w.-]+\/[\w.-]+$/.test(text) ? text : ''
}

/** 规整同步配置。 */
export function normalizeSyncConfig(raw, fallback = REMOTE_SYNC_DEFAULTS) {
  const base = { ...REMOTE_SYNC_DEFAULTS, ...(fallback ?? {}) }
  const source = raw && typeof raw === 'object' ? raw : {}
  const repo = source.repo === undefined ? base.repo : normalizeRepo(source.repo)
  // 设置页按「分钟」填，接口层统一换成毫秒。
  // 注意：patch 会与已有配置合并，所以不能先取 source.intervalMs ——
  // 那会把上一轮的毫秒值带来，显式传进来的分钟数就被吃掉了。
  const minutesInput = Number(source.intervalMinutes)
  const explicitMinutes = raw && raw.intervalMinutes !== undefined && Number.isFinite(minutesInput) && minutesInput > 0
    ? minutesInput
    : undefined
  const explicitMs = raw && raw.intervalMs !== undefined && Number.isFinite(Number(raw.intervalMs)) && Number(raw.intervalMs) > 0
    ? Number(raw.intervalMs)
    : undefined
  const intervalHint = explicitMinutes !== undefined ? explicitMinutes * 60_000 : explicitMs
  const branch = typeof source.branch === 'string' && source.branch.trim() ? source.branch.trim() : base.branch
  return {
    enabled: source.enabled === undefined ? Boolean(base.enabled) : Boolean(source.enabled),
    repo,
    branch,
    intervalMs: num(intervalHint ?? source.intervalMs ?? base.intervalMs, REMOTE_SYNC_DEFAULTS.intervalMs, MIN_REMOTE_INTERVAL_MS, MAX_REMOTE_INTERVAL_MS),
    // token 不再进 sync.json —— 它只落在 sync-token.json（0600）。
    // 这里保留 token 字段纯粹是为了在内存里传值（读配置 → 写配置这一路），
    // writeSyncConfig 落盘前会把它摘走。
    token: source.token === undefined ? cleanToken(base.token) : cleanToken(source.token),
    deviceId: typeof source.deviceId === 'string' && source.deviceId.trim() ? source.deviceId.trim() : base.deviceId ?? '',
    lastSyncAt: Number(source.lastSyncAt ?? base.lastSyncAt ?? 0) || 0,
    lastPushedAt: Number(source.lastPushedAt ?? base.lastPushedAt ?? 0) || 0,
    lastError: typeof source.lastError === 'string' ? source.lastError : base.lastError ?? '',
    tombstones: source.tombstones && typeof source.tombstones === 'object' ? { ...source.tombstones } : { ...(base.tombstones ?? {}) },
    lastSeenIds: Array.isArray(source.lastSeenIds) ? source.lastSeenIds.filter((x) => typeof x === 'string') : [...(base.lastSeenIds ?? [])],
  }
}

/** 读同步配置（坏文件退回默认，不抛）。 */
export function readSyncConfig() {
  const file = syncFile()
  try {
    if (!existsSync(file)) {
      const config = normalizeSyncConfig({ token: readStoredToken() })
      return { file, exists: false, config }
    }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    // 旧版把 token 明文写在 sync.json 里 —— 读的时候顺手搬到独立文件，
    // 顺便把 sync.json 里的明文擦掉。
    const legacyToken = cleanToken(raw?.token)
    const stored = readStoredToken()
    let config = normalizeSyncConfig({ ...raw, token: legacyToken || stored })
    if (legacyToken && legacyToken !== stored) {
      writeStoredToken(legacyToken)
      try {
        const { token: _drop, ...rest } = raw
        writeFileSync(file, JSON.stringify(rest, null, 2), 'utf8')
        config = normalizeSyncConfig({ ...rest, token: legacyToken })
      } catch { /* 擦不掉就下回再说，下次读还会再搬一次 */ }
    }
    return { file, exists: true, config }
  } catch {
    return { file, exists: true, invalid: true, config: normalizeSyncConfig({ token: readStoredToken() }) }
  }
}

/** 写同步配置（临时文件 + rename，防半截）。token 单独落盘，不写进这个文件。 */
export function writeSyncConfig(patch = {}) {
  const { config } = readSyncConfig()
  const next = normalizeSyncConfig({ ...config, ...patch }, config)
  // patch 里明确给了 token（或配置里本来有）→ 写独立文件
  const tokenGiven = patch && Object.prototype.hasOwnProperty.call(patch, 'token')
  const token = tokenGiven ? cleanToken(patch.token) : next.token
  if (token) writeStoredToken(token)
  else if (tokenGiven) writeStoredToken('')
  const { token: _drop, ...persist } = next
  const file = syncFile()
  mkdirSync(brainDir(), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(persist, null, 2), 'utf8')
  renameSync(tmp, file)
  return { ...next, token }
}

/** 设备 id：同一台机器不变，用来在远端区分是谁推的。 */
export function ensureDeviceId(config = readSyncConfig().config) {
  if (config.deviceId) return config.deviceId
  const host = (() => {
    try { return hostname() } catch { return 'unknown' }
  })()
  const id = `${host}-${Math.random().toString(36).slice(2, 8)}`
  writeSyncConfig({ deviceId: id })
  return id
}

/** token 从哪来：先看环境变量，再看独立文件，最后看配置（内存里带着的）。 */
export function tokenOf(config = readSyncConfig().config) {
  const fromEnv = cleanToken(process.env.DSH_SHARED_BRAIN_TOKEN ?? '')
  return fromEnv || config.token || readStoredToken()
}

/* ------------------------------------------------------------------ */
/* GitHub Contents API                                                 */
/* ------------------------------------------------------------------ */

async function gh(path, options = {}) {
  const token = options.token
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'dsh-shared-brain',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (options.body) headers['content-type'] = 'application/json'
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  let json = null
  try { json = await response.json() } catch { json = null }
  return { status: response.status, ok: response.ok, json }
}

/** 读远端文件：不存在返回 sha=null / data=null。 */
export async function readRemoteFile(config, path, token = tokenOf(config)) {
  const res = await gh(
    `/repos/${config.repo}/contents/${path}?ref=${encodeURIComponent(config.branch || 'main')}`,
    { token },
  )
  if (res.status === 404) return { sha: null, data: null, status: 404 }
  if (!res.ok) {
    const message = res.json?.message ?? `HTTP ${res.status}`
    throw new Error(`读远端 ${path} 失败：${message}`)
  }
  const content = typeof res.json?.content === 'string' ? res.json.content : ''
  const text = Buffer.from(content, 'base64').toString('utf8')
  let data = null
  try { data = JSON.parse(text) } catch { data = null }
  return { sha: res.json?.sha ?? null, data, status: 200 }
}

/** 写远端文件（有 sha 就是更新，没有就是新建）。 */
export async function writeRemoteFile(config, path, data, sha, message, token = tokenOf(config)) {
  const body = {
    message: message || `sync: ${path}`,
    content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64'),
    branch: config.branch || 'main',
  }
  if (sha) body.sha = sha
  return gh(`/repos/${config.repo}/contents/${path}`, { method: 'PUT', body, token })
}

/* ------------------------------------------------------------------ */
/* 合并规则                                                            */
/* ------------------------------------------------------------------ */

/**
 * 记忆条目在跨机同步里要不要带：会话级的不带（换台机器召回不到）。
 *
 * 2026-11-04（P1-6 审计）：本机路径（cwd）和会话 id 不上云。
 * 实测 127 条里有 75 条带着绝对路径（含 Windows 用户名）和 sessionId，
 * 而它们的 scope 全是 global —— scope 过滤挡不住。
 * 别的机器上这些路径没有意义，路径本身就是隐私。
 */
export function syncableEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (typeof entry.id !== 'string' || !entry.id) return false
  if (!isAlive(entry)) return false
  if (entry.scope === 'session') return false
  return typeof entry.text === 'string' && entry.text.trim().length > 0
}

/**
 * 把条目收拾成「可以推到远端」的形状：抹掉本机路径与会话 id。
 *
 * 本地那份保留这两项（作用域过滤、路径判断要用），
 * 只有推上云的那份才抹。
 */
export function stripLocalPaths(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const out = { ...entry }
  delete out.cwd
  delete out.sessionId
  delete out.scopeSession
  return out
}

/** 墓碑合并：同一个 id 取更大的删除时间。 */
export function mergeTombstones(a = {}, b = {}) {
  // 墓碑值有两种形状：
  //   旧格式： { id: 时间戳 }
  //   新格式： { id: { at: 时间戳, kind: 'entry' | 'module' } }
  // 老数据照样能读。
  const out = {}
  for (const source of [b, a]) {
    for (const [id, raw] of Object.entries(source ?? {})) {
      const at = Number(typeof raw === 'object' && raw ? raw.at : raw)
      if (!id || !Number.isFinite(at) || at <= 0) continue
      const kind = typeof raw === 'object' && raw && raw.kind === 'module' ? 'module' : 'entry'
      const existing = out[id]
      const existingAt = Number(typeof existing === 'object' && existing ? existing.at : existing) || 0
      if (!existing || at > existingAt) out[id] = { at, kind }
    }
  }
  return out
}

/** 取某个 id 的墓碑时间（没有就是 0）。 */
export function tombstoneAt(tombstones, id) {
  const raw = (tombstones ?? {})[id]
  return Number(typeof raw === 'object' && raw ? raw.at : raw) || 0
}

/** 墓碑种类：记忆条目 / 模块里的条目 / 人设（2026-11-03 加 persona）。 */
export const TOMBSTONE_KINDS = new Set(['entry', 'module', 'persona'])

/** 取某个 id 的墓碑种类：'entry'（记忆条目）、'module'（模块条目）或 'persona'（人设）。 */
export function tombstoneKind(tombstones, id) {
  const raw = (tombstones ?? {})[id]
  const kind = typeof raw === 'object' && raw ? raw.kind : ''
  return TOMBSTONE_KINDS.has(kind) ? kind : 'entry'
}

/** 清掉过期墓碑（默认 30 天），避免 sync.json 无限长大。 */
export function pruneTombstones(tombstones = {}, now = Date.now(), ttl = TOMBSTONE_TTL_MS) {
  const out = {}
  for (const [id, raw] of Object.entries(tombstones ?? {})) {
    const at = Number(typeof raw === 'object' && raw ? raw.at : raw)
    if (!Number.isFinite(at) || at <= 0) continue
    if (at + ttl > now) {
      const kind = typeof raw === 'object' && raw ? raw.kind : ''
      out[id] = { at, kind: TOMBSTONE_KINDS.has(kind) ? kind : 'entry' }
    }
  }
  return out
}

/** 本地消失的条目 = 被删掉了 → 记墓碑。 */
export function detectDeletions(localEntries = [], lastSeenIds = [], now = Date.now(), kind = 'entry') {
  const aliveIds = new Set(localEntries.map((entry) => entry.id))
  const out = {}
  for (const id of lastSeenIds) {
    if (!aliveIds.has(id)) out[id] = { at: now, kind }
  }
  return out
}

/**
 * 合并两边的记忆条目。
 * 规则：墓碑时间晚于条目 updatedAt 就删掉；否则 updatedAt 晚的赢；完全打平保留本地。
 */
export function mergeEntries(localEntries = [], remoteEntries = [], tombstones = {}) {
  const byId = new Map()
  // 2026-11-11：本机那份按 id 留一份。远端条目不带 cwd / sessionId / scopeSession
  // （推上云前就被剥掉了），可合并结果是要写回本地的 —— 以前这里直接把三个字段
  // delete 掉，于是每次同步往返都把本机的「限到某会话 / 某目录」抹平，
  // 会话级条目丢掉 scopeSession 之后再也匹配不上，等于静默消失。
  const localById = new Map()
  for (const entry of localEntries) {
    if (syncableEntry(entry)) localById.set(entry.id, entry)
  }
  for (const entry of remoteEntries) {
    if (syncableEntry(entry)) byId.set(entry.id, { ...entry })
  }
  let added = 0
  let updated = 0
  for (const entry of localEntries) {
    if (!syncableEntry(entry)) continue
    const existing = byId.get(entry.id)
    if (!existing) {
      byId.set(entry.id, { ...entry })
      added += 1
      continue
    }
    const localAt = Number(entry.updatedAt) || 0
    const remoteAt = Number(existing.updatedAt) || 0
    if (localAt > remoteAt) {
      byId.set(entry.id, { ...entry })
      updated += 1
    }
  }
  let deleted = 0
  for (const [id, entry] of [...byId.entries()]) {
    const dead = tombstoneAt(tombstones, id)
    if (!dead) continue
    if (tombstoneKind(tombstones, id) === 'module') continue // 模块条目的墓碑管不到记忆条目
    const at = Number(entry.updatedAt) || 0
    if (dead >= at) {
      byId.delete(id)
      deleted += 1
    }
  }
  // 2026-11-04（P0-1 审计）：合并结果要脱敏。
  // 远端仓库里的条目是**别的机器写进来的**，谁都能往里塞东西。
  // 以前 mergeEntries 原样保留 text/tags → syncOnce 再用 writeStore 裸写回本地 →
  // 远端带密钥的条目就这样一路复制到本地磁盘、再推回远端。
  // （modules.js 的 normalizeModules 早就对模块条目做了同样的事，
  //   只有记忆条目漏了 —— 那条不对称路径被审计抓到了。）
  for (const entry of byId.values()) {
    if (typeof entry.text === 'string') entry.text = redactSecrets(entry.text)
    if (Array.isArray(entry.tags)) {
      entry.tags = entry.tags.map((tag) => redactSecrets(String(tag))).filter((tag) => tag !== '[已脱敏]')
    }
    // 本机归属补回来：远端那份没有这些字段，合并结果要写回本地，不能丢。
    const localCopy = localById.get(entry.id)
    if (localCopy) {
      if (entry.cwd === undefined) entry.cwd = localCopy.cwd
      if (entry.sessionId === undefined) entry.sessionId = localCopy.sessionId
      if (entry.scopeSession === undefined) entry.scopeSession = localCopy.scopeSession
      if (!entry.scope && localCopy.scope) entry.scope = localCopy.scope
      if (!entry.scopePath && localCopy.scopePath) entry.scopePath = localCopy.scopePath
    }
  }
  const merged = [...byId.values()].sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
  return { entries: merged, added, updated, deleted }
}

/**
 * 推上云之前的形状：剥掉本机路径、会话 id、会话级作用域。
 * 合并结果现在是「本地完整、推出去干净」两份，别再靠 delete 直接从合并结果里扣。
 */
export function pushableEntries(entries = []) {
  return entries.map((entry) => {
    const { cwd, sessionId, scopeSession, ...rest } = entry
    return rest
  })
}

/**
 * 「当前用哪个人设」这个字段自己的时间戳。
 *
 * 老数据没有 currentAt，只有整份 updatedAt —— 那时候只能退回整份时间戳，
 * 保持向后兼容（虽然精度差，至少不倒退）。
 */
export function personaCurrentStamp(store) {
  const own = Number(store?.currentAt) || 0
  if (own > 0) return own
  return Number(store?.updatedAt) || 0
}

/** 人设条目的时间戳（没有就退回 0，输给任何有时间的）。 */
function personaItemStamp(persona) {
  return Number(persona?.updatedAt) || 0
}

/**
 * 人设合并（2026-11-03，P1-6 加固）。
 *
 * 以前的问题（都是真踩到的）：
 *   1. **bySession 被清空**：旧实现返回 `bySession: {}`，回到 syncOnce
 *      又 writePersonaStore 写盘 → 本机所有「会话 → 人设」的绑定被抹掉。
 *      会话映射是纯本机的东西（会话 id 换机器就废），必须原样留着。
 *   2. **current 抢整份时间戳**：改任何一个人设都会顶新 updatedAt，
 *      于是「当前人设」跟着整份时间戳打架 —— 谁最后动了别的字段谁就赢。
 *      现在 current 只听自己的 currentAt。
 *   3. **删除会复活**：删掉的人设下次同步又被远端推回来。现在认墓碑
 *      （kind='persona'）。
 *   4. 坏条目（没 id / 没 name）会被写进库 → 现在直接丢掉并计数。
 *
 * @param {object} local 本机的 persona store
 * @param {object} remote 远端的 persona.json
 * @param {object} tombstones 删除记录 { id: { at, kind } }
 */
export function mergePersona(local = {}, remote = {}, tombstones = {}) {
  const localAt = Number(local.updatedAt) || 0
  const remoteAt = Number(remote.updatedAt) || 0
  const byId = new Map()
  let dropped = 0

  const accept = (persona) => {
    if (!persona || typeof persona !== 'object') return null
    const id = typeof persona.id === 'string' ? persona.id.trim() : ''
    if (!id) return null
    const name = typeof persona.name === 'string' ? persona.name.trim() : ''
    if (!name) return null
    // 墓碑比条目新 → 这个人是被删掉的，别再收回来
    const deadAt = tombstoneAt(tombstones, id)
    const deadKind = tombstoneKind(tombstones, id)
    if (deadKind === 'persona' && deadAt >= personaItemStamp(persona)) return null
    if (deadKind === 'persona' && personaItemStamp(persona) === 0) return null
    return { ...persona, id, name }
  }

  for (const persona of Array.isArray(remote.personas) ? remote.personas : []) {
    const ok = accept(persona)
    if (ok) byId.set(ok.id, ok)
    else dropped += 1
  }
  let added = 0
  let updated = 0
  for (const persona of Array.isArray(local.personas) ? local.personas : []) {
    const ok = accept(persona)
    if (!ok) {
      dropped += 1
      continue
    }
    const existing = byId.get(ok.id)
    if (!existing) {
      byId.set(ok.id, ok)
      added += 1
      continue
    }
    if (personaItemStamp(ok) >= personaItemStamp(existing)) {
      if (JSON.stringify(ok) !== JSON.stringify(existing)) updated += 1
      byId.set(ok.id, ok)
    }
  }

  // current：只听 currentAt，平手听本机（本机是「我」正在用的，别乱跳）
  const localStamp = personaCurrentStamp(local)
  const remoteStamp = personaCurrentStamp(remote)
  const pickCurrent = localStamp >= remoteStamp ? local : remote
  let current = typeof pickCurrent.current === 'string' && pickCurrent.current ? pickCurrent.current : 'dafeiyu'
  // 选中的那个要是刚被删掉 / 根本不存在 → 退回内置兜底，别留一个死 id
  if (!byId.has(current) && !BUNDLED_PERSONA_IDS.has(current)) current = 'dafeiyu'

  return {
    version: 1,
    current,
    currentAt: Math.max(localStamp, remoteStamp),
    personas: [...byId.values()].sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0)),
    // 2026-11-04（P1-6 审计）：**不带 bySession**。
    // 会话 → 人设的绑定是本机的事（别的机器上没有这些会话），
    // 以前它跟着合并结果一起写进远端 persona.json → 本机布局泄露到云上，
    // 而且远端回来时又会把本机的绑定覆盖掉。
    // 本机的 bySession 由 syncOnce 落地时单独保留（见 writePersonaStore 那行）。
    updatedAt: Math.max(localAt, remoteAt),
    mergeStats: { added, updated, dropped, total: byId.size },
  }
}

/** 模块设置：整份按 updatedAt 取新，并剥掉会话级的东西。 */
/**
 * 收集所有模块里的条目 id（跨机合并要按条目认人）。
 */
export function collectModuleItemIds(modules) {
  const out = new Set()
  const normalized = modules && typeof modules === 'object' ? modules : {}
  for (const mod of Object.values(normalized)) {
    if (!mod || typeof mod !== 'object') continue
    if (!Array.isArray(mod.items)) continue
    for (const item of mod.items) {
      if (item && typeof item.id === 'string' && item.id) out.add(item.id)
    }
  }
  return out
}

/**
 * 清掉**不该跨机**的模块内容：会话级条目 + 会话 id 列表。
 *
 * 2026-11-04（P1-6 审计）：以前这个函数被用在**本地**那份上，
 * 于是 agentive.sessionIds（"限定自动互动到指定会话"）被清空并落盘 ——
 * 用户的设置被静默抹掉。现在拆成两个：
 *   - stripSessionItems：只清会话级条目（本地合并时用，不动 sessionIds）
 *   - sanitizeModules：上面那个 + 再清 sessionIds（**推送前**用）
 */
export function stripSessionItems(modules) {
  const normalized = normalizeModules(modules ?? {})
  for (const module of Object.values(normalized)) {
    if (!module || typeof module !== 'object') continue
    if (Array.isArray(module.items)) module.items = module.items.filter((item) => item?.scope !== 'session')
  }
  return normalized
}

export function sanitizeModules(modules) {
  const normalized = stripSessionItems(modules)
  if (normalized.agentive) normalized.agentive.sessionIds = []
  return normalized
}

/**
 * 跨机同步的边界：哪些东西会上云，哪些永远留在本机。
 * 设置页要把这张清单明明白白摆给老大看，别让人以为「全都同步了」。
 */
export function syncBoundary() {
  return {
    shared: [
      { key: 'memory-global', label: '全局记忆条目', detail: 'scope=global 的条目会进仓库' },
      { key: 'module-items', label: '各模块的条目', detail: '含底线（手动钉住的那种）、认知、情感、本能' },
      { key: 'persona', label: '人设', detail: '人设正文与当前选中的人设' },
      { key: 'modules', label: '模块设置', detail: '开关、权重、人设语气、表情与自动互动设置' },
    ],
    localOnly: [
      { key: 'session-memory', label: '会话内的记忆', detail: 'scope=session 的条目只在当前会话有效，不上云' },
      { key: 'emotion-state', label: '心情状态', detail: '每个会话的心情各有不同，不跟着走' },
      { key: 'proactive-history', label: '主动互动记录', detail: '说过几次、关心过几次都是本机自己的账' },
      { key: 'token', label: '访问令牌', detail: '只存在本机（独立文件或环境变量），永不上云' },
      { key: 'emoji-assets', label: '表情素材', detail: '内置表情包随插件走，不进仓库' },
      { key: 'persona-by-session', label: '会话里用哪个人设', detail: '每个会话各自选的人设是本机的安排，不跟着走' },
    ],
    note: '删除会同步：某台机器删掉的条目，其它机器同步后也会消失（靠删除记录追踪）。',
  }
}

/**
 * 模块里的某个条目被改了时间戳 → 整个模块就算「更新过」。
 * 没有条目可比时退回复制件的时间戳。
 *
 * 注意：必须用**规整前**的原始模块算 —— normalizeModules 会把模块
 * 重建一遍，模块级的 updatedAt 会被丢掉（只剩条目级的时间戳）。
 */
function moduleStamp(mod) {
  const items = Array.isArray(mod?.items) ? mod.items : []
  let max = 0
  for (const item of items) {
    const at = Number(item?.updatedAt) || 0
    if (at > max) max = at
  }
  return Number(mod?.updatedAt) || max
}

/**
 * 取每个模块自己的时间戳（规整前）。
 * 没有条目也没写 updatedAt 的模块 → 0（视为不比新旧）。
 */
function moduleStamps(modules) {
  const out = new Map()
  if (!modules || typeof modules !== 'object') return out
  for (const [key, mod] of Object.entries(modules)) {
    if (key === 'version' || key === 'updatedAt') continue
    out.set(key, moduleStamp(mod))
  }
  return out
}

/**
 * 按 id 合并两个条目数组：updatedAt 新的赢；墓碑盖过更新时间就删掉。
 * 返回 { items, added, updated, deleted, removedIds }
 */
export function mergeModuleItems(localItems = [], remoteItems = [], tombstones = {}) {
  const byId = new Map()
  for (const item of Array.isArray(remoteItems) ? remoteItems : []) {
    if (item?.id) byId.set(item.id, { ...item })
  }
  let added = 0
  let updated = 0
  for (const item of Array.isArray(localItems) ? localItems : []) {
    if (!item?.id) continue
    const existing = byId.get(item.id)
    if (!existing) {
      byId.set(item.id, { ...item })
      added += 1
      continue
    }
    if ((Number(item.updatedAt) || 0) > (Number(existing.updatedAt) || 0)) {
      byId.set(item.id, { ...item })
      updated += 1
    }
  }
  let deleted = 0
  const removedIds = []
  for (const [id, item] of [...byId.entries()]) {
    const dead = tombstoneAt(tombstones, id)
    if (!dead) continue
    if (tombstoneKind(tombstones, id) !== 'module') continue
    if (dead >= (Number(item.updatedAt) || 0)) {
      byId.delete(id)
      removedIds.push(id)
      deleted += 1
    }
  }
  return { items: [...byId.values()], added, updated, deleted, removedIds }
}

/**
 * 设置合并：**按模块、按条目**合，不再是「整份较新者胜」。
 *
 * 以前的问题：modules.json 里七个模块挤在一份文件里，谁改了一个人设，
 * 另一台机器只要动过任何一项设置（哪怕只是权重），整份文件就会按
 * updatedAt 取新 —— 老大那条底线会被连带覆盖掉。
 *
 * 现在：每个模块单独比（条目按 id 比 updatedAt，模块自身字段取较新的一边），
 * 底线条目只跟底线条目比，谁也不牵连谁。
 */
export function mergeModules(local, remote, tombstones = {}) {
  // 时间戳要在规整前取 —— normalizeModules 会丢掉模块级的 updatedAt。
  const localStamps = moduleStamps(local)
  const remoteStamps = moduleStamps(remote)
  // 2026-11-04（P1-6 审计）：本地那份只用 stripSessionItems —— 不能动
  // agentive.sessionIds（"限定自动互动到指定会话"是本机设置，静默清掉是 bug）。
  // 推送前的那份仍然是 sanitizeModules（远端不需要知道本机的会话 id）。
  const localMods = stripSessionItems(local ?? {})
  const remoteMods = sanitizeModules(remote ?? {})
  const localAt = Number(local?.updatedAt) || 0
  const remoteAt = Number(remote?.updatedAt) || 0
  const keys = new Set([...Object.keys(localMods), ...Object.keys(remoteMods)])
  const out = { version: 1, updatedAt: Math.max(localAt, remoteAt) }
  const stats = { added: 0, updated: 0, deleted: 0 }
  for (const key of keys) {
    if (key === 'version' || key === 'updatedAt') continue
    const l = localMods[key]
    const r = remoteMods[key]
    if (!l && !r) continue
    if (!r) { out[key] = l; continue }
    if (!l) { out[key] = r; continue }
    // 模块级字段（enabled / weight / voice.style）没有自己的时间戳，
    // 只能跟着「哪一份文件更新」走 —— 但**条目**是按 id 单独合并的，
    // 所以谁动别的设置都不会把别处的条目（尤其是底线）挤掉。
    const lStamp = localStamps.get(key) ?? moduleStamp(l)
    const rStamp = remoteStamps.get(key) ?? moduleStamp(r)
    // 模块自己没有时间戳时，退回整份文件的时间戳（谁写得晚听谁的）。
    const lNewer = lStamp === rStamp ? localAt >= remoteAt : lStamp > rStamp
    if (!Array.isArray(l.items) && !Array.isArray(r.items)) {
      // 没有条目的模块（比如 voice 的 style、network）→ 整块取较新的一边
      out[key] = lNewer ? l : r
      continue
    }
    const merged = { ...(lNewer ? l : r) }
    const result = mergeModuleItems(l.items, r.items, tombstones)
    merged.items = result.items
    stats.added += result.added
    stats.updated += result.updated
    stats.deleted += result.deleted
    out[key] = merged
  }
  // 推送形状要清 sessionIds；但**落地到本地**时会把本机的 sessionIds 带回来。
  const sanitized = sanitizeModules(out)
  sanitized.mergeStats = stats
  return sanitized
}

/**
 * 把「推送形状」的合并结果还原成「本地形状」。
 *
 * mergeModules 的返回体里 agentive.sessionIds 一定是空的（那是推给远端的形状，
 * 本机会话 id 不该上云）。但这份结果也要写回本地 —— 以前直接写，等于每同步
 * 一次就把用户的「限定自动互动到指定会话」清一次，表现就是**勾了又自己取消**。
 *
 * 所以本地落地前走一遍这里：scope / sessionIds 一律以本机原值为准。
 * mergeStats 是本机诊断字段，也在这里剥掉（不能落盘、更不能推上云）。
 */
export function restoreLocalAgentive(merged, local) {
  const { mergeStats, ...shape } = merged ?? {}
  const localAgentive = local?.agentive ?? {}
  const scope = localAgentive.scope === 'session' ? 'session' : 'all'
  const sessionIds = Array.isArray(localAgentive.sessionIds)
    ? localAgentive.sessionIds.filter((id) => typeof id === 'string' && id.trim())
    : []
  return {
    ...shape,
    agentive: { ...(shape.agentive ?? {}), scope, sessionIds },
  }
}

/* ------------------------------------------------------------------ */
/* 一次同步                                                            */
/* ------------------------------------------------------------------ */

/**
 * 跑一次同步。
 * @returns {Promise<{ok:boolean, error?:string, summary?:object}>}
 */
export async function syncOnce(options = {}) {
  const config = readSyncConfig().config
  // 2026-11-03：ensureDeviceId 只返回 id、不会写回 config，
  // 于是推上去的 memory.json.deviceId 一直是空的 —— 顺手接住返回值。
  config.deviceId = ensureDeviceId(config)

  if (!config.repo) return { ok: false, error: '还没填同步仓库（形如 owner/repo）' }
  // 2026-11-03：显式传进来的 token 优先（测试/临时脚本会这么用），
  // 以前只认配置和环境变量，传了也白传 —— 报「缺 token」让人莫名其妙。
  const token = cleanToken(options.token ?? '') || tokenOf(config)
  if (!token) return { ok: false, error: '缺 token：填在设置里，或设环境变量 DSH_SHARED_BRAIN_TOKEN' }

  const now = Date.now()
  const local = readStore()
  const localEntries = Array.isArray(local.entries) ? local.entries : []

  let remoteMemory = { sha: null, data: null }
  let remotePersona = { sha: null, data: null }
  let remoteModules = { sha: null, data: null }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    remoteMemory = await readRemoteFile(config, REMOTE_MEMORY, token)
    remotePersona = await readRemoteFile(config, REMOTE_PERSONA, token)
    remoteModules = await readRemoteFile(config, REMOTE_MODULES, token)

    const remoteTombstones = remoteMemory.data?.tombstones && typeof remoteMemory.data.tombstones === 'object'
      ? remoteMemory.data.tombstones
      : {}
    const localDeletions = detectDeletions(localEntries, config.lastSeenIds ?? [], now)
    // 模块条目（底线条目、模块里的手工条目）也要能删：
    // 本机已经没有的，远端还有 → 记墓碑，否则别的机器会把它们推回来。
    const localModules = readModules()
    const localModuleItems = collectModuleItemIds(localModules)
    const remoteModuleItems = [...collectModuleItemIds(sanitizeModules(remoteModules.data ?? {}))]
    // 2026-11-04（P1-5 审计）：删除检测写错了 —— 把「待删 id 列表」同时当成
    // localEntries 和 lastSeenIds 传进 detectDeletions，交集全中 → **恒返回 {}**。
    // 所以模块条目在别的机器上删掉后，下次同步又被推回来。
    //
    // ⚠️ 而且这条路径**必须**有 lastSyncAt 守卫（人设路径本来就有）：
    // 一台从没同步过的新机器，第一次同步时本机当然没有任何模块条目，
    // 没有守卫就会把远端全部模块条目判成「已删除」→ 远端被清空。
    const goneModuleIds = Number(config.lastSyncAt) > 0
      ? remoteModuleItems.filter((id) => !localModuleItems.has(id))
      : []
    const moduleDeletions = detectDeletions([], goneModuleIds, now, 'module')
    // 人设（2026-11-03，P1-6）：删掉的自定义人设以前会在别的机器上复活。
    // 只有「这台机器同步过」才敢把「远端有我这边没有」当成删除 —— 否则
    // 一台新机器第一次同步会把远端所有人设全判成已删除。
    const personaLocalEarly = readPersona().store
    const localPersonaIds = new Set(
      (Array.isArray(personaLocalEarly.personas) ? personaLocalEarly.personas : [])
        .map((p) => (typeof p?.id === 'string' ? p.id : ''))
        .filter(Boolean),
    )
    const remotePersonaIds = (Array.isArray(remotePersona.data?.personas) ? remotePersona.data.personas : [])
      .map((p) => (typeof p?.id === 'string' ? p.id : ''))
      .filter(Boolean)
    const gonePersonaIds = Number(config.lastSyncAt) > 0
      ? remotePersonaIds.filter((id) => !localPersonaIds.has(id))
      : []
    // 2026-11-04（P1-5 审计）：同模块路径 —— 原来恒返回 {}，删除的人设会复活。
    const personaDeletions = detectDeletions([], gonePersonaIds, now, 'persona')
    const tombstones = pruneTombstones(
      mergeTombstones(
        mergeTombstones(
          mergeTombstones(
            mergeTombstones(config.tombstones ?? {}, remoteTombstones),
            localDeletions,
          ),
          moduleDeletions,
        ),
        personaDeletions,
      ),
      now,
    )

    const mergedMemory = mergeEntries(localEntries, Array.isArray(remoteMemory.data?.entries) ? remoteMemory.data.entries : [], tombstones)

    const memoryRemoteNext = {
      version: 1,
      updatedAt: now,
      deviceId: config.deviceId,
      // 推上云的那份不带本机路径/会话 id；写回本地的那份（nextStore）保留
      entries: pushableEntries(mergedMemory.entries),
      tombstones,
    }
    const personaLocal = personaLocalEarly
    const personaMerged = mergePersona(personaLocal, remotePersona.data ?? {}, tombstones)
    // mergeStats 是本机诊断用的，不能写进远端 —— 否则每次统计一变就多一个
    // commit（永远「有改动」），同步会变成无脑空推。
    const { mergeStats: personaMergeStats, ...personaNext } = personaMerged
    // 2026-11-04（0.10.2）：mergeModules 的返回是**推送形状**（sessionIds 已清空）。
    // 以前把这个形状直接写回本地，等于每同步一次就把「限定自动互动到指定会话」
    // 清一次 —— 用户看到的就是「勾了又自己取消」。
    // 现在拆成两份：远端那份不带本机会话 id，本地那份原样留住。
    const modulesMerged = mergeModules(localModules, remoteModules.data ?? {}, tombstones)
    // 推送形状：sessionIds 已清、没有 mergeStats
    const { mergeStats: modulesMergeStats, ...modulesPushShape } = modulesMerged
    // 本地形状：把本机的 scope / sessionIds 还原回来（否则勾选的会话会被清掉）
    const modulesNext = restoreLocalAgentive(modulesPushShape, localModules)

    const pushMemory = JSON.stringify(memoryRemoteNext) !== JSON.stringify(remoteMemory.data ?? {})
    const pushPersona = JSON.stringify(personaNext) !== JSON.stringify(remotePersona.data ?? {})
    // 推的是 modulesPushShape（干净形状，没有 mergeStats）
    const pushModules = JSON.stringify(modulesPushShape) !== JSON.stringify(remoteModules.data ?? {})

    let conflict = false
    const commitTag = `${config.deviceId}`
    if (pushMemory) {
      const res = await writeRemoteFile(config, REMOTE_MEMORY, memoryRemoteNext, remoteMemory.sha, `sync(memory): ${commitTag}`, token)
      if (res.status === 409 || res.status === 422) conflict = true
      else if (!res.ok) throw new Error(`写远端记忆失败：${res.json?.message ?? `HTTP ${res.status}`}`)
    }
    if (!conflict && pushPersona) {
      const res = await writeRemoteFile(config, REMOTE_PERSONA, personaNext, remotePersona.sha, `sync(persona): ${commitTag}`, token)
      if (res.status === 409 || res.status === 422) conflict = true
      else if (!res.ok) throw new Error(`写远端人设失败：${res.json?.message ?? `HTTP ${res.status}`}`)
    }
    if (!conflict && pushModules) {
      const res = await writeRemoteFile(config, REMOTE_MODULES, modulesPushShape, remoteModules.sha, `sync(modules): ${commitTag}`, token)
      if (res.status === 409 || res.status === 422) conflict = true
      else if (!res.ok) throw new Error(`写远端设置失败：${res.json?.message ?? `HTTP ${res.status}`}`)
    }
    if (conflict) {
      if (attempt >= MAX_ATTEMPTS) return { ok: false, error: '远端一直在被别人改，三次都没合上，稍后再试' }
      continue
    }

    // 落地到本地：合并后的记忆 / 人设 / 设置
    const nextStore = { ...local, entries: mergedMemory.entries, updatedAt: now }
    writeStore(nextStore)
    // 2026-11-04（P1-6 审计）：本机的「会话 → 人设」绑定要留住。
    // mergePersona 不再返回 bySession（那是要推给远端的形状），
    // 所以在这里从本地那份取回来补上。
    writePersonaStore({ ...personaNext, bySession: personaLocal?.bySession ?? {} })
    if (JSON.stringify(modulesNext) !== JSON.stringify(localModules)) writeModulesSynced(modulesNext)

    writeSyncConfig({
      lastSyncAt: now,
      lastPushedAt: pushMemory || pushPersona || pushModules ? now : config.lastPushedAt,
      lastError: '',
      tombstones,
      lastSeenIds: mergedMemory.entries.map((entry) => entry.id),
    })

    return {
      ok: true,
      summary: {
        local: localEntries.length,
        remote: Array.isArray(remoteMemory.data?.entries) ? remoteMemory.data.entries.length : 0,
        merged: mergedMemory.entries.length,
        added: mergedMemory.added,
        updated: mergedMemory.updated,
        deleted: mergedMemory.deleted,
        tombstones: Object.keys(tombstones).length,
        pushed: pushMemory || pushPersona || pushModules,
        attempt,
      },
    }
  }

  return { ok: false, error: '同步没跑起来（未知原因）' }
}

/* ------------------------------------------------------------------ */
/* 定时器                                                              */
/* ------------------------------------------------------------------ */

let timer = null
let running = false
let lastResult = null
let stats = { runs: 0, failures: 0, lastRunAt: 0, lastError: '', lastSummary: null }

/** 跑一次同步并记录结果（不抛）。 */
export async function runRemoteSync(options = {}) {
  if (running) return { ok: false, error: '上一次同步还没结束' }
  running = true
  try {
    const result = await syncOnce(options)
    lastResult = result
    stats.runs += 1
    stats.lastRunAt = Date.now()
    if (result.ok) {
      stats.lastError = ''
      stats.lastSummary = result.summary ?? null
    } else {
      stats.failures += 1
      stats.lastError = result.error ?? '未知错误'
      writeSyncConfig({ lastError: result.error ?? '未知错误' })
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stats.runs += 1
    stats.failures += 1
    stats.lastError = message
    stats.lastRunAt = Date.now()
    lastResult = { ok: false, error: message }
    writeSyncConfig({ lastError: message })
    return lastResult
  } finally {
    running = false
  }
}

export function remoteSyncStatus() {
  const { file, exists, config } = readSyncConfig()
  return {
    file,
    exists,
    enabled: Boolean(config.enabled),
    repo: config.repo,
    branch: config.branch,
    intervalMs: config.intervalMs,
    hasToken: Boolean(tokenOf(config)),
    tokenFromEnv: Boolean(cleanToken(process.env.DSH_SHARED_BRAIN_TOKEN ?? '')),
    // token 存在哪：独立文件（0600）还是环境变量 —— 设置页要显示给老大看
    tokenFile: syncTokenFile(),
    tokenStoredInFile: Boolean(readStoredToken()),
    tokenInConfig: Boolean(cleanToken(config.token)),
    deviceId: config.deviceId,
    lastSyncAt: config.lastSyncAt,
    lastPushedAt: config.lastPushedAt,
    lastError: config.lastError,
    trackedEntries: Array.isArray(config.lastSeenIds) ? config.lastSeenIds.length : 0,
    tombstones: Object.keys(config.tombstones ?? {}).length,
    boundary: syncBoundary(),
    runtime: {
      running: Boolean(timer),
      busy: running,
      runs: stats.runs,
      failures: stats.failures,
      lastRunAt: stats.lastRunAt,
      lastError: stats.lastError,
      lastSummary: stats.lastSummary,
      lastResult: lastResult ? { ok: lastResult.ok, error: lastResult.error ?? '' } : null,
    },
  }
}

/** 启动定时同步（enabled 且配置齐全才真的跑）。 */
export function startRemoteSync() {
  stopRemoteSync()
  const { config } = readSyncConfig()
  if (!config.enabled) return { running: false, reason: 'disabled' }
  if (!config.repo) return { running: false, reason: 'no-repo' }
  if (!tokenOf(config)) return { running: false, reason: 'no-token' }
  ensureDeviceId(config)
  const interval = Math.max(MIN_REMOTE_INTERVAL_MS, config.intervalMs)
  // 启动后先跑一次（稍等一下，别和宿主启动抢 IO）
  const kickoff = setTimeout(() => { void runRemoteSync() }, 8_000)
  kickoff.unref?.()
  timer = setInterval(() => { void runRemoteSync() }, interval)
  timer.unref?.()
  return { running: true, intervalMs: interval }
}

export function stopRemoteSync() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 改配置并重启定时器（设置页用）。 */
export function applyRemoteSync(patch = {}) {
  const next = writeSyncConfig(patch)
  const started = startRemoteSync()
  const note = !next.enabled
    ? '跨机同步已关闭'
    : !next.repo
      ? '跨机同步开着，但还没填仓库（owner/repo）'
      : !tokenOf(next)
        ? '跨机同步开着，但缺 token'
        : `跨机同步已开启：${next.repo}（每 ${Math.round(next.intervalMs / 60000)} 分钟一次）`
  return { config: next, started, note }
}
