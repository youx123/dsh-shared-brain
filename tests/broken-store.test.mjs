import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-broken-'))
process.env.DSH_HOME = home
const dir = join(home, 'storages', 'dsh-shared-brain')
mkdirSync(dir, { recursive: true })
const file = join(dir, 'memory.json')
writeFileSync(file, '{"version":1,"entries":[{"id":"x","text":"半截', 'utf8')

const { readStore, writeStore } = await import('file:///C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib/store.js')

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name) } else { fail++; console.log('FAIL  ' + name + '  ' + extra) }
}

const store = readStore()
check('坏文件读成空库、不炸', Array.isArray(store.entries) && store.entries.length === 0)

const files = readdirSync(dir)
check('留下了 .broken-* 副本', files.some((f) => f.includes('.broken-')), files.join(','))
check('坏文件被挪走（原路径不存在）', !existsSync(file), files.join(','))
check('留下了 .unreadable-* 现场', files.some((f) => f.includes('.unreadable-')), files.join(','))

// 空库写回：应被拒绝
writeStore({ version: 1, entries: [] })
check('空库写被拒绝（文件没被重建）', !existsSync(file), existsSync(file) ? readFileSync(file, 'utf8').slice(0, 40) : '')

// 非空写入：应放行
writeStore({
  version: 1,
  entries: [{ id: 'ok1', module: 'cognition', text: '兜底之后又记了一条', weight: 0.6, lifetime: 'permanent', createdAt: Date.now(), updatedAt: Date.now() }],
})
check('非空写入成功', existsSync(file))
check('写进去的内容对得上', existsSync(file) && readFileSync(file, 'utf8').includes('兜底之后又记了一条'))

// 写成功之后旗标应已撤，再写空库（模拟用户清空）应放行
writeStore({ version: 1, entries: [] })
check('旗标撤销后允许清空', existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).entries.length === 0)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
