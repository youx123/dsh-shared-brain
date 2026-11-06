/**
 * 知识模块测试：读过的书不能遗忘。
 *
 * 覆盖三件事：
 *   1. 切分与来源识别（一条一个意思、sourceRef 不丢）
 *   2. 索引渲染（书名 + 条数 + 主题进提示词）
 *   3. 不遗忘的三道保险：不进归档候选 / 召回门槛更低 / 复习队列捞得出来
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const SANDBOX = mkdtempSync(join(tmpdir(), 'sb-knowledge-'))
process.env.DSH_HOME = SANDBOX

const {
  KNOWLEDGE_MODULE,
  KNOWLEDGE_MIN_SCORE_RATIO,
  bookOf,
  splitPoints,
  buildKnowledgeIndex,
  renderKnowledgeIndex,
  reviewQueue,
  passesKnowledgeThreshold,
} = await import('../lib/knowledge.js')
const { archiveCandidates } = await import('../lib/memory-graph.js')
const modulesMod = await import('../lib/modules.js')
const { defaultModules, MEMORY_MODULES, MODULE_LABELS } = modulesMod
const { normalizeStore } = await import('../lib/store.js')

let pass = 0
let fail = 0

function test(name, fn) {
  try {
    fn()
    pass += 1
    console.log('  ✓', name)
  } catch (error) {
    fail += 1
    console.log('  ✗', name, '—', String(error?.message ?? error))
  }
}

console.log('\n知识模块')

test('knowledge 是记忆模块，有中文标签', () => {
  assert.ok(MEMORY_MODULES.includes(KNOWLEDGE_MODULE))
  assert.equal(MODULE_LABELS[KNOWLEDGE_MODULE], '知识')
})

test('默认配置里知识模块是开的、权重 0.7', () => {
  const d = defaultModules()
  assert.equal(d.knowledge.enabled, true)
  assert.equal(d.knowledge.weight, 0.7)
  assert.deepEqual(d.knowledge.items, [])
})

test('bookOf 读 sourceRef', () => {
  assert.equal(bookOf({ sourceRef: '《人月神话》' }), '《人月神话》')
})

test('bookOf 兼容 book: 标签', () => {
  assert.equal(bookOf({ tags: ['book:《论语》', 'x'] }), '《论语》')
})

test('bookOf 没来源返回空串', () => {
  assert.equal(bookOf({ text: '随便一句' }), '')
})

test('splitPoints 按行切', () => {
  const out = splitPoints('- 第一点\n- 第二点\n\n第三点')
  assert.deepEqual(out, ['第一点', '第二点', '第三点'])
})

test('splitPoints 去掉 markdown 标题符号', () => {
  assert.deepEqual(splitPoints('## 第三章\n内容一句'), ['第三章', '内容一句'])
})

test('splitPoints 长段落按句切开且不超长', () => {
  const long = '这是一句话。'.repeat(60)
  const out = splitPoints(long, { max: 100 })
  assert.ok(out.length > 1)
  for (const line of out) assert.ok(line.length <= 100, '超长：' + line.length)
})

test('splitPoints 去重', () => {
  assert.deepEqual(splitPoints('同一句\n同一句'), ['同一句'])
})

test('splitPoints 空输入返回空数组', () => {
  assert.deepEqual(splitPoints('   '), [])
  assert.deepEqual(splitPoints(null), [])
})

test('splitPoints 有上限', () => {
  const many = Array.from({ length: 100 }, (_, i) => `第 ${i} 点`).join('\n')
  assert.equal(splitPoints(many, { maxPoints: 10 }).length, 10)
})

test('索引按来源分组并计数', () => {
  const items = [
    { text: 'a', sourceRef: '《A》', tags: ['book:《A》', '缓存'] },
    { text: 'b', sourceRef: '《A》', tags: ['book:《A》', '并发'] },
    { text: 'c', sourceRef: '《B》', tags: [] },
  ]
  const index = buildKnowledgeIndex(items)
  const a = index.find((it) => it.source === '《A》')
  assert.equal(a.count, 2)
  assert.deepEqual(a.topics.sort(), ['并发', '缓存'].sort())
})

test('索引跳过归档条目', () => {
  const index = buildKnowledgeIndex([
    { text: 'a', sourceRef: '《A》', archived: true },
    { text: 'b', sourceRef: '《B》' },
  ])
  assert.deepEqual(index.map((it) => it.source), ['《B》'])
})

test('没写来源的归到「未标注来源」', () => {
  const index = buildKnowledgeIndex([{ text: 'a' }])
  assert.equal(index[0].source, '（未标注来源）')
})

test('索引按条数排序，且有名额上限', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    text: 't',
    sourceRef: `《书${i}》`,
  }))
  items.push({ text: 'x', sourceRef: '《多》' }, { text: 'y', sourceRef: '《多》' })
  const index = buildKnowledgeIndex(items, { limit: 5 })
  assert.equal(index.length, 5)
  assert.equal(index[0].source, '《多》')
})

test('渲染出书名与条数', () => {
  const text = renderKnowledgeIndex([{ source: '《A》', count: 3, topics: ['缓存'] }])
  assert.match(text, /你读过的/)
  assert.match(text, /《A》 · 3 条/)
  assert.match(text, /缓存/)
})

test('空索引渲染成空串', () => {
  assert.equal(renderKnowledgeIndex([]), '')
  assert.equal(renderKnowledgeIndex(null), '')
})

test('知识永远不进归档候选', () => {
  const old = Date.now() - 400 * 86_400_000
  const entries = [
    { id: 'k1', module: 'knowledge', text: '书上的话', updatedAt: old, hits: 0 },
    { id: 'c1', module: 'cognition', text: '闲聊', updatedAt: old, hits: 0 },
  ]
  const graph = { nodes: [{ id: 'k1', degree: 0 }, { id: 'c1', degree: 0 }], edges: [] }
  const list = archiveCandidates(entries, graph)
  assert.deepEqual(list.map((it) => it.id), ['c1'])
})

test('就算显式把 knowledge 传进 modules 也不归档', () => {
  const old = Date.now() - 400 * 86_400_000
  const entries = [{ id: 'k1', module: 'knowledge', text: '书', updatedAt: old, hits: 0 }]
  const list = archiveCandidates(entries, { nodes: [{ id: 'k1', degree: 0 }], edges: [] }, {
    modules: ['knowledge', 'cognition'],
  })
  assert.deepEqual(list, [])
})

test('知识召回门槛比普通模块低', () => {
  assert.ok(KNOWLEDGE_MIN_SCORE_RATIO < 1)
  // 1.2 × 0.7 = 0.84：0.9 在知识这儿算命中，在别的模块不算
  assert.equal(passesKnowledgeThreshold(0.9, 1.2), true)
  assert.equal(passesKnowledgeThreshold(0.5, 1.2), false)
})

test('复习队列捞出久未命中且没用过的', () => {
  const now = Date.now()
  const entries = [
    { id: 'a', text: 'x', updatedAt: now - 60 * 86_400_000, hits: 0 },
    { id: 'b', text: 'y', updatedAt: now - 60 * 86_400_000, hits: 5 },
    { id: 'c', text: 'z', updatedAt: now - 1000, hits: 0 },
    { id: 'd', text: 'w', updatedAt: now - 60 * 86_400_000, hits: 0, archived: true },
  ]
  const list = reviewQueue(entries, { now, idleDays: 30, maxHits: 0 })
  assert.deepEqual(list.map((it) => it.id), ['a'])
})

test('复习队列按命中次数升序', () => {
  const now = Date.now()
  const entries = [
    { id: 'more', text: 'x', updatedAt: now - 50 * 86_400_000, hits: 2 },
    { id: 'less', text: 'y', updatedAt: now - 50 * 86_400_000, hits: 0 },
  ]
  const list = reviewQueue(entries, { now, idleDays: 30, maxHits: 3 })
  assert.deepEqual(list.map((it) => it.id), ['less', 'more'])
})

test('normalizeStore 保住 sourceRef（不然知识就没了出处）', () => {
  const store = normalizeStore({
    version: 1,
    entries: [
      { id: 'k1', text: '书上的话', module: 'knowledge', sourceRef: '《A》', weight: 0.7 },
    ],
  })
  assert.equal(store.entries[0].sourceRef, '《A》')
})

test('normalizeStore 里的 knowledge 条目保留模块名', () => {
  const store = normalizeStore({
    version: 1,
    entries: [{ id: 'k1', text: 't', module: 'knowledge', weight: 0.7 }],
  })
  assert.equal(store.entries[0].module, 'knowledge')
})

test('putModuleItem 入库时保住 sourceRef（否则写盘就丢了出处）', () => {
  const { putModuleItem, defaultModules } = modulesMod
  const modules = defaultModules()
  putModuleItem(modules, 'knowledge', {
    text: '缓存穿透用布隆过滤器',
    weight: 0.7,
    sourceRef: '《缓存实战》',
    lifetime: 'permanent',
  })
  assert.equal(modules.knowledge.items.length, 1)
  assert.equal(modules.knowledge.items[0].sourceRef, '《缓存实战》')
})

test('putModuleItem 只在 knowledge 模块保留 sourceRef', () => {
  const { putModuleItem, defaultModules } = modulesMod
  const modules = defaultModules()
  putModuleItem(modules, 'cognition', { text: '一句话', sourceRef: '《不该在这》' })
  assert.equal(modules.cognition.items[0].sourceRef, undefined)
})

rmSync(SANDBOX, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) process.exit(1)
