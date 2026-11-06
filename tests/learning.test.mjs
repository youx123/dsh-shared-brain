import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_LEARNING,
  learningConfig,
  todayOf,
  quotaLeft,
  bumpState,
  buildLearnSystem,
  buildLearnUser,
  parseLearned,
  looksWorthKeeping,
  normalizeForDedupe,
  similarity,
  pickNewCandidates,
} from '../lib/learning.js'

test('默认是关闭的（多一次模型调用，得老大显式打开）', () => {
  assert.equal(DEFAULT_LEARNING.enabled, false)
  assert.equal(learningConfig(undefined).enabled, false)
})

test('配置能从 modules.knowledge.learning 读出来并夹住范围', () => {
  const c = learningConfig({ knowledge: { learning: { enabled: true, perDay: 5, maxPerTurn: 99, minChars: 10, maxChars: 100 } } })
  assert.equal(c.enabled, true)
  assert.equal(c.perDay, 5)
  assert.equal(c.maxPerTurn, 5) // 夹到上限
  assert.equal(c.minChars, 10)
  assert.equal(c.maxChars, 100)
})

test('每日额度按天重置', () => {
  const now = new Date('2026-11-06T10:00:00+08:00').getTime()
  const config = { ...DEFAULT_LEARNING, perDay: 3 }
  assert.equal(quotaLeft(config, null, now), 3)
  const st = bumpState(null, 2, now)
  assert.equal(st.day, todayOf(now))
  assert.equal(quotaLeft(config, st, now), 1)
  // 第二天又是满的
  const tomorrow = now + 24 * 3600 * 1000
  assert.equal(quotaLeft(config, st, tomorrow), 3)
})

test('额度用完后是 0，不会变负', () => {
  const now = Date.now()
  const config = { ...DEFAULT_LEARNING, perDay: 1 }
  const st = bumpState(null, 5, now)
  assert.equal(quotaLeft(config, st, now), 0)
})

test('抽取提示里写清「过程话不要」', () => {
  const sys = buildLearnSystem()
  assert.ok(sys.includes('JSON'))
  assert.ok(sys.includes('我这就去查'))
  assert.ok(sys.includes('空数组'))
})

test('buildLearnUser 带上两边的话', () => {
  const u = buildLearnUser({ userText: '什么是缓存雪崩', reply: '大量 key 同时过期' })
  assert.ok(u.includes('缓存雪崩'))
  assert.ok(u.includes('大量 key'))
})

test('parseLearned 能解析标准 JSON 数组', () => {
  const out = parseLearned('[{"text":"钩子函数在渲染前执行","tags":["react"]}]')
  assert.equal(out.length, 1)
  assert.equal(out[0].text, '钩子函数在渲染前执行')
  assert.deepEqual(out[0].tags, ['react'])
})

test('parseLearned 容忍前后废话', () => {
  const out = parseLearned('好的，我判断如下：\n[{"text":"A 会导致 B"}]\n以上。')
  assert.equal(out.length, 1)
  assert.equal(out[0].text, 'A 会导致 B')
})

test('parseLearned 坏 JSON 返回空数组而不是抛错', () => {
  assert.deepEqual(parseLearned('[{"text": 坏掉了'), [])
  assert.deepEqual(parseLearned(''), [])
  assert.deepEqual(parseLearned(null), [])
  assert.deepEqual(parseLearned('[]'), [])
})

test('parseLearned 支持纯字符串数组', () => {
  assert.deepEqual(parseLearned('["一句话知识，够长够完整"]'), [{ text: '一句话知识，够长够完整', tags: [] }])
})

test('looksWorthKeeping 拒收过程话', () => {
  assert.equal(looksWorthKeeping('我这就去查一下缓存的问题'), false)
  assert.equal(looksWorthKeeping('稍等，让我看看日志再回你'), false)
  assert.equal(looksWorthKeeping('好的，明白了，我记一下这个'), false)
})

test('looksWorthKeeping 拒收寒暄与纯符号', () => {
  assert.equal(looksWorthKeeping('哈哈'), false)
  assert.equal(looksWorthKeeping('——————'), false)
  assert.equal(looksWorthKeeping('   '), false)
})

test('looksWorthKeeping 拒收上下文依赖的指代开头', () => {
  assert.equal(looksWorthKeeping('他说的这个方案其实有个漏洞要注意'), false)
  assert.equal(looksWorthKeeping('刚才那个报错是权限问题导致的失败'), false)
})

test('looksWorthKeeping 收下真正的知识点', () => {
  assert.equal(looksWorthKeeping('缓存雪崩是大量 key 同时过期，加随机过期时间能缓解。'), true)
  assert.equal(looksWorthKeeping('勾股定理：直角三角形两直角边平方和等于斜边平方。'), true)
})

test('looksWorthKeeping 按配置卡长度', () => {
  const config = { ...DEFAULT_LEARNING, minChars: 30 }
  assert.equal(looksWorthKeeping('短句知识点', config), false)
})

test('normalizeForDedupe 去标点空格并小写', () => {
  assert.equal(normalizeForDedupe('缓存 雪崩，很危险！'), '缓存雪崩很危险')
  assert.equal(normalizeForDedupe('React Hooks'), 'reacthooks')
})

test('similarity 对相同文本是 1，对无关文本很低', () => {
  assert.equal(similarity('缓存雪崩要加随机过期时间', '缓存雪崩要加随机过期时间'), 1)
  const low = similarity('缓存雪崩要加随机过期时间', '唐诗宋词讲究格律对仗声韵')
  assert.ok(low < 0.2, '实际 ' + low)
})

test('pickNewCandidates 跳过与已有重复的', () => {
  const existing = ['缓存雪崩是大量 key 同时过期，加随机过期时间能缓解。']
  const picked = pickNewCandidates(
    [
      { text: '缓存雪崩是大量key同时过期，加随机过期时间能缓解' },
      { text: '缓存击穿是热点 key 过期，用互斥锁或永不过期来解决。' },
    ],
    existing,
    { limit: 2 },
  )
  assert.equal(picked.length, 1)
  assert.ok(picked[0].text.includes('缓存击穿'))
})

test('pickNewCandidates 自己这批里也不许重复', () => {
  const picked = pickNewCandidates(
    [{ text: '同一条知识写的足够长了，用于测试去重' }, { text: '同一条知识写的足够长了，用于测试去重' }],
    [],
    { limit: 5 },
  )
  assert.equal(picked.length, 1)
})

test('pickNewCandidates 尊重 limit', () => {
  const cands = Array.from({ length: 5 }, (_, i) => ({ text: `第 ${i} 条互不相同的知识点，各自描述一个概念` }))
  assert.equal(pickNewCandidates(cands, [], { limit: 2 }).length, 2)
})

test('pickNewCandidates 过滤掉不该收的', () => {
  const picked = pickNewCandidates([{ text: '我这就去查一下' }, { text: '嗯' }], [], { limit: 3 })
  assert.equal(picked.length, 0)
})
