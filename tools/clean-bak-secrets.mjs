#!/usr/bin/env node
/**
 * 把存储目录里 .bak-* 备份文件中的明文凭据替换成占位符。
 *
 * 为什么不直接删：这些是 memory.json / modules.json 的历史备份，
 * 删掉就没了。只做「脱敏」这一步，其余内容一个字节都不动。
 *
 * 用插件自己的 redactSecrets —— 保证跟运行时擦除的口径完全一致。
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const DIR = process.env.SB_STORAGE || 'C:/Users/13176/.dsh/storages/dsh-shared-brain'

const { redactSecrets, hasSecret } = await import(
  'file:///' + join(LIB, 'summarize.js').replace(/\\/g, '/')
)

const files = readdirSync(DIR).filter((name) => name.includes('.bak'))
let touched = 0
let skipped = 0

for (const name of files) {
  const p = join(DIR, name)
  let raw
  try {
    if (!statSync(p).isFile()) continue
    raw = readFileSync(p, 'utf8')
  } catch {
    skipped += 1
    continue
  }
  if (!hasSecret(raw)) {
    console.log(`  -  ${name}（干净）`)
    continue
  }
  const before = raw.length
  const after = redactSecrets(raw)
  // 安全检查：长度变化必须很小（只换了 token），否则说明正则误伤了正文
  const delta = before - after.length
  if (delta > 2000) {
    throw new Error(`${name}: 脱敏后短了 ${delta} 字节，疑似误伤，已中止`)
  }
  // 写之前再确认一次：脱敏后确实没有 secret 了
  if (hasSecret(after)) {
    console.log(`  !  ${name}：仍残留 secret（形态可能未被覆盖），未写入`)
    skipped += 1
    continue
  }
  writeFileSync(p, after, 'utf8')
  touched += 1
  console.log(`  ✓  ${name}：已脱敏（-${delta} 字节）`)
}

console.log(`\n结果：${touched} 个文件已脱敏，${skipped} 个跳过，共扫描 ${files.length} 个 .bak`)
