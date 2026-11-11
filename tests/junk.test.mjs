/**
 * 目录卫生统计：只统计，不删。
 * 这条测试同时守住一件事——junkReport 是纯函数，不会碰磁盘。
 */
import { junkReport, memoryCheck, renderCheckLine } from '../lib/health.js'

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

const now = 1_700_000_000_000

const files = [
  { name: 'brain.db', size: 3_000_000, mtimeMs: now },
  { name: 'graph.json', size: 3_800_000, mtimeMs: now - 1000 },
  { name: 'graph-probe.json', size: 744_237, mtimeMs: now - 8 * 24 * 3600 * 1000 },
  { name: 'memory.json.bak-retag-2026-11-11T02-32-30-614Z', size: 344_819, mtimeMs: now - 60_000 },
  { name: 'brain.db.bak-retag-2026-11-11T02-32-30-614Z', size: 3_375_104, mtimeMs: now - 60_000 },
  { name: 'memory.json.broken-1700000000000', size: 2048, mtimeMs: now - 3600_000 },
  { name: 'memory-archive.jsonl', size: 4096, mtimeMs: now - 7200_000 },
  { name: 'modules.json', size: 278_000, mtimeMs: now },
]

const report = junkReport(files, { now })

check('总条数只算垃圾（探针/备份/坏文件/归档）', report.total === 5, String(report.total))
const kinds = report.groups.map((g) => g.kind).sort().join(',')
check('四类都识别到', kinds === 'archive,backup,broken,probe', kinds)
const backup = report.groups.find((g) => g.kind === 'backup')
check('备份两条、字节数相加', backup.count === 2 && backup.bytes === 344_819 + 3_375_104, JSON.stringify(backup))
check('干净文件不算进去', !report.groups.some((g) => g.examples.includes('brain.db')), '')
check('探针脚本算陈旧（8 天）', report.groups.find((g) => g.kind === 'probe').stale === true, '')
check('刚生成的备份不算陈旧', backup.stale === false, '')

check('空输入不炸', junkReport([], { now }).total === 0, '')
check('非数组不炸', junkReport(null, { now }).total === 0, '')
check('缺字段的文件跳过', junkReport([{ size: 1 }], { now }).total === 0, '')

// 接进体检：一行摘要要带「可清理」
const base = memoryCheck({ entries: [{ id: 'a', module: 'cognition', text: '一句话', updatedAt: now }], modules: {}, now, files })
const line = renderCheckLine(base)
check('体检行带上可清理', line.includes('可清理 5 个'), line)
check('体检结果里带 junk 明细', base.junk && base.junk.groups.length === 4, JSON.stringify(base.junk?.groups?.map((g) => g.kind)))

const noJunk = renderCheckLine(memoryCheck({ entries: [], modules: {}, now, files: [] }))
check('没垃圾时不显示可清理', !noJunk.includes('可清理'), noJunk)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
