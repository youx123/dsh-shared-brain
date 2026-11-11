/**
 * 话题池（方案 §5.5）：从读过的书里挑没错过的由头。
 */
import assert from 'node:assert/strict'
import { buildTopicPool, mergeTopicPool } from '../lib/topic-pool.js'
import { decideProactive, pickTopic, renderTopic } from '../lib/proactive-mood.js'

console.log('== 话题池 ==')

const modules = {
  knowledge: {
    items: [
      { id: 'k1', text: '欲穷千里目，更上一层楼。——王之涣《登鹳雀楼》。要看得更远，就得站得更高。', sourceRef: '唐宋诗词精选' },
      { id: 'k2', text: '商（约前 1600-前 1046）有甲骨文，是目前确认的最早成熟汉字体系。', sourceRef: '中国历史纲要' },
      { id: 'k3', text: '短', sourceRef: '中国历史纲要' },
      { id: 'k4', text: '改了配置必须重启进程才生效，别当成补丁写错了。', sourceRef: '自主学习' },
      { id: 'k5', text: '先跑通的再谈优化，别一上来就重构。', sourceRef: '' },
    ],
  },
}
const flat = [
  { id: 'k6', module: 'knowledge', text: '都江堰鱼嘴分水，把岷江一分为二，内江灌溉、外江排洪。', sourceRef: '都江堰' },
  { id: 'k7', module: 'cognition', text: '这条是工作记忆，不该进话题池。' },
]

const pool = buildTopicPool({ modules, entries: flat, limit: 10 })
const keys = pool.map((t) => t.key)

assert.equal(pool.length, 4, `应有 4 条（短文本/自主学习/工作记忆都要排除），实际 ${pool.length}`)
assert.ok(!keys.some((k) => k.includes('自主学习')), '自主学习不进池')
assert.ok(!keys.some((k) => k.includes('这条是工作记忆')), '工作记忆不进池')
assert.ok(pool.some((t) => t.intent.includes('登鹳雀楼')), '诗词进池')

const poem = pool.find((t) => t.intent.includes('登鹳雀楼'))
assert.ok(poem, '诗词由头在')
assert.ok(poem.intent.includes('王之涣'), '带作者')
assert.ok(poem.hint.includes('更上一层楼'), '带原文提示')
assert.equal(renderTopic(poem).startsWith('（这次想聊的：'), true, '能渲染成提示')

// 按书轮转：一本几十条也只占一份，别的书还能轮到
const many = {
  knowledge: {
    items: [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, text: `中国历史第 ${i} 条，讲某个朝代的事，长度够用了。`, sourceRef: '中国历史纲要' })),
      { id: 'p1', text: '欲穷千里目，更上一层楼。——王之涣《登鹳雀楼》。要看得更远。', sourceRef: '唐宋诗词精选' },
      { id: 'p2', text: '都江堰鱼嘴分水，把岷江一分为二，内江灌溉、外江排洪。', sourceRef: '都江堰' },
    ],
  },
}
const rotated = buildTopicPool({ modules: many, limit: 3 })
const books = new Set(rotated.map((t) => t.key.split(':')[1]))
assert.equal(books.size, 3, `前三条应来自三本书，实际 ${[...books].join('/')}`)

// 去重：同一条重复喂两次只留一份
const dupPool = buildTopicPool({ modules: { knowledge: { items: [modules.knowledge.items[0], modules.knowledge.items[0]] } }, limit: 10 })
assert.equal(dupPool.length, 1, '同条重复只留一份')

// 空输入
assert.deepEqual(buildTopicPool({}), [], '空输入给空池')

// 合并：池子在前面，内置不重复
const merged = mergeTopicPool([{ key: 'progress', intent: 'x' }], [{ key: 'progress', intent: 'lib' }, { key: 'curious', intent: 'y' }])
assert.deepEqual(merged.map((t) => t.key), ['progress', 'curious'], '合并去重且池子优先')

// 决策层：有话题池时优先从池里挑
const decision = decideProactive({
  moodState: { mood: 70, dims: {} },
  history: { spokeToday: 0, lastSpokeAt: 0, usedTopics: [] },
  config: { maxPerDay: 3, quietPeriodMs: 0 },
  topicPool: pool,
  now: Date.UTC(2026, 10, 11, 4, 0, 0),
})
assert.equal(decision.action, 'speak', '该说话')
assert.ok(decision.topic, '有话题')
assert.ok(String(decision.topic.key).startsWith('read:'), `优先用池里的由头，实际 ${decision.topic.key}`)

// 池子用完了会退回内置话题
const used = pool.map((t) => t.key)
const fallback = decideProactive({
  moodState: { mood: 70, dims: {} },
  history: { spokeToday: 0, lastSpokeAt: 0, usedTopics: used },
  config: { maxPerDay: 3, quietPeriodMs: 0 },
  topicPool: pool,
  now: Date.UTC(2026, 10, 11, 4, 0, 0),
})
assert.ok(fallback.topic, '仍有话题')
assert.ok(!String(fallback.topic.key).startsWith('read:'), '池子用过后退回内置')

// pickTopic 的轮换仍然正常
const t1 = pickTopic({ pool: [{ key: 'a', intent: 'a' }, { key: 'b', intent: 'b' }], used: ['a'], rand: () => 0 })
assert.equal(t1.key, 'b', '用过的不再优先')

console.log('✅ 话题池全部通过')
