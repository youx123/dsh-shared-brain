/**
 * 共享记忆的本地存储层。
 *
 * 记忆落在 DSH_HOME 下（跨 profile、跨会话共享），格式是单个 JSON 文件：
 *   ~/.dsh/storages/dsh-shared-brain/memory.json
 *
 * 之所以自己写文件而不复用 Hindsight 服务：本机没有 Hindsight 的 API key，
 * 本地 daemon 模式又缺 uv / Rust / LLM key，两条路都走不通。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { hasData, readAllEntries, replaceAllEntries, readMeta, writeMeta } from './db.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redactSecrets } from './summarize.js'

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
 * PERF-2：规整后的库缓存。
 *
 * readStore 一轮会被调用 2~3 次，每次都要 JSON.parse + normalizeStore（含逐条
 * 脱敏正则），实测 ~2.857ms。文件没变就没必要重算 —— 用「mtime + ctime + 大小」
 * 做 key。命中时返回深拷贝：调用方（bridge / commands / persistTurn / 本文件的
 * 脱敏写回）会就地改条目，共享引用会把缓存改脏。
 */
let storeCache = null // { file, key, store }

function statKey(file) {
  try {
    const st = statSync(file)
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`
  } catch {
    return ''
  }
}

/**
 * 读库。文件不存在或坏了都退回空库，绝不因为记忆损坏把宿主带崩。
 */
export function readStore() {
  // SQLite 优先（2026-11-06 存储重构）：事务 + schema 强约束，
  // 字段定义在 lib/db.js 的 MEMORY_FIELDS 里只有一份，不会再静默丢。
  // 缓存用 meta.entries_updated_at 当版本号，写入方一变就失效。
  try {
    if (hasData()) {
      let stamp = Number(readMeta('entries_updated_at') ?? 0)

      // 外部工具（Cursor 扩展、手工编辑、别的脚本）会绕过 writeStore 直接改 memory.json。
      // 只认库不认文件的话，这些写入会被静默无视 —— 数据看着"没生效"。
      // 判据：文件的 mtime 比库里的版本号新出 1 秒以上，就认为侧门有写入，导入一次再读。
      // 1 秒的余量是给自己写的：writeStore 会先落 JSON 再盖版本号，正常不会踩到。
      const jsonMtime = (() => {
        try {
          return statSync(brainFile()).mtimeMs
        } catch {
          return 0
        }
      })()
      if (jsonMtime > stamp + 1000) {
        try {
          const raw = JSON.parse(readFileSync(brainFile(), 'utf8'))
          const imported = normalizeStore(raw)
          // 差值必须在盖新版本号之前算，否则日志里是负数（踩过）
          const lagSec = Math.round((jsonMtime - stamp) / 1000)
          replaceAllEntries(imported.entries)
          stamp = Date.now()
          writeMeta('entries_updated_at', stamp)
          const store = { version: 1, updatedAt: stamp, entries: imported.entries }
          storeCache = { file: 'db', dbStamp: stamp, store }
          console.warn(
            `[dsh-shared-brain] 检测到 memory.json 被外部改过（比库新 ${lagSec}s），已导入 ${imported.entries.length} 条`,
          )
          return structuredClone(store)
        } catch (error) {
          console.warn(
            '[dsh-shared-brain] 外部写入导入失败，继续用库里的：' + String(error?.message ?? error),
          )
        }
      }

      if (storeCache && storeCache.dbStamp === stamp && storeCache.file === 'db') {
        return structuredClone(storeCache.store)
      }
      const store = { version: 1, updatedAt: stamp, entries: readAllEntries() }
      storeCache = { file: 'db', dbStamp: stamp, store }
      return structuredClone(store)
    }
  } catch (error) {
    console.warn('[dsh-shared-brain] SQLite 读取失败，退回 memory.json：' + String(error?.message ?? error))
  }

  const file = brainFile()
  const key = statKey(file)
  if (key && storeCache && storeCache.file === file && storeCache.key === key) {
    return structuredClone(storeCache.store)
  }
  if (!key) {
    storeCache = null
    return emptyStore()
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const store = normalizeStore(raw)
    // 读的时候顺手把残留的凭据擦掉并写回——外部工具（Cursor 扩展等）可能绕过写入闸门。
    //
    // 2026-11-04（P0-1 审计）：以前这里只看 redactStoreSecrets 的 cleaned，
    // 而 normalizeStore 自己就先抹了一遍 → cleaned 恒为 0 → 永远不写回，
    // 磁盘上的明文一直留着。现在改成「拿原始内容比对」：
    // 只要磁盘上还有 secret，就一定要把干净版本写回去。
    const { cleaned } = redactStoreSecrets(store)
    // 磁盘上还有没有 secret？不能只看 cleaned（normalizeStore 已经先擦了一遍，
    // cleaned 恒为 0）—— 要拿磁盘里的**原文**跟现在这份比：
    // 不一样，就说明磁盘上确实留着凭据，得写回去。
    const rawById = new Map()
    for (const item of Array.isArray(raw.entries) ? raw.entries : []) {
      if (item && typeof item.id === 'string') rawById.set(item.id, item)
    }
    let rawHasSecret = false
    for (const entry of store.entries) {
      if (!entry || typeof entry.text !== 'string') continue
      const original = rawById.get(entry.id)
      if (!original || typeof original.text !== 'string') continue
      if (original.text !== entry.text) {
        rawHasSecret = true
        break
      }
    }
    if (cleaned > 0 || rawHasSecret) {
      try {
        writeStore(store)
      } catch {
        // 写不回就算了，不该因为擦不干净就崩掉读库
      }
    }
    // 写回会改文件 mtime，所以 key 要在写回之后重取。
    const freshKey = statKey(file)
    if (freshKey) storeCache = { file, key: freshKey, store }
    return structuredClone(store)
  } catch {
    storeCache = null
    return emptyStore()
  }
}

/**
 * 记忆的来源。
 *
 * 2026-11-03（P0-2）：以前这里只有 'manual' 和 'auto' 两种，
 * Cursor 同步过来的条目也被算成 'auto' —— 于是「本鱼自己的工作日志」
 * 和「从 Cursor 同步来的记忆」混在一起分不开，
 * 没法按来源做判断（比如待办只认老大亲口说的）。
 * 现在把 'sync' 单列出来。
 */
export const SOURCES = ['manual', 'auto', 'sync']

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
        // 最后一道过道：不管这份记忆是谁写进来的（DSH 自己、Cursor 扩展、别的工具、
        // 甚至有人手改了 memory.json），密钥都不许留在里面。
        //
        // 2026-11-04（P0-1 审计）：这里**继续**脱敏 —— 这是对外的那道闸
        // （外部工具绕过写入闸门直接改 memory.json 时，normalizeStore 是唯一防线）。
        // 审计查到的「磁盘永远明文」不是因为这里脱敏了，而是因为 readStore 的
        // 写回判断看错了指标（cleaned 恒为 0）。那个判断已经改成
        // 「拿磁盘原文比对」，两道防线现在都在。
        text: redactSecrets(String(item.text).trim()).slice(0, 4000),
        tags: Array.isArray(item.tags)
          ? item.tags
              .filter((t) => typeof t === 'string' && t.trim())
              .map((t) => redactSecrets(t.trim()))
              .filter((t) => t !== '[已脱敏]')
              .slice(0, 12)
          : [],
        module: typeof item.module === 'string' && item.module ? item.module : 'cognition',
        weight: Number.isFinite(item.weight) ? Math.min(1, Math.max(0, item.weight)) : 0.5,
        lifetime,
        expiresAt: lifetime === 'temporary' && Number.isFinite(item.expiresAt) ? item.expiresAt : 0,
        ttlMs: Number.isFinite(item.ttlMs) && item.ttlMs > 0 ? item.ttlMs : lifetime === 'temporary' ? DEFAULT_TEMPORARY_TTL_MS : 0,
        pinned,
        // 2026-11-03（P0-2）：保住来源，不认识的退回 auto。
        // 以前只有 'manual' 才保住，'sync' 被静默改写成 'auto'。
        source: SOURCES.includes(item.source) ? item.source : 'auto',
        scope: ['global', 'workspace', 'session'].includes(item.scope) ? item.scope : 'global',
        scopePath: typeof item.scopePath === 'string' ? item.scopePath : '',
        scopeSession: typeof item.scopeSession === 'string' ? item.scopeSession : '',
        // 情感语义字段（2026-11-02）：亲密度 / 极性 / 对象
        intimacy: Number.isFinite(item.intimacy) ? Math.min(1, Math.max(0, item.intimacy)) : undefined,
        sentiment: typeof item.sentiment === 'string' ? item.sentiment : undefined,
        target: typeof item.target === 'string' ? item.target : undefined,
        supersedes: typeof item.supersedes === 'string' ? item.supersedes : '',
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
        cwd: typeof item.cwd === 'string' ? item.cwd : '',
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
        hits: Number.isFinite(item.hits) ? item.hits : 0,
        // 归档标记（2026-11-05，记忆图谱）：normalizeStore 是逐字段重建对象的，
        // 这里不显式保住 archived / archivedAt / archiveReason，归档标记会在
        // 下一次读库时被静默「复活」——记忆又跑回召回池。
        // 归档只打标记，**不删文本**，所以三个字段都只是标记位。
        archived: item.archived === true ? true : undefined,
        archivedAt: Number.isFinite(item.archivedAt) ? item.archivedAt : undefined,
        archiveReason: typeof item.archiveReason === 'string' ? item.archiveReason : undefined,
        // 知识来源（2026-11-06，知识模块）：书名/出处。同样是逐字段重建，
        // 不显式保住就会在读库时丢掉，然后知识就变成"一堆没有出处的句子"。
        sourceRef:
          typeof item.sourceRef === 'string' && item.sourceRef.trim()
            ? item.sourceRef.trim().slice(0, 200)
            : undefined,
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
 * 清理库里已经存在的密钥。
 *
 * 脱敏是 0.9.3 才加的，在那之前入库的条目可能已经含有 PAT / API key。
 * 这些东西还躺在 memory.json 里（还会被召回进提示词），所以要有一次
 * 性的清洗。清洗完把正文替换成脱敏版本，不删条目（保留上下文）。
 *
 * @returns {{ store: object, cleaned: number }} 清理后的库与被清洗的条数
 */
export function redactStoreSecrets(store) {
  let cleaned = 0
  for (const entry of store.entries ?? []) {
    if (typeof entry?.text !== 'string') continue
    const safe = redactSecrets(entry.text)
    if (safe !== entry.text) {
      entry.text = safe
      entry.updatedAt = Date.now()
      cleaned += 1
    }
    // 标签里也可能藏着密钥（摘要时提取的英文 token 会被当成标签）
    if (Array.isArray(entry.tags)) {
      const safeTags = entry.tags.map((tag) => redactSecrets(String(tag)))
      if (safeTags.some((tag, i) => tag !== entry.tags[i])) {
        entry.tags = safeTags.filter((tag) => tag !== '[已脱敏]')
        cleaned += 1
      }
    }
  }
  return { store, cleaned }
}

/**
 * PERF-1：召回命中的「延迟写」缓冲区。
 *
 * 以前每轮召回命中都会 hits+1 并立刻 writeStoreSynced —— 全量重写 ~108KB，
 * 实测 6.69ms/轮，还要为跨机同步跑 4 次坐标 I/O。而 hits 根本不参与召回打分
 * （recall.js 的 scoreEntry 不看它），所以完全可以把增量攒在内存里，合并成
 * 一次写。
 *
 * 放在 store.js 而不是 index.js，是因为 writeStore 是**所有**写路径的收口：
 * 这样 persistTurn / bridge / commands 任何一次立即落盘都会顺手把攒着的
 * hits 和续期带上，不会被冲掉。
 */
const pendingMutations = new Map() // id -> { hits, renewal }

/** 记一次命中增量（只改内存）。 */
export function notePendingHit(id, delta = 1) {
  if (typeof id !== 'string' || !id) return
  if (!Number.isFinite(delta) || delta === 0) return
  const item = pendingMutations.get(id) ?? { hits: 0, renewal: null }
  item.hits += delta
  pendingMutations.set(id, item)
}

/** 记一次临时记忆续期（只改内存，flush 时套用）。 */
export function notePendingRenewal(id, renewed) {
  if (typeof id !== 'string' || !id || !renewed || typeof renewed !== 'object') return
  if (!Number.isFinite(renewed.expiresAt)) return
  const item = pendingMutations.get(id) ?? { hits: 0, renewal: null }
  // 多次命中只留最新的一次续期
  if (!item.renewal || renewed.updatedAt >= item.renewal.updatedAt) {
    item.renewal = {
      expiresAt: renewed.expiresAt,
      ttlMs: Number.isFinite(renewed.ttlMs) ? renewed.ttlMs : 0,
      updatedAt: Number.isFinite(renewed.updatedAt) ? renewed.updatedAt : Date.now(),
    }
  }
  pendingMutations.set(id, item)
}

/** 有没有还没落盘的命中/续期。 */
export function hasPendingMutations() {
  return pendingMutations.size > 0
}

/** 还没落盘的条目 id（只读，测试/诊断用）。 */
export function pendingMutationIds() {
  return [...pendingMutations.keys()]
}

/**
 * 把攒着的增量套到条目上。返回值只是计数，清空由 writeStore 在**写成功之后**
 * 做 —— 写盘失败时保留增量，下一次写还能补上。
 */
function applyPendingMutations(entries) {
  if (pendingMutations.size === 0) return 0
  const byId = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry && typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  let applied = 0
  for (const [id, delta] of pendingMutations) {
    const entry = byId.get(id)
    if (!entry) continue
    if (delta.hits) {
      entry.hits = (Number.isFinite(entry.hits) ? entry.hits : 0) + delta.hits
    }
    if (delta.renewal && entry.lifetime === 'temporary') {
      entry.expiresAt = delta.renewal.expiresAt
      entry.ttlMs = delta.renewal.ttlMs
      entry.updatedAt = Math.max(
        Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
        delta.renewal.updatedAt,
      )
    }
    applied += 1
  }
  return applied
}

/**
 * 写库。先写临时文件再 rename，避免宿主崩溃时留下半个 JSON。
 */
export function writeStore(store) {
  const dir = brainDir()
  mkdirSync(dir, { recursive: true })
  const file = brainFile()
  const tmp = `${file}.${process.pid}.tmp`
  // 2026-11-04（P0-1 审计）：writeStore 是**所有**写路径的收口
  // （readStore 的写回、remote-sync 的落地、persistTurn 的入库……都走这里），
  // 所以脱敏必须在这里兜住 —— 不能指望每条调用路径都记得先擦一遍。
  // 以前脱敏只在读的时候做，于是 syncOnce 裸写 writeStore(nextStore)
  // 就把远端带密钥的条目原样写回磁盘、再原样推上远端。
  const safeStore = { ...store, entries: Array.isArray(store?.entries) ? store.entries : [] }
  const hadPending = pendingMutations.size > 0
  applyPendingMutations(safeStore.entries)
  redactStoreSecrets(safeStore)
  const payload = { ...safeStore, updatedAt: Date.now() }

  // 顺序很关键：JSON 快照先落，库后写、版本号最后盖。
  // 反过来的话，JSON 的 mtime 会比库里的版本号新，下一次读就会误判成
  // "外部从侧门改了文件"，白白多做一次全量导入。
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)

  // 权威写到 SQLite：事务内整库替换，要么全成要么全不动；倒排表同步重建。
  try {
    replaceAllEntries(payload.entries)
    writeMeta('entries_updated_at', Date.now())
  } catch (error) {
    console.warn('[dsh-shared-brain] SQLite 写入失败，退回 JSON：' + String(error?.message ?? error))
  }
  // PERF-2：任何写路径都从这里过，写成功后缓存必然失效。
  storeCache = null
  // PERF-1：只有落下去了才丢掉增量；写失败时留着下次补。
  if (hadPending) pendingMutations.clear()
  return payload
}

/** 生成一条记忆的 id。 */
export function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
