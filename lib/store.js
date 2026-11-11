/**
 * 共享记忆的本地存储层。
 *
 * 记忆落在 DSH_HOME 下（跨 profile、跨会话共享），格式是单个 JSON 文件：
 *   ~/.dsh/storages/dsh-shared-brain/memory.json
 *
 * 之所以自己写文件而不复用 Hindsight 服务：本机没有 Hindsight 的 API key，
 * 本地 daemon 模式又缺 uv / Rust / LLM key，两条路都走不通。
 */
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { checkpointNow, hasData, readAllEntries, replaceAllEntries, readMeta, syncEntries, writeMeta } from './db.js'
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
// 2026-11-11：memory.json 读不出来、库也空的时候记下时间戳，用来挡住「空库写回」。
let brokenFileAt = 0
// 2026-11-11：内容没变的侧门导入只记一次日志，别每读一次就喊一遍。
let lastQuietImportAt = 0

/**
 * 一批条目的指纹，用来判断「memory.json 被碰过但内容没变」。
 * 只取 id / updatedAt / 正文长度 / 标签 —— 正文全文太大，比较这些足够区分。
 */
function storeDigest(entries) {
  const rows = (Array.isArray(entries) ? entries : []).map(
    (entry) =>
      `${entry?.id ?? ''}\u0001${entry?.updatedAt ?? 0}\u0001${String(entry?.text ?? '').length}\u0001${(entry?.tags ?? []).join(',')}`,
  )
  rows.sort()
  return `${rows.length}:${rows.join('\u0002')}`
}

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
function readStoreInner() {
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

          // 导入前先保住库里已有的出处。
          // 老版本宿主写的 memory.json 不带 sourceRef，直接导入会把补好的
          // 230 条知识出处一次性抹掉 —— 实测发生过两次。只补空，不覆盖已有值。
          let dbEntries = null
          try {
            dbEntries = readAllEntries()
            const prev = new Map(
              dbEntries
                .filter((entry) => typeof entry.sourceRef === 'string' && entry.sourceRef)
                .map((entry) => [entry.id, entry.sourceRef]),
            )
            if (prev.size > 0) {
              let kept = 0
              for (const entry of imported.entries) {
                if (!entry.sourceRef && prev.has(entry.id)) {
                  entry.sourceRef = prev.get(entry.id)
                  kept += 1
                }
              }
              if (kept > 0) {
                console.warn(`[dsh-shared-brain] 导入时保住了 ${kept} 条已有出处（文件里没带）`)
              }
            }
          } catch {
            /* 读不到旧的就按文件内容走 */
          }

          // 2026-11-11：先把内容和库里的比一遍。别小看这一步 —— 任何工具碰一下
          // memory.json（哪怕一个字节没改）都会让 mtime 变新，原来的逻辑于是整份
          // 重写 SQLite 并打一条「检测到被外部改过，已导入 560 条」。读一次记忆就
          // 触发一次全量重写，日志还吓人。内容一样就把版本号往前推一下收工。
          if (dbEntries && storeDigest(dbEntries) === storeDigest(imported.entries)) {
            stamp = Date.now()
            writeMeta('entries_updated_at', stamp)
            storeCache = null
            if (Date.now() - lastQuietImportAt > 60 * 60 * 1000) {
              lastQuietImportAt = Date.now()
              console.warn('[dsh-shared-brain] memory.json 只是被碰了一下（内容没变），跳过整份导入')
            }
          } else {
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
          }
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
  } catch (error) {
    // 2026-11-06 修（报告 1.14）：坏文件以前是静默回空库 —— 下一轮任何写操作
    // 都会把空库写回去，整份记忆就这么没了。现在留下告警 + 现场副本，方便手动捞。
    console.warn('[dsh-shared-brain] memory.json 解析失败，先用空库兜底：' + String(error?.message ?? error))
    try {
      copyFileSync(file, file + '.broken-' + Date.now())
    } catch {
      // 复制失败不影响主流程
    }
    // 2026-11-11 加固：库里要是也没数据，这个空库就是**唯一**的记忆来源，
    // 之后随便一次写（记一条新东西、调个权重）都会把坏文件覆盖掉。
    // 所以把坏文件挪到一边，并立个牌子：这一轮不许用空库把记忆写没。
    try {
      if (!hasData()) {
        renameSync(file, `${file}.unreadable-${Date.now()}`)
        brokenFileAt = Date.now()
        console.warn('[dsh-shared-brain] 数据库也是空的：已把读不出来的 memory.json 挪到一边，本轮拒绝用空库覆盖')
      }
    } catch {
      // 挪不动就算了，至少还有 .broken 副本
    }
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

/**
 * 读库，并在返回值上挂两个内部字段（2026-11-11，P0-2）：
 *   - `__revision`：读到这一刻库里的 `entries_updated_at`
 *   - `__baseIds` ：这一份快照里有哪些 id
 * 写回时拿它们做乐观校验：版本号变了说明别人写过，要先合并再写，
 * 不然「后写覆盖先写」，先写进去的新记忆会被当成已删除再删一遍。
 * 这两个字段只活在内存里，writeStore 落盘时会剥掉。
 */
export function readStore() {
  const store = readStoreInner()
  try {
    store.__revision = hasData() ? Number(readMeta('entries_updated_at') ?? 0) : 0
  } catch {
    store.__revision = 0
  }
  store.__baseIds = (store.entries ?? []).map((entry) => entry?.id).filter((id) => typeof id === 'string')
  return store
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
        // 情感语义字段（2026-11-02）：亲密度 / 极性 / 对象；owner（2026-11-09）：谁的情绪
        intimacy: Number.isFinite(item.intimacy) ? Math.min(1, Math.max(0, item.intimacy)) : undefined,
        sentiment: typeof item.sentiment === 'string' ? item.sentiment : undefined,
        target: typeof item.target === 'string' ? item.target : undefined,
        owner: ['user', 'self', 'general'].includes(item.owner) ? item.owner : undefined,
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
        // 2026-11-11：话题键。以前 normalizeStore 逐字段重建时没保住它，
        // 写一次库就没了——冲突检测（同话题新旧说法）等于瞎的。
        topicKey:
          typeof item.topicKey === 'string' && item.topicKey.trim()
            ? item.topicKey.trim().slice(0, 200)
            : undefined,
      }
    })
  // 2026-11-11：id 去重。id 是「操作哪一条」的唯一凭据，两条撞了 id，
  // 改一条会牵连另一条（改寿命、删条目都可能打在错的条目上）。
  // 老数据里权重并存过 mem_/mod_ 两套前缀，重复只可能来自同一批生成，
  // 这里在入库前统一收敛一次：后来的那条换新 id，正文一条不丢。
  const usedIds = new Set()
  for (const entry of store.entries) {
    if (usedIds.has(entry.id)) {
      const fresh = newId()
      entry.id = usedIds.has(fresh) ? `${fresh}_${usedIds.size.toString(36)}` : fresh
    }
    usedIds.add(entry.id)
  }
  store.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : store.entries[0]?.updatedAt ?? 0
  return store
}

