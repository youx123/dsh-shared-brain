import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../lib/atomic-write.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) } else { fail += 1; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'sb-atomic-'))
const file = join(dir, 'coord.json')

const r1 = writeFileAtomicSync(file, '{"a":1}\n')
check('首次写入是原子的', r1.atomic === true)
check('内容写进去了', readFileSync(file, 'utf8') === '{"a":1}\n')

const r2 = writeFileAtomicSync(file, '{"a":2}\n')
check('覆盖已有文件也成功', r2.atomic === true && readFileSync(file, 'utf8') === '{"a":2}\n')

const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
check('不留临时文件', leftovers.length === 0, leftovers.join(','))

// 目标是个目录：rename 必然失败，走兜底分支也要把 onFallback 叫到
const dirTarget = join(dir, 'as-dir')
writeFileAtomicSync(dirTarget + '.keep', 'x')
let called = false
let threw = false
try {
  // 让目标路径是个目录：先建目录，再往同路径写
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dirTarget)
  writeFileAtomicSync(dirTarget, 'y', { onFallback: () => { called = true } })
} catch {
  threw = true
}
check('写不进去时要么抛要么走兜底，不许静默', threw || called, `threw=${threw} fallback=${called}`)

rmSync(dir, { recursive: true, force: true })

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
