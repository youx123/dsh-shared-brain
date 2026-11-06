#!/usr/bin/env node
// 在 audit-0101.test.mjs 的汇总打印之前插入 E5 两条测试
import { readFileSync, writeFileSync } from 'node:fs'

const p = 'C:/Users/13176/Documents/dsh-shared-brain-patches/tests/audit-0101.test.mjs'
const lines = readFileSync(p, 'utf8').split('\n')

// 找到汇总打印那一行（按前缀找，别用模板串匹配）
const idx = lines.findIndex((l) => l.startsWith('process.stdout.write(') && l.includes('pass'))
if (idx < 0) throw new Error('找不到汇总打印行')

const block = [
  '// ─────────────────────────────────────────────────────────────',
  "console.log('== E5 / DEAD：死代码接线 ==')",
  '// ─────────────────────────────────────────────────────────────',
  '',
  "test('normalizeEmotionItem：负向情感按 0.9 降权（这条设计以前从没生效过）', () => {",
  "  const like = E.normalizeEmotionItem({ text: '老大喜欢吃鱼', sentiment: 'like', intimacy: 0.8 })",
  "  const hate = E.normalizeEmotionItem({ text: '老大讨厌啰嗦', sentiment: 'dislike', intimacy: 0.8 })",
  "  assert.equal(like.weight, 0.8, '正向不打折')",
  "  assert.equal(hate.weight, 0.72, '负向 ×0.9')",
  "  assert.equal(hate.intimacy, 0.8, '亲密度本身不变')",
  '})',
  '',
  "test('normalizeEmotionItem：亲密度才是权重来源，不是通用置信度', () => {",
  "  const item = E.normalizeEmotionItem({ text: '老大在意进度', sentiment: 'care', intimacy: 0.35, weight: 0.9 })",
  "  assert.equal(item.intimacy, 0.35, 'intimacy 优先于 weight')",
  "  assert.equal(item.weight, 0.35, '权重跟着亲密度走')",
  '})',
  '',
]

// 往回退一行空行，让新块和汇总之间保持一个空行
lines.splice(idx, 0, ...block)
writeFileSync(p, lines.join('\n'), 'utf8')
console.log(`[ok] 在 ${idx + 1} 行前插入 E5 两条测试`)
