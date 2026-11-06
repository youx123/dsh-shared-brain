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
  return entries?.length ?? 0
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
  const rows = openDb()
    .prepare(
      `SELECT m.${COLUMN_LIST.split(', ').join(', m.')}
         FROM memory_terms t
         JOIN memories m ON m.id = t.memory_id
        WHERE t.term IN (${placeholders})
        GROUP BY m.id
        ORDER BY count(*) DESC, m.updated_at DESC
        LIMIT ?`,
    )
    .all(...list, limit)
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
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
}

export function graphStats() {
  const h = openDb()
  const nodes = Number(h.prepare('SELECT count(*) AS c FROM graph_nodes').get()?.c ?? 0)
  const edges = Number(h.prepare('SELECT count(*) AS c FROM graph_edges').get()?.c ?? 0)
  return { nodes, edges }
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