/**
 * 过期记忆的回收文件（和 memory.json 放一起）。
 *
 * 以前过期就是**直接删掉**，删完就没了，连个念想都没有。
 * 现在删之前先落到这个文件里：真删错了还能捞回来。
 */
function expiredArchiveFile() {
  return join(brainDir(), 'memory-expired.jsonl')
}

/** 把要删的过期条目写进回收文件。 */
function archiveExpiredEntries(entries) {
  if (!entries.length) return
  try {
    mkdirSync(brainDir(), { recursive: true })
    const stamp = Date.now()
    const lines = entries
      .map((entry) => JSON.stringify({ ...entry, expiredAt: stamp }))
      .join('\n')
    appendFileSync(expiredArchiveFile(), `${lines}\n`, 'utf8')
    trimExpiredArchive()
  } catch (error) {
    console.warn('[dsh-shared-brain] 过期记忆写回收文件失败：', String(error?.message ?? error))
  }
}

/** 回收文件别无限长：超过 1MB 就只留最后 500 条。 */
function trimExpiredArchive() {
  try {
    const file = expiredArchiveFile()
    const stat = statSync(file)
    if (stat.size <= 1024 * 1024) return
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    writeFileSync(file, `${lines.slice(-500).join('\n')}\n`, 'utf8')
  } catch {
    // 读不了就算了，不影响主流程
  }
}

/**
 * 丢掉已经过期的临时记忆。
 *
 * 2026-11-09 改了两处：
 *   1. **钉住的条目不删**。老大手动钉过的东西，不该被时间悄悄带走 ——
 *      以前它到期就被物理删除，连回收站都没有。
 *      现在钉住的过期条目留在库里（但照旧不参与召回，除非续期）。
 *   2. **别的过期条目删之前先写回收文件**（memory-expired.jsonl），
 *      免得「过期 = 消失」这种静默删除。
 *
 * @returns {{ store: object, removed: number, kept: number }} 清理后的库、删除条数、保留的钉住条数
 */
export function pruneExpired(store, now = Date.now()) {
  const before = store.entries.length
  const expired = []
  let kept = 0
  store.entries = store.entries.filter((entry) => {
    if (isAlive(entry, now)) return true
    if (entry?.pinned === true) {
      kept += 1
      return true
    }
    expired.push(entry)
    return false
  })
  const removed = before - store.entries.length
  if (expired.length) archiveExpiredEntries(expired)
  return { store, removed, kept }
}

