#!/usr/bin/env node
/** audit-0101 测试：加「modules 写盘脱敏」两条 */
import { readFileSync, writeFileSync } from 'node:fs'

const P = 'C:/Users/13176/Documents/dsh-shared-brain-patches/tests/audit-0101.test.mjs'
let src = readFileSync(P, 'utf8')

const IMPORT_ANCHOR = "const PM = await load('proactive-mood.js')"
if (src.split(IMPORT_ANCHOR).length - 1 !== 1) throw new Error('导入锚点不唯一')
if (!src.includes("load('modules.js')")) src = src.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + "\nconst MOD = await load('modules.js')")

const BLOCK = String.raw`
// ─────────────────────────────────────────────────────────────
console.log('== P0-1 补漏：模块配置的写盘路径 ==')
// ─────────────────────────────────────────────────────────────

const MODULES_FILE = join(SANDBOX, 'storages', 'dsh-shared-brain', 'modules.json')

test('writeModules：落盘前擦掉条目里的明文凭据（这条路径以前是裸写）', () => {
  // 实测过：一条含明文 token 的记忆被摘要写进 modules.json，
  // 插件重载后新代码照样原样落盘 —— normalizeModules 只在读的时候脱敏。
  const secret = 'ghp_' + 'A'.repeat(36)
  const dirty = MOD.readModules()
  dirty.cognition.items = [{ id: 'mod_test_dirty', text: '这里的密钥是 ' + secret + ' 别忘了', timestamp: Date.now() }]
  MOD.writeModules(dirty)
  const onDisk = readFileSync(MODULES_FILE, 'utf8')
  assert.ok(!onDisk.includes(secret), '磁盘上不该有明文')
  assert.ok(onDisk.includes('[已脱敏]'), '应该留下占位符')
})

test('writeModules：不改调用方传进来的对象（index.js 之后还要用）', () => {
  const secret = 'ghp_' + 'B'.repeat(36)
  const dirty = MOD.readModules()
  dirty.instinct.items = [{ id: 'mod_test_src', text: '口令 ' + secret, timestamp: Date.now() }]
  MOD.writeModules(dirty)
  assert.ok(dirty.instinct.items[0].text.includes(secret), '入参对象必须原样')
})

`

const lines = src.split('\n')
const idx = lines.findIndex((l) => l.startsWith('process.stdout.write(') && l.includes('pass'))
if (idx < 0) throw new Error('找不到汇总行')

lines.splice(idx, 0, BLOCK)
writeFileSync(P, lines.join('\n'), 'utf8')
console.log(`[ok] 在 ${idx + 1} 行前插入 2 条模块写盘脱敏测试`)
