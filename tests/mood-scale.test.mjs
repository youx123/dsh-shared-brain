/**
 * 共享大脑 · 情绪维度的「相对量纲」测试（2026-11-12）
 *
 * 背景：七维名义量程是 0~100，但每 90 分钟衰减一半、每轮最多 ±10，
 * 真值常年只有 0~5（12 个 state 实测 max=5）。以前三处写死的门槛
 * （emotion.js 的 20、emoji-affinity.js 的 20、proactive-mood.js 的 6/8）
 * 全都够不到 —— 于是「还担心、甜蜜」「主导情绪挑表情」「压着担心」
 * 这些能力一次都没在真实数据上生效过。
 *
 * 这里守的是改完之后的行为：
 *   1. 全维一样低 → 没有信号，不许硬凑；
 *   2. 值小但明显领先 → 要认出来（这才是真数据的样子）；
 *   3. 极性要分对：低落时不能点名「开心」。
 *
 * 跑法：node "<本文件路径>"
 * 只读；不碰真实的 ~/.dsh/storages/dsh-shared-brain。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

const E = await import(`file:///${LIB}/emotion.js`)
const PM = await import(`file:///${LIB}/proactive-mood.js`)
const EA = await import(`file:///${LIB}/emoji-affinity.js`)

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failed++
    failures.push({ name, error })
    process.stdout.write(`  FAIL ${name}\n       ${error && error.message ? error.message : error}\n`)
  }
}

function group(title) {
  process.stdout.write(`\n${title}\n`)
}

function ok(actual, message) {
  if (!actual) throw new Error(message)
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}（实际 ${a}，期望 ${b}）`)
}

/** 造一个心情状态（过掉 renderMoodContext 的闸门）。 */
function moodState({ mood = 60, dims = {}, confidence = 80, revision = 1 } = {}) {
  const full = { happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0, ...dims }
  return {
    sessionId: 's1',
    mood,
    dims: full,
    minor: false,
    lastConfidence: confidence,
    revision,
    saidAt: [],
    timeline: [],
    updatedAt: Date.now(),
  }
}

// ────────────────────────────────────────────────────────────────────
group('topMoodDims · 相对量纲')
// ────────────────────────────────────────────────────────────────────

test('空 dims → 空数组', () => {
  eq(E.topMoodDims({}), [])
  eq(E.topMoodDims(null), [])
})

test('全零 / 全 1 → 空数组（没信号不硬凑）', () => {
  eq(E.topMoodDims({ happy: 0, calm: 0 }), [])
  eq(E.topMoodDims({ happy: 1, calm: 1, worry: 1 }), [])
})

test('真实量级（7 / 6）→ 两维都认出来', () => {
  const rows = E.topMoodDims({ happy: 7, calm: 6 })
  eq(rows.map((r) => r.key), ['happy', 'calm'])
  eq(rows[0].label, '开心')
})

test('明显领先的只留领先那维（5 / 1）', () => {
  const rows = E.topMoodDims({ happy: 5, calm: 1 })
  eq(rows.map((r) => r.key), ['happy'])
})

test('默认最多两维', () => {
  const rows = E.topMoodDims({ happy: 5, calm: 5, sweet: 5 })
  eq(rows.length, 2)
})

test('下限 2 分以下不算信号（1 分）', () => {
  eq(E.topMoodDims({ sad: 1 }), [])
})

test('坏值不炸', () => {
  eq(E.topMoodDims({ happy: NaN, calm: 'x' }), [])
  eq(E.topMoodDims({ happy: -3, calm: 4 }).map((r) => r.key), ['calm'])
})

// ────────────────────────────────────────────────────────────────────
group('renderMoodContext · 维度真的会出现了')
// ────────────────────────────────────────────────────────────────────

test('label 模式：担心 4 分就写出来', () => {
  const text = E.renderMoodContext(moodState({ mood: 55, dims: { worry: 4, calm: 1 } }), {
    mode: 'label',
    now: Date.now(),
  })
  ok(text.includes('担心'), `没写担心：${text}`)
})

