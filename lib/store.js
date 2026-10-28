/**
 * 共享记忆的本地存储层。
 *
 * 记忆落在 DSH_HOME 下（跨 profile、跨会话共享），格式是单个 JSON 文件：
 *   ~/.dsh/storages/dsh-shared-brain/memory.json
 *
 * 之所以自己写文件而不复用 Hindsight 服务：本机没有 Hindsight 的 API key，
 * 本地 daemon 模式又缺 uv / Rust / LLM key，两条路都走不通。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 记忆库所在目录：与其它 storages 平级，但独立成一个目录，好清理。 */
export function brainDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-shared-brain')
}

/** 记忆库文件路径。 */
export function brainFile() {
  return join(brainDir(), 'memory.json')
}

/** 空库。 */
export function emptyStore() {
  return {
    version: 1,
    entries: [],
    updatedAt: 0,
  }
}

/**
 * 读库。文件不存在或坏了都退回空库，绝不因为记忆损坏把宿主带崩。
 */
export function readStore() {
  const file = brainFile()
  if (!existsSync(file)) return emptyStore()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return normalizeStore(raw)
  } catch {
    return emptyStore()
  }
}

/** 记忆的寿命类型：永久留着，还是临时（到期即失效）。 */
export const LIFETIMES = ['permanent', 'temporary']

/** 临时记忆的默认存活时长：24 小时。 */
export const DEFAULT_TEMPORARY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 判断一条记忆此刻是否还有效。
 *
 * 永久记忆永远有效；临时记忆过了 expiresAt 就作废。
 */
export function isAlive(entry, now = Date.now()) {
  if (!entry) return false
  if (entry.lifetime !== 'temporary') return true
  if (!Number.isFinite(entry.expiresAt)) return true
  return entry.expiresAt > now
}

/**
 * 给一条临时记忆续期（滑动窗口）。
 *
 * 一条临时记忆如果**被召回过**，说明它还有用，就不该急着过期。
 * 这里把它的到期时间往后推一个 TTL：
 *   - 有 ttlMs 就用 ttlMs
 *   - 没有就用「原本的剩余时长」或默认 24 小时
 *
 * @param {object} entry 记忆条目
 * @param {number} now 当前时间
 * @returns {object} 续期后的条目（永久记忆原样返回）
 */
export function renewEntry(entry, now = Date.now()) {
  if (!entry || entry.lifetime !== 'temporary') return entry
  if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= 0) return entry
  const remaining = entry.expiresAt - now
  const span = Number.isFinite(entry.ttlMs) && entry.ttlMs > 0
    ? entry.ttlMs
    : remaining > 0
      ? remaining
      : DEFAULT_TEMPORARY_TTL_MS
  return { ...entry, expiresAt: now + span, ttlMs: span, updatedAt: now }
}

/**
 * 规整磁盘内容：丢弃字段不对的条目，补齐缺失字段。
 * 一条记忆的形状：
 *   { id, text, tags[], module, weight, lifetime, expiresAt, pinned, source,
 *     sessionId, cwd, createdAt, updatedAt, hits, ttlMs, scope, scopePath,
 *     supersedes }
 *
 * module   —— 归属的模块（bottomline / cognition / emotion / instinct），
 *             老数据没有这个字段时默认归到 cognition。
 * weight   —— 这条记忆自己的权重（0..1），含义随模块而变：
 *             底线=约束强度、认知=置信度、情感=亲密度、本能=使用频次。
 * lifetime —— 'permanent'（永久）或 'temporary'（临时）；老数据默认永久。
 * expiresAt—— 临时记忆的到期时间（毫秒时间戳）；永久记忆为 0。
 * ttlMs    —— 临时记忆的存活时长（续期时用）。
 * pinned   —— 是否被用户**手动钉住**。底线只有钉住的才注入。
 * source   —— 'manual'（用户手动加的）/ 'auto'（对话里自动分类的）。
 * scope    —— 作用域：'global'（到处生效）/ 'workspace'（只在该工作区生效）。
 * scopePath—— 作用域为 workspace 时对应的工作区路径。
 * supersedes—— 被这条记忆取代的旧条目 id（新说法推翻旧说法）。
 */
export function normalizeStore(raw) {
  const store = emptyStore()
  if (!raw || typeof raw !== 'object') return store
  const list = Array.isArray(raw.entries) ? raw.entries : []
  store.entries = list
    .filter((item) => item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim().length > 0)
    .map((item) => {
      const lifetime = LIFETIMES.includes(item.lifetime) ? item.lifetime : 'permanent'
      const pinned = item.pinned === true
      return {
        id: typeof item.id === 'string' && item.id ? item.id : newId(),
        text: String(item.text).trim().slice(0, 4000),
        tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 12) : [],
        module: typeof item.module === 'string' && item.module ? item.module : 'cognition',
        weight: Number.isFinite(item.weight) ? Math.min(1, Math.max(0, item.weight)) : 0.5,
        lifetime,
        expiresAt: lifetime === 'temporary' && Number.isFinite(item.expiresAt) ? item.expiresAt : 0,
        ttlMs: Number.isFinite(item.ttlMs) && item.ttlMs > 0 ? item.ttlMs : lifetime === 'temporary' ? DEFAULT_TEMPORARY_TTL_MS : 0,
        pinned,
        source: item.source === 'manual' ? 'manual' : 'auto',
        scope: item.scope === 'workspace' ? 'workspace' : 'global',
        scopePath: typeof item.scopePath === 'string' ? item.scopePath : '',
        supersedes: typeof item.supersedes === 'string' ? item.supersedes : '',
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
        cwd: typeof item.cwd === 'string' ? item.cwd : '',
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
        hits: Number.isFinite(item.hits) ? item.hits : 0,
      }
    })
  store.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : store.entries[0]?.updatedAt ?? 0
  return store
}

/**
 * 丢掉已经过期的临时记忆。
 *
 * @returns {{ store: object, removed: number }} 清理后的库与删除条数
 */
export function pruneExpired(store, now = Date.now()) {
  const before = store.entries.length
  store.entries = store.entries.filter((entry) => isAlive(entry, now))
  return { store, removed: before - store.entries.length }
}

/**
 * 写库。先写临时文件再 rename，避免宿主崩溃时留下半个 JSON。
 */
export function writeStore(store) {
  const dir = brainDir()
  mkdirSync(dir, { recursive: true })
  const file = brainFile()
  const tmp = `${file}.${process.pid}.tmp`
  const payload = { ...store, updatedAt: Date.now() }
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)
  return payload
}

/** 生成一条记忆的 id。 */
export function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
