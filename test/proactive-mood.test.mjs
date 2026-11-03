/**
 * 共享大脑 · 自动互动「心情驱动」决策层测试（proactive-mood.js）
 *
 * 跑法：
 *   node "<本文件路径>"
 *
 * 只读；不碰真实的 ~/.dsh/storages/dsh-shared-brain（靠 DSH_HOME 隔离）。
 */
import assert from 'node:assert/strict'

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

const PM = await import(`file:///${LIB}/proactive-mood.js`)
const E = await import(`file:///${LIB}/emotion.js`)
const M = await import(`file:///${LIB}/modules.js`)

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

const MIN = 60 * 1000
const HOUR = 60 * MIN

/** 造一个心情状态。 */
function moodState({ mood = 70, dims = {}, updatedAt = Date.now() } = {}) {
  return {
    sessionId: 's1',
    mood,
    dims: { happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0, ...dims },
    updatedAt,
    lastDecayAt: updatedAt,
    lastNotedMood: mood,
    lastReason: '',
    lastConfidence: 0,
    lastDelta: null,
    minor: false,
    injectedFor: '',
    saidAt: [],
    timeline: [],
    judgements: [],
  }
}

/** 造一份历史。 */
function history(over = {}) {
  return {
    lastSpokeAt: 0,
    spokeToday: 0,
    concerns: 0,
    usedTopics: [],
    pending: [],
    ...over,
  }
}

const NOW = Date.UTC(2026, 10, 2, 8, 0, 0)

// ───────────────────────────────────────────────────────────────────
group('一、配置规整')

test('默认配置齐全且数值合理', () => {
  const cfg = PM.normalizeProactiveMoodConfig(undefined)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.lowMood, 45)
  assert.equal(cfg.highMood, 78)
  assert.equal(cfg.quietPeriodMs, 30 * MIN)
  assert.equal(cfg.maxPerDay, 3)
  assert.equal(cfg.lowIntervalFactor, 0.5)
  assert.equal(cfg.highIntervalFactor, 0.7)
  assert.equal(cfg.maxConcernsPerSession, 1)
  assert.equal(cfg.allowConcern, true)
  assert.equal(cfg.allowShare, true)
})

test('越界数值被夹紧', () => {
  const cfg = PM.normalizeProactiveMoodConfig({
    lowMood: 999, highMood: -50, quietPeriodMs: 999 * HOUR,
    maxPerDay: 1e9, lowIntervalFactor: 0, highIntervalFactor: 99,
    maxConcernsPerSession: 999,
  })
  assert.equal(cfg.lowMood, 100)
  // highMood 先夹到 0，再因为低于 lowMood(100) 被拉平到 100
  assert.equal(cfg.highMood, 100)
  assert.equal(cfg.quietPeriodMs, 24 * HOUR)
  assert.equal(cfg.maxPerDay, 50)
  assert.equal(cfg.lowIntervalFactor, 0.1)
  assert.equal(cfg.highIntervalFactor, 2)
  assert.equal(cfg.maxConcernsPerSession, 10)
})

test('highMood 低于 lowMood 时被拉平', () => {
  const cfg = PM.normalizeProactiveMoodConfig({ lowMood: 80, highMood: 20 })
  assert.ok(cfg.highMood >= cfg.lowMood, `${cfg.lowMood} / ${cfg.highMood}`)
})

test('非数字输入退回默认值', () => {
  const cfg = PM.normalizeProactiveMoodConfig({ lowMood: 'x', maxPerDay: null })
  assert.equal(cfg.lowMood, 45)
  assert.equal(cfg.maxPerDay, 3)
})

test('modules.js 的 agentive.mood 与决策层默认一致', () => {
  const mods = M.defaultModules()
  assert.ok(mods.agentive.mood, 'agentive.mood 不存在')
  const cfg = PM.normalizeProactiveMoodConfig(mods.agentive.mood)
  const def = PM.normalizeProactiveMoodConfig(undefined)
  assert.equal(cfg.lowMood, def.lowMood)
  assert.equal(cfg.highMood, def.highMood)
  assert.equal(cfg.quietPeriodMs, def.quietPeriodMs)
  assert.equal(cfg.maxPerDay, def.maxPerDay)
})

// ───────────────────────────────────────────────────────────────────
group('二、心情信号读档')

test('mood 低于 lowMood → low', () => {
  const signal = PM.readMoodSignal(moodState({ mood: 30 }), PM.normalizeProactiveMoodConfig())
  assert.equal(signal.level, 'low')
  assert.equal(signal.mood, 30)
})

test('mood 高于 highMood → high', () => {
  const signal = PM.readMoodSignal(moodState({ mood: 90 }), PM.normalizeProactiveMoodConfig())
  assert.equal(signal.level, 'high')
})

