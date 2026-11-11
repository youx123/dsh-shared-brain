/**
 * 阅读层（方案 §5.1）：把「读过的书」从工作记忆里分出来单独召回。
 * 只测纯函数，不碰真实数据。
 */
import assert from 'node:assert/strict'
import { parseExcerpt, readingHits, renderReading, isReadingItem, READING_BOOKS } from '../lib/reading.js'

console.log('== 阅读层 ==')

// ── 解析 ──
const poem = parseExcerpt({
  text: '欲穷千里目，更上一层楼。——王之涣《登鹳雀楼》。要看得更远，就得站得更高。',
  sourceRef: '唐宋诗词精选',
})
assert.equal(poem.quote, '欲穷千里目，更上一层楼。', '原文截到破折号前')
assert.equal(poem.author, '王之涣', '作者拆出来了')
assert.equal(poem.title, '登鹳雀楼', '篇名拆出来了')
assert.ok(poem.note.startsWith('要看得更远'), '短评留在 note')
assert.equal(poem.book, '唐宋诗词精选', '书名取 sourceRef')

const hist = parseExcerpt({ text: '商（约前 1600-前 1046）有甲骨文，是目前确认的最早成熟汉字体系。', sourceRef: '中国历史纲要' })
assert.ok(hist.quote.startsWith('商（约前 1600'), '没有破折号就整条当摘录')
assert.equal(hist.title, '', '史料没有篇名')

assert.equal(parseExcerpt({ text: '   ' }), null, '空文本返回 null')
assert.equal(isReadingItem({ text: '端口 59604' }), false, '没有出处的不算书')
assert.equal(isReadingItem({ text: 'x', sourceRef: '自主学习' }), false, '学来的话不算书')
assert.equal(isReadingItem({ text: 'x', sourceRef: '唐宋诗词精选' }), true, '书里的算')

// ── 召回：只认命中 ──
const items = [
  { text: '欲穷千里目，更上一层楼。——王之涣《登鹳雀楼》。要看得更远。', sourceRef: '唐宋诗词精选', weight: 0.7 },
  { text: '长风破浪会有时，直挂云帆济沧海。——李白《行路难》。困顿中仍信时运必至。', sourceRef: '唐宋诗词精选', weight: 0.7 },
  { text: '商（约前 1600-前 1046）有甲骨文。', sourceRef: '中国历史纲要', weight: 0.7 },
  { text: '把 npm 脚本改成常驻进程，用 pm2 起。', sourceRef: '自主学习', weight: 0.7 },
]

const hits = readingHits(items, '我想登高看得更远', { limit: 3 })
assert.ok(hits.length >= 1, '有命中')
assert.ok(hits[0].quote.includes('更上一层楼'), '最贴题的那句排第一')
assert.ok(hits.every((h) => h.book !== '自主学习'), '学来的话不会冒充读过的书')
assert.ok(hits.length <= 3, '不超配额')

assert.deepEqual(readingHits(items, '', { limit: 3 }), [], '空查询不塞书')
assert.deepEqual(readingHits(items, '今天修个 CSS', { limit: 3 }), [], '无关话题不硬塞')

// ── 去重：同一句多份副本只留一条 ──
const dup = readingHits([items[0], { ...items[0] }, items[1]], '更上一层楼 长风破浪 困顿', { limit: 3 })
assert.equal(dup.length, 2, '重复三份压成两条')

// ── 渲染 ──
const text = renderReading(hits)
assert.ok(text.includes('【读过的书】'), '有段落标题')
assert.ok(text.includes('王之涣') && text.includes('《登鹳雀楼》'), '出处写全')
assert.ok(text.includes('唐宋诗词精选'), '带书名')
assert.equal(renderReading([]), '', '空列表渲染成空串')

// 历史条目没有篇名时只写摘录 + 书名
const onlyHist = renderReading([hist])
assert.ok(onlyHist.includes('中国历史纲要'), '史料带书名')
assert.ok(!onlyHist.includes('《》'), '没有篇名时不出空书名号')

assert.ok(READING_BOOKS.includes('唐宋诗词精选'), '内置书单含诗词')

console.log('✅ 阅读层全部通过')
