import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-prune-'))
process.env.DSH_HOME = home

const { readStore, writeStore, pruneExpired, isPrunedText } = await import('../lib/store.js')
const { readModules, writeModules } = await import('../lib/modules.js')
const { recallPreview } = await import('../lib/index.js')

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
const expiredText = '过期的那条：缓存清理脚本放在 D 盘工具目录里。'
const keepText = '长久的那条：每周五整理一次周报。'

const mkEntry = (id, text, overrides = {}) => ({
  id,
  text,
  module: 'cognition',
  tags: [],
  weight: 0.7,
  lifetime: 'permanent',
  expiresAt: 0,
  pinned: false,
  source: 'auto',
  createdAt: now - 60000,
  updatedAt: now - 60000,
  hits: 0,
  ...overrides,
})

// 库里两条：一条已过期、一条长期；模块桶里各留一份副本（桶条目不带到期字段）
writeStore({
  version: 1,
  updatedAt: now,
  entries: [
    mkEntry('mem_exp', expiredText, { lifetime: 'temporary', expiresAt: now - 1000 }),
    mkEntry('mem_keep', keepText),
  ],
})

const modules = readModules()
modules.cognition = modules.cognition ?? {}
modules.cognition.items = [
  { id: 'mod_exp', text: expiredText, weight: 0.7 },
  { id: 'mod_keep', text: keepText, weight: 0.7 },
]
writeModules(modules)

// 走一次真实清理：过期那条被删，并留下「已删正文」指纹
const store = readStore()
const pruned = pruneExpired(store, now)
writeStore(store)
check('过期条目被清掉 1 条', pruned.removed === 1, String(pruned.removed))
check('删掉的正文记了指纹', isPrunedText(expiredText) === true, String(isPrunedText(expiredText)))
check('没删的正文没有指纹', isPrunedText(keepText) === false, String(isPrunedText(keepText)))

// 关键：桶里那份副本不能再把它「复活」
const expiredPreview = recallPreview(expiredText)
check(
  '过期条目没有被桶里的副本复活',
  !expiredPreview.hits.some((hit) => hit.text.includes('缓存清理脚本')),
  JSON.stringify(expiredPreview.hits),
)
check('过期文案不在召回正文里', !String(expiredPreview.rendered ?? '').includes('缓存清理脚本'), String(expiredPreview.rendered ?? '').slice(0, 120))

// 对照：没删的那条照常召回（桶副本也在，但不该被误伤）
const keepPreview = recallPreview(keepText)
check(
  '没删的条目照常召回',
  keepPreview.hits.some((hit) => hit.text.includes('每周五整理一次周报')),
  JSON.stringify(keepPreview.hits),
)

// 手指纹只在「补桶副本」时生效：同文本重新写成长期条目，仍然能被召回
writeStore({
  version: 1,
  updatedAt: Date.now(),
  entries: [mkEntry('mem_exp_again', expiredText)],
})
const again = recallPreview(expiredText)
check(
  '同文本重新存成长期条目后仍可召回',
  again.hits.some((hit) => hit.text.includes('缓存清理脚本')),
  JSON.stringify(again.hits),
)

try {
  rmSync(home, { recursive: true, force: true })
} catch {
  /* Windows 上 SQLite 句柄可能还开着 */
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
