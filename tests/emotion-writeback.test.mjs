import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 心情判定的「记账」不能把刚写好的心情冲掉。
 *
 * 线上症状：judgeLog.count 一路涨到 5，states 最新还停在 72 小时前。
 * 根因：saveMoodState 自己读-改-写（盘上有了新 state），
 * 紧接着 noteMoodJudge 拿函数开头读的旧快照整份写回，把新 state 盖没了。
 * 修法：记账前重读一次磁盘。
 *
 * 这里直接复现两种写法，确认哪一种能同时留下 count 和 state。
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), 'sb-writeback-'))
process.env.DSH_HOME = ROOT

const LIB = join(HERE, '..', 'lib')
const EMO = await import(`file:///${LIB.replace(/\\/g, '/')}/emotion.js`)
const INDEX_SRC = readFileSync(join(LIB, 'index.js'), 'utf8')

const emotionFile = join(ROOT, 'storages', 'dsh-shared-brain', 'emotion.json')
const sessionId = 'sess-writeback'
const base = Date.now()

let pass = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log('PASS  ' + name)
  } else {
    console.log('FAIL  ' + name + '  ' + extra)
    process.exitCode = 1
  }
}

function seed() {
  const store = EMO.readEmotionStore()
  store.judgeLog = { day: '2026-11-12', count: 3, skipped: 0, failed: 0, lastError: '' }
  EMO.writeEmotionStore(store)
}

function readDisk() {
  return JSON.parse(readFileSync(emotionFile, 'utf8'))
}

// 场景一：旧写法 —— 拿开头读的旧快照记账
seed()
const staleStore = EMO.readEmotionStore()
{
  const { state } = EMO.getMoodState(sessionId)
  EMO.applyMoodDelta(state, { moodDelta: -6, dims: { worry: 3 } }, { sigMoodRaw: 1 })
  EMO.saveMoodState(sessionId, state)
  EMO.noteMoodJudge(staleStore, 'judged')
}
const oldWay = readDisk()
check(
  '旧写法确实会把刚写好的心情冲掉（这就是线上那个症状）',
  !oldWay.states?.[sessionId] || Number(oldWay.states[sessionId].updatedAt ?? 0) < base,
  `state=${JSON.stringify(oldWay.states?.[sessionId]?.updatedAt)}`,
)

// 场景二：新写法 —— 记账前重读磁盘
seed()
{
  const { state } = EMO.getMoodState(sessionId)
  EMO.applyMoodDelta(state, { moodDelta: -6, dims: { worry: 3 } }, { sigMoodRaw: 1 })
  EMO.saveMoodState(sessionId, state)
  EMO.noteMoodJudge(EMO.readEmotionStore(), 'judged')
}
const newWay = readDisk()
check('新写法：次数照样记上', newWay.judgeLog.count === 4, `count=${newWay.judgeLog.count}`)
check(
  '新写法：心情写回没被冲掉',
  Number(newWay.states?.[sessionId]?.updatedAt ?? 0) >= base,
  `updatedAt=${newWay.states?.[sessionId]?.updatedAt}`,
)
check('新写法：心情值也留住了', newWay.states?.[sessionId]?.mood === 68, `mood=${newWay.states?.[sessionId]?.mood}`)

// 静态守卫：源码里不许再出现「拿旧 store 记账」
const staleCalls = (INDEX_SRC.match(/noteMoodJudge\(store,/g) ?? []).length
check('index.js 里没有残留 noteMoodJudge(store, ...)', staleCalls === 0, `命中 ${staleCalls} 处`)
const freshCalls = (INDEX_SRC.match(/noteMoodJudge\(readEmotionStore\(\),/g) ?? []).length
check('index.js 的判定期记账都重读了磁盘', freshCalls >= 6, `命中 ${freshCalls} 处`)

try {
  rmSync(ROOT, { recursive: true, force: true })
} catch {
  /* 临时目录删不掉不影响结论 */
}

console.log(`\n${process.exitCode ? 'FAILED' : 'ALL PASS'} ${pass} passed`)
