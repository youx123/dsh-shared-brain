/**
 * 六项性能改造的回归测试（行为正确性，不测时间数字）
 *
 * PERF-1 hits 增量延迟合并写盘（含续期、真写不受影响）
 * PERF-2 readStore / readModules 的 mtime 缓存与失效
 * PERF-3 倒排索引与缓存：召回结果必须和逐条 scoreEntry 完全一致
 * PERF-4 图谱 index.json 的 mtime 缓存
 * PERF-5 renderVoice / renderCapabilities 与人设整行去重
 * PERF-6 emojiStatus 复用 scanEmojiPacksCached
 *
 * 跑法：node tests/perf.test.mjs
 * 全部用临时 DSH_HOME，不碰真实记忆库。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-perf-test-'))
process.env.DSH_HOME = SANDBOX

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')
const load = (name) => import(pathToFileURL(join(LIB, name)).href)

const S = await load('store.js')
const M = await load('modules.js')
const R = await load('recall.js')
const G = await load('graph-expand.js')
const W = await load('weighted-recall.js')
const E = await load('emoji.js')

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log('  ✓', name)
  } catch (error) {
    failed++
    failures.push(`${name}: ${error && error.message ? error.message : error}`)
    console.log('  ✗', name, '—', error && error.message ? error.message : error)
  }
}
function group(name) {
  console.log(`\n${name}`)
}
function ok(value, label = '') {
  if (!value) throw new Error(`${label} 期望为真，实际 ${JSON.stringify(value)}`)
}
function equal(actual, expected, label = '') {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label} 期望 ${b}，实际 ${a}`)
}

function entry(id, over = {}) {
  return {
    id,
    text: `测试记忆 ${id}`,
    tags: [],
    module: 'cognition',
    weight: 0.5,
    lifetime: 'permanent',
    source: 'manual',
    sessionId: '',
    cwd: '',
    createdAt: 1,
    updatedAt: 1,
    hits: 0,
    ...over,
  }
}
function readRaw(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}
function rawEntry(id) {
  return readRaw(S.brainFile()).entries.find((it) => it.id === id)
}
// Windows 上杀毒软件偶尔会短暂占用 memory.json，导致 rename 报 EPERM；
// 这里只对 EPERM 做几次重试，测试的目的是验证 pending 语义，不是磁盘时序。
function flushStore() {
  let last = null
  for (let i = 0; i < 6; i++) {
    try {
      S.writeStore(S.readStore())
      return
    } catch (error) {
      last = error
      if (error?.code !== 'EPERM') throw error
      const until = Date.now() + 50
      while (Date.now() < until) { /* 短暂等待后重试 */ }
    }
  }
  throw last
}

mkdirSync(join(SANDBOX, 'storages', 'dsh-shared-brain'), { recursive: true })

// ─────────────────────────────────────────────────────────────
group('PERF-1 hits 延迟合并写盘')

await test('只记 pending 时不会写盘', () => {
  S.writeStore({ entries: [entry('p1')] })
  const before = readFileSync(S.brainFile())
  S.notePendingHit('p1', 1)
  const after = readFileSync(S.brainFile())
  ok(before.equals(after), 'pending 阶段不应该有磁盘写入')
  ok(S.hasPendingMutations(), 'pending 标记应该存在')
})

await test('多次 hits 合并成一次写，最终值正确', () => {
  S.writeStore({ entries: [entry('p2')] })
  S.notePendingHit('p2', 1)
  S.notePendingHit('p2', 1)
  S.notePendingHit('p2', 1)
  ok(rawEntry('p2').hits === 0, 'flush 之前磁盘上还是旧值')
  flushStore()
  equal(rawEntry('p2').hits, 3, '合并后 hits')
  ok(!S.hasPendingMutations(), 'flush 之后 pending 应该清空')
})

await test('temporary 续期和 hits 一起落盘', () => {
  const now = Date.now()
  S.writeStore({
    entries: [entry('p3', { lifetime: 'temporary', ttlMs: 60_000, expiresAt: now + 30_000 })],
  })
  S.notePendingHit('p3', 1)
  S.notePendingRenewal('p3', { expiresAt: now + 600_000, ttlMs: 600_000, updatedAt: now + 1000 })
  flushStore()
  const saved = rawEntry('p3')
  equal(saved.hits, 1, 'hits')
  equal(saved.expiresAt, now + 600_000, 'expiresAt')
  equal(saved.ttlMs, 600_000, 'ttlMs')
  equal(saved.updatedAt, now + 1000, 'updatedAt')
})

