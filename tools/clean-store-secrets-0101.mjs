#!/usr/bin/env node
/**
 * 清掉 memory.json / modules.json 里残留的明文凭据。
 *
 * 为什么还要单独清：0.10.1 的 writeStore 收口已经会擦，但**插件还没重新加载**，
 * 没人触发过一次读写 —— 磁盘上那份还是脏的。
 *
 * 做法：**直接在原文上做字符串替换**，不解析、不重新序列化。
 * 这样除了密钥本身，文件的每一个字节（缩进、字段顺序、换行）都不动，
 * 不会因为它跟插件写盘的格式差一个换行就产生满文件 diff。
 *
 * 策略：只替换密钥字符串，不删条目、不动其它字段；替换前先原样备份。
 */
import { readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const DIR = 'C:/Users/13176/.dsh/storages/dsh-shared-brain'

// 跟运行时同一套规则：redactSecrets 的占位符是 '[已脱敏]'
const { SECRET_PATTERNS } = await import('file:///' + join(LIB, 'summarize.js').replace(/\\/g, '/')).catch(() => ({}))

// summarize.js 不一定导出 SECRET_PATTERNS，兜底用同样的几条
const PATTERNS = Array.isArray(SECRET_PATTERNS) && SECRET_PATTERNS.length
  ? SECRET_PATTERNS
  : [
      /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
      /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
      /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
      /\bAKIA[0-9A-Z]{16}\b/g,
      /\bAIza[0-9A-Za-z_-]{30,}/g,
      /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
      /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    ]

const MARK = '[已脱敏]'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
let totalChanges = 0

for (const name of ['memory.json', 'modules.json']) {
  const file = join(DIR, name)
  const raw = readFileSync(file, 'utf8')
  let next = raw
  const hits = []

  for (const pattern of PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    re.lastIndex = 0
    let m
    while ((m = re.exec(next)) !== null) {
      hits.push(`${m[0].slice(0, 6)}…(${m[0].length} 字符)`)
      if (hits.length > 20) break
    }
    re.lastIndex = 0
    next = next.replace(re, MARK)
  }

  if (next === raw) {
    console.log(`  ${name}：已经是干净的 ✅`)
    continue
  }

  const before = raw.length
  const after = next.length
  copyFileSync(file, `${file}.bak-redact-${stamp}`)

  // 原子写：临时文件 + rename（跟插件自己的写盘方式一致，不留「文件不存在」的窗口）
  const tmp = `${file}.tmp-redact`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, file)

  console.log(`  ${name}：命中 ${hits.length} 处 → ${before} 字节变 ${after} 字节（备份 ${name}.bak-redact-${stamp}）`)
  for (const h of hits) console.log(`      ${h}`)
  totalChanges += hits.length
}

console.log(`\n合计脱敏 ${totalChanges} 处`)
