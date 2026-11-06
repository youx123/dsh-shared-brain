/**
 * 共享大脑 · 记忆图谱（memory-graph.js）功能测试
 *
 * 跑法：
 *   node "<本文件路径>"
 *
 * 只读 + 临时目录；不碰真实的 ~/.dsh/storages/dsh-shared-brain（靠 DSH_HOME 隔离）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-graph-test-'))
process.env.DSH_HOME = SANDBOX

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

const G = await import(`file:///${LIB}/memory-graph.js`)
const S = await import(`file:///${LIB}/store.js`)

const NOW = Date.now()
const DAY = 86_400_000

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

/** 造一条记忆条目。 */
function entry(id, text, extra = {}) {
  return {
    id,
    text,
    tags: [],
    module: 'cognition',
    weight: 0.5,
    lifetime: 'permanent',
    expiresAt: 0,
    ttlMs: 0,
    pinned: false,
    source: 'auto',
    scope: 'global',
    scopePath: '',
    scopeSession: '',
    supersedes: '',
    sessionId: '',
    cwd: '',
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    hits: 0,
    ...extra,
  }
}

process.stdout.write('\n共享大脑 · 记忆图谱测试\n\n')

// ---------------------------------------------------------------- 建图

test('buildGraph：给两条记忆建出节点', () => {
  const graph = G.buildGraph([
    entry('m1', '共享大脑的记忆图谱要做节点和边'),
    entry('m2', '桌宠要跟共享大脑联动'),
  ])
  assert.equal(graph.nodes.filter((n) => n.type === 'memory').length, 2)
  assert.ok(graph.version === G.GRAPH_VERSION)
})

test('buildGraph：噪声 tag 不该变成实体节点', () => {
  const graph = G.buildGraph([
    entry('m1', '一条记忆', { tags: ['dsh', 'json', 'https', 'github', 'users'] }),
  ])
  const entities = graph.nodes.filter((n) => n.type === 'entity')
  assert.equal(entities.length, 0, `不该有实体，实际：${entities.map((e) => e.label).join(',')}`)
})

test('buildGraph：有意义的 tag 会变成实体节点并连 mentions 边', () => {
  const graph = G.buildGraph([
    entry('m1', '桌宠项目在推进', { tags: ['项目:dsh-pet-brain'] }),
  ])
  const ent = graph.nodes.find((n) => n.type === 'entity')
  assert.ok(ent, '应该有实体节点')
  assert.equal(ent.label, 'dsh-pet-brain')
  const edge = graph.edges.find((e) => e.kind === 'mentions')
  assert.ok(edge, '应该有 mentions 边')
})

test('buildGraph：supersedes 生成取代边', () => {
  const graph = G.buildGraph([
    entry('m1', '新版本的说法', { supersedes: 'm0' }),
    entry('m0', '旧版本的说法'),
  ])
  const edge = graph.edges.find((e) => e.kind === 'supersedes')
  assert.ok(edge)
  assert.equal(edge.from, 'm1')
  assert.equal(edge.to, 'm0')
})

test('buildGraph：内容相近的两条记忆连 cooccur 边', () => {
  const graph = G.buildGraph([
    entry('m1', '共享大脑的记忆图谱需要节点和边来做可视化'),
    entry('m2', '共享大脑的记忆图谱需要节点和边来做遗忘机制'),
  ])
  const edge = graph.edges.find((e) => e.kind === 'cooccur')
  assert.ok(edge, '相近内容应该连边')
})

test('buildGraph：归档条目不进活跃图', () => {
  const graph = G.buildGraph([
    entry('m1', '还在的记忆'),
    entry('m2', '归档了的记忆', { archived: true, archivedAt: NOW, archiveReason: 'x' }),
  ])
  assert.equal(graph.nodes.filter((n) => n.type === 'memory').length, 1)
  assert.equal(graph.stats.archived, 1)
})

test('buildGraph：entityExtractor 回调可用（LLM 抽取的插口）', () => {
  const graph = G.buildGraph([entry('m1', '随便一条')], {
    entityExtractor: () => ['小龙虾'],
  })
  const ent = graph.nodes.find((n) => n.type === 'entity')
  assert.ok(ent)
  assert.equal(ent.label, '小龙虾')
})