test('中性心情 → neutral', () => {
  const signal = PM.readMoodSignal(moodState({ mood: 60 }), PM.normalizeProactiveMoodConfig())
  assert.equal(signal.level, 'neutral')
})

test('嘴上说没事但主导维度是 worry → low（捕捉隐藏的低落）', () => {
  const signal = PM.readMoodSignal(
    moodState({ mood: 60, dims: { worry: 30 } }),
    PM.normalizeProactiveMoodConfig(),
  )
  assert.equal(signal.level, 'low', `实际 ${signal.level}`)
  assert.equal(signal.dominant, 'worry')
})

test('主导维度是 happy 且够高 → high', () => {
  const signal = PM.readMoodSignal(
    moodState({ mood: 60, dims: { happy: 35 } }),
    PM.normalizeProactiveMoodConfig(),
  )
  assert.equal(signal.level, 'high', `实际 ${signal.level}`)
})

test('没有心情状态时按中性处理', () => {
  const signal = PM.readMoodSignal(null, PM.normalizeProactiveMoodConfig())
  assert.equal(signal.level, 'neutral')
})

// ───────────────────────────────────────────────────────────────────
group('三、决策：有待办必说话')

test('有真待办 → speak（不管什么心情）', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 60 }),
    history: history({ pending: ['答应老大回头把文档整理好'] }),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
  })
  assert.equal(decision.action, 'speak')
  assert.equal(decision.reason, 'pending')
})

test('待办为空且心情中性且刚说完 → silent（静默机制）', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 60 }),
    history: history({ lastSpokeAt: NOW - 5 * MIN, pending: [] }),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
  })
  assert.equal(decision.action, 'silent')
  assert.equal(decision.reason, 'quiet-period')
})

test('待办为空且心情中性且很久没说话 → speak（routine）', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 60 }),
    history: history({ lastSpokeAt: NOW - 5 * HOUR, pending: [] }),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
  })
  assert.equal(decision.action, 'speak')
  assert.equal(decision.reason, 'routine')
})

// ───────────────────────────────────────────────────────────────────
group('四、决策：心情驱动')

test('心情低落 → speak + 关心语气 + 缩短间隔', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 30 }),
    history: history(),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
  })
  assert.equal(decision.action, 'speak')
  assert.equal(decision.reason, 'concern')
  assert.equal(decision.tone, 'soft')
  assert.equal(decision.intervalFactor, 0.5)
  assert.ok(decision.topic, '应当挑到一个关心类话题')
})

test('心情低落但已关心过 → 仍会说话，只是换成轻软语气（不追问、不沉默）', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 30 }),
    history: history({ concerns: 1 }),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
  })
  assert.equal(decision.action, 'speak')
  assert.equal(decision.reason, 'concern-already')
  assert.equal(decision.tone, 'soft')
})

test('关心过一次后安静期放大到 4 倍（不连着追着问）', () => {
  const cfg = PM.normalizeProactiveMoodConfig()
  // 安静期 30 分钟 × 4 = 2 小时；刚过 1 小时 → 还该静默
  const early = PM.decideProactive({
    moodState: moodState({ mood: 30 }),
    history: history({ concerns: 1, lastSpokeAt: NOW - HOUR }),
    config: cfg,
    now: NOW,
  })
  assert.equal(early.action, 'silent')
  assert.equal(early.reason, 'quiet-period')
  // 过了 2 小时 → 可以再说
  const later = PM.decideProactive({
    moodState: moodState({ mood: 30 }),
    history: history({ concerns: 1, lastSpokeAt: NOW - 3 * HOUR }),
    config: cfg,
    now: NOW,
  })
  assert.equal(later.action, 'speak')
})

test('心情高 → speak + 轻快语气 + 分享话题', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 90 }),
    history: history(),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
  })
  assert.equal(decision.action, 'speak')
  assert.equal(decision.reason, 'share')
  assert.equal(decision.tone, 'upbeat')
  assert.equal(decision.intervalFactor, 0.7)
})

test('今天说得太多 → silent（daily-limit）', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 90 }),
    history: history({ spokeToday: 3 }),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
  })
  assert.equal(decision.action, 'silent')
  assert.equal(decision.reason, 'daily-limit')
})

