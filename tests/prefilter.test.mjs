/**
 * 召回预筛（方案 B 批）：候选排序按「命中词的稀有度」而不是「命中词数」。
 * 用临时 DSH_HOME 建库，不碰真实数据。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-prefilter-'))
process.env.DSH_HOME = home

const { writeStore } = await import('../lib/store.js')
const { candidatesByTerms } = await import('../lib/db.js')

console.log('== 召回预筛 ==')

const now = Date.now()
const base = {
  weight: 0.7,
  lifetime: 'permanent',
  expiresAt: 0,
  ttlMs: 0,
  pinned: false,
  source: 'auto',
  tags: [],
  createdAt: now,
  updatedAt: now,
}

// 一条稀有条目：只含「李白」
const rare = { ...base, id: 'rare', module: 'knowledge', text: '李白《将进酒》。', updatedAt: now - 1000 }

// 20 条常见条目：都反复出现「记忆」，而且都很长、更新时间更新
const common = Array.from({ length: 20 }, (_, i) => ({
  ...base,
  id: `common-${i}`,
  module: 'cognition',
  text: `关于记忆的说明第 ${i} 条，里面反复出现记忆这个词，长度也足够长，容易挤进候选前列。`,
  updatedAt: now,
}))

writeStore({ version: 1, entries: [rare, ...common], updatedAt: now })

const both = candidatesByTerms(['李白', '记忆'], { limit: 5 })
assert.ok(both.length > 0, '应该有候选')
assert.equal(both[0].id, 'rare', `稀有条目应排第一，实际 ${both[0].id}`)

const onlyCommon = candidatesByTerms(['记忆'], { limit: 3 })
assert.equal(onlyCommon.length, 3, 'limit 生效')
assert.ok(onlyCommon.every((e) => e.id.startsWith('common')), '只查常见词时只该返回常见条目')

const none = candidatesByTerms([], { limit: 5 })
assert.equal(none.length, 0, '空查询返回空')

// 长词不炸：整串传进来会再过一遍分词
const long = candidatesByTerms(['将进酒'], { limit: 5 })
assert.ok(long.some((e) => e.id === 'rare'), '整串查询也能命中')

// Windows 上 sqlite 句柄还没关，删目录会 EPERM —— 清不掉就算了，临时目录不碍事。
try {
  rmSync(home, { recursive: true, force: true })
} catch {
  /* 忽略 */
}
console.log('✅ 召回预筛全部通过')
