#!/usr/bin/env node
/**
 * P1-7 收尾：放宽到 sync 之后，工作日志会混进「待办线索」。
 *
 * 实测：放宽后能选中 1 条（只认 manual 时是 0 条），而那 1 条是本鱼自己的
 * 工作日志（跨机同步时 source 被刷成 'sync'，看不出它原本是 'auto'）。
 * 这正是 0.9.8 修过的「内部日志偷偷决定对老大说什么」那类问题。
 *
 * 改法：待办线索除了看 source，还要过一遍 summarize.js 的
 * `isWorthRemembering` —— 助手过程播报那类文本直接不要。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'index.js')
let src = readFileSync(p, 'utf8')

// ① 导入 isWorthRemembering（看现有 summarize 导入里有什么）
const importLine = src.split('\n').find((l) => l.includes("from './summarize.js'"))
if (!importLine) throw new Error('找不到 summarize.js 的导入行')

if (importLine.includes('isWorthRemembering')) {
  console.log('[skip] isWorthRemembering 已经导入了')
} else {
  // 单行导入 / 多行导入都处理
  if (importLine.includes('{') && importLine.includes('}')) {
    src = src.replace(importLine, importLine.replace('{', '{ isWorthRemembering,'))
  } else {
    // 形如 import * as X from './summarize.js'
    throw new Error('summarize 导入不是解构形式，手动处理: ' + importLine)
  }
  writeFileSync(p, src, 'utf8')
  console.log('[ok] 导入 isWorthRemembering')
}

// ② 待办过滤多一道「是不是值得记的东西」
const from = `      if (entry.source !== 'manual' && entry.source !== 'sync') continue
      const text = entry.text.trim()
      if (!text) continue`
const to = `      if (entry.source !== 'manual' && entry.source !== 'sync') continue
      const text = entry.text.trim()
      if (!text) continue
      // 2026-11-04（P1-7 补）：source 放宽到 sync 之后，跨机同步过来的
      // **本鱼自己的工作日志**（原本是 auto，同步时 source 被刷成 sync）
      // 也会被当成老大交代的待办 —— 实测能选中 1 条。
      // 这正是 0.9.8 修过的「内部日志偷偷决定对老大说什么」那类问题。
      // 再加一道：助手过程播报（「找到关键线索了」「现在就改」…）不算待办。
      if (!isWorthRemembering(text)) continue`

const count = src.split(from).length - 1
if (count !== 1) throw new Error(`锚点出现 ${count} 次`)
src = src.replace(from, to)
writeFileSync(p, src, 'utf8')
console.log('[ok] pendingHintsOf 加 isWorthRemembering 过滤')