test('buildGraph：extractor 抛错不该拖垮建图', () => {
  const graph = G.buildGraph([entry('m1', '随便一条')], {
    entityExtractor: () => {
      throw new Error('boom')
    },
  })
  assert.ok(graph.nodes.length >= 1)
})

// ---------------------------------------------------------------- 顺边召回

test('expandWithNeighbors：命中一条能带出邻居', () => {
  const entries = [
    entry('m1', '共享大脑的记忆图谱需要节点和边来做可视化'),
    entry('m2', '共享大脑的记忆图谱需要节点和边来做遗忘机制'),
  ]
  const graph = G.buildGraph(entries)
  const index = new Map(entries.map((e) => [e.id, e]))
  const hits = [{ entry: entries[0], score: 5 }]
  const { neighbors } = G.expandWithNeighbors(hits, graph, index)
  assert.equal(neighbors.length, 1)
  assert.equal(neighbors[0].entry.id, 'm2')
  assert.ok(neighbors[0].score < 5, '邻居分数必须低于原命中')
})

test('expandWithNeighbors：不会把已命中的重复带出来', () => {
  const entries = [
    entry('m1', '共享大脑的记忆图谱需要节点和边来做可视化'),
    entry('m2', '共享大脑的记忆图谱需要节点和边来做遗忘机制'),
  ]
  const graph = G.buildGraph(entries)
  const index = new Map(entries.map((e) => [e.id, e]))
  const hits = [
    { entry: entries[0], score: 5 },
    { entry: entries[1], score: 4 },
  ]
  const { neighbors } = G.expandWithNeighbors(hits, graph, index)
  assert.equal(neighbors.length, 0)
})

test('expandWithNeighbors：实体会被单独返回，不混进提示词邻居', () => {
  const entries = [entry('m1', '桌宠项目在推进', { tags: ['项目:pet-brain'] })]
  const graph = G.buildGraph(entries)
  const index = new Map(entries.map((e) => [e.id, e]))
  const { neighbors, entities } = G.expandWithNeighbors([{ entry: entries[0], score: 3 }], graph, index)
  assert.equal(neighbors.length, 0)
  assert.equal(entities.length, 1)
  assert.equal(entities[0].label, 'pet-brain')
})

// ---------------------------------------------------------------- 遗忘 / 归档

test('archiveCandidates：pinned 不进候选', () => {
  const candidates = G.archiveCandidates(
    [entry('m1', '老记忆', { pinned: true, updatedAt: NOW - 400 * DAY })],
    { nodes: [] },
    { now: NOW },
  )
  assert.equal(candidates.length, 0)
})

test('archiveCandidates：emotion / bottomline 不自动归档', () => {
  const candidates = G.archiveCandidates(
    [entry('m1', '老记忆', { module: 'emotion', updatedAt: NOW - 400 * DAY })],
    { nodes: [] },
    { now: NOW },
  )
  assert.equal(candidates.length, 0)
})

test('archiveCandidates：新的、热的记忆不进候选', () => {
  const candidates = G.archiveCandidates(
    [entry('m1', '刚写的', { updatedAt: NOW - 1000 })],
    { nodes: [] },
    { now: NOW },
  )
  assert.equal(candidates.length, 0)
})

test('archiveCandidates：又老又没人理又孤立的进候选（strong）', () => {
  const candidates = G.archiveCandidates(
    [entry('m1', '一条被遗忘的记忆', { updatedAt: NOW - 400 * DAY, hits: 0 })],
    { nodes: [{ id: 'm1', degree: 0 }] },
    { now: NOW },
  )
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].tier, 'strong')
})

test('archiveCandidates：图上还有邻居的只算 normal', () => {
  const candidates = G.archiveCandidates(
    [entry('m1', '一条被遗忘的记忆', { updatedAt: NOW - 200 * DAY, hits: 1 })],
    { nodes: [{ id: 'm1', degree: 3 }] },
    { now: NOW, maxDegree: 1 },
  )
  assert.equal(candidates.length, 0)
})

test('markArchived：只打标记，文本一条不少', () => {
  const entries = [entry('m1', '要归档的记忆')]
  const { entries: next, changed } = G.markArchived(entries, ['m1'], 'graph-isolated', NOW)
  assert.equal(changed, 1)
  assert.equal(next.length, 1)
  assert.equal(next[0].text, '要归档的记忆')
  assert.equal(next[0].archived, true)
  assert.equal(next[0].archiveReason, 'graph-isolated')
})

