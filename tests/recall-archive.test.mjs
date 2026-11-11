/**
 * 归档条目不该出现在召回里（2026-11-11）
 *
 * 背景：召回前会把扁平库条目按「模块桶」形状重建，重建时按白名单逐字段复制。
 * 白名单一度漏了 archived / archivedAt / archiveReason，于是下游的
 * `if (item.archived === true) continue` 永远不成立 —— 归档等于没归档。
 * 这里用临时 DSH_HOME 建库，守两处：模块桶召回 + 扁平召回。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-recall-archive-'))
process.env.DSH_HOME = home

const { writeStore } = await import('../lib/store.js')
const { recallModules } = await import('../lib/weighted-recall.js')
const { recall } = await import('../lib/recall.js')

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`)
  }
}

const now = Date.now()
const base = {
  weight: 0.8,
  lifetime: 'permanent',
  expiresAt: 0,
  ttlMs: 0,
  pinned: false,
  source: 'manual',
  tags: ['将进酒', '李白'],
  hits: 3,
  createdAt: now - 86400000,
  updatedAt: now - 86400000,
}

const alive = { ...base, id: 'mod_alive', module: 'knowledge', text: '李白《将进酒》里那句天生我材必有用。' }
const dead = {
  ...base,
  id: 'mod_dead',
  module: 'knowledge',
  text: '李白《将进酒》里那句天生我材必有用（旧版重复）。',
  archived: true,
  archivedAt: now - 1000,
  archiveReason: 'stale',
}

writeStore({ version: 1, entries: [alive, dead] })

// 模块桶的形状与召回时重建出来的一致（都是归档标记在 item 上）
function modulesWith(items) {
  return {
    knowledge: { enabled: true, weight: 0.7, items },
    bottomline: { enabled: true, weight: 1, items: [] },
    cognition: { enabled: true, weight: 1, items: [] },
    emotion: { enabled: true, weight: 1, items: [] },
    instinct: { enabled: true, weight: 1, items: [] },
  }
}

const result = recallModules(modulesWith([alive, dead]), '李白 将进酒')
const hits = result.hits ?? []
const ids = hits.map((h) => h.id ?? h.item?.id)
check('归档条目不进模块召回', ids.includes('mod_alive'), `实际 ${JSON.stringify(ids)}`)
check('留下的是没归档那条', ids.length === 1 && ids[0] === 'mod_alive', JSON.stringify(ids))

const flat = recall([
  { ...alive },
  { ...dead },
], '李白 将进酒')
const flatIds = (flat ?? []).map((hit) => hit.id ?? hit.entry?.id)
check('归档条目不进扁平召回', flatIds.includes('mod_alive') && !flatIds.includes('mod_dead'), JSON.stringify(flatIds))

// Windows 上 sqlite 句柄还没关干净时 rmSync 会 EPERM；临时目录删不掉不算失败。
try {
  rmSync(home, { recursive: true, force: true })
} catch {
  // 留着也行，系统会自己清 %TEMP%
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