test('关掉心情驱动 → 不看心情，但安静期照旧（不再每 15 分钟刷一次）', () => {
  const cfg = PM.normalizeProactiveMoodConfig({ enabled: false })
  const justSpoke = PM.decideProactive({
    moodState: moodState({ mood: 30 }),
    history: history({ lastSpokeAt: NOW - MIN }),
    config: cfg,
    now: NOW,
  })
  assert.equal(justSpoke.action, 'silent')
  assert.equal(justSpoke.reason, 'quiet-period')
  // 安静期过了就正常说话，而且**不带**心情色彩
  const longAgo = PM.decideProactive({
    moodState: moodState({ mood: 30 }),
    history: history({ lastSpokeAt: NOW - 5 * HOUR }),
    config: cfg,
    now: NOW,
  })
  assert.equal(longAgo.action, 'speak')
  assert.equal(longAgo.reason, 'routine')
  assert.equal(longAgo.tone, 'light')
})

test('关掉「关心」开关 → 心情低也不主动关心', () => {
  const cfg = PM.normalizeProactiveMoodConfig({ allowConcern: false })
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 30 }),
    history: history(),
    config: cfg,
    now: NOW,
  })
  assert.notEqual(decision.reason, 'concern')
})

test('关掉「分享」开关 → 心情高不分享', () => {
  const cfg = PM.normalizeProactiveMoodConfig({ allowShare: false })
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 90 }),
    history: history(),
    config: cfg,
    now: NOW,
  })
  assert.notEqual(decision.reason, 'share')
})

test('低落时关心可以突破每日额度（额度不能把人挡在门外）', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 20 }),
    history: history({ spokeToday: 5 }),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
  })
  assert.equal(decision.action, 'speak')
  assert.equal(decision.reason, 'concern')
})

test('但突破额度只给关心，高兴时照样受额度限制', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 95 }),
    history: history({ spokeToday: 5 }),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
  })
  assert.equal(decision.action, 'silent')
  assert.equal(decision.reason, 'daily-limit')
})

test('额度按剩余时间均匀铺开（不会上午用光下午哑火）', () => {
  const cfg = PM.normalizeProactiveMoodConfig()
  // 还剩 3 次额度、距今日窗口结束还有 3 小时 → 每次至少要隔 1 小时
  // 安静期只有 30 分钟，所以「过了安静期但没到均摊间隔」时会判 paced
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 60 }),
    history: history({ lastSpokeAt: NOW - 40 * MIN, spokeToday: 0 }),
    config: cfg,
    now: NOW,
    dayEnd: NOW + 3 * HOUR,
  })
  assert.equal(decision.action, 'silent')
  assert.equal(decision.reason, 'paced')
})

test('均摊间隔过后就正常说话（不是一直压着）', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 60 }),
    history: history({ lastSpokeAt: NOW - 70 * MIN, spokeToday: 0 }),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
    dayEnd: NOW + 3 * HOUR,
  })
  assert.equal(decision.action, 'speak')
  assert.equal(decision.reason, 'routine')
})

test('待办不豁免每日额度（同一件事不会一天提醒 57 遍）', () => {
  const decision = PM.decideProactive({
    moodState: moodState({ mood: 60 }),
    history: history({ spokeToday: 3, pending: ['答应老大修共享大脑'] }),
    config: PM.normalizeProactiveMoodConfig(),
    now: NOW,
    dayEnd: NOW + 8 * HOUR,
  })
  assert.equal(decision.action, 'silent')
  assert.equal(decision.reason, 'daily-limit')
})

test('静默期对关心和分享同样生效（不连珠炮）', () => {
  const cfg = PM.normalizeProactiveMoodConfig()
  for (const mood of [30, 95]) {
    const decision = PM.decideProactive({
      moodState: moodState({ mood }),
      history: history({ lastSpokeAt: NOW - MIN }),
      config: cfg,
      now: NOW,
    })
    assert.equal(decision.action, 'silent', `心情 ${mood} 刚说完就该静默`)
    assert.equal(decision.reason, 'quiet-period')
  }
})

// ───────────────────────────────────────────────────────────────────
group('五、话题多样性')

test('优先挑没用过的话题', () => {
  const used = ['progress', 'pending']
  const topic = PM.pickTopic({ pool: PM.TOPIC_LIBRARY, used, rand: () => 0.5 })
  assert.ok(topic)
  assert.ok(!used.includes(topic.key), `挑到了用过的 ${topic.key}`)
})

test('全部用过时挑用得最少的那个', () => {
  const pool = [{ key: 'a', text: 'a', tone: 'light' }, { key: 'b', text: 'b', tone: 'light' }]
  const topic = PM.pickTopic({ pool, used: ['a', 'a', 'b'], rand: () => 0.5 })
  assert.equal(topic.key, 'b')
})

test('exclude 里的话题被跳过', () => {
  const pool = [{ key: 'a', text: 'a', tone: 'light' }, { key: 'b', text: 'b', tone: 'light' }]
  const topic = PM.pickTopic({ pool, used: [], rand: () => 0.5, exclude: 'a' })
  assert.equal(topic.key, 'b')
})

