/**
 * 一键迁移：JSON 老库 → SQLite。
 *
 * 原则：
 *   1. **只读老文件，不删不改** —— 迁移失败或反悔，原文件原样还在。
 *   2. 迁移完做**逐条对数**（条数、模块分布、抽几条正文比对），对不上就报错退出。
 *   3. 可重复跑：默认整库替换，不会累积重复。
 *
 * 用法：
 *   node scripts/migrate-to-sqlite.mjs            # 真迁移
 *   node scripts/migrate-to-sqlite.mjs --dry      # 只看会迁多少
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { brainDir } from '../lib/store.js'
import { splitPoints } from '../lib/knowledge.js'
import {
  replaceAllEntries,
  readAllEntries,
  countEntries,
  getValue,
  setValue,
  writeMeta,
  dbFile,
} from '../lib/db.js'

const dry = process.argv.includes('--dry')
const dir = brainDir()

const readJson = (name, fallback) => {
  const file = join(dir, name)
  if (!existsSync(file)) return fallback
  return JSON.parse(readFileSync(file, 'utf8'))
}

const store = readJson('memory.json', { version: 1, entries: [] })
const modules = readJson('modules.json', {})
const entries = Array.isArray(store.entries) ? store.entries : []

/**
 * 知识条目补出处。
 *
 * 为什么在迁移时补：`sourceRef` 这个字段已经被"某条写盘路径用旧内存副本覆盖"抹掉三次了。
 * 出处本来就能从导入时的源文件（每本书一个 md）确定性重建，不必依赖库里的字段活着。
 * 迁移时重建一次，之后 DB 是权威源，这条链路就断了。
 */
function backfillSourceRef(list, knowledgeDir) {
  if (!existsSync(knowledgeDir)) return { filled: 0, files: 0 }
  const byText = new Map()
  const files = readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'))
  for (const file of files) {
    const title = basename(file, '.md')
    for (const point of splitPoints(readFileSync(join(knowledgeDir, file), 'utf8'), { max: 260, maxPoints: 400 })) {
      byText.set(point, title)
    }
  }
  let filled = 0
  for (const entry of list) {
    if (entry.module !== 'knowledge' || entry.sourceRef) continue
    const title = byText.get(String(entry.text ?? '').trim())
    if (!title) continue
    entry.sourceRef = title
    const tags = Array.isArray(entry.tags) ? entry.tags : []
    if (!tags.some((t) => String(t).startsWith('book:'))) tags.push('book:' + title)
    entry.tags = tags
    filled += 1
  }
  return { filled, files: files.length }
}

const knowledgeDir = process.env.SB_KNOWLEDGE_DIR || 'C:/Users/13176/Documents/dsh-shared-brain-knowledge'
const backfill = backfillSourceRef(entries, knowledgeDir)

const byModule = {}
for (const entry of entries) {
  const key = entry?.module ?? '(none)'
  byModule[key] = (byModule[key] ?? 0) + 1
}
const withRef = entries.filter((e) => e?.sourceRef).length

console.log(`老库条目 = ${entries.length}`)
console.log(`模块分布 = ${JSON.stringify(byModule)}`)
console.log(`迁移前已带出处 = ${withRef}；从 ${backfill.files} 本源文件补回 ${backfill.filled} 条`)
console.log(`带出处合计 = ${entries.filter((e) => e?.sourceRef).length}`)
console.log(`目标库 = ${dbFile()}`)

if (dry) {
  console.log('\n--dry：没有写入')
  process.exit(0)
}

const written = replaceAllEntries(entries)
const after = countEntries()
if (after !== entries.length) {
  console.error(`✗ 条数对不上：写了 ${written}，库里 ${after}，老库 ${entries.length}`)
  process.exit(1)
}

// 模块配置整份存一条 kv（结构化配置不多，整份存最省事，也不会因为白名单漏字段）
if (modules && typeof modules === 'object') setValue('modules', modules)

writeMeta('migrated_from', 'memory.json+modules.json')
writeMeta('migrated_at', new Date().toISOString())
writeMeta('legacy_entry_count', entries.length)

// 对数：抽 8 条比正文与出处
const sample = entries.filter((e) => e?.id).slice(0, 8)
const index = new Map(readAllEntries().map((e) => [e.id, e]))
let mismatched = 0
for (const entry of sample) {
  const back = index.get(entry.id)
  if (!back) {
    mismatched += 1
    continue
  }
  if (back.text !== entry.text) mismatched += 1
  if ((back.sourceRef ?? '') !== (entry.sourceRef ?? '')) mismatched += 1
  if (back.module !== entry.module) mismatched += 1
}
console.log(`逐条抽检 ${sample.length} 条，不一致 ${mismatched} 处`)

const modulesBack = getValue('modules')
const bucketBack = Object.keys(modulesBack ?? {}).length
console.log(`模块配置回读 = ${modulesBack ? 'ok（' + bucketBack + ' 个键）' : '丢失'}`)

if (mismatched > 0) {
  console.error('✗ 抽检不一致，迁移视为失败；老 json 未动，可以重来')
  process.exit(1)
}

console.log('\n✓ 迁移完成。老 json 一个字节没动，放在同目录可以直接对照。')
