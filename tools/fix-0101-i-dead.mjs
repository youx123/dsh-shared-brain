#!/usr/bin/env node
/**
 * E5 / DEAD：把 emotion.js 里两个死代码函数接上，并清掉无用的 import。
 *
 * ① `normalizeEmotionItem`（emotion.js:146）从来没被调用。
 *    它的文档写着「权重 = 亲密度 × 极性强度修正（负向 ×0.9）」，
 *    但实际写入的是 `classification.intimacy` 原值 ——
 *    也就是说这条设计**从来没生效过**，负向情感和正向情感一样重。
 *    现在自动记录情感条目时走一遍它。
 *
 * ② `emotionItemInScope`（emotion.js:193）在 index.js 里 import 了但没调用，
 *    因为 index.js 自己另有一份 `inScope`。删掉这个无用 import。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'

function patchText(file, from, to) {
  const p = join(LIB, file)
  const src = readFileSync(p, 'utf8')
  const count = src.split(from).length - 1
  if (count === 0) throw new Error(`${file}: 找不到锚点 ${JSON.stringify(from.slice(0, 110))}`)
  if (count > 1) throw new Error(`${file}: 锚点出现 ${count} 次`)
  writeFileSync(p, src.replace(from, to), 'utf8')
  console.log(`[ok] ${file}`)
}

// ① 导入 normalizeEmotionItem，顺带摘掉没用的 emotionItemInScope
patchText(
  'index.js',
  `  normalizeMoodConfig,
  emotionItemInScope,
  sameSessionKey,`,
  `  normalizeMoodConfig,
  normalizeEmotionItem,
  sameSessionKey,`,
)

// ② 情感条目写库前走规整函数
patchText(
  'index.js',
  `    store.entries.push(entry)
    if (store.entries.length > MAX_ENTRIES) {`,
  `    // 2026-11-04（E5）：情感条目走 emotion.js 的规整函数。
    // 以前这里直接写 classification.intimacy 原值，emotion.js 文档承诺的
    // 「权重 = 亲密度 × 极性修正（负向 ×0.9）」从来没生效过 ——
    // normalizeEmotionItem 是个从没被调用的死代码。
    // 现在负向情感不再和正向一样重（讨厌类不该比喜欢类更「重要」）。
    let emoNorm = null
    if (moduleKey === 'emotion') {
      emoNorm = normalizeEmotionItem(entry, classification.weight)
      entry.weight = emoNorm.weight
      entry.intimacy = emoNorm.intimacy
      entry.sentiment = emoNorm.sentiment
      entry.target = emoNorm.target
    }
    store.entries.push(entry)
    if (store.entries.length > MAX_ENTRIES) {`,
)

// ③ 模块副本用同一份规整结果，两份存储不能一个有降权一个没有
patchText(
  'index.js',
  `    putModuleItem(modules, moduleKey, {
      text: candidate.text,
      weight: classification.weight,
      // 情感条目的语义字段（亲密度 / 极性 / 对象）——2026-11-02
      ...(moduleKey === 'emotion'
        ? {
            intimacy: classification.intimacy ?? classification.weight,
            sentiment: classification.sentiment ?? 'neutral',
            target: classification.target ?? 'general',
          }
        : {}),`,
  `    putModuleItem(modules, moduleKey, {
      text: candidate.text,
      // 2026-11-04（E5）：用跟扁平库同一份规整结果，
      // 否则模块副本有降权、扁平库没有，两份数据对不上。
      weight: emoNorm ? emoNorm.weight : classification.weight,
      // 情感条目的语义字段（亲密度 / 极性 / 对象）——2026-11-02
      ...(moduleKey === 'emotion'
        ? {
            intimacy: emoNorm ? emoNorm.intimacy : (classification.intimacy ?? classification.weight),
            sentiment: emoNorm ? emoNorm.sentiment : (classification.sentiment ?? 'neutral'),
            target: emoNorm ? emoNorm.target : (classification.target ?? 'general'),
          }
        : {}),`,
)

console.log('[done] E5（normalizeEmotionItem 接线 + 清死 import）完成')
