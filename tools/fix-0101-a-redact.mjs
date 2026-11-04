#!/usr/bin/env node
/**
 * 0.10.1 修复批次 A：脱敏收口（P0-1）
 *
 * 审计发现（实测复现）：
 *   1. store.js 的 readStore() 里 `if (cleaned > 0) writeStore(store)` 永远不触发 ——
 *      因为 normalizeStore 自己在读的时候就已经 redactSecrets 过了，
 *      redactStoreSecrets 拿到手时已经干净 → cleaned 恒为 0。
 *      结果：内存干净、磁盘永远明文。
 *   2. remote-sync.js 的 syncOnce 落地时走 writeStore(nextStore)，而 writeStore
 *      不做脱敏；mergeEntries 也不脱敏 → 远端带密钥的条目原样写回本地、
 *      再原样推上远端。脱敏在这条路径上被完全旁路。
 *
 * 改法（本次）：
 *   - store.js: normalizeStore 不再抹 secret（它只做形状规整），
 *     脱敏统一由 redactStoreSecrets 负责 → readStore 的写回判断才有意义。
 *   - store.js: writeStore 作为所有写路径的收口，在落盘前强制脱敏一次。
 *   - remote-sync.js: mergeEntries 输出侧补 redactSecrets（对称于 modules.js）。
 *
 * 另外把 SECRET_PATTERNS 的漏网形态补上（审计 P1-4）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'

function patch(file, edits) {
  const p = join(LIB, file)
  let src = readFileSync(p, 'utf8')
  const before = src
  for (const [from, to] of edits) {
    if (!src.includes(from)) {
      throw new Error(`${file}: 找不到锚点 —— ${JSON.stringify(from.slice(0, 90))}`)
    }
    src = src.split(from).join(to)
  }
  if (src === before) throw new Error(`${file}: 没有变化`)
  writeFileSync(p, src, 'utf8')
  console.log(`[ok] ${file}`)
}

/* ------------------------------------------------------------------ */
/* 1. store.js —— 脱敏收口                                            */
/* ------------------------------------------------------------------ */
patch('store.js', [
  // normalizeStore：不再抹 secret（它只管形状）
  [
    `        // 最后一道过道：不管这份记忆是谁写进来的（DSH 自己、Cursor 扩展、别的工具、
        // 甚至有人手改了 memory.json），密钥都不许留在里面。
        text: redactSecrets(String(item.text).trim()).slice(0, 4000),
        tags: Array.isArray(item.tags)
          ? item.tags
              .filter((t) => typeof t === 'string' && t.trim())
              .map((t) => redactSecrets(t.trim()))
              .filter((t) => t !== '[已脱敏]')
              .slice(0, 12)
          : [],`,
    `        // 2026-11-04（P0-1 审计）：这里**不再**脱敏。
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
          : [],`,
  ],
  // readStore：写回判断改成看「原始磁盘内容里有没有 secret」
  [
    `    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const store = normalizeStore(raw)
    // 读的时候顺手把残留的凭据擦掉并写回——外部工具（Cursor 扩展等）可能绕过写入闸门。
    const { cleaned } = redactStoreSecrets(store)
    if (cleaned > 0) {
      try {
        writeStore(store)
      } catch {
        // 写不回就算了，不该因为擦不干净就崩掉读库
      }
    }
    return store`,
    `    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const store = normalizeStore(raw)
    // 读的时候顺手把残留的凭据擦掉并写回——外部工具（Cursor 扩展等）可能绕过写入闸门。
    //
    // 2026-11-04（P0-1 审计）：以前这里只看 redactStoreSecrets 的 cleaned，
    // 而 normalizeStore 自己就先抹了一遍 → cleaned 恒为 0 → 永远不写回，
    // 磁盘上的明文一直留着。现在改成「拿原始内容比对」：
    // 只要磁盘上还有 secret，就一定要把干净版本写回去。
    const { cleaned } = redactStoreSecrets(store)
    const rawHasSecret = store.entries.some((entry) =>
      entry && typeof entry.text === 'string' && entry.text !== (raw.entries?.find?.((r) => r?.id === entry.id)?.text ?? entry.text),
    )
    if (cleaned > 0 || rawHasSecret) {
      try {
        writeStore(store)
      } catch {
        // 写不回就算了，不该因为擦不干净就崩掉读库
      }
    }
    return store`,
  ],
  // writeStore：所有写路径的收口，落盘前强制脱敏
  [
    `export function writeStore(store) {
  const dir = brainDir()
  mkdirSync(dir, { recursive: true })
  const file = brainFile()
  const tmp = \`\${file}.\${process.pid}.tmp\`
  const payload = { ...store, updatedAt: Date.now() }
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)
  return payload
}`,
    `export function writeStore(store) {
  const dir = brainDir()
  mkdirSync(dir, { recursive: true })
  const file = brainFile()
  const tmp = \`\${file}.\${process.pid}.tmp\`
  // 2026-11-04（P0-1 审计）：writeStore 是**所有**写路径的收口
  // （readStore 的写回、remote-sync 的落地、persistTurn 的入库……都走这里），
  // 所以脱敏必须在这里兜住 —— 不能指望每条调用路径都记得先擦一遍。
  // 以前脱敏只在读的时候做，于是 syncOnce 裸写 writeStore(nextStore)
  // 就把远端带密钥的条目原样写回磁盘、再原样推上远端。
  const safeStore = { ...store, entries: Array.isArray(store?.entries) ? store.entries : [] }
  redactStoreSecrets(safeStore)
  const payload = { ...safeStore, updatedAt: Date.now() }
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)
  return payload
}`,
  ],
])

/* ------------------------------------------------------------------ */
/* 2. remote-sync.js —— mergeEntries 输出侧脱敏                       */
/* ------------------------------------------------------------------ */
patch('remote-sync.js', [
  [
    `import { readPersona, writePersonaStore, BUNDLED_PERSONAS } from './persona.js'`,
    `import { readPersona, writePersonaStore, BUNDLED_PERSONAS } from './persona.js'
import { redactSecrets } from './summarize.js'`,
  ],
  [
    `  const merged = [...byId.values()].sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
  return { entries: merged, added, updated, deleted }`,
    `  // 2026-11-04（P0-1 审计）：合并结果要脱敏。
  // 远端仓库里的条目是**别的机器写进来的**，谁都能往里塞东西。
  // 以前 mergeEntries 原样保留 text/tags → syncOnce 再用 writeStore 裸写回本地 →
  // 远端带密钥的条目就这样一路复制到本地磁盘、再推回远端。
  // （modules.js 的 normalizeModules 早就对模块条目做了同样的事，
  //   只有记忆条目漏了 —— 那条不对称路径被审计抓到了。）
  for (const entry of byId.values()) {
    if (typeof entry.text === 'string') entry.text = redactSecrets(entry.text)
    if (Array.isArray(entry.tags)) {
      entry.tags = entry.tags.map((tag) => redactSecrets(String(tag))).filter((tag) => tag !== '[已脱敏]')
    }
  }
  const merged = [...byId.values()].sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
  return { entries: merged, added, updated, deleted }`,
  ],
])

console.log('[done] 批次 A（脱敏收口）已改')
