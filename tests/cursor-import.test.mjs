import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-cursor-import-'))
const rulesDir = join(home, 'cursor-rules')
const coordDir = join(home, 'coord')
process.env.DSH_HOME = home
process.env.DSH_SHARED_BRAIN_CURSOR_RULES = rulesDir
process.env.DSH_SHARED_BRAIN_CURSOR_BRAIN = coordDir

const lib = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const store = await import(`file:///${lib}/store.js`)
const cross = await import(`file:///${lib}/cross-sync.js`)

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

const ruleFile = join(rulesDir, 'memory', 'note.mdc')
mkdirSync(join(rulesDir, 'memory'), { recursive: true })

function writeRule(body, updatedAt) {
  writeFileSync(ruleFile, `---\nmodule: cognition\nupdatedAt: ${updatedAt}\n---\n${body}\n`, 'utf8')
}

/** 让 shouldDshReact() 认为 Cursor 侧有新东西 */
function armCursor(generation) {
  mkdirSync(coordDir, { recursive: true })
  writeFileSync(join(coordDir, 'sync-coordinator.json'), JSON.stringify({
    version: 1, generation, dshApplied: generation - 1, writer: null, writerAt: 0, suppressWatchUntil: 0,
  }), 'utf8')
}

const only = () => {
  const es = store.readStore().entries
  return es.length === 1 ? es[0] : null
}

// 1) 首次导入：正文进来、时间戳沿用 Cursor 的
writeRule('正文A：先记一条。', 1_700_000_000_000)
armCursor(1)
const r1 = cross.importFromCursorRules()
check('首次导入 merged=1', r1.ok === true && r1.merged === 1, JSON.stringify(r1))
check('正文进来了', only()?.text === '正文A：先记一条。', only()?.text)
check('时间戳用 Cursor 的', only()?.updatedAt === 1_700_000_000_000, String(only()?.updatedAt))
check('指纹文件已写', existsSync(join(coordDir, 'cursor-sync-state.json')))

// 2) 只是碰了下文件（正文没变、时间戳变新）→ 不重导、不推 updatedAt
const before = only()?.updatedAt
writeRule('正文A：先记一条。', 1_700_000_500_000)
armCursor(2)
const r2 = cross.importFromCursorRules()
check('内容没变 → merged=0', r2.ok === true && r2.merged === 0, JSON.stringify(r2))
check('内容没变 → updatedAt 没被推新', only()?.updatedAt === before, String(only()?.updatedAt))

// 3) 正文真变了 → 导入
writeRule('正文B：改过了。', 1_700_000_900_000)
armCursor(3)
const r3 = cross.importFromCursorRules()
check('正文变了 → merged=1', r3.ok === true && r3.merged === 1, JSON.stringify(r3))
check('正文已更新', only()?.text === '正文B：改过了。', only()?.text)
check('时间戳跟着更新', only()?.updatedAt === 1_700_000_900_000, String(only()?.updatedAt))

// 4) 本机改过正文、Cursor 又发同一条旧内容 → 不能盖回去
const edited = only()
edited.text = '本机改的版本。'
edited.updatedAt = Date.now() + 5_000
store.writeStore({ version: 1, updatedAt: Date.now(), entries: [edited] })
writeRule('正文B：改过了。', Date.now() + 10_000)
armCursor(4)
const r4 = cross.importFromCursorRules()
check('Cursor 旧内容不覆盖本机改动', only()?.text === '本机改的版本。', only()?.text)
check('这种情况 merged=0', r4.merged === 0, JSON.stringify(r4))

// 5) Cursor 时钟快得离谱（快 1 小时）→ 时间戳要夹到现在附近
writeRule('正文C：时钟快了。', Date.now() + 3_600_000)
armCursor(5)
const r5 = cross.importFromCursorRules()
check('离谱时间戳仍能导入', r5.merged === 1, JSON.stringify(r5))
check('时间戳被夹到 1 分钟内', only()?.updatedAt <= Date.now() + 60_000, String(only()?.updatedAt))
check('正文是 C 版', only()?.text === '正文C：时钟快了。', only()?.text)

// 6) 条目被删掉后，指纹也跟着清掉
store.writeStore({ version: 1, updatedAt: Date.now(), entries: [] })
writeRule('正文D：新的一条。', Date.now())
armCursor(6)
cross.importFromCursorRules()
const state = JSON.parse(readFileSync(join(coordDir, 'cursor-sync-state.json'), 'utf8'))
const ids = new Set(store.readStore().entries.map((e) => e.id))
const rules = state.rules ?? {}
const orphans = Object.entries(rules).filter(([, rec]) => !ids.has(rec?.entryId))
check('没有孤儿指纹', orphans.length === 0, JSON.stringify(orphans))

try {
  rmSync(home, { recursive: true, force: true })
} catch {
  // 临时目录清不掉无所谓
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
