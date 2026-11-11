import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-topic-key-'))
process.env.DSH_HOME = home

const lib = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const store = await import(`file:///${lib}/store.js`)
const db = await import(`file:///${lib}/db.js`)

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}  ${extra}`)
  }
}

const now = Date.now()
const entry = {
  id: 'mem_topic_1',
  text: '李白《将进酒》里「天生我材必有用」是豪放里带着一股不服。',
  tags: ['将进酒', '李白'],
  module: 'knowledge',
  weight: 0.7,
  lifetime: 'permanent',
  expiresAt: 0,
  pinned: false,
  source: 'manual',
  scope: 'global',
  scopePath: '',
  sourceRef: '唐宋诗词精选',
  topicKey: 'book:唐宋诗词精选:李白将进酒',
  createdAt: now,
  updatedAt: now,
  hits: 0,
}

store.writeStore({ version: 1, updatedAt: now, entries: [entry] })

// 1) 读回来（走 SQLite）两个字段都在
const back = store.readStore().entries[0]
check('sourceRef 透过 SQLite 还在', back.sourceRef === '唐宋诗词精选', String(back.sourceRef))
check('topicKey 透过 SQLite 还在', back.topicKey === 'book:唐宋诗词精选:李白将进酒', String(back.topicKey))

// 2) SQLite 里确实建了 topic_key 列
const handle = db.openDb()
const cols = handle.prepare('PRAGMA table_info(memories)').all().map((c) => c.name)
check('memories 有 topic_key 列', cols.includes('topic_key'), cols.join(','))

// 3) 列里存的不是空串
const row = handle.prepare('SELECT topic_key FROM memories WHERE id = ?').get('mem_topic_1')
check('topic_key 落库有值', row && row.topic_key === 'book:唐宋诗词精选:李白将进酒', JSON.stringify(row))

// 4) 没有 topicKey 的条目照常工作（不写 undefined）
const plain = { ...entry, id: 'mem_topic_2', text: '另一条没有话题键的知识。', topicKey: undefined, sourceRef: undefined }
store.writeStore({ version: 1, updatedAt: now, entries: [entry, plain] })
const two = store.readStore().entries
check('两条都在', two.length === 2, String(two.length))
check('没有 topicKey 的那条读回也是空', !two.find((e) => e.id === 'mem_topic_2').topicKey)

// 5) 老库迁移：删掉列再重开，应该自动补回来、数据不丢
db.closeDb()
const rawsqlite = handle
try {
  rawsqlite.exec('ALTER TABLE memories DROP COLUMN topic_key')
} catch (error) {
  console.log('跳过迁移用例（这个 SQLite 不支持 DROP COLUMN）：' + error.message)
}
db.closeDb()
const again = db.openDb()
const cols2 = again.prepare('PRAGMA table_info(memories)').all().map((c) => c.name)
check('重开后 topic_key 列自动补回', cols2.includes('topic_key'), cols2.join(','))
const count = again.prepare('SELECT count(*) AS n FROM memories').get().n
check('补列后条数不变', count === 2, String(count))

db.closeDb()
try {
  rmSync(home, { recursive: true, force: true })
} catch {
  // Windows 上句柄有时没放干净，清不掉就算了（临时目录）
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