test('unmarkArchived：能恢复', () => {
  const entries = [entry('m1', '要归档的记忆')]
  const marked = G.markArchived(entries, ['m1'], 'x', NOW).entries
  const { entries: restored, changed } = G.unmarkArchived(marked, ['m1'])
  assert.equal(changed, 1)
  assert.equal(restored[0].archived, undefined)
})

test('normalizeStore：归档标记能活过规范化（不复活）', () => {
  const store = S.normalizeStore({
    version: 1,
    entries: [
      { id: 'm1', text: '归档过的记忆', archived: true, archivedAt: NOW, archiveReason: 'r' },
      { id: 'm2', text: '正常记忆' },
    ],
  })
  const m1 = store.entries.find((e) => e.id === 'm1')
  assert.equal(m1.archived, true)
  assert.equal(m1.archiveReason, 'r')
  assert.equal(store.entries.find((e) => e.id === 'm2').archived, undefined)
})

test('writeStore + readStore：归档标记落盘后仍在', () => {
  const store = S.normalizeStore({
    version: 1,
    entries: [{ id: 'm9', text: '落盘测试', archived: true, archivedAt: NOW, archiveReason: 'r2' }],
  })
  S.writeStore(store)
  const back = S.readStore()
  const m9 = back.entries.find((e) => e.id === 'm9')
  assert.equal(m9.archived, true)
  assert.equal(m9.archiveReason, 'r2')
})

// ---------------------------------------------------------------- 图谱落盘

test('writeGraph + readGraph：往返不丢', () => {
  const graph = G.buildGraph([entry('m1', '图谱落盘测试条目')], { now: NOW })
  G.writeGraph(graph)
  const back = G.readGraph()
  assert.ok(back)
  assert.equal(back.nodes.length, graph.nodes.length)
  assert.ok(Array.isArray(back.adjacency))
})

test('readGraph：文件不存在返回 null', () => {
  // source: 'file' 强制走文件 —— 不加的话会优先读 SQLite 表，
  // 而表是全局的，别的用例写过图就在这里拿到数据了。
  assert.equal(G.readGraph(join(SANDBOX, 'nope', 'graph.json'), { source: 'file' }), null)
})

// ------------------------------------------------------ 性能 / 枢纽实体阻尼

test('readGraph：同文件二次读命中缓存（不再重新解析）', () => {
  const graph = G.buildGraph([entry('c1', '缓存测试 记忆图谱缓存')], { now: NOW })
  G.writeGraph(graph)
  const first = G.readGraph()
  const second = G.readGraph()
  assert.ok(first)
  // 命中缓存时返回的是同一个对象引用；重新解析会得到新对象
  assert.equal(first, second)
})

test('readGraph：文件被外部改写后缓存失效', () => {
  const graph = G.buildGraph([entry('c2', '缓存失效 记忆图谱')], { now: NOW })
  const file = G.writeGraph(graph) && G.graphFile()
  const first = G.readGraph(file, { source: 'file' })
  assert.ok(first)
  writeFileSync(file, JSON.stringify({ ...first, nodes: [] }, null, 2), 'utf8')
  const second = G.readGraph(file, { source: 'file' })
  assert.notEqual(first, second)
  assert.equal(second.nodes.length, 0)
})

test('expandWithNeighbors：枢纽实体按 1/sqrt(度数) 阻尼，分数低于不加阻尼', () => {
  // hub 实体被 4 条记忆共用，leaf 实体只被 2 条共用
  const entries = [
    entry('h1', '一号记录', { tags: ['hub'] }),
    entry('h2', '二号记录', { tags: ['hub'] }),
    entry('h3', '三号记录', { tags: ['hub'] }),
    entry('h4', '四号记录', { tags: ['hub'] }),
  ]
  const graph = G.buildGraph(entries, { now: NOW, cooccurThreshold: 2 })
  const index = new Map(entries.map((e) => [e.id, e]))
  const damped = G.expandWithNeighbors([{ entry: entries[0], score: 10 }], graph, index, { limit: 5 })
  const plain = G.expandWithNeighbors([{ entry: entries[0], score: 10 }], graph, index, { limit: 5, hubDamping: false })
  assert.ok(damped.neighbors.length > 0, '应该带出邻居')
  assert.equal(damped.neighbors[0].viaKind, 'entity', '关掉共现后邻居只能来自实体桥')
  const maxDamped = damped.neighbors[0].score
  const maxPlain = plain.neighbors[0].score
  assert.ok(maxDamped < maxPlain, `阻尼后应更小：${maxDamped} < ${maxPlain}`)
})

