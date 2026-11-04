#!/usr/bin/env node
/**
 * P0-1 验收：在隔离副本上验证「磁盘明文会被真的擦掉」。
 *
 * 审计的核心发现是：内存干净、磁盘永远明文 —— 因为 readStore 的写回判断
 * 看的是 cleaned，而 normalizeStore 已经先擦过一遍，cleaned 恒为 0。
 *
 * 这个脚本把真实存储复制到临时目录、把 DSH_HOME 指过去，
 * 然后调 readStore()，检查**磁盘上的**文件还有没有密钥。
 * 绝对不碰真实数据。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const REAL = 'C:/Users/13176/.dsh/storages/dsh-shared-brain'

const home = mkdtempSync(join(tmpdir(), 'sb-verify-'))
const storage = join(home, 'storages', 'dsh-shared-brain')
mkdirSync(storage, { recursive: true })
process.env.DSH_HOME = home

// 造一份带密钥的记忆库（模拟审计查到的磁盘状态）
const FAKE = 'ghp_' + 'A'.repeat(36)
const dirty = {
  version: 1,
  updatedAt: Date.now(),
  entries: [
    { id: 'a', text: `用户给了一个 token ${FAKE} 让我记住`, weight: 0.5, module: 'cognition', updatedAt: Date.now() },
    { id: 'b', text: '这条是正常记忆，不该被动', weight: 0.5, module: 'cognition', updatedAt: Date.now() },
  ],
}
writeFileSync(join(storage, 'memory.json'), JSON.stringify(dirty, null, 2), 'utf8')

const url = (name) => 'file:///' + join(LIB, name).replace(/\\/g, '/')
const store = await import(url('store.js'))

// ① 读一遍 —— 修复前后就在这里分道扬镳
const read = store.readStore()
const diskAfterRead = readFileSync(join(storage, 'memory.json'), 'utf8')
console.log('=== 读路径 ===')
console.log(`  内存里还有明文？   ${read.entries[0].text.includes(FAKE) ? '有（BUG）' : '没有 ✅'}`)
console.log(`  磁盘上还有明文？   ${diskAfterRead.includes(FAKE) ? '有（BUG）' : '没有 ✅'}`)
console.log(`  正常条目被误伤？   ${diskAfterRead.includes('这条是正常记忆') ? '没有 ✅' : '被改了（BUG）'}`)

// ② 写路径：模拟 syncOnce 那样「拿到远端脏条目 → 直接 writeStore」
const dirty2 = {
  version: 1,
  updatedAt: Date.now(),
  entries: [
    { id: 'c', text: `远端推来的 ${FAKE}`, weight: 0.5, module: 'cognition', updatedAt: Date.now() },
  ],
}
store.writeStore(dirty2)
const diskAfterWrite = readFileSync(join(storage, 'memory.json'), 'utf8')
console.log('=== 写路径（writeStore 收口）===')
console.log(`  磁盘上还有明文？   ${diskAfterWrite.includes(FAKE) ? '有（BUG）' : '没有 ✅'}`)

// ③ mergeEntries 输出侧也要干净
const sync = await import(url('remote-sync.js'))
const merged = sync.mergeEntries([], [{ id: 'd', text: `远端 ${FAKE}`, updatedAt: Date.now(), scope: 'global' }], {})
const mergedDirty = merged.entries.some((e) => e.text.includes(FAKE))
console.log('=== 合并路径（mergeEntries）===')
console.log(`  合并结果有明文？   ${mergedDirty ? '有（BUG）' : '没有 ✅'}`)
console.log(`  本机路径被剥掉？   ${merged.entries[0]?.cwd === undefined ? '是 ✅' : '没剥（BUG）'}`)

rmSync(home, { recursive: true, force: true })
console.log('\n临时目录已清理')
