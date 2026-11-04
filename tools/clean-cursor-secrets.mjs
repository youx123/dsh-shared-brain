#!/usr/bin/env node
/**
 * 清掉 Cursor 侧那份镜像里的明文凭据。
 *
 * 为什么清它：`.dsh/storages/*.json` 清了两遍都回来了 —— 根因不在 DSH 这边，
 * 而是 Cursor 桥接每 10 分钟会把 `~/.cursor/rules/shared-brain/**` 的 .mdc
 * 当「Cursor 侧的变更」导回 DSH。那份 mdc 里躺着明文，于是清一次回来一次。
 *
 * 做法：跟清 storages 一样 —— **原文逐条字符串替换**，不重新序列化。
 * frontmatter 的字段顺序、换行、正文排版全部保持原样，只把凭据换成占位符。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'

const summarize = await import('file:///' + LIB.replace(/\\/g, '/') + '/summarize.js')
const MARK = '[已脱敏]'

// 直接借运行时那套规则，保证跟插件自己擦的口径一致
function redact(text) {
  return summarize.redactSecrets(text)
}

const FILES = [
  'C:/Users/13176/.cursor/rules/shared-brain/cognition/ub_mvsw05pf_sjmnz.mdc',
]

let total = 0
for (const file of FILES) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    console.log(`  跳过（读不到）：${file} — ${error.message}`)
    continue
  }
  const next = redact(raw)
  if (next === raw) {
    console.log(`  干净：${file}`)
    continue
  }
  // 数一下换掉了几处：按 ghp_/sk- 开头的形状粗算，避免依赖内部实现
  const before = (raw.match(/\b(?:ghp|gho|github_pat|sk-ant|sk-proj|AKIA)[A-Za-z0-9_-]{8,}/g) || []).length
  writeFileSync(file, next, 'utf8')
  total += before || 1
  console.log(`  ${file}：${before} 处 → 已换 ${MARK}（${raw.length} → ${next.length} 字节）`)
}

console.log(`\n合计处理 ${total} 处。`)
