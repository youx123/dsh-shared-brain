/**
 * 记忆体检（方案 §5.4）：只读统计 + 建议。用固定样本，不碰真实库。
 */
import assert from 'node:assert/strict'
import { memoryCheck, renderCheckLine } from '../lib/health.js'

console.log('== 记忆体检 ==')

const now = Date.UTC(2026, 10, 11, 2, 0, 0)
const day = 24 * 60 * 60 * 1000

const entries = [
  { id: 'a', module: 'cognition', text: '端口 59604', updatedAt: now - day, pinned: false, scope: 'global', source: 'auto' },
  { id: 'b', module: 'cognition', text: '端口 59604', updatedAt: now - day, pinned: false, scope: 'global', source: 'auto' },
  { id: 'c', module: 'knowledge', text: '欲穷千里目，更上一层楼。', sourceRef: '唐宋诗词精选', updatedAt: now - day, scope: 'global', source: 'sync' },
  { id: 'd', module: 'knowledge', text: '没出处的条目', updatedAt: now - day, scope: 'global', source: 'sync' },
  { id: 'e', module: 'bottomline', text: '不删数据', pinned: true, updatedAt: now - 400 * day, scope: 'global', source: 'manual' },
  { id: 'f', module: 'cognition', text: '过期的临时记忆', lifetime: 'temporary', expiresAt: now - day, updatedAt: now - 2 * day, scope: 'workspace', source: 'auto', pinned: false },
  { id: 'g', module: 'cognition', text: '很久以前的一条普通记忆', updatedAt: now - 400 * day, scope: 'global', source: 'sync', pinned: false },
]

const check = memoryCheck({
  entries,
  modules: { bottomline: { items: [{ id: 'e' }] }, knowledge: { items: [] } },
  now,
  walBytes: 2048,
  dbBytes: 1024,
  lastWriteAt: now - day,
})

assert.equal(check.total, 7, '总数')
assert.equal(check.byModule.cognition, 4, '按模块计数')
assert.equal(check.byModule.bottomline, 1, '底线计入扁平库')
assert.equal(check.pinned, 1, '钉住数')
assert.equal(check.expired, 1, '过期数')
assert.equal(check.duplicates.length, 1, '同模块同正文算一组重复')
assert.equal(check.duplicates[0].count, 2, '重复组里两条')
assert.equal(check.noSource, 1, '知识缺出处数')
assert.equal(check.bottomUnmirrored, 0, '底线已镜像')
assert.equal(check.scope.workspace, 1, '作用域统计')
assert.equal(check.source.auto, 3, '来源统计')
assert.ok(check.stale >= 1, '很久没动的算陈旧（钉住的不算）')
assert.deepEqual(check.emptyModules, ['emotion', 'instinct'], '没条目的模块列出来')

const texts = check.suggestions.map((s) => s.text).join('\n')
assert.ok(texts.includes('重复'), '建议里提到重复')
assert.ok(texts.includes('出处'), '建议里提到缺出处')
assert.ok(texts.includes('WAL'), 'WAL 比主库大时提醒')

const line = renderCheckLine(check)
assert.ok(line.includes('共 7 条'), '摘要含总数')
assert.ok(line.includes('重复 1 组'), '摘要含重复')

// 底线没镜像时会提醒
const warn = memoryCheck({
  entries: [{ id: 'x', module: 'cognition', text: 'a', updatedAt: now }],
  modules: { bottomline: { items: [{ id: 'b1', text: 'x' }, { id: 'b2', text: 'y' }] } },
  now,
})
assert.equal(warn.bottomUnmirrored, 2, '底线两条没进扁平库')
assert.ok(warn.suggestions.some((s) => s.level === 'warn'), '有 warn 级提醒')

// 空库也不炸
const empty = memoryCheck({ entries: [], modules: {}, now })
assert.equal(empty.total, 0, '空库总数 0')
assert.ok(empty.suggestions.some((s) => s.level === 'ok'), '空库给个 ok')

console.log('✅ 记忆体检全部通过')
