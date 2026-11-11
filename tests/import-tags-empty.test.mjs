/**
 * 侧门导入：文件里写成空数组（tags: []）也不能把库里的标签抹掉。
 * 这是 2026-11-11 那次实测丢标签（tagged 305 → 18）的回归。
 */
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-import-tags-'))
process.env.DSH_HOME = home
const LIB = 'file:///C:/Users/13176/Documents/dsh-shared-brain-patches/lib/'
const store = await import(LIB + 'store.js')

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++
    console.log('PASS  ' + name)
  } else {
    fail++
    console.log('FAIL  ' + name + '  ' + extra)
  }
}

const file = join(home, 'storages', 'dsh-shared-brain', 'memory.json')
const now = Date.now()
const entries = [
  {
    id: 'mem_k1',
    module: 'knowledge',
    text: '欲穷千里目，更上一层楼。——王之涣《登鹳雀楼》',
    tags: ['登鹳雀楼', '王之涣', '唐宋诗词精选'],
    sourceRef: '唐宋诗词精选',
    weight: 0.7,
    lifetime: 'permanent',
    expiresAt: 0,
    pinned: false,
    source: 'manual',
    scope: 'global',
    createdAt: now,
    updatedAt: now,
    hits: 0,
  },
  {
    id: 'mem_c1',
    module: 'cognition',
    text: '老大要求先给结论再讲理由。',
    tags: ['沟通习惯'],
    weight: 0.6,
    lifetime: 'permanent',
    expiresAt: 0,
    pinned: false,
    source: 'auto',
    scope: 'global',
    createdAt: now,
    updatedAt: now,
    hits: 0,
  },
]

store.writeStore({ version: 1, updatedAt: now, entries })
const written = store.readStore()
check('先写进去时标签在', written.entries.every((e) => Array.isArray(e.tags) && e.tags.length > 0), JSON.stringify(written.entries.map((e) => e.tags)))

// 模拟老进程写盘：整份文件不带标签（tags: []）
const raw = JSON.parse(readFileSync(file, 'utf8'))
for (const entry of raw.entries) entry.tags = []
raw.updatedAt = Date.now() + 5000
writeFileSync(file, JSON.stringify(raw, null, 2))
const stamp = new Date(Date.now() + 10 * 1000)
utimesSync(file, stamp, stamp)

const imported = store.readStore()
const byId = new Map(imported.entries.map((e) => [e.id, e]))
check('空数组不会抹掉知识标签', (byId.get('mem_k1')?.tags ?? []).length === 3, JSON.stringify(byId.get('mem_k1')?.tags))
check('空数组不会抹掉认知标签', (byId.get('mem_c1')?.tags ?? []).length === 1, JSON.stringify(byId.get('mem_c1')?.tags))
check('出处也保住了', byId.get('mem_k1')?.sourceRef === '唐宋诗词精选', String(byId.get('mem_k1')?.sourceRef))

try {
  rmSync(home, { recursive: true, force: true })
} catch {}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
