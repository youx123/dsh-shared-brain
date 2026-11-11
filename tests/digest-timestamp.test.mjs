/**
 * 回归：云端同步每轮把 updatedAt 往前推、正文没变 —— 不该触发整份重导。
 * 旧指纹把 updatedAt 算进去了，实测每轮都会重写一遍 SQLite。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-digest-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'storages', 'dsh-shared-brain'), { recursive: true })

const lib = new URL('../lib/', import.meta.url).pathname
const { writeStore, readStore } = await import(`${lib}store.js`)
const { readAllEntries } = await import(`${lib}db.js`)

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

const base = Date.now()
const mk = (id, text, updatedAt) => ({
  id,
  module: 'cognition',
  text,
  tags: ['测试'],
  weight: 0.5,
  lifetime: 'permanent',
  expiresAt: 0,
  pinned: false,
  source: 'sync',
  createdAt: base,
  updatedAt,
})

writeStore({ version: 1, updatedAt: base, entries: [mk('a', '第一条内容', base), mk('b', '第二条内容', base)] })
check('写入两条', readStore().entries.length === 2, String(readStore().entries.length))

// 模拟云端同步：只把 updatedAt 推后 100 秒，正文一字不动，文件 mtime 更新
const json = JSON.parse((await import('node:fs')).readFileSync(join(home, 'storages', 'dsh-shared-brain', 'memory.json'), 'utf8'))
json.entries = json.entries.map((e) => ({ ...e, updatedAt: base + 100_000 }))
writeFileSync(join(home, 'storages', 'dsh-shared-brain', 'memory.json'), JSON.stringify(json, null, 2))

const logs = []
const realWarn = console.warn
console.warn = (...args) => logs.push(args.join(' '))
const after = readStore()
console.warn = realWarn

const joined = logs.join('\n')
check('条数没变', after.entries.length === 2, String(after.entries.length))
check('没打「已导入」', !joined.includes('已导入'), joined)
check('打的是「跳过整份导入」或干脆没说', joined.includes('跳过整份导入') || joined === '', joined)
check('库里的 updatedAt 没被无意义地推后', readAllEntries().every((e) => Number(e.updatedAt) === base), JSON.stringify(readAllEntries().map((e) => e.updatedAt)))

// 正文真变了，必须导入
json.entries[0].text = '第一条内容（改过）'
writeFileSync(join(home, 'storages', 'dsh-shared-brain', 'memory.json'), JSON.stringify(json, null, 2))
const logs2 = []
console.warn = (...args) => logs2.push(args.join(' '))
const after2 = readStore()
console.warn = realWarn
check('正文变了会导入', after2.entries.some((e) => e.text === '第一条内容（改过）'), after2.entries.map((e) => e.text).join('|'))
check('真变化时打「已导入」', logs2.join('\n').includes('已导入'), logs2.join('\n'))

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
try { rmSync(home, { recursive: true, force: true }) } catch { /* Windows 上可能被占用，忽略 */ }
process.exit(fail === 0 ? 0 : 1)
