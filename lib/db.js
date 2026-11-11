/**
 * 权威存储层：SQLite（Node 内置 node:sqlite，零依赖）。
 *
 * ## 为什么换掉 JSON
 *
 * 老方案是 `memory.json` / `modules.json` 两个大文件，每次读全量解析、写全量覆盖。
 * 问题不是慢（444 条解析不到 1ms），而是**正确性**：
 *   1. 三份写入方（宿主进程、外部脚本、远端同步）各拿一份内存副本写回，后写的覆盖先写的；
 *   2. 字段靠三处手写的白名单逐个复制，漏一个就静默丢（sourceRef 因此踩过三次）；
 *   3. 写盘不是原子的，中途崩了就半截。
 *
 * SQLite 一次性把三个都解决：事务、schema 强约束、WAL 崩溃安全。
 *
 * ## 为什么还要倒排表
 *
 * 召回现在每轮把全部条目遍历打分。444 条不要紧，但知识库是要长大的。
 * `memory_terms` 存中文 2-gram（和 lib/recall.js 的切词口径一致），
 * 召回先用 SQL 捞出「至少命中一个词」的候选，再在 JS 里精排 —— 从 O(全部) 变成 O(命中)。
 *
 * ## 设计约束
 *
 * - **只加不减**：老的 `readStore()` / `writeStore()` 语义保持不变，上层不用改。
 * - **可回滚**：迁移只导入、不删除原 JSON；DB 建不起来就退回 JSON 路径。
 * - **字段唯一真源**：`MEMORY_FIELDS` 定义一次，读、写、迁移都从它生成。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 记忆条目的字段定义（唯一真源）。新增字段只改这里。 */
export const MEMORY_FIELDS = {
  id: 'TEXT PRIMARY KEY',
  module: "TEXT NOT NULL DEFAULT 'cognition'",
  text: "TEXT NOT NULL DEFAULT ''",
  tags: "TEXT NOT NULL DEFAULT '[]'", // JSON 数组
  weight: 'REAL NOT NULL DEFAULT 0.5',
  lifetime: "TEXT NOT NULL DEFAULT 'permanent'",
  expires_at: 'INTEGER NOT NULL DEFAULT 0',
  ttl_ms: 'INTEGER NOT NULL DEFAULT 0',
  pinned: 'INTEGER NOT NULL DEFAULT 0',
  source: "TEXT NOT NULL DEFAULT 'auto'",
  source_ref: "TEXT NOT NULL DEFAULT ''",
  scope: "TEXT NOT NULL DEFAULT 'global'",
  scope_path: "TEXT NOT NULL DEFAULT ''",
  scope_session: "TEXT NOT NULL DEFAULT ''",
  session_id: "TEXT NOT NULL DEFAULT ''",
  cwd: "TEXT NOT NULL DEFAULT ''",
  supersedes: "TEXT NOT NULL DEFAULT ''",
  intimacy: 'REAL',
  sentiment: 'TEXT',
  target: 'TEXT',
  // 2026-11-09（P0-3）：谁的情绪（user = 老大自己的状态，self = 我对老大的情感）
  owner: 'TEXT',
  hits: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL DEFAULT 0',
  archived: 'INTEGER NOT NULL DEFAULT 0',
  archived_at: 'INTEGER',
  archive_reason: 'TEXT',
}

/** JSON 字段 ↔ 列名的映射（写死在这里，避免各处各写一遍） */
const JSON_FIELDS = new Set(['tags'])

/** JS 驼峰 ↔ SQL 下划线 */
const toColumn = (jsKey) =>
  jsKey.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())
const toJsKey = (column) => column.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

const COLUMNS = Object.keys(MEMORY_FIELDS).map((k) => ({ column: k, jsKey: toJsKey(k) }))
const COLUMN_LIST = COLUMNS.map((c) => c.column).join(', ')
const PLACEHOLDERS = COLUMNS.map(() => '?').join(', ')

let db = null
let dbPath = null

/**
 * 数据库文件放哪。
 * 和 JSON 老文件同目录（storages/dsh-shared-brain），迁移完并排放着，方便对照。
 */
export function dbFile() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return join(home, 'storages', 'dsh-shared-brain', 'brain.db')
}

