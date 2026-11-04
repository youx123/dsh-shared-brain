#!/usr/bin/env node
/**
 * 修掉 hasInjectionPhrase 的两个真 bug：
 *   1. `.filter(...).join(' ')` 会在**每个字符之间插空格** → 中文短语永远匹配不上
 *      （'忽略上面' 变成 '忽 略 上 面'）→ 注入防护整条失效
 *   2. `'\\u3000'` 在脚本模板里被吃掉一层 → 变成字面量 `\u3000`，全角空格永远不匹配
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'weighted-recall.js')

const src = readFileSync(p, 'utf8')
const lines = src.split('\n')

const start = lines.findIndex((l) => l.includes('function hasInjectionPhrase'))
if (start < 0) throw new Error('找不到 hasInjectionPhrase')

// 找到函数结束（下一个顶格的 } ）
let end = -1
for (let i = start; i < lines.length; i += 1) {
  if (lines[i] === '}') {
    end = i
    break
  }
}
if (end < 0) throw new Error('找不到 hasInjectionPhrase 的结尾')

const replacement = [
  'function hasInjectionPhrase(text) {',
  '  // 注意：这里只是「把连续空白压成一个空格」，**不能**在字符之间插空格 ——',
  '  // 那样中文短语会被拆开，永远匹配不上。',
  '  const raw = String(text ?? "").toLowerCase()',
  '  const flat = raw.replace(/[\\s\\u3000]+/g, " ")',
  '  for (const phrase of INJECTION_PHRASES) {',
  '    if (flat.includes(phrase)) return true',
  '  }',
  '  return false',
  '}',
]

lines.splice(start, end - start + 1, ...replacement)
writeFileSync(p, lines.join('\n'), 'utf8')
console.log(`[ok] weighted-recall.js: hasInjectionPhrase 已重写（${start + 1}-${end + 1}）`)
