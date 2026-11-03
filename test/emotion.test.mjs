/**
 * 共享大脑 · 情感模块（emotion.js + 心情 mood）功能测试
 *
 * 跑法：
 *   cd "/c/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib"
 *   node "<本文件路径>"
 *
 * 只读 + 临时目录；不碰真实的 ~/.dsh/storages/dsh-shared-brain（靠 DSH_HOME 隔离）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-emotion-test-'))
process.env.DSH_HOME = SANDBOX

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

const E = await import(`file:///${LIB}/emotion.js`)
const C = await import(`file:///${LIB}/classify.js`)
const M = await import(`file:///${LIB}/modules.js`)
const W = await import(`file:///${LIB}/weighted-recall.js`)
const S = await import(`file:///${LIB}/store.js`)

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

async function atest(name, fn) {
  try {
    await fn()
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

// ───────────────────────────────────────────────────────────────────
group('一、语义结构')

test('detectSentiment 认得出喜欢/讨厌/爱/担心', () => {
  assert.equal(E.detectSentiment('老大喜欢简洁的回复'), 'like')
  assert.equal(E.detectSentiment('我讨厌啰嗦'), 'dislike')
  assert.equal(E.detectSentiment('我爱你'), 'love')
  assert.equal(E.detectSentiment('我有点担心这件事'), 'worry')
  assert.equal(E.detectSentiment('今天天气不错'), 'neutral')
})

test('detectTarget 认得出称呼与「关于X」', () => {
  assert.equal(E.detectTarget('老大喜欢简洁的回复'), '老大')
  // 「关于X」后面按 1-20 字取，所以是「项目的偏好」而不是「项目」
  assert.equal(E.detectTarget('关于项目的偏好'), '项目的偏好')
  assert.ok(E.detectTarget('关于项目的偏好').includes('项目'))
  assert.equal(E.detectTarget('今天天气不错'), 'general')
})

test('normalizeEmotionItem 补齐全部字段', () => {
  const item = E.normalizeEmotionItem({ text: '老大喜欢简洁的回复' })
  assert.equal(item.text, '老大喜欢简洁的回复')
  assert.equal(item.sentiment, 'like')
  assert.equal(item.target, '老大')
  assert.ok(typeof item.intimacy === 'number' && item.intimacy > 0)
  assert.equal(item.scope, 'global')
  assert.ok(item.id)
})

test('weight 由 intimacy 推导（负极性打折）', () => {
  const like = E.normalizeEmotionItem({ text: '老大喜欢简洁' })
  const dislike = E.normalizeEmotionItem({ text: '老大讨厌啰嗦' })
  assert.ok(like.weight > dislike.weight, `like=${like.weight} dislike=${dislike.weight}`)
  assert.ok(dislike.weight < 1)
})

test('sameSessionKey 忽略 session- 前缀', () => {
  assert.equal(E.sameSessionKey('session-abc', 'abc'), true)
  assert.equal(E.sameSessionKey('session-abc', 'session-abc'), true)
  assert.equal(E.sameSessionKey('abc', 'xyz'), false)
})

test('emotionItemInScope 三档作用域', () => {
  const g = { scope: 'global' }
  const w = { scope: 'workspace', scopePath: 'D:/proj' }
  const s = { scope: 'session', scopeSession: 'session-abc' }
  assert.equal(E.emotionItemInScope(g, { cwd: 'D:/other', sessionId: 'x' }), true)
  assert.equal(E.emotionItemInScope(w, { cwd: 'D:/proj/sub', sessionId: 'x' }), true)
  assert.equal(E.emotionItemInScope(w, { cwd: 'D:/other', sessionId: 'x' }), false)
  assert.equal(E.emotionItemInScope(s, { cwd: 'D:/any', sessionId: 'session-abc' }), true)
  assert.equal(E.emotionItemInScope(s, { cwd: 'D:/any', sessionId: 'session-zzz' }), false)
})

// ───────────────────────────────────────────────────────────────────
group('二、classify 误判修复')

test('工作汇报不再被误判成情感', () => {
  const r = C.classify('好嘞！本鱼这就把通道打通，deploy key 写进环境变量了')
  assert.notEqual(r.module, 'emotion', `实际 module=${r.module}`)
  assert.equal(r.module, 'cognition')
})

test('「我们把功能做完上线了」不是情感', () => {
  const r = C.classify('我们把功能做完上线了')
  assert.equal(r.module, 'cognition')
})

test('明确的情感仍然进情感模块并带语义字段', () => {
  // classify 的入参是摘要对象 { user, text, assistant }，不是纯字符串
  const r = C.classify({ text: '老大喜欢简洁的回复' })
  assert.equal(r.module, 'emotion')
  assert.equal(r.sentiment, 'like')
  assert.equal(r.target, '老大')
  assert.ok(r.intimacy >= 0.6)
})

test('「我爱你」亲密度更高', () => {
  const hi = C.classify({ text: '我爱你' })
  const mid = C.classify({ text: '老大喜欢简洁的回复' })
  assert.equal(hi.module, 'emotion')
  assert.ok(hi.intimacy > mid.intimacy, `hi=${hi.intimacy} mid=${mid.intimacy}`)
})

// ───────────────────────────────────────────────────────────────────
group('三、modules 作用域与语义字段')

test('ITEM_SCOPES 包含 session', () => {
  assert.deepEqual(M.ITEM_SCOPES, ['global', 'workspace', 'session'])
})

test('normalizeModules 规整情感条目的语义字段', () => {
  const mods = M.normalizeModules({
    emotion: {
      enabled: true,
      weight: 0.5,
      items: [{ text: '老大喜欢简洁', sentiment: 'like', target: '老大', intimacy: 0.7, scope: 'session', scopeSession: 'session-abc' }],
    },
  })
  const item = mods.emotion.items[0]
  assert.equal(item.scope, 'session')
  assert.equal(item.scopeSession, 'session-abc')
  assert.equal(item.sentiment, 'like')
  assert.equal(item.target, '老大')
  assert.equal(item.intimacy, 0.7)
})

test('setModuleItemScope 选 session 必须给会话 id', () => {
  const mods = M.normalizeModules({
    emotion: { enabled: true, weight: 0.5, items: [{ text: 'x', id: 'it_1' }] },
  })
  const bad = M.setModuleItemScope(mods, 'emotion', 'it_1', 'session')
  assert.equal(bad.changed, false)
  assert.ok(bad.note)
  const good = M.setModuleItemScope(mods, 'emotion', 'it_1', 'session', '', 'session-abc')
  assert.equal(good.changed, true)
  assert.equal(mods.emotion.items[0].scope, 'session')
  assert.equal(mods.emotion.items[0].scopeSession, 'session-abc')
})

test('putModuleItem 合并相似条目时保留更具体的 scope', () => {
  const mods = M.defaultModules()
  const base = { id: 'a', text: '老大喜欢简洁', weight: 0.6, tags: ['偏好'], pinned: false, scope: 'workspace', scopePath: 'D:/p' }
  M.putModuleItem(mods, 'emotion', { ...base })
  M.putModuleItem(mods, 'emotion', { ...base, id: 'b', scope: 'session', scopeSession: 'session-abc', weight: 0.7 })
  assert.equal(mods.emotion.items.length, 1)
  assert.equal(mods.emotion.items[0].scope, 'session')
  assert.equal(mods.emotion.items[0].scopeSession, 'session-abc')
  assert.ok(mods.emotion.items[0].weight >= 0.7)
})

test('moduleSummary 输出语义字段', () => {
  const mods = M.defaultModules()
  M.putModuleItem(mods, 'emotion', {
    id: 'x', text: '老大喜欢简洁', weight: 0.6, tags: [], pinned: false,
    sentiment: 'like', target: '老大', intimacy: 0.6,
  })
  const sum = M.moduleSummary(mods)
  assert.equal(sum.emotion.count, 1)
  assert.equal(sum.emotion.items[0].sentiment, 'like')
  assert.equal(sum.emotion.items[0].target, '老大')
  assert.equal(sum.emotion.items[0].intimacy, 0.6)
})

// ───────────────────────────────────────────────────────────────────
group('四、情感召回打分')

test('喜欢与讨厌能被区分（旧的 token 打分分不出）', () => {
  const mods = M.defaultModules()
  M.putModuleItem(mods, 'emotion', {
    id: 'e1', text: '老大喜欢简洁的回复', weight: 0.6, tags: ['偏好'], pinned: false,
    sentiment: 'like', target: '老大', intimacy: 0.6,
  })
  M.putModuleItem(mods, 'emotion', {
    id: 'e2', text: '老大讨厌啰嗦的回复', weight: 0.6, tags: ['偏好'], pinned: false,
    sentiment: 'dislike', target: '老大', intimacy: 0.6,
  })
  const result = W.recallModules(mods, '老大喜欢什么样的回复', { limit: 6, minScore: 1.2 })
  const hits = result.hits || []
  const like = hits.find((h) => h.item && h.item.id === 'e1')
  const dislike = hits.find((h) => h.item && h.item.id === 'e2')
  assert.ok(like && dislike, `命中：${hits.map((h) => h.item && h.item.id).join(',')}`)
  assert.ok(like.score > dislike.score, `like=${like.score} dislike=${dislike.score}`)
})

test('renderModuleRecall 渲染情感语义', () => {
  const mods = M.defaultModules()
  M.putModuleItem(mods, 'emotion', {
    id: 'e1', text: '老大喜欢简洁的回复', weight: 0.6, tags: ['偏好'], pinned: false,
    sentiment: 'like', target: '老大', intimacy: 0.7,
  })
  const result = W.recallModules(mods, '老大喜欢什么样的回复', { limit: 6, minScore: 1.2 })
  const text = W.renderModuleRecall(result)
  assert.ok(text.includes('老大喜欢简洁的回复'), text)
  assert.ok(text.includes('亲密度'), text)
})

// ───────────────────────────────────────────────────────────────────
group('五、store 语义字段往返')

test('normalizeStore 保留语义字段与 scopeSession', () => {
  const store = S.normalizeStore({
    version: 1,
    entries: [{
      id: 'm1', text: '老大喜欢简洁', module: 'emotion', weight: 0.6, tags: [],
      scope: 'session', scopeSession: 'session-abc',
      sentiment: 'like', target: '老大', intimacy: 0.7,
    }],
    updatedAt: 1,
  })
  const e = store.entries[0]
  assert.equal(e.scope, 'session')
  assert.equal(e.scopeSession, 'session-abc')
  assert.equal(e.sentiment, 'like')
  assert.equal(e.target, '老大')
  assert.equal(e.intimacy, 0.7)
})

// ───────────────────────────────────────────────────────────────────
group('六、心情状态机')

test('步长只吃判定值的 1/3', () => {
  const state = E.normalizeMoodState({ mood: 70, dims: {} }, 's1')
  const r = E.applyMoodDelta(state, { moodDelta: -6, dims: {} })
  assert.equal(r.changed, true)
  assert.equal(r.state.mood, 68, `实际 ${r.state.mood}`)
})

test('底部饱和：≤40 时跌速减半', () => {
  const state = E.normalizeMoodState({ mood: 38, dims: {} }, 's1')
  const r = E.applyMoodDelta(state, { moodDelta: -8, dims: {} })
  assert.equal(r.state.mood, 37, `实际 ${r.state.mood}`)
})

test('顶部饱和：≥85 时涨速减半', () => {
  const state = E.normalizeMoodState({ mood: 86, dims: {} }, 's1')
  const r = E.applyMoodDelta(state, { moodDelta: 9, dims: {} })
  assert.equal(r.state.mood, 88, `实际 ${r.state.mood}`)
})

test('零变化不记账', () => {
  const state = E.normalizeMoodState({ mood: 70, dims: {} }, 's1')
  const r = E.applyMoodDelta(state, { moodDelta: 0, dims: {} })
  assert.equal(r.changed, false)
  assert.equal(r.minor, true)
})

test('半衰期衰减：mood 回基线、情绪淡下去', () => {
  const now = Date.now()
  const state = E.normalizeMoodState({
    mood: 40, dims: { worry: 60 }, lastDecayAt: now - 12 * 3600 * 1000,
  }, 's1', now)
  const r = E.decayMood(state, 70, now, 12)
  assert.equal(r.changed, true)
  assert.ok(state.mood > 40 && state.mood < 70, `实际 ${state.mood}`)
  assert.ok(state.dims.worry < 60, `实际 ${state.dims.worry}`)
  assert.ok(state.timeline.some((x) => x.kind === 'decay'))
})

test('parseMoodDelta 容错解析', () => {
  const d = E.parseMoodDelta('前缀 {"moodDelta":-4,"dims":{"happy":3},"reason":"老大累了一天","confidence":75} 后缀')
  assert.equal(d.moodDelta, -4)
  assert.equal(d.dims.happy, 3)
  assert.equal(d.confidence, 75)
  assert.equal(d.reason, '老大累了一天')
})

test('parseMoodDelta 夹紧越界值', () => {
  const d = E.parseMoodDelta('{"moodDelta":999,"dims":{"happy":-50},"confidence":9999}')
  assert.equal(d.moodDelta, 10)
  // dims 是「变化量」，夹到 [-10,10]；累加时再夹到 [0,100]
  assert.equal(d.dims.happy, -10)
  assert.equal(d.confidence, 100)
})

test('parseMoodDelta 解析不了就返回 null', () => {
  assert.equal(E.parseMoodDelta('完全不是 JSON'), null)
})

test('judgeModeOf 分流四种口径', () => {
  assert.equal(E.judgeModeOf('user'), 'user')
  assert.equal(E.judgeModeOf('speak-up'), 'talk')
  assert.equal(E.judgeModeOf('bili-duty-scan'), 'work')
  assert.equal(E.judgeModeOf('runtime-context'), '')
  assert.equal(E.judgeModeOf('system-reminder'), '')
})

test('normalizeMoodConfig 夹紧越界配置', () => {
  const c = E.normalizeMoodConfig({ moodBase: 999, moodBase_: 0, decayHalfHours: 999, injectMode: '乱写', sigMood: 0 })
  assert.equal(c.moodBase, 100)
  assert.equal(c.decayHalfHours, 168)
  assert.equal(c.injectMode, 'event')
  assert.equal(c.sigMood, 1)
})

test('moodBand 五档', () => {
  assert.equal(E.moodBand(85).label, '欢喜')
  assert.equal(E.moodBand(70).label, '开心')
  assert.equal(E.moodBand(50).label, '一般')
  assert.equal(E.moodBand(30).label, '心疼')
  assert.equal(E.moodBand(10).label, '难过')
})

// ───────────────────────────────────────────────────────────────────
group('七、注入渲染的四道闸门')

function makeState(over = {}) {
  const now = Date.now()
  return E.normalizeMoodState({
    mood: 78, dims: { happy: 60 },
    updatedAt: now, lastDecayAt: now,
    lastReason: '老大答应去热饭，还叫你好宝宝，我当时心里软了一下',
    lastConfidence: 80,
    injectedFor: 0, saidAt: [], minor: false,
    timeline: [{ time: now - 5 * 60000, mood: 78, delta: 2, reason: '老大答应去热饭', confidence: 80 }],
    ...over,
  }, 's1', now)
}

test('mode=off 什么都不说', () => {
  const text = E.renderMoodContext(makeState(), { mode: 'off' })
  assert.equal(text, '')
})

test('一次变化只说一次（按 revision，不按 updatedAt）', () => {
  // P1-10：以前比 injectedFor === updatedAt，但 updatedAt 每次写状态都会变
  // （minor 分支、decay 都更新它），标记永远追不上 → 同一件事被说第二遍。
  // 现在比只增不减的 revision。
  const state = makeState({ revision: 7, injectedFor: 7 })
  assert.equal(E.renderMoodContext(state, { mode: 'event' }), '')
})

test('revision 推进后可以再说一次', () => {
  const state = makeState({ revision: 8, injectedFor: 7 })
  assert.ok(E.renderMoodContext(state, { mode: 'event' }).length > 0, 'revision 变了就该再说')
})

test('小波动只记账不打扰', () => {
  const text = E.renderMoodContext(makeState({ minor: true }), { mode: 'event' })
  assert.equal(text, '')
})

test('可信度不够只记后台', () => {
  const text = E.renderMoodContext(makeState({ lastConfidence: 30 }), { mode: 'event', injectConfidence: 60 })
  assert.equal(text, '')
})

test('label 模式说一句话', () => {
  const text = E.renderMoodContext(makeState(), { mode: 'label' })
  assert.ok(text.length > 0, '应该说出点什么')
  assert.ok(text.includes('底子') || text.includes('背景'), text)
})

test('event 模式三行 + 不念出来', () => {
  const text = E.renderMoodContext(makeState(), { mode: 'event' })
  const lines = text.split('\n').filter((x) => x.trim())
  assert.ok(lines.length >= 2, `行数 ${lines.length}`)
  assert.ok(text.includes('别把这段念出来'), text)
})

test('事件模式里出现「此刻/现在/正/一直/还」要判不合格', () => {
  const text = E.renderMoodContext(makeState(), { mode: 'event' })
  for (const word of ['此刻', '现在']) {
    assert.ok(!text.includes(word), `不该出现「${word}」：${text}`)
  }
})

test('日上限用完就不说了', () => {
  const now = Date.now()
  const saidAt = []
  for (let i = 0; i < 6; i++) saidAt.push(now - i * 1000)
  const text = E.renderMoodContext(makeState({ saidAt, updatedAt: now, injectedFor: 0 }), { mode: 'event', injectPerDay: 6 })
  assert.equal(text, '')
})

// ───────────────────────────────────────────────────────────────────
group('八、持久化（隔离目录）')

await atest('心情库读写往返', async () => {
  E.writeEmotionStore({
    version: 1,
    config: { ...E.MOOD_DEFAULTS, enabled: true, moodBase: 65 },
    states: {
      'abc': E.normalizeMoodState({ mood: 72, dims: { happy: 40 } }, 'abc'),
    },
    updatedAt: Date.now(),
  })
  const store = E.readEmotionStore()
  assert.equal(store.config.enabled, true)
  assert.equal(store.config.moodBase, 65)
  assert.ok(store.states.abc)
  assert.equal(Math.round(store.states.abc.mood), 72)
})

await atest('getMoodState / saveMoodState 按会话键存取', async () => {
  E.saveMoodState('session-xyz', E.normalizeMoodState({ mood: 55, dims: {} }, 'xyz'))
  const { state } = E.getMoodState('session-xyz')
  assert.equal(Math.round(state.mood), 55)
  // 两种写法要落到同一份
  const { state: state2 } = E.getMoodState('xyz')
  assert.equal(Math.round(state2.mood), 55)
})

await atest('moodStatus 输出对外状态', async () => {
  const status = E.moodStatus(E.readEmotionStore())
  assert.ok(status.file.endsWith('emotion.json'), status.file)
  assert.ok(Array.isArray(status.sessions))
  assert.ok(status.total >= 1)
})

// ───────────────────────────────────────────────────────────────────
group('九、bridge / commands 接口')

const B = await import(`file:///${LIB}/bridge.js`)
const CMD = await import(`file:///${LIB}/commands.js`)

await atest('bridge setMoodConfig 生效', async () => {
  const r = B.mutateModules({ action: 'setMoodConfig', enabled: true, injectMode: 'label', moodBase: 66 })
  assert.equal(r.ok, true)
  const snap = B.snapshotOf()
  assert.equal(snap.emotion.config.enabled, true)
  assert.equal(snap.emotion.config.injectMode, 'label')
  assert.equal(snap.emotion.config.moodBase, 66)
})

await atest('bridge resetMood 清空', async () => {
  const r = B.mutateModules({ action: 'resetMood' })
  assert.equal(r.ok, true)
  assert.equal(B.snapshotOf().emotion.total, 0)
})

await atest('commands /shared-memory mood 报状态', async () => {
  let handler = null
  CMD.registerCommands({ effect: (fn) => fn(), commands: { register: (spec) => { handler = spec.handler } } })
  const out = handler(['mood'])
  assert.equal(out.kind, 'success')
  assert.ok(out.text.includes('心情'), out.text)
})

await atest('commands mood-config 能改能查', async () => {
  let handler = null
  CMD.registerCommands({ effect: (fn) => fn(), commands: { register: (spec) => { handler = spec.handler } } })
  const changed = handler(['mood-config', 'moodBase', '64'])
  assert.equal(changed.kind, 'success')
  const shown = handler(['mood-config'])
  assert.ok(shown.text.includes('64'), shown.text)
  const bad = handler(['mood-config', 'injectMode', '乱写'])
  assert.equal(bad.kind, 'error')
  const badKey = handler(['mood-config', '乱键', '1'])
  assert.equal(badKey.kind, 'error')
})

// ───────────────────────────────────────────────────────────────────
group('十、index.js 接线')

const I = await import(`file:///${LIB}/index.js`)

test('inject 声明了 llm（否则 ctx.llm 不存在）', () => {
  assert.ok(I.inject.includes('llm'), I.inject.join(','))
})

test('index.js 导出齐全', () => {
  for (const key of ['apply', 'inject', 'name', 'status']) {
    assert.ok(I[key] !== undefined, `缺少导出 ${key}`)
  }
})

// ───────────────────────────────────────────────────────────────────
process.stdout.write(`\n结果：${passed} 通过 / ${failed} 失败\n`)
if (failed > 0) {
  process.stdout.write('\n失败明细：\n')
  for (const f of failures) {
    process.stdout.write(`  · ${f.name}\n    ${f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 4).join('\n    ') : f.error}\n`)
  }
}
rmSync(SANDBOX, { recursive: true, force: true })
process.exit(failed > 0 ? 1 : 0)