/** 打开（或复用）连接。重复调用返回同一个实例。 */
export function openDb(file = dbFile()) {
  if (db && dbPath === file) return db
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
  mkdirSync(join(file, '..'), { recursive: true })
  db = new DatabaseSync(file)
  dbPath = file
  // WAL：读写不互相阻塞，崩溃后能自动恢复到一致状态
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = OFF')
  migrateSchema(db)
  return db
}

/** 每写这么多次就归并一次 WAL（2026-11-06 修：以前从不 checkpoint，wal 比库还大）。 */
const CHECKPOINT_EVERY = 40

/** WAL 文件超过这个大小就顺手归并一次（2026-11-09 补：只按次数不按体积，老 WAL 一直回收不掉）。 */
const WAL_SIZE_TRIGGER = 1024 * 1024

let writesSinceCheckpoint = 0

/** 现在 WAL 有多大（拿不到就当 0）。 */
function walFileSize() {
  try {
    if (!dbPath) return 0
    return statSync(`${dbPath}-wal`).size
  } catch {
    return 0
  }
}

/**
 * WAL 归并。
 *
 * WAL 模式不 checkpoint 的话，-wal 文件会一直涨（实测 5.3MB vs 库 2.9MB），
 * 磁盘不回收、打开也慢。这里在每次写完后数一次，攒够次数就截断一次。
 * 2026-11-09 再加一条：文件本身超过 1MB 也立刻截断 —— 只按次数的话，
 * 老版本攒下的 5MB WAL 要等 40 次写才回收。
 * 失败不影响主流程 —— checkpoint 只是维护动作。
 */
function maybeCheckpoint(handle) {
  writesSinceCheckpoint += 1
  const oversized = walFileSize() > WAL_SIZE_TRIGGER
  if (writesSinceCheckpoint < CHECKPOINT_EVERY && !oversized) return
  writesSinceCheckpoint = 0
  try {
    handle.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* 忙的时候会失败，下次再来 */
  }
}

/**
 * 立刻看一眼要不要归并 WAL（写完库之后调一下）。
 *
 * 单独暴露出来是因为「写完库 → 记版本号 → 归并」是固定三步，
 * 让每个调用方自己判断要不要 checkpoint 太啰嗦。
 */
export function checkpointNow() {
  try {
    maybeCheckpoint(openDb())
  } catch {
    /* 归并失败不影响主流程 */
  }
}

/** 关掉连接（测试用；插件里不需要主动关） */
export function closeDb() {
  if (!db) return
  try {
    db.close()
  } catch {
    /* ignore */
  }
  db = null
  dbPath = null
}

function migrateSchema(handle) {
  const columns = Object.entries(MEMORY_FIELDS)
    .map(([name, type]) => `${name} ${type}`)
    .join(',\n  ')

  handle.exec(`
    CREATE TABLE IF NOT EXISTS memories (
  ${columns}
    );
    CREATE INDEX IF NOT EXISTS idx_memories_module ON memories(module, archived, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
    CREATE INDEX IF NOT EXISTS idx_memories_lifetime ON memories(lifetime, expires_at);

    -- 倒排索引：term → 记忆。中文按 2-gram 切（与 lib/recall.js 口径一致）。
    -- 召回先用它把候选缩到「命中词的那些条」，再在 JS 里精排。
    CREATE TABLE IF NOT EXISTS memory_terms (
      term TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      PRIMARY KEY (term, memory_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_terms_memory ON memory_terms(memory_id);

    -- 对话账本（原来是 chat-log.json）
    CREATE TABLE IF NOT EXISTS chat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'chat',
      text TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_at ON chat_log(at);

    -- 结构化配置（人设、模块开关、声音风格……原来是 modules.json）
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    -- 记忆图谱（原来是 graph.json，700KB 全量读写）
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      module TEXT,
      degree INTEGER NOT NULL DEFAULT 0,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS graph_edges (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (from_id, to_id, kind)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_edges_to ON graph_edges(to_id);

    -- 元信息：schema 版本、迁移状态
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // 补列（2026-11-09）：CREATE TABLE IF NOT EXISTS 只建新表，不会给老库加字段。
  // 所以 MEMORY_FIELDS 里新增的字段（如情感条目的 owner）必须显式 ALTER TABLE，
  // 否则老库插入时就报「no such column」。
  try {
    const present = new Set(
      handle.prepare('PRAGMA table_info(memories)').all().map((row) => String(row.name)),
    )
    for (const [name, type] of Object.entries(MEMORY_FIELDS)) {
      if (present.has(name)) continue
      handle.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`)
    }
  } catch {
    /* 补列失败不影响主流程：老库只是读不到新字段 */
  }
}

