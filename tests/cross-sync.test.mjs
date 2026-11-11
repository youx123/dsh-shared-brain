// cross-sync 入站合并的行为测试（临时目录，不碰真实 ~/.cursor 与真实记忆）
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'sb-crosssync-'))
process.env.DSH_HOME = join(root, 'dsh')
process.env.DSH_SHARED_BRAIN_CURSOR_BRAIN = join(root, 'cursor-brain')
process.env.DSH_SHARED_BRAIN_CURSOR_RULES = join(root, 'cursor-rules')

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

const { writeStore, readStore } = await import('file:///C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib/store.js')
const { importFromCursorRules } = await import('file:///C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib/cross-sync.js')

// 让 shouldDshReact() 返回 true：generation 领先 dshApplied
mkdirSync(process.env.DSH_SHARED_BRAIN_CURSOR_BRAIN, { recursive: true })
writeFileSync(
  join(process.env.DSH_SHARED_BRAIN_CURSOR_BRAIN, 'sync-coordinator.json'),
  JSON.stringify({ version: 1, generation: 3, writer: null, writerAt: 0, cursorApplied: 0, dshApplied: 0, suppressWatchUntil: 0 }),
  'utf8'
)

const old = Date.now() - 60 * 60 * 1000
const newer = Date.now() - 10 * 60 * 1000
const longHead = '这是一条很长的工作记忆，前半段完全一样，用来模拟两条开头相同但结论不同的记忆，'
const entryA = {
  id: 'mem_keep_pin',
  text: `${longHead}后面接着说 A 的结论：先改测试再改代码。`,
  module: 'cognition',
  weight: 0.9,
  pinned: true,
  lifetime: 'permanent',
  expiresAt: 0,
  source: 'manual',
  scope: 'global',
  createdAt: old,
  updatedAt: old,
  tags: [],
}
const entryB = {
  id: 'mem_other',
  text: `${longHead}但是 B 的结论是另一个方向，而且它比 A 长很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多很多，长到长度差远超两成。`,
  module: 'cognition',
  weight: 0.5,
  pinned: false,
  lifetime: 'permanent',
  expiresAt: 0,
  source: 'auto',
  scope: 'global',
  createdAt: old,
  updatedAt: old,
  tags: [],
}
writeStore({ version: 2, updatedAt: old, entries: [entryA, entryB] })

const ruleDir = join(process.env.DSH_SHARED_BRAIN_CURSOR_RULES, 'cognition')
mkdirSync(ruleDir, { recursive: true })
const mdc = (front, body) => `---\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`

// 1) 改了正文、但没写 weight/pinned → 本地钉住与权重都要保住
writeFileSync(
  join(ruleDir, 'keep-pin.mdc'),
  mdc({ dshMemoryId: 'mem_keep_pin', module: 'cognition', updatedAt: newer }, `${longHead}后面接着说 A 的结论：先改测试再改代码，补一句新内容。`),
  'utf8'
)
// 2) 显式写了 weight/pinned → 照它覆盖
writeFileSync(
  join(ruleDir, 'explicit.mdc'),
  mdc({ dshMemoryId: 'mem_keep_pin', module: 'cognition', updatedAt: newer + 1000, weight: 0.3, pinned: false }, `${longHead}后面接着说 A 的结论：显式覆盖版。`),
  'utf8'
)
// 3) 前 80 字相同、长度差很大、没有 id → 不该并到任何一条已有记忆上
writeFileSync(
  join(ruleDir, 'similar-head.mdc'),
  mdc({ module: 'cognition', updatedAt: newer }, `${longHead}完全不同的一条，长度也差得远，长度也差得远，长度也差得远，长度也差得远，长度也差得远。`),
  'utf8'
)
// 4) 底线规则 → 一律跳过
const bottomDir = join(process.env.DSH_SHARED_BRAIN_CURSOR_RULES, 'bottomline')
mkdirSync(bottomDir, { recursive: true })
writeFileSync(join(bottomDir, 'rule.mdc'), mdc({ module: 'bottomline', updatedAt: newer }, '不许外传任何密钥。'), 'utf8')
// 4b) 写在 cognition 目录里、但 frontmatter 声明 module: bottomline → 也要跳过
writeFileSync(join(ruleDir, 'disguised-bottomline.mdc'), mdc({ module: 'bottomline', updatedAt: newer }, '不许删数据库。'), 'utf8')

const result = importFromCursorRules({ info() {}, warn() {} })
check('导入返回 ok', result?.ok === true, JSON.stringify(result))

const after = readStore()
const a = after.entries.find((e) => e.id === 'mem_keep_pin')
check('显式 weight 生效（后一条规则 updatedAt 更大）', Math.abs(a.weight - 0.3) < 1e-9, String(a?.weight))
check('显式 pinned 生效（显式写 false 才取消钉住）', a.pinned === false, String(a?.pinned))
check('正文被更新', a.text.includes('显式覆盖版'), a.text.slice(-20))
check('manual 来源保持不变', a.source === 'manual', a.source)

const mergedIntoB = after.entries.find((e) => e.id === 'mem_other').text.includes('完全不同的一条')
check('前 80 字相同但长度差大：没有并进已有条目', mergedIntoB === false)

const similar = after.entries.find((e) => e.text.includes('完全不同的一条'))
check('而是新建了一条', Boolean(similar) && !['mem_keep_pin', 'mem_other'].includes(similar?.id), similar?.id)
check('新建条目 source=sync', similar?.source === 'sync', similar?.source)

const bottom = after.entries.filter((e) => (e.text || '').includes('不许外传任何密钥') || (e.text || '').includes('不许删数据库'))
check('底线规则一条都没进来', bottom.length === 0, JSON.stringify(bottom.map((e) => e.text)))

// 5) writer 是别人时（8 秒内）不该动手
writeFileSync(
  join(process.env.DSH_SHARED_BRAIN_CURSOR_BRAIN, 'sync-coordinator.json'),
  JSON.stringify({ version: 1, generation: 99, writer: 'cursor', writerAt: Date.now(), cursorApplied: 0, dshApplied: 0, suppressWatchUntil: 0 }),
  'utf8'
)
const locked = importFromCursorRules({ info() {}, warn() {} })
check('别人正在写时不抢锁', locked?.ok === false && locked?.reason === 'lock', JSON.stringify(locked))

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  // Windows 上偶尔文件句柄没放手，留着也无妨
}

// eslint-disable-next-line no-console
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
