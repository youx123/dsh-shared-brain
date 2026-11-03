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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { brainDir, isAlive, readStore, writeStore } from './store.js'
import { normalizeModules, readModules } from './modules.js'
import { writeModulesSynced } from './cross-sync.js'
import { readPersona, writePersonaStore } from './persona.js'

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
    if (!existsSync(file)) return { file, exists: false, config: normalizeSyncConfig({}) }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { file, exists: true, config: normalizeSyncConfig(raw) }
  } catch {
    return { file, exists: true, invalid: true, config: normalizeSyncConfig({}) }
  }
}

/** 写同步配置（临时文件 + rename，防半截）。 */
export function writeSyncConfig(patch = {}) {
  const { config } = readSyncConfig()
  const next = normalizeSyncConfig({ ...config, ...patch }, config)
  const file = syncFile()
  mkdirSync(brainDir(), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, file)
  return next
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

/** token 从哪来：先看配置，再看环境变量。 */
export function tokenOf(config = readSyncConfig().config) {
  const fromEnv = cleanToken(process.env.DSH_SHARED_BRAIN_TOKEN ?? '')
  return config.token || fromEnv
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

/** 记忆条目在跨机同步里要不要带：会话级的不带（换台机器召回不到）。 */
export function syncableEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (typeof entry.id !== 'string' || !entry.id) return false
  if (!isAlive(entry)) return false
  if (entry.scope === 'session') return false
  return typeof entry.text === 'string' && entry.text.trim().length > 0
}

/** 墓碑合并：同一个 id 取更大的删除时间。 */
export function mergeTombstones(a = {}, b = {}) {
  const out = {}
  for (const source of [b, a]) {
    for (const [id, ts] of Object.entries(source ?? {})) {
      const value = Number(ts)
      if (!id || !Number.isFinite(value) || value <= 0) continue
      if (!(id in out) || value > out[id]) out[id] = value
    }
  }
  return out
}

/** 清掉过期墓碑（默认 30 天），避免 sync.json 无限长大。 */
export function pruneTombstones(tombstones = {}, now = Date.now(), ttl = TOMBSTONE_TTL_MS) {
  const out = {}
  for (const [id, ts] of Object.entries(tombstones)) {
    if (Number(ts) + ttl > now) out[id] = Number(ts)
  }
  return out
}

/** 本地消失的条目 = 被删掉了 → 记墓碑。 */
export function detectDeletions(localEntries = [], lastSeenIds = [], now = Date.now()) {
  const aliveIds = new Set(localEntries.map((entry) => entry.id))
  const out = {}
  for (const id of lastSeenIds) {
    if (!aliveIds.has(id)) out[id] = now
  }
  return out
}

/**
 * 合并两边的记忆条目。
 * 规则：墓碑时间晚于条目 updatedAt 就删掉；否则 updatedAt 晚的赢；完全打平保留本地。
 */
export function mergeEntries(localEntries = [], remoteEntries = [], tombstones = {}) {
  const byId = new Map()
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
    const dead = Number(tombstones[id]) || 0
    if (!dead) continue
    const at = Number(entry.updatedAt) || 0
    if (dead >= at) {
      byId.delete(id)
      deleted += 1
    }
  }
  const merged = [...byId.values()].sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
  return { entries: merged, added, updated, deleted }
}

/** 人设：整份按 updatedAt 取新，但 personas 数组按 id 并集（同 id 取新）。 */
export function mergePersona(local = {}, remote = {}) {
  const localAt = Number(local.updatedAt) || 0
  const remoteAt = Number(remote.updatedAt) || 0
  const newer = localAt >= remoteAt ? local : remote
  const byId = new Map()
  for (const persona of Array.isArray(remote.personas) ? remote.personas : []) {
    if (persona?.id) byId.set(persona.id, persona)
  }
  for (const persona of Array.isArray(local.personas) ? local.personas : []) {
    if (!persona?.id) continue
    const existing = byId.get(persona.id)
    if (!existing || (Number(persona.updatedAt) || 0) >= (Number(existing.updatedAt) || 0)) byId.set(persona.id, persona)
  }
  return {
    version: 1,
    current: typeof newer.current === 'string' && newer.current ? newer.current : 'dafeiyu',
    personas: [...byId.values()],
    bySession: {}, // 会话级映射不上云（会话 id 换机器就废了）
    updatedAt: Math.max(localAt, remoteAt),
  }
}

/** 模块设置：整份按 updatedAt 取新，并剥掉会话级的东西。 */
export function sanitizeModules(modules) {
  const normalized = normalizeModules(modules ?? {})
  for (const module of Object.values(normalized)) {
    if (!module || typeof module !== 'object') continue
    if (Array.isArray(module.items)) module.items = module.items.filter((item) => item?.scope !== 'session')
  }
  if (normalized.agentive) normalized.agentive.sessionIds = []
  return normalized
}

export function mergeModules(local, remote) {
  const localAt = Number(local?.updatedAt) || 0
  const remoteAt = Number(remote?.updatedAt) || 0
  const winner = localAt >= remoteAt ? local : remote
  return sanitizeModules(winner)
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
  ensureDeviceId(config)

  if (!config.repo) return { ok: false, error: '还没填同步仓库（形如 owner/repo）' }
  const token = tokenOf(config)
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
    const tombstones = pruneTombstones(mergeTombstones(mergeTombstones(config.tombstones ?? {}, remoteTombstones), localDeletions), now)

    const mergedMemory = mergeEntries(localEntries, Array.isArray(remoteMemory.data?.entries) ? remoteMemory.data.entries : [], tombstones)

    const memoryRemoteNext = {
      version: 1,
      updatedAt: now,
      deviceId: config.deviceId,
      entries: mergedMemory.entries,
      tombstones,
    }
    const personaLocal = readPersona().store
    const personaNext = mergePersona(personaLocal, remotePersona.data ?? {})
    const modulesLocal = readModules()
    const modulesNext = mergeModules(modulesLocal, remoteModules.data ?? {})

    const pushMemory = JSON.stringify(memoryRemoteNext) !== JSON.stringify(remoteMemory.data ?? {})
    const pushPersona = JSON.stringify(personaNext) !== JSON.stringify(remotePersona.data ?? {})
    const pushModules = JSON.stringify(modulesNext) !== JSON.stringify(remoteModules.data ?? {})

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
      const res = await writeRemoteFile(config, REMOTE_MODULES, modulesNext, remoteModules.sha, `sync(modules): ${commitTag}`, token)
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
    writePersonaStore(personaNext)
    if (JSON.stringify(modulesNext) !== JSON.stringify(modulesLocal)) writeModulesSynced(modulesNext)

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
    tokenFromEnv: !config.token && Boolean(cleanToken(process.env.DSH_SHARED_BRAIN_TOKEN ?? '')),
    deviceId: config.deviceId,
    lastSyncAt: config.lastSyncAt,
    lastPushedAt: config.lastPushedAt,
    lastError: config.lastError,
    trackedEntries: Array.isArray(config.lastSeenIds) ? config.lastSeenIds.length : 0,
    tombstones: Object.keys(config.tombstones ?? {}).length,
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