await test('新增条目这类真写立即落盘，且不丢 pending hits', () => {
  S.writeStore({ entries: [entry('p4')] })
  S.notePendingHit('p4', 2)
  const store = S.readStore()
  store.entries.push(entry('p4-new'))
  S.writeStore(store)
  equal(rawEntry('p4').hits, 2, '老条目 hits 被同一次写带下去')
  ok(rawEntry('p4-new'), '新条目立即落盘')
})

await test('写失败之外的正常写会清空 pending', () => {
  S.writeStore({ entries: [entry('p5')] })
  S.notePendingHit('p5', 1)
  flushStore()
  ok(!S.hasPendingMutations(), 'pending 应清空')
  flushStore()
  equal(rawEntry('p5').hits, 1, '再次写不会重复叠加')
})

// ─────────────────────────────────────────────────────────────
group('PERF-2 readStore / readModules 缓存')

await test('readStore 命中缓存但返回深拷贝', () => {
  S.writeStore({ entries: [entry('c1')] })
  const first = S.readStore()
  const second = S.readStore()
  ok(first !== second, '两次读不能是同一个对象')
  ok(first.entries !== second.entries, 'entries 数组也要分开')
  ok(first.entries[0] !== second.entries[0], '条目对象也要分开')
  equal(second.entries[0].text, first.entries[0].text, '内容一致')
})

await test('改返回值不会污染缓存', () => {
  S.writeStore({ entries: [entry('c2', { text: '原始内容' })] })
  const first = S.readStore()
  first.entries[0].text = '被就地改了'
  first.entries.push(entry('c2-extra'))
  const second = S.readStore()
  equal(second.entries[0].text, '原始内容', '缓存里的正文不能被改')
  equal(second.entries.length, 1, '缓存里的条目数不能被改')
})

await test('writeStore 之后缓存立刻失效', () => {
  S.writeStore({ entries: [entry('c3', { text: '旧内容' })] })
  S.readStore()
  S.writeStore({ entries: [entry('c3', { text: '新内容' }), entry('c3b')] })
  const after = S.readStore()
  equal(after.entries.length, 2, '条目数')
  equal(after.entries.find((it) => it.id === 'c3').text, '新内容', '正文')
})

await test('外部直接改文件（绕过 writeStore）也能读到', () => {
  S.writeStore({ entries: [entry('c4', { text: '旧' })] })
  S.readStore()
  const file = S.brainFile()
  const raw = readRaw(file)
  raw.entries[0].text = '外部写入的新内容加长一点'
  raw.entries.push(entry('c4-ext'))
  writeFileSync(file, JSON.stringify(raw), 'utf8')
  const future = new Date(Date.now() + 3000)
  utimesSync(file, future, future)
  const after = S.readStore()
  equal(after.entries.find((it) => it.id === 'c4').text, '外部写入的新内容加长一点', '正文')
  ok(after.entries.some((it) => it.id === 'c4-ext'), '外部新增条目可见')
})

await test('readModules 命中缓存返回深拷贝，写后失效', () => {
  const base = M.readModules()
  M.writeModules(base)
  const first = M.readModules()
  const second = M.readModules()
  ok(first !== second, '两次读不能是同一个对象')
  ok(first.voice !== second.voice, '子对象也要分开')
  first.voice.enabled = true
  first.voice.style = { tone: '被改的' }
  const third = M.readModules()
  ok(third.voice !== first.voice, '缓存不能被就地改污染')

  const changed = M.readModules()
  changed.network = { ...changed.network, enabled: false }
  M.writeModules(changed)
  equal(M.readModules().network.enabled, false, '写后应看到新值')
})

await test('外部改 modules.json 也能读到', () => {
  const file = M.modulesFile()
  M.writeModules(M.readModules())
  const cached = M.readModules()
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.agentive = { ...raw.agentive, enabled: false }
  raw.updatedAt = (raw.updatedAt ?? 0) + 7
  writeFileSync(file, JSON.stringify(raw), 'utf8')
  const future = new Date(Date.now() + 3000)
  utimesSync(file, future, future)
  ok(cached !== null)
  equal(M.readModules().agentive.enabled, false, '外部修改应可见')
})

// ─────────────────────────────────────────────────────────────
group('PERF-3 倒排索引召回等价性')