test('event 模式：同样写出来', () => {
  const text = E.renderMoodContext(moodState({ mood: 55, dims: { worry: 4, calm: 1 } }), { now: Date.now() })
  ok(text.includes('还担心'), `没写「还担心」：${text}`)
})

test('全维一样低 → 不写维度', () => {
  const text = E.renderMoodContext(moodState({ mood: 55, dims: { happy: 1, calm: 1 } }), {
    mode: 'label',
    now: Date.now(),
  })
  ok(text.includes('心情'), '连档位都没写')
  ok(!text.includes('、'), `不该出现维度列举：${text}`)
})

// ────────────────────────────────────────────────────────────────────
group('renderMoodHint · 点名也按相对量纲')
// ────────────────────────────────────────────────────────────────────

test('低落 + 担心 4 分 → 点名「担心」', () => {
  // lowMood 默认 45：要真的落到低落档，维度才走「点名」那条路
  const signal = PM.readMoodSignal(moodState({ mood: 35, dims: { worry: 4, calm: 1 } }))
  const text = PM.renderMoodHint(signal)
  ok(text.includes('担心'), `没点名担心：${text}`)
})

test('低落 + 分不开 → 只说「情绪有点沉」', () => {
  const signal = PM.readMoodSignal(moodState({ mood: 35, dims: { worry: 1, sad: 1 } }))
  const text = PM.renderMoodHint(signal)
  ok(text.includes('情绪有点沉'), `措辞变了：${text}`)
  ok(!text.includes('担心') && !text.includes('难过'), `不该点名：${text}`)
})

test('低落时不许点名「开心」（极性筛住）', () => {
  // mood 只有 55，但维度上开心明显领先 —— 档位假低落、维度假开心这种事会撞上。
  const signal = PM.readMoodSignal(moodState({ mood: 55, dims: { happy: 5, calm: 1 } }))
  const signal2 = { ...signal, level: 'low' }
  const text = PM.renderMoodHint(signal2)
  ok(!text.includes('开心'), `低落却点名开心：${text}`)
})

test('心情好 + 开心 4 分 → 点名「开心」', () => {
  const signal = PM.readMoodSignal(moodState({ mood: 85, dims: { happy: 4, calm: 1 } }))
  const text = PM.renderMoodHint(signal)
  ok(text.includes('开心'), `没点名开心：${text}`)
})

test('没有 signal → 空串', () => {
  eq(PM.renderMoodHint(null), '')
})

// ────────────────────────────────────────────────────────────────────
group('dominantDimOf · 表情也吃同一套尺')
// ────────────────────────────────────────────────────────────────────

test('担心 3 分（真值量级）→ 按担心挑表情', () => {
  const proposal = EA.proposeEmoji({ moodState: { mood: 70, dims: { worry: 3, calm: 1 } } })
  ok(proposal.keys.length > 0, '一个表情都没给')
  eq(proposal.keys[0], 'sigh', `第一条不是担心系的：${proposal.keys.join(',')}`)
})

test('全维一样低 → 退回档位（不硬挑维度）', () => {
  const proposal = EA.proposeEmoji({ moodState: { mood: 70, dims: { happy: 1, calm: 1 } } })
  eq(proposal.keys[0], 'happy', `退回档位应该给 happy：${proposal.keys.join(',')}`)
})

test('大数值仍然认得出来（老数据兼容）', () => {
  const proposal = EA.proposeEmoji({ moodState: { mood: 30, dims: { worry: 50 } } })
  eq(proposal.keys[0], 'sigh', `大数值没认出担心：${proposal.keys.join(',')}`)
})

// ────────────────────────────────────────────────────────────────────
process.stdout.write(`\n${passed} 通过 / ${failed} 失败\n`)
if (failed) {
  process.stdout.write('\n失败明细：\n')
  for (const { name, error } of failures) {
    process.stdout.write(` - ${name}: ${error && error.message ? error.message : error}\n`)
  }
  process.exitCode = 1
}