test('rememberTopic 只保留最近 12 个', () => {
  let used = []
  for (let i = 0; i < 20; i += 1) used = PM.rememberTopic(used, `t${i}`)
  assert.equal(used.length, 12)
  assert.equal(used[used.length - 1], 't19')
})

test('话题库不为空且每条都有文本与语气', () => {
  assert.ok(PM.TOPIC_LIBRARY.length >= 8, `话题太少：${PM.TOPIC_LIBRARY.length}`)
  for (const topic of PM.TOPIC_LIBRARY) {
    assert.ok(topic.key, '缺 key')
    assert.ok(topic.text, `话题 ${topic.key} 缺文本`)
    assert.ok(topic.tone, `话题 ${topic.key} 缺语气`)
  }
})

// ───────────────────────────────────────────────────────────────────
group('六、语气与提示')

test('TONE_HINTS 覆盖所有用到的语气', () => {
  for (const tone of ['soft', 'upbeat', 'warm', 'light', 'neutral']) {
    assert.ok(PM.TONE_HINTS[tone], `缺语气提示 ${tone}`)
  }
})

test('心情提示只在 low/high 时出现', () => {
  const cfg = PM.normalizeProactiveMoodConfig()
  const low = PM.renderMoodSignal
    ? null
    : null
  const signalLow = PM.readMoodSignal(moodState({ mood: 30 }), cfg)
  const signalHigh = PM.readMoodSignal(moodState({ mood: 90 }), cfg)
  const signalMid = PM.readMoodSignal(moodState({ mood: 60 }), cfg)
  assert.ok(PM.renderMoodHint(signalLow), '低时应给提示')
  assert.ok(PM.renderMoodHint(signalHigh), '高时应给提示')
  assert.equal(PM.renderMoodHint(signalMid), '', '中性不该给提示')
  assert.equal(low, null)
})

// ───────────────────────────────────────────────────────────────────
group('七、反馈闭环：主动搭话也算一轮')

test('judgeModeOf 认 plugin:dsh-shared-brain 为 talk', () => {
  assert.equal(E.judgeModeOf('plugin:dsh-shared-brain'), 'talk')
  assert.equal(E.judgeModeOf('speak-up'), 'talk')
  assert.equal(E.judgeModeOf('user'), 'user')
  assert.equal(E.judgeModeOf('schedule'), 'work')
  assert.equal(E.judgeModeOf('system-reminder'), '')
})

// ───────────────────────────────────────────────────────────────────
group('八、proactive.js 接线')

const P = await import(`file:///${LIB}/proactive.js`)

test('proactive.js 导出 formatDuration', () => {
  assert.equal(typeof P.formatDuration, 'function')
  assert.ok(P.formatDuration(30 * 1000).includes('不到一分钟'))
  assert.ok(P.formatDuration(5 * MIN).includes('分钟'))
  assert.ok(P.formatDuration(3 * HOUR).includes('小时'))
  assert.ok(P.formatDuration(2 * 24 * HOUR).includes('天'))
})

test('SKIP_REASON 有 silent', () => {
  assert.equal(P.SKIP_REASON.silent, 'silent')
})

test('proactiveStatus 带 silenced / lastDecisionReason / lastMoodBand', () => {
  const status = P.proactiveStatus()
  assert.ok('silenced' in status, '缺 silenced')
  assert.ok('lastDecisionReason' in status, '缺 lastDecisionReason')
  assert.ok('lastMoodBand' in status, '缺 lastMoodBand')
})

test('buildProactivePrompt 说明是主动搭话，并带话题与语气', () => {
  const prompt = P.buildProactivePrompt({
    topicText: '最近手上那件事推进得怎么样？',
    moodHint: '老大这会儿有点累。',
    toneHint: '语气放轻一点。',
    title: '某个会话',
  })
  assert.ok(prompt.includes('主动搭话'), prompt.slice(0, 120))
  assert.ok(prompt.includes('最近手上那件事推进得怎么样？'))
  assert.ok(prompt.includes('老大这会儿有点累。'))
  assert.ok(prompt.includes('语气放轻一点。'))
  assert.ok(prompt.includes('暂时没有需要主动做的事'), '必须留静默出口')
})

// ───────────────────────────────────────────────────────────────────
process.stdout.write(`\n结果：${passed} 通过 / ${failed} 失败\n`)
if (failed > 0) {
  process.stdout.write('\n失败明细：\n')
  for (const f of failures) {
    process.stdout.write(`  · ${f.name}\n    ${f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 4).join('\n    ') : f.error}\n`)
  }
}
process.exit(failed > 0 ? 1 : 0)
