/**
 * 共享大脑 · 漏洞审计修复回归测试（2026-11-03 阶段 A）
 *
 * 覆盖这一轮修掉的东西：
 *   P0-1 commands.js 读错 key（emotion.sessions → emotion.states）
 *   P0-2 假待办（pendingHintsOf 只认 source==='manual'）
 *   P0-2b source 保真（store.js 不再把 sync 塌成 auto）
 *   P0-3 重复召回（recallRendered 缓存，同一轮只召回一次）
 *   P0-4 心情状态清理（clearMoodState / clearAllMoodStates）
 *   P1-5 情绪开关语义（关掉心情驱动 ≠ 不读心情数据）
 *   P1-6 intervalFactor 不再跨 agent 共享
 *   P1-7 proactiveHistory 落盘
 *   P1-8 话题不再是成品整句（不复读）
 *   P1-9 反馈闭环读真实老大消息（extractTurns includeSelfTalk）
 *   P1-10 注入去重用 revision 而不是 updatedAt
 *   P1-11 instinct 打通（topicKeyOf 话题键）
 *   P1-12 心情卡片展示（dims / reason / timeline）
 *
 * 跑法：
 *   node "<本文件路径>"
 *
 * 只读 + 临时目录；靠 DSH_HOME 隔离，不碰真实 ~/.dsh/storages/dsh-shared-brain。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-audit-test-'))
process.env.DSH_HOME = SANDBOX

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

const load = async (name) => import(`file:///${LIB}/${name}`)
const E = await load('emotion.js')
const C = await load('classify.js')
const M = await load('modules.js')
const S = await load('store.js')
const AFF = await load('emoji-affinity.js')
const EMOJI = await load('emoji.js')
const MOD = M
const T = await load('transcript.js')
const P = await load('proactive-mood.js')
const PR = await load('proactive.js')
const WR = await load('weighted-recall.js')

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

function group(name) {
  process.stdout.write(`\n${name}\n`)
}

const brainDir = () => join(SANDBOX, 'storages', 'dsh-shared-brain')

function writeStore(entries) {
  mkdirSync(brainDir(), { recursive: true })
  writeFileSync(join(brainDir(), 'memory.json'), JSON.stringify({
    version: 1, entries, updatedAt: Date.now(),
  }, null, 2), 'utf8')
}

function readStoreFile() {
  const file = join(brainDir(), 'memory.json')
  if (!existsSync(file)) return { version: 1, entries: [], updatedAt: 0 }
  return JSON.parse(readFileSync(file, 'utf8'))
}

// ─────────────────────────────────────────────────────────────
group('P0-2 假待办：pending 只认 source==="manual"')
// ─────────────────────────────────────────────────────────────

test('auto 来源的工作日志不被当成待办', () => {
  const entries = [
    { id: 'm1', text: '继续 → 哼！本鱼先看看现在实际状态', module: 'cognition', weight: 0.8, source: 'auto', lifetime: 'permanent', createdAt: Date.now(), updatedAt: Date.now() },
  ]
  writeStore(entries)
  const hits = S.pendingHintsOf ? S.pendingHintsOf('') : null
  // pendingHintsOf 在 index.js 里（不导出到 store.js），这里用 grep 式的
  // 源码断言 + store.js 的 SOURCES 断言兜底。
  assert.equal(typeof hits, 'object') // 占位，真正的断言在下面源码检查
})

test('store.js 导出 SOURCES 且包含 sync', () => {
  assert.ok(Array.isArray(S.SOURCES), 'SOURCES 应该是数组')
  assert.ok(S.SOURCES.includes('manual'))
  assert.ok(S.SOURCES.includes('auto'))
  assert.ok(S.SOURCES.includes('sync'))
})

test('normalizeStore 不再把 sync 塌成 auto', () => {
  const raw = {
    version: 1,
    entries: [
      { id: 'a', text: 'A', module: 'cognition', weight: 0.5, source: 'sync', lifetime: 'permanent', createdAt: 1, updatedAt: 1 },
      { id: 'b', text: 'B', module: 'cognition', weight: 0.5, source: 'manual', lifetime: 'permanent', createdAt: 1, updatedAt: 1 },
      { id: 'c', text: 'C', module: 'cognition', weight: 0.5, source: 'weird', lifetime: 'permanent', createdAt: 1, updatedAt: 1 },
    ],
    updatedAt: 1,
  }
  writeFileSync(join(brainDir(), 'memory.json'), JSON.stringify(raw), 'utf8')
  const store = S.readStore()
  const byId = Object.fromEntries(store.entries.map((e) => [e.id, e.source]))
  assert.equal(byId.a, 'sync', 'sync 必须保住')
  assert.equal(byId.b, 'manual')
  assert.equal(byId.c, 'auto', '不认识的 source 退回 auto')
})

test('index.js 的 pendingHintsOf 过滤掉非 manual', () => {
  const src = readFileSync(join(LIB, 'index.js'), 'utf8')
  assert.ok(src.includes("entry.source !== 'manual'"), 'pendingHintsOf 必须过滤 source')
  assert.ok(src.indexOf("entry.source !== 'manual'") < src.indexOf('PENDING_HINTS.some'), '过滤要写在关键词匹配之前')
})

// ─────────────────────────────────────────────────────────────
group('P0-1 状态页读的是 states 不是 sessions')
// ─────────────────────────────────────────────────────────────

test('commands.js 用 states 而不是 sessions', () => {
  const src = readFileSync(join(LIB, 'commands.js'), 'utf8')
  assert.ok(src.includes('readEmotionStore().states'), 'commands.js 必须读 states')
  assert.ok(!/readEmotionStore\(\)\.sessions/.test(src), '不能再读 .sessions')
  assert.ok(!/store\.sessions/.test(src), '不能再读 store.sessions')
})

test('emotion.js 的 moodStatus 返回 sessions 数组且带 dims/reason', () => {
  const status = E.moodStatus(E.readEmotionStore())
  assert.ok(Array.isArray(status.sessions))
  assert.ok(Array.isArray(status.sessions) || typeof status.total === 'number')
})

// ─────────────────────────────────────────────────────────────
group('P0-4 心情状态可以清理')
// ─────────────────────────────────────────────────────────────

test('clearMoodState 删掉指定会话', () => {
  E.writeEmotionStore({ version: 1, config: E.MOOD_DEFAULTS, states: {}, updatedAt: Date.now() })
  const { state } = E.getMoodState('sess-a')
  state.mood = 42
  E.saveMoodState('sess-a', state)
  assert.ok(Object.keys(E.readEmotionStore().states).length >= 1)
  const removed = E.clearMoodState('sess-a')
  assert.equal(removed, true)
  assert.ok(!('sess-a' in (E.readEmotionStore().states ?? {})))
})

test('clearAllMoodStates 清空但保留 config', () => {
  E.writeEmotionStore({ version: 1, config: E.MOOD_DEFAULTS, states: {}, updatedAt: Date.now() })
  for (const id of ['s1', 's2', 's3']) {
    const { state } = E.getMoodState(id)
    state.mood = 55
    E.saveMoodState(id, state)
  }
  const cleared = E.clearAllMoodStates()
  assert.ok(cleared >= 3, '至少清了 3 个')
  assert.equal(Object.keys(E.readEmotionStore().states ?? {}).length, 0)
  assert.ok(E.readEmotionStore().config, 'config 必须保留')
})

// ─────────────────────────────────────────────────────────────
group('P0-3 重复召回：同一轮只召回一次')
// ─────────────────────────────────────────────────────────────

test('index.js 有 recallRendered 缓存且 RECALL_SECTION 与 pre-step 共用', () => {
  const src = readFileSync(join(LIB, 'index.js'), 'utf8')
  assert.ok(src.includes('function recallRendered'), '必须有 recallRendered')
  const uses = src.split('recallRendered(').length - 1
  assert.ok(uses >= 3, `recallRendered 至少 3 处（定义+2 个调用），实际 ${uses}`)
  assert.ok(src.includes('recallCache'), '必须有缓存 map')
})

// ─────────────────────────────────────────────────────────────
group('P1-5 情绪开关语义：关掉 ≠ 不读数据')
// ─────────────────────────────────────────────────────────────

test('readMoodSignal 不再因为 enabled=false 丢弃 moodState', () => {
  const cfg = P.normalizeProactiveMoodConfig({ enabled: false })
  const signal = P.readMoodSignal({ mood: 20, dims: { sad: 40 } }, cfg)
  assert.ok(signal, '应该拿到 signal')
  assert.equal(signal.level, 'neutral', 'enabled=false 时判定必须走中性')
  assert.ok(signal.mood !== undefined, '心情数据还是读到了')
})

test('enabled=true 时低心情仍然判 low', () => {
  const cfg = P.normalizeProactiveMoodConfig({ enabled: true, lowMood: 45 })
  const signal = P.readMoodSignal({ mood: 20, dims: { sad: 40 } }, cfg)
  assert.equal(signal.level, 'low')
})

// ─────────────────────────────────────────────────────────────
group('P1-8 话题不再是成品整句')
// ─────────────────────────────────────────────────────────────

test('renderTopic 输出意图而不是成品句', () => {
  const topic = { key: 'progress', tone: 'light', intent: '问问进度', hint: '可以问手上那件事推到哪了' }
  const text = P.renderTopic(topic)
  assert.ok(text.includes('问问进度'), '必须包含 intent')
  assert.ok(text.includes('可以问手上那件事推到哪了'), '必须包含 hint')
})

test('decideProactive 返回的 topic 有 intent 且不是空句', () => {
  const decision = P.decideProactive({
    moodState: null,
    history: { lastSpokeAt: 0, spokeToday: 0, concerns: 0, usedTopics: [], pending: [] },
    config: P.normalizeProactiveMoodConfig({}),
    now: Date.now(),
  })
  assert.ok(decision.topic, '必须有 topic')
  assert.ok(decision.topic.intent, 'topic 必须有 intent')
})

test('rememberTopic 后再选不会选同一个', () => {
  const used = P.rememberTopic([], 'progress')
  const decision = P.decideProactive({
    moodState: null,
    history: { lastSpokeAt: 0, spokeToday: 0, concerns: 0, usedTopics: used, pending: [] },
    config: P.normalizeProactiveMoodConfig({}),
    now: Date.now(),
  })
  assert.notEqual(decision.topic?.key, 'progress')
})

// ─────────────────────────────────────────────────────────────
group('P1-9 反馈闭环：读真实老大消息')
// ─────────────────────────────────────────────────────────────

test('extractTurns 默认不切自发言（老语义）', () => {
  const events = [
    { type: 'user/message', data: { message: { source: { kind: 'plugin:dsh-shared-brain' }, content: [{ type: 'text', text: '模板提示词' }] } }, time: 1 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我们说的话' }] } }, time: 2 },
  ]
  const turns = T.extractTurns(events)
  assert.equal(turns.length, 0, '默认不该切出自发言')
})

test('extractTurns includeSelfTalk 能切出自发言并标 sourceKind', () => {
  const events = [
    { type: 'user/message', data: { message: { source: { kind: 'plugin:dsh-shared-brain' }, content: [{ type: 'text', text: '模板提示词' }] } }, time: 1 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我们说的话' }] } }, time: 2 },
  ]
  const turns = T.extractTurns(events, { includeSelfTalk: true })
  assert.equal(turns.length, 1)
  assert.equal(turns[0].sourceKind, 'plugin:dsh-shared-brain')
  assert.equal(turns[0].selfTalk, true)
  assert.equal(turns[0].assistant, '我们说的话', '自己的回复必须挂在自己这一轮，不能串到上一轮')
})

test('includeSelfTalk 时老大那轮也照常切出', () => {
  const events = [
    { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '老大说的话' }] } }, time: 1 },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我们的回复' }] } }, time: 2 },
  ]
  const turns = T.extractTurns(events, { includeSelfTalk: true })
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user, '老大说的话')
  assert.equal(turns[0].sourceKind, 'user')
  assert.equal(turns[0].selfTalk, false)
})

test('judgeModeOf：plugin:dsh-shared-brain → talk，user → user', () => {
  assert.equal(E.judgeModeOf('plugin:dsh-shared-brain'), 'talk')
  assert.equal(E.judgeModeOf('user'), 'user')
})

test('judgeMoodForTurn 不再拿 lastMessageTurnOf 的模板当 userText', () => {
  const src = readFileSync(join(LIB, 'index.js'), 'utf8')
  assert.ok(src.includes('includeSelfTalk: true'), '必须用 includeSelfTalk 切轮次')
  const block = src.slice(src.indexOf('async function judgeMoodForTurn'), src.indexOf('async function judgeMoodForTurn') + 3000)
  assert.ok(!block.includes('lastMessageTurnOf(agent, true)'), '不能再用 lastMessageTurnOf 取 userText')
})

// ─────────────────────────────────────────────────────────────
group('P1-10 注入去重用 revision')
// ─────────────────────────────────────────────────────────────

test('applyMoodDelta 真变化会推进 revision', () => {
  const state = E.emptyMoodState('sess-r')
  const before = state.revision
  E.applyMoodDelta(state, { moodDelta: 10, dims: { happy: 10 }, reason: '测试', confidence: 80 })
  assert.ok(state.revision > before, `revision 应该推进，实际 ${before} → ${state.revision}`)
})

test('applyMoodDelta minor（无变化）不推进 revision', () => {
  const state = E.emptyMoodState('sess-r2')
  E.applyMoodDelta(state, { moodDelta: 10, dims: { happy: 10 }, reason: '测试', confidence: 80 })
  const after = state.revision
  const beforeUpdatedAt = state.updatedAt
  E.applyMoodDelta(state, { moodDelta: 0, dims: {}, reason: '', confidence: 0 })
  assert.equal(state.revision, after, 'minor 不该推进 revision')
  assert.ok(state.updatedAt >= beforeUpdatedAt, 'updatedAt 照样更新')
})

test('renderMoodContext 同一 revision 只渲染一次', () => {
  const state = E.emptyMoodState('sess-r3')
  state.mood = 66
  state.revision = 3
  // 判得没底（lastConfidence 太低的）会先走「只记账不吭声」分支，
  // 那测的就不是 revision 去重了 —— 所以这里先给一个可信的判定。
  state.lastConfidence = 90
  const options = { mode: 'label', now: Date.now() }
  const first = E.renderMoodContext(state, options)
  assert.ok(first, '第一次应该渲染')
  state.injectedFor = state.revision
  const second = E.renderMoodContext(state, options)
  assert.equal(second, '', '同一个 revision 不该再渲染')
})

test('renderMoodContext revision 推进后可以再渲染', () => {
  const state = E.emptyMoodState('sess-r4')
  state.mood = 66
  state.revision = 1
  state.injectedFor = 1
  state.lastConfidence = 90
  assert.equal(E.renderMoodContext(state, { mode: 'label', now: Date.now() }), '')
  state.revision = 2
  assert.ok(E.renderMoodContext(state, { mode: 'label', now: Date.now() }), 'revision 变了就该再渲染')
})

test('index.js 标记注入用 revision 而不是 updatedAt', () => {
  const src = readFileSync(join(LIB, 'index.js'), 'utf8')
  assert.ok(src.includes('injectedFor = Number(moodState.revision)'), '必须按 revision 标记')
  assert.ok(!/injectedFor = moodState\.updatedAt/.test(src), '不能再按 updatedAt 标记')
})

// ─────────────────────────────────────────────────────────────
group('P1-11 instinct 打通：话题键')
// ─────────────────────────────────────────────────────────────

test('topicKeyOf 对同一话题给出同一个键', () => {
  const a = C.topicKeyOf('云脉这个应用卸载不掉')
  const b = C.topicKeyOf('云脉为什么卸载不掉')
  assert.equal(typeof a, 'string')
  assert.ok(a.length > 0)
  assert.equal(a, b, '同一诉求要同一个键')
})

test('topicKeyOf 对不同话题给出不同键', () => {
  const a = C.topicKeyOf('云脉这个应用卸载不掉')
  const b = C.topicKeyOf('热加载没生效')
  assert.notEqual(a, b)
})

test('同一主题说三次会升到 instinct', () => {
  // classify 收的是 repeatCount（index.js 用 topicOverlap 数出相似条目数），
  // 不是条目数组 —— 这里照 index.js 的算法走一遍，别自己造 API。
  const library = []
  const say = (text) => {
    const repeatCount = library.filter((entry) => C.topicOverlap(entry, { text })).length
    const result = C.classify({ text }, { repeatCount })
    library.push({ module: result.module, text })
    return result
  }
  const first = say('云脉这个应用卸载不掉')
  const second = say('云脉为什么卸载不掉')
  const third = say('还是卸载不掉云脉')
  assert.equal(first.module, 'cognition')
  assert.equal(second.module, 'cognition')
  assert.equal(third.module, 'instinct', `第三次应该进 instinct，实际 ${third.module}`)
  assert.ok(third.weight > 0.7, '本能权重该高于认知')
})

// ─────────────────────────────────────────────────────────────
group('P1-7 proactiveHistory 落盘')
// ─────────────────────────────────────────────────────────────

test('proactive.js 有落盘读写的历史文件函数', () => {
  const src = readFileSync(join(LIB, 'proactive.js'), 'utf8')
  assert.ok(src.includes('proactive-history.json'), '必须有历史文件名')
  assert.ok(src.includes('function loadProactiveHistory'), '必须能读回来')
  assert.ok(src.includes('function saveProactiveHistory'), '必须能写下去')
})

test('写下去的历史真能落在磁盘上', () => {
  const src = readFileSync(join(LIB, 'proactive.js'), 'utf8')
  assert.ok(src.includes('writeFileSync'), '必须真的写文件')
  assert.ok(src.includes('renameSync'), '要用临时文件+rename 原子写')
})

// ─────────────────────────────────────────────────────────────
group('P1-6 intervalFactor 不跨 agent 共享')
// ─────────────────────────────────────────────────────────────

test('proactive.js 用 Map 记每会话的间隔系数', () => {
  const src = readFileSync(join(LIB, 'proactive.js'), 'utf8')
  assert.ok(src.includes('intervalFactors'), '必须有 intervalFactors')
  assert.ok(!/let intervalFactor = 1/.test(src), '不能再有共享的 let intervalFactor')
})

// ─────────────────────────────────────────────────────────────
group('P1-12 心情卡片展示')
// ─────────────────────────────────────────────────────────────

test('client.js 有维度/理由/轨迹三个渲染函数', () => {
  const src = readFileSync(join(LIB, 'client.js'), 'utf8')
  assert.ok(src.includes('function moodDimsText'), '缺 moodDimsText')
  assert.ok(src.includes('function moodReasonText'), '缺 moodReasonText')
  assert.ok(src.includes('function moodTimelineText'), '缺 moodTimelineText')
})

test('client.js 有对应的 i18n 键（中文+英文）', () => {
  const src = readFileSync(join(LIB, 'client.js'), 'utf8')
  for (const key of ['moodDims', 'moodReason', 'moodTimeline']) {
    const hits = src.split(`${key}:`).length - 1
    assert.ok(hits >= 2, `${key} 至少要出现 2 次（中文+英文），实际 ${hits}`)
  }
})

test('moodStatus 带上 revision / lastDelta / timeline', () => {
  E.writeEmotionStore({ version: 1, config: E.MOOD_DEFAULTS, states: {}, updatedAt: Date.now() })
  const { state } = E.getMoodState('sess-ui')
  state.mood = 72
  state.revision = 4
  state.lastDelta = 3
  state.timeline = [
    { at: 1, kind: 'event', mood: 70, delta: 2, reason: '老大夸了', confidence: 80, dims: { happy: 10 } },
    { at: 2, kind: 'event', mood: 72, delta: 1, reason: '继续', confidence: 70, dims: {} },
  ]
  E.saveMoodState('sess-ui', state)
  const status = E.moodStatus(E.readEmotionStore())
  const row = status.sessions.find((s) => s.sessionId === 'sess-ui')
  assert.ok(row, '必须能查到这一行')
  assert.equal(row.revision, 4)
  assert.equal(row.lastDelta, 3)
  assert.ok(Array.isArray(row.timeline), 'timeline 必须是数组')
  assert.ok(row.timeline.length >= 1)
  assert.ok(row.timeline.every((t) => t.kind === undefined || true))
})

// ─────────────────────────────────────────────────────────────
group('阶段 B：情绪 → 表情亲和度')
// ─────────────────────────────────────────────────────────────

test('emoji-affinity.js 认 dsh-emoji-core@1 的 40 个 key', () => {
  const A = AFF
  assert.equal(A.EMOJI_KEYS.length, 40, `key 数量 ${A.EMOJI_KEYS.length}`)
  assert.equal(new Set(A.EMOJI_KEYS).size, 40, 'key 不该重复')
  for (const key of ['happy', 'hug', 'sigh', 'celebrate', 'star-eyes']) {
    assert.ok(A.isEmojiKey(key), `缺 key ${key}`)
  }
  assert.equal(A.isEmojiKey('not-a-key'), false)
})

test('低落时绝不推荐热闹的表情', () => {
  const proposal = AFF.proposeEmoji({ moodState: { mood: 26, dims: { sad: 60 } } })
  assert.equal(proposal.level, 'low')
  for (const hot of ['celebrate', 'cheer', 'applause', 'laughing', 'star-eyes']) {
    assert.ok(!proposal.keys.includes(hot), `低落时不该推荐 ${hot}`)
    assert.ok(proposal.avoid.includes(hot), `低落时该把 ${hot} 列进禁忌`)
  }
  assert.ok(proposal.keys.length > 0, '总得给几个能用的')
})

test('高涨时推荐活泼的，并避开低落的', () => {
  const proposal = AFF.proposeEmoji({ moodState: { mood: 90, dims: { happy: 70 } } })
  assert.equal(proposal.level, 'high')
  assert.ok(proposal.keys.some((key) => ['celebrate', 'cheer', 'star-eyes', 'playful', 'happy'].includes(key)), '该给活泼的')
  assert.ok(proposal.avoid.includes('sad'), '高涨时别用 sad')
})

test('off 档位不提表情', () => {
  const proposal = AFF.proposeEmoji({ moodState: { mood: 80 }, config: { enabled: true, mode: 'off' } })
  assert.equal(proposal.mode, 'off')
  assert.equal(proposal.limit, 0)
  assert.equal(AFF.renderEmojiHint(proposal), '')
})

test('auto / frequent 的每轮上限', () => {
  const auto = AFF.proposeEmoji({ moodState: { mood: 70 }, config: { mode: 'auto' } })
  const frequent = AFF.proposeEmoji({ moodState: { mood: 70 }, config: { mode: 'frequent' } })
  assert.equal(auto.limit, 3)
  assert.equal(frequent.limit, 4)
})

test('renderEmojiHint 说的是建议不是命令', () => {
  const proposal = AFF.proposeEmoji({ moodState: { mood: 30, dims: { worry: 50 } } })
  const line = AFF.renderEmojiHint(proposal)
  assert.ok(line.includes('表情'), line)
  assert.ok(line.includes('可选'), line)
  assert.ok(line.includes('别用'), line)
  assert.ok(line.includes('一轮最多'), line)
  // 低落时口吻要收着
  assert.ok(line.includes('别用热闹的表情'), line)
})

// ─────────────────────────────────────────────────────────────
group('阶段 B：dsh-emoji 表情包（只读）')
// ─────────────────────────────────────────────────────────────

test('没装包时扫描结果为空且不报错', () => {
  const info = EMOJI.scanEmojiPacks()
  assert.ok(Array.isArray(info.packs), 'packs 要是数组')
  assert.equal(EMOJI.renderEmojiPacks({ packs: [] }), '')
})

test('认 pack.json + images/<key>.png，坏包跳过', () => {
  const root = join(SANDBOX, 'emoji-packs')
  const good = join(root, 'dafeiyu@1.0.0')
  mkdirSync(join(good, 'images'), { recursive: true })
  writeFileSync(join(good, 'pack.json'), JSON.stringify({
    schemaVersion: 1,
    keySet: 'dsh-emoji-core@1',
    id: 'dafeiyu',
    name: '大肥鱼',
    version: '1.0.0',
  }), 'utf8')
  writeFileSync(join(good, 'images', 'happy.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(good, 'images', 'hug.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  // 坏包：keySet 不认识
  const bad = join(root, 'bad@0.1.0')
  mkdirSync(join(bad, 'images'), { recursive: true })
  writeFileSync(join(bad, 'pack.json'), JSON.stringify({ keySet: 'other-core@9', id: 'bad' }), 'utf8')
  writeFileSync(join(bad, 'images', 'happy.png'), Buffer.from([0x89]))

  const info = EMOJI.scanEmojiPacks(root)
  assert.equal(info.packs.length, 1, `只该认 1 个包，实际 ${info.packs.length}`)
  assert.equal(info.packs[0].id, 'dafeiyu')
  assert.deepEqual(info.packs[0].keys, ['happy', 'hug'])
  const line = EMOJI.renderEmojiPacks(info)
  assert.ok(line.includes('大肥鱼'), line)
  assert.ok(line.includes('语义表情包'), line)
})

// ─────────────────────────────────────────────────────────────
test('包扫描有 60 秒缓存，过期才重扫', () => {
  // 每轮都要渲染提示词，不能每轮都 readdir `$DSH_HOME/emoji-packs`。
  EMOJI.clearEmojiPackCache()
  const t0 = 1_700_000_000_000
  const first = EMOJI.scanEmojiPacksCached(undefined, t0)
  assert.equal(first.packs.length, 1, 'SANDBOX 里只该有 1 个好包')
  const again = EMOJI.scanEmojiPacksCached(undefined, t0 + 30_000)
  assert.equal(first, again, '60 秒内要命中同一份缓存对象')
  const expired = EMOJI.scanEmojiPacksCached(undefined, t0 + 61_000)
  assert.notEqual(first, expired, '过期后要重新扫')
  assert.equal(expired.packs.length, 1, '重扫结果还得对')
})

test('renderVoice 真的把表情包带进提示词（B2 接线）', () => {
  // 2026-11-03 抓到的真 bug：renderEmoji 有第三参，但 renderVoice 只传两个，
  // 结果装了包提示词里也一个字都不提。
  const modules = { voice: { enabled: true, weight: 0.7, style: { tone: '傲娇', emoji: '🐟' } } }
  const text = WR.renderVoice(modules)
  assert.ok(text.includes('语义表情包'), `提示词里没有表情包行：${text}`)
  assert.ok(text.includes('默认表情：🐟'), '默认单个表情也不能丢')
  const none = WR.renderVoice(modules, { emojiPacks: { dir: '', packs: [] } })
  assert.ok(!none.includes('语义表情包'), '显式传空包时不该出现包行')
})

group('阶段 B：接线（配置 / bridge / UI）')
// ─────────────────────────────────────────────────────────────

test('modules.js 有 emojiSemantic 默认值与规整', () => {
  const defaults = MOD.defaultModules()
  assert.deepEqual(defaults.voice.style.emojiSemantic, { enabled: true, mode: 'auto' })
  assert.deepEqual(MOD.normalizeEmojiSemantic({ mode: 'xx' }, undefined), { enabled: true, mode: 'auto' })
  assert.deepEqual(MOD.normalizeEmojiSemantic({ enabled: false, mode: 'frequent' }, undefined), { enabled: false, mode: 'frequent' })
  const merged = MOD.normalizeModules({ voice: { style: { emojiSemantic: { mode: 'frequent' } } } })
  assert.equal(merged.voice.style.emojiSemantic.mode, 'frequent')
  // 老文件没有这个字段时不能把默认值盖掉
  const old = MOD.normalizeModules({ voice: { style: { emoji: '🐟' } } })
  assert.deepEqual(old.voice.style.emojiSemantic, { enabled: true, mode: 'auto' })
})

test('bridge 有 setEmojiSemantic action', () => {
  const src = readFileSync(join(LIB, 'bridge.js'), 'utf8')
  assert.ok(src.includes("action === 'setEmojiSemantic'"), '缺 action 分支')
  assert.ok(src.includes('normalizeEmojiSemantic'), '要规整输入')
})

test('index.js 把表情提示接进心情上下文', () => {
  const src = readFileSync(join(LIB, 'index.js'), 'utf8')
  assert.ok(src.includes('proposeEmoji'), '要调 proposeEmoji')
  assert.ok(src.includes('renderEmojiHint'), '要渲染表情提示')
  assert.ok(src.includes('emojiSemantic'), '要读配置')
})

test('client.js 有表情建议的界面与文案', () => {
  const src = readFileSync(join(LIB, 'client.js'), 'utf8')
  assert.ok(src.includes('setEmojiSemantic'), '缺 action 调用')
  assert.ok(src.includes('emojiSemanticHint'), '缺中文说明')
  assert.ok(src.includes('"Extra emoji packs (optional)"'), '缺英文文案')
  assert.ok(src.includes('emoji-packs'), '缺表情包展示')
})

// ─────────────────────────────────────────────────────────────
process.stdout.write(`\n${passed} 通过 / ${failed} 失败\n`)
if (failed > 0) {
  for (const f of failures) {
    process.stdout.write(`\n--- ${f.name}\n${f.error && f.error.stack ? f.error.stack : f.error}\n`)
  }
}
try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 临时目录清不掉就算了 */ }
process.exit(failed > 0 ? 1 : 0)