/**
 * 把「底线」模块桶里的条目镜像进扁平库（2026-11-11，P0-1）。
 *
 * 以前底线只活在 modules.json 的桶里：SQLite 里 `bottomline` 0 行，
 * 换机恢复、云端同步（只推 memory.json / modules.json / persona.json）、
 * 召回白名单都拿不到它。桶里的 JSON 一旦损坏，底线就没了。
 *
 * 镜像用**同一个 id**（桶里的 mod_*），召回时两边按 id 就能去重，
 * 桶里删掉也同步删掉扁平库那份。
 *
 * @returns {boolean} 有没有改到东西（没改就别写盘）
 */
export function mirrorBottomlineEntries(store, modules) {
  const items = Array.isArray(modules?.bottomline?.items) ? modules.bottomline.items : []
  const wanted = new Map()
  for (const item of items) {
    const id = String(item?.id ?? '').trim()
    const text = String(item?.text ?? '').trim()
    if (!id || !text) continue
    wanted.set(id, item)
  }

  let changed = false
  const kept = []
  for (const entry of store.entries ?? []) {
    if (entry?.module !== 'bottomline') {
      kept.push(entry)
      continue
    }
    if (wanted.has(String(entry?.id))) kept.push(entry)
    else changed = true // 桶里删了，镜像也删
  }
  store.entries = kept

  const byId = new Map(store.entries.map((entry) => [String(entry?.id), entry]))
  const now = Date.now()
  for (const [id, item] of wanted) {
    const text = String(item.text).trim()
    const weight = Number(item.weight)
    const existing = byId.get(id)
    if (existing) {
      if (existing.text !== text || existing.pinned !== true || (Number.isFinite(weight) && existing.weight !== weight)) {
        existing.text = text
        existing.pinned = true
        if (Number.isFinite(weight)) existing.weight = weight
        existing.lifetime = 'permanent'
        existing.expiresAt = 0
        existing.updatedAt = now
        changed = true
      }
      continue
    }
    const entry = {
      id,
      module: 'bottomline',
      text,
      tags: Array.isArray(item.tags) ? item.tags : [],
      weight: Number.isFinite(weight) ? weight : 0.9,
      lifetime: 'permanent',
      expiresAt: 0,
      ttlMs: 0,
      pinned: true,
      source: item.source === 'auto' ? 'auto' : 'manual',
      scope: 'global',
      scopePath: '',
      scopeSession: '',
      supersedes: '',
      sessionId: '',
      cwd: '',
      createdAt: Number(item.createdAt) || now,
      updatedAt: Number(item.updatedAt) || now,
      hits: 0,
    }
    store.entries.push(entry)
    byId.set(id, entry)
    changed = true
  }
  return changed
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
 * 并发写入合并（2026-11-11，P0-2）。
 *
 * 场景：两个 DSH 进程（或 Cursor 侧门）同时写。双方都拿着自己那份快照，
 * 谁后写谁就把对方新增的条目当成「已删除」，再删一遍。
 * 这里以库里的最新内容为底，和「我们想写的」逐条合并：
 *   - 两边都有 → 取 updatedAt 新的（同时间取我们这份）
 *   - 只有库里有、我们读过所以 baseIds 里有 → 是我们删的，跳过
 *   - 只有库里有、baseIds 里没有 → 是别人新增的，保留
 *   - 只有我们有 → 本次新增，保留
 *
 * @param {Array} entries 本次想写的条目
 * @param {string[]} [baseIds] 读快照时库里有、现在这份快照里的 id 列表
 * @returns {Array} 合并后的条目
 */
function mergeConcurrentWrite(entries, baseIds) {
  const ours = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.id) ours.set(entry.id, entry)
  }
  const base = new Set(Array.isArray(baseIds) ? baseIds : [])
  let theirs = []
  try {
    theirs = readAllEntries()
  } catch {
    theirs = []
  }
  const merged = new Map()
  for (const entry of theirs) {
    if (!entry?.id) continue
    const mine = ours.get(entry.id)
    if (mine) {
      const mineAt = Number(mine.updatedAt) || 0
      const theirsAt = Number(entry.updatedAt) || 0
      merged.set(entry.id, mineAt >= theirsAt ? mine : entry)
    } else if (!base.has(entry.id)) {
      merged.set(entry.id, entry)
    }
    // base 里有、我们这份没有 = 我们确实删了，不补回来
  }
  for (const [id, entry] of ours) {
    if (!merged.has(id)) merged.set(id, entry)
  }
  return dedupeEntries([...merged.values()])
}

/**
 * 写库。先写临时文件再 rename，避免宿主崩溃时留下半个 JSON。
 */