let seed = 987654321
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
function pick(list) {
  return list[Math.floor(rnd() * list.length)]
}
const WORDS = [
  '共享记忆', '记忆库', '召回', '性能', '插件', '测试', '部署', '缓存', '索引', '延迟',
  '写入', '读取', '磁盘', '同步', '人设', '情感', '底线', '认知', '本能', '声音',
  'memory', 'recall', 'cache', 'index', 'plugin', 'store', 'write', 'read', 'graph',
  'node', 'sync', 'persona', 'emoji', 'voice', 'network', 'agentive', 'performance',
]
function makeText() {
  const n = 4 + Math.floor(rnd() * 16)
  const parts = []
  for (let i = 0; i < n; i++) parts.push(pick(WORDS))
  return parts.join(pick([' ', '，', '', '、']))
}
function makeEntries(count) {
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({
      id: `r_${i}`,
      text: makeText(),
      tags: rnd() < 0.5 ? [pick(WORDS)] : [],
      updatedAt: 1_700_000_000_000 + Math.floor(rnd() * 40) * 86_400_000,
    })
  }
  return out
}
function naive(entries, query, options) {
  const limit = options.limit ?? 6
  const minScore = options.minScore ?? 1.2
  const now = options.now
  const terms = R.queryTerms(query)
  if (terms.length === 0) return []
  const scored = []
  for (const item of entries) {
    const score = R.scoreEntry(item, terms, now)
    if (score >= minScore) scored.push({ entry: item, score })
  }
  scored.sort((a, b) => b.score - a.score || (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0))
  return scored.slice(0, limit)
}
function shape(list) {
  return list.map((hit) => ({ id: hit.entry.id, score: hit.score }))
}

await test('批量召回与逐条 scoreEntry 完全一致（含子串语义）', () => {
  const entries = makeEntries(40)
  const now = 1_710_000_000_000
  for (let q = 0; q < 12; q++) {
    const query = makeText()
    equal(
      shape(R.recall(entries, query, { now, limit: 8 })),
      shape(naive(entries, query, { now, limit: 8 })),
      `query=${query}`,
    )
  }
})

await test('子串匹配不退化成精确 token（记忆 → 记忆库）', () => {
  const entries = [
    entry('sub1', { text: '记忆库需要定期整理', tags: [], updatedAt: 1_700_000_000_000 }),
    entry('sub2', { text: '完全无关的一句话', tags: [], updatedAt: 1_700_000_000_000 }),
  ]
  const opts = { now: 1_710_000_000_000, minScore: 1 }
  const hits = R.recall(entries, '记忆', opts)
  ok(hits.some((hit) => hit.entry.id === 'sub1'), '记忆库应该被「记忆」子串命中')
  ok(!hits.some((hit) => hit.entry.id === 'sub2'), '无关条目不应命中')
  equal(shape(hits), shape(naive(entries, '记忆', opts)), '与朴素实现一致')
})

await test('条目改动后索引/缓存跟着变', () => {
  const entries = [
    entry('mut1', { text: '缓存 索引 性能', updatedAt: 1_700_000_000_000 }),
    entry('mut2', { text: '情感 人设 底线', updatedAt: 1_700_000_000_000 }),
  ]
  const now = 1_710_000_000_000
  const before = R.recall(entries, '缓存', { now })
  ok(before.some((hit) => hit.entry.id === 'mut1'), '改之前应命中')
  entries[0] = { ...entries[0], text: '完全换成别的内容', updatedAt: 1_700_000_000_500 }
  const after = R.recall(entries, '缓存', { now })
  ok(!after.some((hit) => hit.entry.id === 'mut1'), '改之后不该再命中旧词')
  equal(shape(after), shape(naive(entries, '缓存', { now })), '改动后仍与朴素实现一致')
})

await test('标签命中的权重语义不变', () => {
  const entries = [
    entry('tag1', { text: '和标签无关的正文', tags: ['缓存'], updatedAt: 1_700_000_000_000 }),
    entry('tag2', { text: '正文里写了缓存两个字', tags: [], updatedAt: 1_700_000_000_000 }),
  ]
  const now = 1_710_000_000_000
  const opts = { now, minScore: 1 }
  const hits = R.recall(entries, '缓存', opts)
  const a = hits.find((hit) => hit.entry.id === 'tag1')
  const b = hits.find((hit) => hit.entry.id === 'tag2')
  ok(a && b, '两个都应该命中')
  ok(a.score > b.score, '标签命中比正文命中权重高')
  equal(shape(hits), shape(naive(entries, '缓存', opts)), '与朴素实现一致')
})

// ─────────────────────────────────────────────────────────────
group('PERF-4 图谱索引缓存')

const GRAPH_DIR = join(SANDBOX, 'storages', 'dsh-dir-graph')
const GRAPH_FILE = join(GRAPH_DIR, 'index.json')

await test('重复读取命中缓存（同一引用）且内容正确', () => {
  mkdirSync(GRAPH_DIR, { recursive: true })
  writeFileSync(
    GRAPH_FILE,
    JSON.stringify({ nodes: { a: { path: 'A' } }, roots: ['A'] }),
    'utf8',
  )
  const first = G.readGraphIndex()
  const second = G.readGraphIndex()
  ok(first, '应能读到索引')
  ok(first === second, '缓存命中应返回同一对象')
  equal(first.roots, ['A'], '内容')
})