test('expandWithNeighbors：同一实体最多带 maxPerEntity 条邻居', () => {
  const entries = [
    entry('p1', '一号记录', { tags: ['hub'] }),
    entry('p2', '二号记录', { tags: ['hub'] }),
    entry('p3', '三号记录', { tags: ['hub'] }),
    entry('p4', '四号记录', { tags: ['hub'] }),
  ]
  const graph = G.buildGraph(entries, { now: NOW, cooccurThreshold: 2 })
  const index = new Map(entries.map((e) => [e.id, e]))
  const out = G.expandWithNeighbors([{ entry: entries[0], score: 10 }], graph, index, { limit: 5, maxPerEntity: 1 })
  const viaHub = out.neighbors.filter((n) => n.viaEntity === 'hub')
  assert.ok(viaHub.length <= 1, `同一实体不应超过 1 条，实际 ${viaHub.length}`)
})

test('writeGraph：落盘后直接进缓存，读回不再触发解析', () => {
  const graph = G.buildGraph([entry('w1', '写盘缓存 记忆图谱')], { now: NOW })
  const payload = G.writeGraph(graph)
  const back = G.readGraph()
  assert.ok(back)
  assert.equal(back.nodes.length, payload.nodes.length)
  assert.equal(back.stats.memories, payload.stats.memories)
})

// ---------------------------------------------------------------- 真实库冒烟

test('真实记忆库：能建图且不炸', () => {
  const realHome = process.env.USERPROFILE
  void realHome
  // 用沙箱里手工造一份库，模拟真实场景：噪声 tag + 有意义 tag + 老记忆
  mkdirSync(join(SANDBOX, 'storages', 'dsh-shared-brain'), { recursive: true })
  // 2026-11-06：readStore 现在优先读 SQLite，直接写 memory.json 已经不管用了。
  // 走统一写入口径（writeStore 会落库），符合新的存储契约。
  S.writeStore({
    version: 1,
    updatedAt: NOW,
    entries: [
      // 显式写 module：走 SQLite 时没有 normalizeStore 帮忙补默认值了，
      // 缺 module 的条目在归档判据里会被当成"不认识的模块"直接跳过。
      { id: 'a', module: 'cognition', text: '共享大脑的图谱能力要接记忆节点', tags: ['项目:shared-brain'], hits: 3, updatedAt: NOW },
      // 2026-11-06：正文关键词也进实体之后，两条文本一样的记忆会通过共用词连成边，
      // 就不再「孤立」了 —— 而孤立正是进归档候选的前提。这条老的换成不相干内容，
      // 才是用例真正想验的「又老、又没人理、又孤立」。
      { id: 'b', module: 'cognition', text: '完全不搭界的另一句，与上面没有共同点', tags: ['dsh', 'json'], hits: 0, updatedAt: NOW - 500 * DAY },
    ],
  })
  const store = S.readStore()
  const graph = G.buildGraph(store.entries, { now: NOW })
  assert.ok(graph.nodes.length >= 2)
  assert.ok(graph.stats.entities >= 1)
  const candidates = G.archiveCandidates(store.entries, graph, { now: NOW })
  assert.ok(candidates.length >= 1, '老记忆应该进候选')
})

process.stdout.write(`\n通过 ${passed} / 失败 ${failed}\n`)
try {
  rmSync(SANDBOX, { recursive: true, force: true })
} catch {
  /* 清理失败无所谓 */
}
if (failed > 0) {
  process.stdout.write('\n失败详情：\n')
  for (const f of failures) {
    process.stdout.write(`  - ${f.name}: ${f.error && f.error.stack ? f.error.stack : f.error}\n`)
  }
  process.exitCode = 1
}