/** 读一条 meta */
export function readMeta(key, fallback = null) {
  const row = openDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? row.value : fallback
}

export function writeMeta(key, value) {
  openDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value))
}

/** 库里有没有数据（决定要不要走迁移） */
export function hasData() {
  const row = openDb().prepare('SELECT count(*) AS c FROM memories').get()
  return Number(row?.c ?? 0) > 0
}

// ── 条目 ↔ 行 ────────────────────────────────────────────────

function rowToEntry(row) {
  const out = {}
  for (const { column, jsKey } of COLUMNS) {
    const raw = row[column]
    if (raw === undefined || raw === null) continue
    if (JSON_FIELDS.has(jsKey)) {
      try {
        out[jsKey] = JSON.parse(raw)
      } catch {
        out[jsKey] = []
      }
      continue
    }
    if (jsKey === 'pinned' || jsKey === 'archived') {
      out[jsKey] = Number(raw) === 1
      continue
    }
    out[jsKey] = raw
  }
  // 布尔字段 false 也要显式给（上层有 === true 的判断）
  out.pinned = out.pinned === true
  out.archived = out.archived === true
  return out
}

/** 某列的 SQL 默认值（列声明里写了 NOT NULL DEFAULT 的那种） */
function defaultFor(column) {
  const decl = MEMORY_FIELDS[column] ?? ''
  if (!decl.includes('NOT NULL')) return null
  if (decl.startsWith('INTEGER')) return 0
  if (decl.startsWith('REAL')) return 0
  return ''
}

function entryToValues(entry) {
  return COLUMNS.map(({ column, jsKey }) => {
    const v = entry[jsKey]
    if (JSON_FIELDS.has(jsKey)) return JSON.stringify(Array.isArray(v) ? v : [])
    if (jsKey === 'pinned' || jsKey === 'archived') return v === true ? 1 : 0
    if (v === undefined || v === null) return defaultFor(column)
    return v
  })
}

/** 中文 2-gram + 英文词 —— 和 lib/recall.js 的切词保持同一口径 */
export function indexTerms(text) {
  const out = new Set()
  const s = String(text || '').toLowerCase()
  for (const word of s.match(/[a-z0-9_]{2,}/g) ?? []) out.add(word)
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const chunk of cjk.split(/\s+/)) {
    for (let i = 0; i + 1 < chunk.length; i += 1) out.add(chunk.slice(i, i + 2))
  }
  return [...out]
}

function reindexTerms(handle, entry) {
  handle.prepare('DELETE FROM memory_terms WHERE memory_id = ?').run(entry.id)
  const terms = indexTerms(`${entry.text} ${(entry.tags ?? []).join(' ')} ${entry.sourceRef ?? ''}`)
  if (terms.length === 0) return
  const ins = handle.prepare('INSERT OR IGNORE INTO memory_terms (term, memory_id) VALUES (?, ?)')
  for (const term of terms) ins.run(term, entry.id)
}

// ── 读写 ────────────────────────────────────────────────────

/** 读全部条目（兼容老 readStore 的语义） */
export function readAllEntries() {
  const rows = openDb().prepare(`SELECT ${COLUMN_LIST} FROM memories`).all()
  return rows.map(rowToEntry)
}

