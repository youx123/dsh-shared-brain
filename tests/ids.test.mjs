// id 唯一性：重复 id 必须在入库前被拆开，且正文一条不能丢
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'sb-ids-'))
process.env.DSH_HOME = root

const { normalizeStore, newId } = await import('file:///C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib/store.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    // eslint-disable-next-line no-console
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    // eslint-disable-next-line no-console
    console.log(`FAIL  ${name}  ${extra}`)
  }
}

const raw = {
  version: 2,
  updatedAt: 1,
  entries: [
    { id: 'mem_same', text: '第一条：改寿命打在这条上', module: 'cognition' },
    { id: 'mem_same', text: '第二条：和上面撞了 id', module: 'cognition' },
    { id: '', text: '第三条：压根没有 id', module: 'cognition' },
    { id: 'mem_same', text: '第四条：还是同一个 id', module: 'knowledge' },
    { id: 'mem_only', text: '第五条：独一份', module: 'instinct' },
  ],
}

const store = normalizeStore(raw)
const ids = store.entries.map((e) => e.id)
check('条数没变', store.entries.length === 5, String(store.entries.length))
check('id 全不重复', new Set(ids).size === ids.length, ids.join(','))
check('每一条都有 id', ids.every((id) => typeof id === 'string' && id.length > 0), ids.join(','))
check('正文一条没丢', ['第一条', '第二条', '第三条', '第四条', '第五条'].every((k) => store.entries.some((e) => e.text.includes(k))))
check('原有的独立 id 不动', store.entries.find((e) => e.text.includes('第五条'))?.id === 'mem_only')
check('第一条的 id 保留', store.entries[0].id === 'mem_same', store.entries[0].id)
check('模块没被改', store.entries.find((e) => e.text.includes('第四条'))?.module === 'knowledge')

// newId 连续生成 2000 个不应重复
const many = new Set()
for (let i = 0; i < 2000; i += 1) many.add(newId())
check('连续 2000 个 newId 无重复', many.size === 2000, `${many.size}/2000`)

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  // 句柄没放手时留着无妨
}

// eslint-disable-next-line no-console
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