export function writeStore(store) {
  const dir = brainDir()
  // 2026-11-11 加固（配合上面 brokenFileAt）：记忆文件读不出来、库又是空的，
  // 这时候写「空库」等于把整份记忆抹掉。拦一次，让人能看到告警去捞备份。
  // 显式带 __forceEmpty 的（真的想清空）不拦。
  if (brokenFileAt && store?.__forceEmpty !== true && !(Array.isArray(store?.entries) && store.entries.length > 0)) {
    console.warn('[dsh-shared-brain] 拒绝用空库覆盖记忆：内存里这份是「文件读不出来」兜底出来的空库')
    return store
  }
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
  // 2026-11-06 修：脱敏会把两条不同的条目擦成同一句话（都变成「[已脱敏]」），
  // 于是库里凭空多出重复。这里按「模块 + 正文」再去一次重，保留信息更全的那条。
  safeStore.entries = dedupeEntries(safeStore.entries)
  // 只落这三样：__revision / __baseIds 是内存里的校验信息，不进文件。
  const payload = { version: safeStore.version ?? 1, updatedAt: Date.now(), entries: safeStore.entries }

  // 顺序很关键：JSON 快照先落，库后写、版本号最后盖。
  // 反过来的话，JSON 的 mtime 会比库里的版本号新，下一次读就会误判成
  // "外部从侧门改了文件"，白白多做一次全量导入。
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)

  // 权威写到 SQLite：只写真的变了的那些行，没变的一个字节都不碰。
  // 2026-11-09 改：以前是 replaceAllEntries（整库 DELETE + 逐条重插），
  // 每写一次整个库重写一遍，WAL 涨到比库本身还大、写一次 50ms。
  // 现在走增量同步：只有真变了的条目才 upsert，真没了的才 delete。
  try {
    // 2026-11-11（P0-2）：带上读的时候看到的版本号。对不上说明这中间
    // 有别的进程写过（两个 DSH 同时开、Cursor 侧门写），它返回 conflict，
    // 我们重读合并后再写一次 —— 否则后写的会把先写的新条目删掉。
    const expected = Number(store?.__revision)
    const useExpected = Number.isFinite(expected) && expected > 0
    let result = syncEntries(payload.entries, useExpected ? { expectedRevision: expected } : {})
    if (result?.conflict) {
      payload.entries = mergeConcurrentWrite(payload.entries, store?.__baseIds)
      // 合并后的内容也要落回 JSON，否则文件和库又不一致
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, file)
      result = syncEntries(payload.entries)
      console.warn(
        `[dsh-shared-brain] 检测到并发写入，已合并后重写（改 ${result.changed} 条 / 删 ${result.removed} 条）`,
      )
    }
    writeMeta('entries_updated_at', Date.now())
    // 顺手看一眼 WAL 能不能回收（老版本攒下的 5MB WAL 就是这么没的）
    checkpointNow()
  } catch (error) {
    console.warn('[dsh-shared-brain] SQLite 写入失败，退回 JSON：' + String(error?.message ?? error))
  }
  // PERF-2：任何写路径都从这里过，写成功后缓存必然失效。
  storeCache = null
  // 写成功了（且不是空库兜底），说明记忆文件已经重建，旗标可以撤。
  if (payload.entries.length > 0) brokenFileAt = 0
  // PERF-1：只有落下去了才丢掉增量；写失败时留着下次补。
  if (hadPending) pendingMutations.clear()
  return payload
}

/**
 * 去重（2026-11-06）：同一模块里正文一模一样的条目只留一条。
 *
 * 只按正文判等 —— 不按前 N 个字近似，那种判法会把「A 是 B」和「A 是 C」并掉。
 * 两条重了留哪条：有出处的 > 有标签的 > 被钉住的 > 先来的。
 */
function dedupeEntries(entries) {
  const list = Array.isArray(entries) ? entries : []
  const best = new Map()
  const order = []
  for (const entry of list) {
    if (!entry || typeof entry.text !== 'string') continue
    const key = `${entry.module ?? 'cognition'}\u0000${entry.text.trim()}`
    const score =
      (typeof entry.sourceRef === 'string' && entry.sourceRef.trim() ? 4 : 0) +
      (Array.isArray(entry.tags) && entry.tags.length ? 2 : 0) +
      (entry.pinned === true ? 1 : 0)
    const prev = best.get(key)
    if (!prev) {
      best.set(key, { entry, score })
      order.push(key)
    } else if (score > prev.score) {
      best.set(key, { entry, score })
    }
  }
  if (best.size === list.length) return list
  return order.map((key) => best.get(key).entry)
}

/** 生成一条记忆的 id。 */
let idCounter = 0

export function newId() {
  // 2026-11-11：加进程内自增序号。同一毫秒里连生成多条时，
  // 「时间 + 6 位随机」仍有撞车可能；序号把它压到可以忽略。
  idCounter = (idCounter + 1) % 1296
  return `mem_${Date.now().toString(36)}_${idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`
}
