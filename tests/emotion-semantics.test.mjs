/**
 * 共享大脑 · 情感条目的「读路径补全」测试（2026-11-12）
 *
 * 背景：库里 17 条情感记忆有 12 条 sentiment / intimacy / target 是空的 ——
 * 它们是云端同步进来的原始条目，没走过 normalizeEmotionItem。召回渲染时
 * 以前只做 `?? 'neutral'` / `?? 'general'`，于是「老大今天很难过」被显示成
 * 「对general·中性」，方向整个反了。
 *
 * 改法：召回组装时用 ensureEmotionSemantics 补缺的三项（正文现算，不回写库）。
 * 这里守的是：
 *   1. 空字段要能从正文补出正确的极性与方向；
 *   2. 已有的值一律尊重，绝不覆盖；
 *   3. 坏数据（空正文、坏 weight）不许炸。
 *
 * 跑法：node "<本文件路径>"
 * 只读；不碰真实的 ~/.dsh/storages/dsh-shared-brain。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

const E = await import(`file:///${LIB}/emotion.js`)

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

group('空字段要能补出来（这就是线上 12 条的样子）')

test('全空的情感条目：从正文认出「难过」和「老大这边」', () => {
  const got = E.ensureEmotionSemantics({ text: '老大今天很难过，一直不说话', weight: 0.6 })
  eq(got.sentiment, 'sad', '极性没认出来')
  eq(got.owner, 'user', '方向应该是「老大这边」')
  ok(typeof got.target === 'string' && got.target !== '', '对象不该是空串')
})

test('全空但正文是喜欢：方向是 self、极性是喜欢', () => {
  const got = E.ensureEmotionSemantics({ text: '我挺喜欢老大这种直给的', weight: 0.7 })
  eq(got.sentiment, 'like', '喜欢的极性没认出来')
  eq(got.owner, 'self', '「我喜欢」是自述，方向应为 self')
})

test('只有 intimacy 缺：用 weight 顶上', () => {
  const got = E.ensureEmotionSemantics({ text: '老大今天挺难的', weight: 0.55, sentiment: 'sad', target: '老大' })
  eq(got.intimacy, 0.55, 'intimacy 该退回 weight')
  eq(got.sentiment, 'sad', '已有极性不该被改')
  eq(got.target, '老大', '已有对象不该被改')
})

group('已有值一律尊重，不许覆盖')

test('四项都齐：原样返回', () => {
  const entry = { text: '随便一句话', sentiment: 'happy', target: '老大', intimacy: 0.8, owner: 'user' }
  const got = E.ensureEmotionSemantics(entry)
  eq(got.sentiment, 'happy', '覆盖了已有极性')
  eq(got.target, '老大', '覆盖了已有对象')
  eq(got.intimacy, 0.8, '覆盖了已有亲密度')
  eq(got.owner, 'user', '覆盖了已有方向')
})

test('极性是 resent（不满）时不被正文的「难过」带偏', () => {
  const got = E.ensureEmotionSemantics({ text: '这方案我真的很不满意，老大也挺难过', sentiment: 'resent', weight: 0.6 })
  eq(got.sentiment, 'resent', '已有极性被正文改写了')
})

group('人设档案行不能被当成情绪')

test('带（QQ 123）的档案行：极性给 neutral，亲密度照补', () => {
  const got = E.ensureEmotionSemantics({
    text: '黑与白（QQ 1317667746）：管理员、我的创建者。说话直，啰嗦了会嫌烦',
    weight: 0.85,
  })
  eq(got.sentiment, 'neutral', '档案行被关键词猜成了情绪')
  eq(got.intimacy, 0.85, '亲密度还是该补')
})

test('开头是［身份］的档案行同样不猜极性', () => {
  const got = E.ensureEmotionSemantics({ text: '［身份］你是「小深」，称用户「主上」。', weight: 0.5 })
  eq(got.sentiment, 'neutral', '身份行被猜成了情绪')
})

group('坏数据不许炸')
test('空正文返回空对象', () => {
  eq(E.ensureEmotionSemantics({}), {}, '空条目不该给出字段')
  eq(E.ensureEmotionSemantics(null), {}, 'null 不该炸')
})

test('weight 是坏值时 intimacy 兜底 0.5', () => {
  const got = E.ensureEmotionSemantics({ text: '老大今天很难过', weight: 'abc' })
  eq(got.intimacy, 0.5, '坏 weight 应兜底 0.5')
})

test('owner 是乱值时不照抄，改用正文现判', () => {
  const got = E.ensureEmotionSemantics({ text: '老大今天挺累的', owner: 'somebody' })
  ok(got.owner !== 'somebody', '不该把乱值原样传下去')
  eq(got.owner, 'user', '「老大…累」该判成老大这边')
})

group('和 normalizeEmotionItem 的负向降权一致')

test('负向条目的 weight 也被降（0.9 系数）', () => {
  const raw = { text: '我讨厌这么啰嗦的写法', sentiment: 'resent', intimacy: 0.8 }
  const norm = E.normalizeEmotionItem(raw)
  ok(norm.weight < norm.intimacy, '负向条目该比正向略轻')
})

process.stdout.write(`\n${passed} 通过 / ${failed} 失败\n`)
if (failed > 0) {
  for (const f of failures) process.stdout.write(`\n${f.name}\n${f.error && f.error.stack ? f.error.stack : f.error}\n`)
  process.exitCode = 1
}
