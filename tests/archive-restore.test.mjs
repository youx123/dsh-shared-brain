/**
 * 归档 → 召回消失 → 已归档列表能看到 → 恢复 → 重新进召回
 * 2026-11-11：界面上「查看已归档 / 全部恢复 / 每条恢复」都在，但服务端这条往返一直没人守。
 * 归档只打标记不删文本；这里同时钉住「恢复之后真的还能被召回」，
 * 免得哪天白名单又把 archived 漏掉，形成第二个「归档等于没归档」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-archive-'))
process.env.DSH_HOME = home

const { writeStore, readStore } = await import('../lib/store.js')
const { mutateModules } = await import('../lib/bridge.js')
const { recallModules } = await import('../lib/weighted-recall.js')

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}`) }
  else { fail += 1; console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

const now = Date.now()
const keepText = '阳台上的茉莉要少浇水'
const goneText = '旧项目已经归档了别再提'
const entries = [keepText, goneText].map((text, i) => ({
  id: `mem_arch_${i + 1}`,
  module: 'cognition',
  text,
  weight: 0.7,
  lifetime: 'permanent',
  expiresAt: 0,
  ttlMs: 0,
  pinned: false,
  source: 'manual',
  tags: [],
  scope: 'global',
  scopePath: '',
  scopeSession: '',
  createdAt: now,
  updatedAt: now,
}))
writeStore({ version: 1, entries })

// 召回用模块桶的形态：扁平库条目按模块归位后要带上 archived 才有意义
const asModules = (store) => ({
  cognition: {
    enabled: true,
    weight: 1,
    items: store.entries
      .filter((e) => e.module === 'cognition')
      .map((e) => ({
        id: e.id, text: e.text, weight: e.weight, lifetime: e.lifetime,
        expiresAt: e.expiresAt, pinned: e.pinned, source: e.source, tags: e.tags,
        archived: e.archived === true, createdAt: e.createdAt, updatedAt: e.updatedAt,
      })),
  },
})

// 注意：recallModules 的 hits 是「命中包」{ module, label, item, score }，条目在 .item 里
const hitIds = (query) => recallModules(asModules(readStore()), query, { limit: 10 }).hits.map((h) => h.item?.id)

// 1. 归档前两条都能召回
check('归档前能召回两条', hitIds('茉莉 旧项目').length === 2)

// 2. 归档一条
const archived = mutateModules({ action: 'archiveItems', ids: ['mem_arch_2'] })
check('归档返回 ok', archived.ok === true, JSON.stringify(archived))
check('归档计数是 1', archived.value?.archived === 1)
const afterArchive = readStore()
check('归档只打标记、文本还在', afterArchive.entries.find((e) => e.id === 'mem_arch_2')?.text === goneText)
check('归档带上了时间戳', Number(afterArchive.entries.find((e) => e.id === 'mem_arch_2')?.archivedAt) > 0)

// 3. 归档后不再进召回
const afterIds = hitIds('茉莉 旧项目')
check('归档后只剩一条', afterIds.length === 1 && afterIds[0] === 'mem_arch_1', afterIds.join(','))

// 4. 已归档列表能查到（界面上「查看已归档」走的这条）
const list = mutateModules({ action: 'searchMemory', query: '', archived: true, limit: 10 })
check('已归档列表能查到它', list.ok === true && list.value.hits.some((h) => h.id === 'mem_arch_2'))
const active = mutateModules({ action: 'searchMemory', query: '', archived: false, limit: 10 })
check('没归档的列表里没有它', !active.value.hits.some((h) => h.id === 'mem_arch_2'))

// 5. 恢复一条（界面每条的「恢复」走这条）
const restored = mutateModules({ action: 'restoreItems', ids: ['mem_arch_2'] })
check('恢复返回 ok', restored.ok === true && restored.value?.restored === 1)
check('恢复后 archived 标记清掉', readStore().entries.find((e) => e.id === 'mem_arch_2')?.archived !== true)

// 6. 恢复后重新进召回
const backIds = hitIds('茉莉 旧项目')
check('恢复后又能召回两条', backIds.length === 2, backIds.join(','))

// 7. 重复归档 / 重复恢复的边界
check('重复恢复报错而不是假装成功', mutateModules({ action: 'restoreItems', ids: ['mem_arch_2'] }).ok === false)
check('空 id 列表报错', mutateModules({ action: 'archiveItems', ids: [] }).ok === false)

try { rmSync(home, { recursive: true, force: true }) } catch { /* Windows 上 sqlite 句柄未释放，忽略 */ }

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