await test('索引文件变化后重新读取', () => {
  writeFileSync(
    GRAPH_FILE,
    JSON.stringify({ nodes: { a: { path: 'A' }, b: { path: 'B' } }, roots: ['A', 'B'] }),
    'utf8',
  )
  const future = new Date(Date.now() + 3000)
  utimesSync(GRAPH_FILE, future, future)
  const next = G.readGraphIndex()
  equal(next.roots, ['A', 'B'], '新内容应可见')
})

await test('索引文件缺失返回 null，重建后恢复', () => {
  rmSync(GRAPH_FILE)
  equal(G.readGraphIndex(), null, '缺失时')
  writeFileSync(GRAPH_FILE, JSON.stringify({ nodes: {}, roots: [] }), 'utf8')
  const again = G.readGraphIndex()
  ok(again, '重建后应能读到')
  equal(again.roots, [], '内容')
})

// ─────────────────────────────────────────────────────────────
group('PERF-5 人设整行去重')

const VOICE_MODULES = {
  voice: {
    enabled: true,
    weight: 0.7,
    style: {
      tone: '口语、短句',
      tics: ['行', '我猜'],
      address: '小深',
      speech: { voiceName: '晓伊', rate: 0.98, pitch: 0.98, volume: 1 },
    },
    items: [{ text: '别端着', weight: 1 }],
  },
}
const CAP_MODULES = {
  network: { enabled: true },
  agentive: { enabled: true, timeWindow: { enabled: false }, scope: 'all' },
}
const EMOJI_OPTS = { emoji: { dir: '', exists: false, items: [], count: 0 }, emojiPacks: { dir: '', packs: [] } }

await test('人设包含完整声音段时该段被整行去掉', () => {
  const full = W.renderVoice(VOICE_MODULES, { ...EMOJI_OPTS })
  ok(full.length > 0, '先要能渲染出内容')
  const deduped = W.renderVoice(VOICE_MODULES, { ...EMOJI_OPTS, personaText: full })
  equal(deduped, '', '整段都重复时应全部去掉')
})

await test('人设包含完整能力段时该段被整行去掉', () => {
  const full = W.renderCapabilities(CAP_MODULES, {})
  ok(full.length > 0, '先要能渲染出内容')
  const deduped = W.renderCapabilities(CAP_MODULES, { personaText: full })
  equal(deduped, '', '整段都重复时应全部去掉')
})

await test('只重复网络那行时只去掉网络，自动互动保留', () => {
  const full = W.renderCapabilities(CAP_MODULES, {})
  const networkLine = full.split('\n').find((line) => line.startsWith('【网络】'))
  ok(networkLine, '应有网络行')
  const deduped = W.renderCapabilities(CAP_MODULES, { personaText: networkLine })
  ok(!deduped.includes('【网络】'), '网络行应去掉')
  ok(deduped.includes('【自动互动】'), '自动互动应保留')
})

await test('人设里没有这些行时输出完全不变', () => {
  const plain = W.renderVoice(VOICE_MODULES, { ...EMOJI_OPTS })
  const withUnrelated = W.renderVoice(VOICE_MODULES, {
    ...EMOJI_OPTS,
    personaText: '我是一只小鲸鱼，喜欢深蓝色。',
  })
  equal(withUnrelated, plain, '无关人设不应影响输出')
  const caps = W.renderCapabilities(CAP_MODULES, {})
  const capsUnrelated = W.renderCapabilities(CAP_MODULES, { personaText: '一条不相干的人设' })
  equal(capsUnrelated, caps, '无关人设不应影响能力段')
})

// ─────────────────────────────────────────────────────────────
group('PERF-6 emojiStatus 复用包扫描缓存')

await test('连续两次 emojiStatus 复用同一份 packs 数组', () => {
  const a = E.emojiStatus({})
  const b = E.emojiStatus({})
  ok(Array.isArray(a.packs), 'packs 是数组')
  ok(a.packs === b.packs, '缓存命中应返回同一个数组引用')
})

await test('清掉缓存后重新扫描（不再复用旧数组）', () => {
  const before = E.emojiStatus({})
  E.clearEmojiPackCache()
  const after = E.emojiStatus({})
  ok(before.packs !== after.packs, '清缓存后应是新数组')
  equal(after.packs.length, before.packs.length, '内容仍然一致')
})

// ─────────────────────────────────────────────────────────────
try {
  const { closeDb } = await import('../lib/db.js')
  closeDb()
} catch {
  /* 没有 db.js 就跳过 */
}
try {
  rmSync(SANDBOX, { recursive: true, force: true })
} catch {
  /* Windows 上 WAL 可能还被持有，清理失败不影响测试结论 */
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  for (const line of failures) console.log('  ✗', line)
  process.exit(1)
}
