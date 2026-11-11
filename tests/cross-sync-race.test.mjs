/**
 * 跨进程协调：写盘期间别人推进了一代，不能被标成「已应用」。
 * 0.9 那条（coord 伪造/并发会丢改动）的回归。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'sb-race-'))
process.env.DSH_SHARED_BRAIN_CURSOR_BRAIN = root
const LIB = 'file:///C:/Users/13176/Documents/dsh-shared-brain-patches/lib/'
const cross = await import(LIB + 'cross-sync.js')

const coordFile = join(root, 'sync-coordinator.json')
const read = () => JSON.parse(readFileSync(coordFile, 'utf8'))
const write = (value) => writeFileSync(coordFile, JSON.stringify(value, null, 2))

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++
    console.log('PASS  ' + name)
  } else {
    fail++
    console.log('FAIL  ' + name + '  ' + extra)
  }
}

// 1. 正常收尾：没有别人插进来 → dshApplied 跟上 generation
cross.beginWriteDsh()
cross.finishWriteDsh({ bump: true, baseGeneration: 0, suppressMs: 0 })
const normal = read()
check('正常收尾 generation=1', normal.generation === 1, JSON.stringify(normal))
check('正常收尾 dshApplied=1', normal.dshApplied === 1, JSON.stringify(normal))
check('正常收尾后不需要反应', cross.shouldDshReact() === false, JSON.stringify(normal))

// 2. 写盘期间别人推进了一代 → 只认开工那一代，让下一轮去导
write({ version: 1, generation: 4, writer: null, writerAt: 0, cursorApplied: 5, dshApplied: 4, suppressWatchUntil: 0 })
const lock = cross.beginWriteDsh()
check('开工时拿到当前代', lock.ok === true && lock.generation === 4, JSON.stringify(lock))
// 模拟 Cursor 在我们写盘期间推进到第 5 代
const during = read()
during.generation = 5
during.writer = 'cursor'
during.writerAt = Date.now()
write(during)
cross.finishWriteDsh({ bump: true, baseGeneration: lock.generation, suppressMs: 0 })
const raced = read()
check('并发后 generation=6', raced.generation === 6, JSON.stringify(raced))
check('并发后 dshApplied 只到 4', raced.dshApplied === 4, JSON.stringify(raced))
check('并发后仍待导入', cross.shouldDshReact() === true, JSON.stringify(raced))

// 3. Cursor 正在写（8 秒内）→ 我方拿不到锁
write({ version: 1, generation: 2, writer: 'cursor', writerAt: Date.now(), cursorApplied: 2, dshApplied: 2, suppressWatchUntil: 0 })
check('Cursor 在写时让路', cross.beginWriteDsh().ok === false)
// 8 秒后可以接管
write({ version: 1, generation: 2, writer: 'cursor', writerAt: Date.now() - 9000, cursorApplied: 2, dshApplied: 2, suppressWatchUntil: 0 })
check('过了 8 秒可以接管', cross.beginWriteDsh().ok === true)

// 4. dshApplied 只增不减
write({ version: 1, generation: 9, writer: null, writerAt: 0, cursorApplied: 9, dshApplied: 7, suppressWatchUntil: 0 })
const back = cross.beginWriteDsh()
cross.finishWriteDsh({ bump: true, baseGeneration: back.generation, suppressMs: 0 })
check('dshApplied 不被往回拨', read().dshApplied === 10, JSON.stringify(read()))

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
try {
  const { rmSync } = await import('node:fs')
  rmSync(root, { recursive: true, force: true })
} catch {}
process.exit(fail === 0 ? 0 : 1)
