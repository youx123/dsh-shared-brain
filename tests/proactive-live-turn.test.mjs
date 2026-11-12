import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-live-turn-'))
process.env.DSH_HOME = home

const { noteUserTurn, recentlyActive, ACTIVE_GRACE_MS } = await import(
  '../lib/proactive.js'
)

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log('PASS  ' + name)
  } else {
    fail++
    console.log('FAIL  ' + name + '  ' + extra)
  }
}

// 1. 没记任何轮次、chat_log 也空 → 不算忙
check('一开始不算忙', recentlyActive(ACTIVE_GRACE_MS) === false)

// 2. 记一笔「刚刚」，chat_log 依然是空 → 现在算忙
noteUserTurn()
check('记了一笔就算正在说话', recentlyActive(ACTIVE_GRACE_MS) === true)
check('一两分钟前仍算忙', recentlyActive(ACTIVE_GRACE_MS, Date.now() + 60 * 1000) === true)

// 3. 宽限期过去就不算忙（五分钟前的那笔，按十分钟后看）
check('宽限期过了就不算', recentlyActive(ACTIVE_GRACE_MS, Date.now() + ACTIVE_GRACE_MS + 5000) === false)

// 4. 未来太远的时间戳不收（防时钟乱跳把人永久锁在「正在说话」）
const before = recentlyActive(ACTIVE_GRACE_MS, Date.now() + 2 * 60 * 60 * 1000)
noteUserTurn(Date.now() + 60 * 60 * 1000)
const after = recentlyActive(ACTIVE_GRACE_MS, Date.now() + 2 * 60 * 60 * 1000)
check('半小时后的时间戳不收', before === false && after === before)

// 5. 非法值不炸、不生效
noteUserTurn('not a number')
noteUserTurn(-5)
noteUserTurn(NaN)
check('乱值不会把它判成忙', recentlyActive(0) === false)

// 6. 攒很多轮也只留最近 20 条（内部裁剪不抛错，行为仍对）
for (let i = 0; i < 50; i += 1) noteUserTurn(Date.now() - i * 1000)
check('记五十笔之后仍然判忙', recentlyActive(ACTIVE_GRACE_MS) === true)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
try {
  rmSync(home, { recursive: true, force: true })
} catch {
  // Windows 上 SQLite 句柄没释放时删不掉，忽略
}
process.exit(fail === 0 ? 0 : 1)
