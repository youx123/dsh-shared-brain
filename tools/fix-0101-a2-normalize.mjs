#!/usr/bin/env node
/**
 * 修正批次 A 的一个副作用：normalizeStore 恢复脱敏。
 *
 * 我原先把脱敏从 normalizeStore 里拿掉（因为「读时已脱敏 → cleaned 恒 0 →
 * 磁盘永远明文」），但那等于拆掉了「外部工具绕过写入闸门直接改 memory.json」
 * 这道防线 —— harness 正好有一条断言守着它（normalizeStore 必须擦掉密钥）。
 *
 * 正确解法：
 *   - normalizeStore **保留**脱敏（读入规整就该管这个，它是对外的那道闸）
 *   - readStore 的写回判断改成「拿磁盘原始内容比对」——
 *     以前只看 redactStoreSecrets 的 cleaned，而 normalizeStore 自己先擦了一遍，
 *     cleaned 恒为 0 → 永远不写回 → 磁盘永远明文。现在改成：
 *     只要磁盘上的原文和规整后的内容不一样（说明磁盘里确实有 secret），
 *     就把干净版本写回去。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'store.js')

let src = readFileSync(p, 'utf8')

const from = `        // 2026-11-04（P0-1 审计）：这里**不再**脱敏。
        // 以前 normalizeStore 读的时候就把 secret 抹了，于是 redactStoreSecrets
        // 拿到手时已经干净 → cleaned 恒为 0 → readStore 里那句
        // \`if (cleaned > 0) writeStore(store)\` 永远不触发：
        // 内存干净、磁盘永远明文。
        // 现在脱敏统一由 redactStoreSecrets 负责（writeStore 落盘前也会再兜一层），
        // 所以「读出来是干净的」和「写回去是干净的」是同一件事。
        text: String(item.text).trim().slice(0, 4000),
        tags: Array.isArray(item.tags)
          ? item.tags
              .filter((t) => typeof t === 'string' && t.trim())
              .map((t) => t.trim())
              .slice(0, 12)
          : [],`

const to = `        // 最后一道过道：不管这份记忆是谁写进来的（DSH 自己、Cursor 扩展、别的工具、
        // 甚至有人手改了 memory.json），密钥都不许留在里面。
        //
        // 2026-11-04（P0-1 审计）：这里**继续**脱敏 —— 这是对外的那道闸
        // （外部工具绕过写入闸门直接改 memory.json 时，normalizeStore 是唯一防线）。
        // 审计查到的「磁盘永远明文」不是因为这里脱敏了，而是因为 readStore 的
        // 写回判断看错了指标（cleaned 恒为 0）。那个判断已经改成
        // 「拿磁盘原文比对」，两道防线现在都在。
        text: redactSecrets(String(item.text).trim()).slice(0, 4000),
        tags: Array.isArray(item.tags)
          ? item.tags
              .filter((t) => typeof t === 'string' && t.trim())
              .map((t) => redactSecrets(t.trim()))
              .filter((t) => t !== '[已脱敏]')
              .slice(0, 12)
          : [],`

if (!src.includes(from)) throw new Error('store.js: 找不到 normalizeStore 的锚点')
src = src.replace(from, to)

// readStore 的写回判断：rawHasSecret 现在恒为 false（因为 normalizeStore 已擦），
// 要改成「磁盘原文 vs 擦干净后的内容」逐条比对。
const from2 = `    const { cleaned } = redactStoreSecrets(store)
    const rawHasSecret = store.entries.some((entry) =>
      entry && typeof entry.text === 'string' && entry.text !== (raw.entries?.find?.((r) => r?.id === entry.id)?.text ?? entry.text),
    )
    if (cleaned > 0 || rawHasSecret) {`

const to2 = `    const { cleaned } = redactStoreSecrets(store)
    // 磁盘上还有没有 secret？不能只看 cleaned（normalizeStore 已经先擦了一遍，
    // cleaned 恒为 0）—— 要拿磁盘里的**原文**跟现在这份比：
    // 不一样，就说明磁盘上确实留着凭据，得写回去。
    const rawById = new Map()
    for (const item of Array.isArray(raw.entries) ? raw.entries : []) {
      if (item && typeof item.id === 'string') rawById.set(item.id, item)
    }
    let rawHasSecret = false
    for (const entry of store.entries) {
      if (!entry || typeof entry.text !== 'string') continue
      const original = rawById.get(entry.id)
      if (!original || typeof original.text !== 'string') continue
      if (original.text !== entry.text) {
        rawHasSecret = true
        break
      }
    }
    if (cleaned > 0 || rawHasSecret) {`

if (!src.includes(from2)) throw new Error('store.js: 找不到 readStore 的锚点')
src = src.replace(from2, to2)

writeFileSync(p, src, 'utf8')
console.log('[ok] store.js: normalizeStore 恢复脱敏 + readStore 写回判断改为原文比对')