/** 整库替换（迁移、导入用）。事务内完成，中途失败整体回滚。 */
export function replaceAllEntries(entries) {
  const handle = openDb()
  handle.exec('BEGIN')
  try {
    handle.exec('DELETE FROM memories')
    handle.exec('DELETE FROM memory_terms')
    const ins = handle.prepare(`INSERT INTO memories (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`)
    for (const entry of entries ?? []) {
      if (!entry?.id) continue
      ins.run(...entryToValues(entry))
      reindexTerms(handle, entry)
    }
    handle.exec('COMMIT')
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
  writeMeta('entries_updated_at', Date.now())
  maybeCheckpoint(handle)
  return entries?.length ?? 0
}

/**
 * 库里那一行跟传入的条目是不是一模一样（逐列比）。
 *
 * SQLite 里没有 undefined：空串和 null 都算「空」，所以先归一化再比字符串。
 */
function rowEqualsEntry(row, entry) {
  const values = entryToValues(entry)
  for (let i = 0; i < COLUMNS.length; i += 1) {
    const column = COLUMNS[i].column
    const left = row[column]
    const right = values[i]
    if (left === right) continue
    const leftEmpty = left === null || left === undefined || left === ''
    const rightEmpty = right === null || right === undefined || right === ''
    if (leftEmpty && rightEmpty) continue
    if (String(left ?? '') !== String(right ?? '')) return false
  }
  return true
}

/**
 * 增量同步（2026-11-09）。
 *
 * 以前每次写库都是 `replaceAllEntries`：DELETE 全表 + 逐条重插。
 * 几百条记忆 × 27 列，每写一次整个库重写一遍 —— WAL 一路涨到比库本身还大，
 * 写一次 50ms，倒排表也跟着反复重算。
 *
 * 现在改成**先比后写**：只有内容真变了的那几条才 upsert，真没了的才 delete，
 * 没变的行一个字节都不碰。WAL 自然就瘦了，写入也快一个量级。
 *
 * @param {{ expectedRevision?: number }} [options] 传 expectedRevision 时做一次乐观校验：
 *   库里的 entries_updated_at 与它不一致，说明这中间有别的进程写过，
 *   这次不写、返回 conflict，让调用方重读合并后再来（2026-11-11，P0-2）。
 * @returns {{ changed: number, removed: number, conflict?: boolean }} 改了几条、删了几条
 */
export function syncEntries(entries, options = {}) {
  const list = (entries ?? []).filter((e) => e?.id)
  const handle = openDb()
  // 2026-11-11（P0-2）：先看版本号。以前两个 DSH 进程同时写，后写的
  // 拿的是自己那份旧快照，会把先写进去的新条目当成「已删除」再删一遍。
  const expected = options?.expectedRevision
  if (expected !== undefined && expected !== null) {
    const current = Number(readMeta('entries_updated_at') ?? 0)
    if (Number(expected) !== current) {
      return { changed: 0, removed: 0, conflict: true }
    }
  }
  const existing = new Map()
  for (const row of handle.prepare(`SELECT ${COLUMN_LIST} FROM memories`).all()) {
    existing.set(row.id, row)
  }
  const changed = []
  const seen = new Set()
  for (const entry of list) {
    seen.add(entry.id)
    const row = existing.get(entry.id)
    if (!row || !rowEqualsEntry(row, entry)) changed.push(entry)
  }
  const removed = []
  for (const id of existing.keys()) {
    if (!seen.has(id)) removed.push(id)
  }
  if (changed.length === 0 && removed.length === 0) {
    // 什么都没变也要看一眼 WAL —— 老版本攒下的 5MB 得有个机会回收掉。
    maybeCheckpoint(handle)
    return { changed: 0, removed: 0 }
  }
  handle.exec('BEGIN')
  try {
    if (changed.length > 0) {
      const stmt = handle.prepare(`INSERT INTO memories (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})
        ON CONFLICT(id) DO UPDATE SET ${COLUMNS.map((c) => `${c.column} = excluded.${c.column}`).join(', ')}`)
      for (const entry of changed) {
        stmt.run(...entryToValues(entry))
        reindexTerms(handle, entry)
      }
    }
    if (removed.length > 0) {
      const del = handle.prepare('DELETE FROM memories WHERE id = ?')
      const delTerms = handle.prepare('DELETE FROM memory_terms WHERE memory_id = ?')
      for (const id of removed) {
        del.run(id)
        delTerms.run(id)
      }
    }
    handle.exec('COMMIT')
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
  writeMeta('entries_updated_at', Date.now())
  maybeCheckpoint(handle)
  return { changed: changed.length, removed: removed.length }
}

/** 单条 upsert（带倒排维护），返回是否写入 */
export function upsertEntry(entry) {
  if (!entry?.id) return false
  const handle = openDb()
  handle.exec('BEGIN')
  try {
    handle
      .prepare(`INSERT INTO memories (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})
        ON CONFLICT(id) DO UPDATE SET ${COLUMNS.map((c) => `${c.column} = excluded.${c.column}`).join(', ')}`)
      .run(...entryToValues(entry))
    reindexTerms(handle, entry)
    handle.exec('COMMIT')
    return true
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
}

/** 批量 upsert（一个事务里做完，快且原子） */
export function upsertEntries(entries) {
  const list = (entries ?? []).filter((e) => e?.id)
  if (list.length === 0) return 0
  const handle = openDb()
  handle.exec('BEGIN')
  try {
    const stmt = handle.prepare(`INSERT INTO memories (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})
      ON CONFLICT(id) DO UPDATE SET ${COLUMNS.map((c) => `${c.column} = excluded.${c.column}`).join(', ')}`)
    for (const entry of list) {
      stmt.run(...entryToValues(entry))
      reindexTerms(handle, entry)
    }
    handle.exec('COMMIT')
    return list.length
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
}

export function deleteEntries(ids) {
  const list = (ids ?? []).filter(Boolean)
  if (list.length === 0) return 0
  const handle = openDb()
  handle.exec('BEGIN')
  try {
    const del = handle.prepare('DELETE FROM memories WHERE id = ?')
    const delTerms = handle.prepare('DELETE FROM memory_terms WHERE memory_id = ?')
    for (const id of list) {
      del.run(id)
      delTerms.run(id)
    }
    handle.exec('COMMIT')
    return list.length
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
}

export function countEntries() {
  const row = openDb().prepare('SELECT count(*) AS c FROM memories').get()
  return Number(row?.c ?? 0)
}

/**
 * 候选召回：先用倒排表把范围缩到「命中至少一个词」的条目。
 *
 * 和 JS 全量打分的区别：全量是 O(所有条目)，这里是 O(命中)。知识库上万条时差别就出来了。
 * 返回的仍然是完整条目对象，交给上层精排 —— 打分口径完全不变，所以排序结果不会漂。
 */
export function candidatesByTerms(terms, options = {}) {
  // 输入的词统一过一遍分词：调用方传整串（"勾股定理"）或传已切好的 2-gram 都行。
  // 索引侧是按 indexTerms 切的，查询侧不归一化就会一条都命中不了 —— 实测踩过。
  const list = [
    ...new Set((terms ?? []).filter(Boolean).flatMap((t) => indexTerms(String(t)))),
  ]
  if (list.length === 0) return []
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 4000
  const placeholders = list.map(() => '?').join(', ')
  // 2026-11-11：预筛排序从「命中词数」改成「命中词的稀有度之和」。
  // 原来按 count(*) 排，长条目容易同时命中一堆常见 2-gram，霸占前 800 名，
  // 真正稀有但关键的词（人名、文件名、专有名词）反而被挤掉。
  // 这里每个词按 1/(1+df) 加权：df 小 = 少见 = 更能定位。
  const rows = openDb()
    .prepare(
      `SELECT m.${COLUMN_LIST.split(', ').join(', m.')}
         FROM memory_terms t
         JOIN memories m ON m.id = t.memory_id
         JOIN (
           SELECT term AS rterm, count(*) AS df
             FROM memory_terms
            WHERE term IN (${placeholders})
            GROUP BY term
         ) r ON r.rterm = t.term
        WHERE t.term IN (${placeholders})
        GROUP BY m.id
        ORDER BY sum(1.0 / (1.0 + r.df)) DESC, m.updated_at DESC
        LIMIT ?`,
    )
    .all(...list, ...list, limit)
  return rows.map(rowToEntry)
}

// ── 对话账本 ────────────────────────────────────────────────

export function appendChat(role, kind, text, at = Date.now()) {
  if (!text) return false
  openDb()
    .prepare('INSERT INTO chat_log (role, kind, text, at) VALUES (?, ?, ?, ?)')
    .run(String(role), String(kind || 'chat'), String(text).slice(0, 2000), Number(at))
  return true
}

export function recentChats(limit = 60) {
  const rows = openDb()
    .prepare('SELECT role, kind, text, at FROM chat_log ORDER BY at DESC, id DESC LIMIT ?')
    .all(Number(limit) || 60)
  return rows.reverse()
}

export function pruneChats(keep = 400) {
  openDb()
    .prepare(
      'DELETE FROM chat_log WHERE id NOT IN (SELECT id FROM chat_log ORDER BY at DESC, id DESC LIMIT ?)',
    )
    .run(Number(keep) || 400)
}

// ── 键值配置 ────────────────────────────────────────────────

export function getValue(key, fallback = null) {
  const row = openDb().prepare('SELECT value FROM kv WHERE key = ?').get(key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value)
  } catch {
    return fallback
  }
}

export function setValue(key, value) {
  openDb()
    .prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(key, JSON.stringify(value ?? null), Date.now())
}

// ── 图谱 ────────────────────────────────────────────────────

export function replaceGraph(nodes, edges) {
  const handle = openDb()
  handle.exec('BEGIN')
  try {
    handle.exec('DELETE FROM graph_nodes')
    handle.exec('DELETE FROM graph_edges')
    const n = handle.prepare('INSERT OR REPLACE INTO graph_nodes (id, type, label, module, degree, data) VALUES (?,?,?,?,?,?)')
    for (const node of nodes ?? []) {
      n.run(
        String(node.id),
        String(node.type ?? 'memory'),
        String(node.label ?? ''),
        node.module ?? null,
        Number(node.degree ?? 0),
        JSON.stringify(node),
      )
    }
    const e = handle.prepare('INSERT OR IGNORE INTO graph_edges (from_id, to_id, kind, weight) VALUES (?,?,?,?)')
    for (const edge of edges ?? []) {
      e.run(String(edge.from), String(edge.to), String(edge.kind ?? 'mentions'), Number(edge.weight ?? 1))
    }
    handle.exec('COMMIT')
    // 2026-11-11：记一个版本戳。图谱缓存的旧判据是「节点数:边数」，
    // 数量一样、内容变了（换了标签、改了权重）就会命中脏缓存，读到上一版图。
    writeMeta('graph_updated_at', Date.now())
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
}

/** 把整张图读回来（结构对齐 graph.json，交给 withAdjacency 补邻接表） */
export function readGraphFromDb() {
  const h = openDb()
  const nodes = h
    .prepare('SELECT data FROM graph_nodes')
    .all()
    .map((row) => {
      try {
        return JSON.parse(row.data)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  if (nodes.length === 0) return null
  const edges = h
    .prepare('SELECT from_id AS "from", to_id AS "to", kind, weight FROM graph_edges')
    .all()
    .map((row) => ({ from: row.from, to: row.to, kind: row.kind, weight: Number(row.weight) }))
  const memories = nodes.filter((n) => n.type === 'memory').length
  const entities = nodes.filter((n) => n.type === 'entity').length
  const newest = nodes.reduce((mx, n) => Math.max(mx, Number(n.updatedAt ?? 0)), 0)
  const archived = nodes.filter((n) => n.archived === true).length
  return {
    version: 1,
    nodes,
    edges,
    stats: { memories, entities, edges: edges.length, archived, newest },
    updatedAt: newest,
  }
}

export function graphStats() {
  const h = openDb()
  const nodes = Number(h.prepare('SELECT count(*) AS c FROM graph_nodes').get()?.c ?? 0)
  const edges = Number(h.prepare('SELECT count(*) AS c FROM graph_edges').get()?.c ?? 0)
  // 2026-11-11：带上版本戳，缓存判据不再只看数量。
  const updatedAt = Number(readMeta('graph_updated_at') ?? 0)
  return { nodes, edges, updatedAt }
}

/** 某个记忆节点的一跳邻居（图侧召回用，不用把整张图搬进内存） */
export function neighborsOf(id, limit = 8) {
  const rows = openDb()
    .prepare(
      `SELECT to_id AS id, kind, weight FROM graph_edges WHERE from_id = ?
       UNION ALL
       SELECT from_id AS id, kind, weight FROM graph_edges WHERE to_id = ?
       LIMIT ?`,
    )
    .all(id, id, Number(limit) || 8)
  return rows
}

/** 库文件是否已经存在（迁移判断用） */
export function dbExists(file = dbFile()) {
  return existsSync(file) && statSync(file).size > 0
}
