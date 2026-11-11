import { mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-import-'))
process.env.DSH_HOME = home

const { readStore, writeStore, brainFile } = await import('../lib/store.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log('PASS  ' + name)
  } else {
    fail += 1
    console.log('FAIL  ' + name + '  ' + extra)
  }
}

const now = Date.now()
const entry = {
  id: 'mem_keep_1',
  text: '商（约前 1600-前 1046）有甲骨文，是目前确认的最早成熟汉字体系。',
  module: 'knowledge',
  tags: ['中国历史纲要', '甲骨文'],
  sourceRef: '中国历史纲要',
  sentiment: 'neutral',
  target: '老大',
  owner: 'user',
  intimacy: 0.6,
  hits: 7,
  weight: 0.7,
  lifetime: 'permanent',
  expiresAt: 0,
  pinned: false,
  source: 'sync',
  createdAt: now - 10000,
  updatedAt: now - 10000,
}

writeStore({ version: 1, entries: [entry], updatedAt: now })

// 模拟「外部工具写的 memory.json 不带这些字段」：删掉字段再落盘，并把 mtime 推新
const file = brainFile()
const raw = JSON.parse(readFileSync(file, 'utf8'))
for (const item of raw.entries) {
  delete item.tags
  delete item.sourceRef
  delete item.sentiment
  delete item.target
  delete item.owner
  delete item.intimacy
  delete item.hits
}
raw.updatedAt = now + 1000
writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
const later = new Date(Date.now() + 2000)
utimesSync(file, later, later)

const back = readStore()
const got = back.entries.find((e) => e.id === 'mem_keep_1')

check('条目还在', Boolean(got))
check('标签被保住', Array.isArray(got?.tags) && got.tags.length === 2, JSON.stringify(got?.tags))
check('出处被保住', got?.sourceRef === '中国历史纲要', String(got?.sourceRef))
check('情绪字段被保住', got?.sentiment === 'neutral' && got?.target === '老大', `${got?.sentiment}/${got?.target}`)
check('归属被保住', got?.owner === 'user', String(got?.owner))
check('亲密度被保住', got?.intimacy === 0.6, String(got?.intimacy))
check('命中次数被保住', got?.hits === 7, String(got?.hits))

// 文件里**明确改了**的字段仍然以文件为准
const raw2 = JSON.parse(readFileSync(file, 'utf8'))
raw2.entries[0].text = '商朝有甲骨文（外部改过的正文）。'
raw2.entries[0].tags = ['外部改的标签']
writeFileSync(file, JSON.stringify(raw2, null, 2), 'utf8')
const later2 = new Date(Date.now() + 5000)
utimesSync(file, later2, later2)
const back2 = readStore().entries.find((e) => e.id === 'mem_keep_1')
check('文件里给的新正文生效', String(back2?.text).includes('外部改过的正文'), String(back2?.text))
check('文件里给的新标签没被旧值盖掉', JSON.stringify(back2?.tags) === JSON.stringify(['外部改的标签']), JSON.stringify(back2?.tags))

try {
  rmSync(home, { recursive: true, force: true })
} catch {
  /* Windows 上 SQLite 句柄可能还开着，清不掉就算了 */
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
