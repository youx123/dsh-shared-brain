import { junkReport, junkListing } from '../lib/health.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) } else { fail += 1; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

const NOW = new Date('2026-11-11T12:00:00+08:00').getTime()
const day = 24 * 60 * 60 * 1000

const files = [
  { name: 'graph-probe.json', size: 744000, mtimeMs: NOW - 9 * day },
  { name: 'memory.json.bak-2026-11-01T00-00-00-000Z', size: 300000, mtimeMs: NOW - 10 * day },
  { name: 'modules.json.bak-2026-11-10T00-00-00-000Z', size: 150000, mtimeMs: NOW - 1 * day },
  { name: 'memory-archive.jsonl', size: 7000, mtimeMs: NOW - 2 * day },
  { name: 'brain.db', size: 3300000, mtimeMs: NOW },
]

const junk = junkReport(files, { now: NOW })

check('统计到 4 个可清理', junk.total === 4, String(junk.total))
check('探针被认出来', junk.groups.some((g) => g.kind === 'probe' && g.count === 1))
check('备份合并成一组', junk.groups.find((g) => g.kind === 'backup')?.count === 2)

const lines = junkListing(junk, { now: NOW })
check('给出每一类的行', lines.length === junk.groups.length + 1, String(lines.length))
check('探针行带大小与时间', lines.some((line) => line.includes('调试探针') && line.includes('727KB') && line.includes('9 天前')), lines.join(' | '))
check('时间戳备份行合计两个', lines.some((line) => line.includes('时间戳备份 2 个')), lines.join(' | '))
check('最后一行是合计并说不擅自删', lines[lines.length - 1].includes('合计 4 个') && lines[lines.length - 1].includes('不擅自删'))

const empty = junkReport([], { now: NOW })
check('没有垃圾时给一句人话', junkListing(empty, { now: NOW }).length === 1 && junkListing(empty, { now: NOW })[0].includes('没有可清理'))

check('坏参数不炸', Array.isArray(junkListing(null)))
check('limit 限制行数', junkListing(junk, { now: NOW, limit: 1 }).length === 2)
check('刚动过的显示小时/刚动过', junkListing(junkReport([{ name: 'x.bak-1', size: 1024, mtimeMs: NOW - 3600 * 1000 }], { now: NOW }), { now: NOW })[0].includes('1 小时前'))

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
