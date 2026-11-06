// 自动互动随机间隔 + duplicate 修复的功能验证
const LIB = 'file:///C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib/'

const P = await import(LIB + 'proactive.js')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')) }
}

// ── 1. randomizeInterval 落在 ±50% 区间内 ──────────────────────────
{
  const base = 10 * 60 * 1000
  let min = Infinity, max = -Infinity
  for (let i = 0; i < 2000; i++) {
    const v = P.randomizeInterval(base)
    if (v < min) min = v
    if (v > max) max = v
  }
  const lo = base * (1 - P.PROACTIVE_INTERVAL_JITTER)
  const hi = base * (1 + P.PROACTIVE_INTERVAL_JITTER)
  ok('randomizeInterval 不越下界', min >= lo - 1000, `min=${min} lo=${lo}`)
  ok('randomizeInterval 不越上界', max <= hi + 1000, `max=${max} hi=${hi}`)
  ok('randomizeInterval 有分散度（min<max）', max - min > base * 0.5, `${min}~${max}`)
  ok('randomizeInterval 取整到秒', P.randomizeInterval(base) % 1000 === 0)
}

// ── 2. 可注入随机源：端点值验证 ───────────────────────────────────
{
  const base = 10 * 60 * 1000
  const low = P.randomizeInterval(base, () => 0)
  const high = P.randomizeInterval(base, () => 0.999999)
  ok('rand=0 → 下界', Math.abs(low - base * 0.5) < 1000, `${low}`)
  ok('rand≈1 → 上界', Math.abs(high - base * 1.5) < 2000, `${high}`)
}

// ── 3. clamp 后再随机（基准越界也不炸）────────────────────────────
{
  const v1 = P.randomizeInterval(0)
  const v2 = P.randomizeInterval(10 ** 12)
  ok('基准 0 → 夹到最小间隔', v1 >= P.MIN_PROACTIVE_INTERVAL_MS, `${v1}`)
  ok('基准超大 → 夹到最大间隔', v2 <= P.MAX_PROACTIVE_INTERVAL_MS, `${v2}`)
}

// ── 4. buildProactivePrompt 带 nonce → 每次内容不同 ────────────────
{
  const a = P.buildProactivePrompt({ cwd: 'D:/x', nonce: 1 })
  const b = P.buildProactivePrompt({ cwd: 'D:/x', nonce: 2 })
  const c = P.buildProactivePrompt({ cwd: 'D:/x' })
  ok('nonce 不同 → 提示词不同', a !== b)
  ok('提示词含 nonce', a.includes('1'))
  ok('无 nonce 时不炸', typeof c === 'string' && c.length > 0)
}

// ── 5. 关键回归：同一 agent 连发 3 次（冷却期内不重复），过冷却后不再被 duplicate 挡掉 ──
{
  const sent = []
  const agent = {
    session: { header: { id: 'session-test-1', cwd: 'D:/x' } },
    followup: (payload) => { sent.push(payload); return true },
  }
  const agentive = { enabled: true, scope: 'all', sessionIds: [] }
  // 冷却时间为 0 → 模拟「间隔到了」的情形
  const r1 = P.nudgeAgent(agent, { agentive, sessionId: 'session-test-1', nonce: 1, cooldownMs: 0 })
  const r2 = P.nudgeAgent(agent, { agentive, sessionId: 'session-test-1', nonce: 2, cooldownMs: 0 })
  const r3 = P.nudgeAgent(agent, { agentive, sessionId: 'session-test-1', nonce: 3, cooldownMs: 0 })
  ok('连续 3 次都发出去', r1 === true && r2 === true && r3 === true, `${r1}/${r2}/${r3}`)
  ok('实际投递 3 条', sent.length === 3, `${sent.length}`)
  ok('三条内容互不相同', new Set(sent.map((m) => m.content[0].text)).size === 3)
  ok('三条消息 id 互不相同', new Set(sent.map((m) => m.id)).size === 3)
  ok('消息 id 前缀 proactive-', String(sent[0].id).startsWith('proactive-'), `${sent[0].id}`)

  // 默认冷却期内：应当被 cooldown 挡掉，而不是 duplicate
  const r4 = P.nudgeAgent(agent, { agentive, sessionId: 'session-test-1', nonce: 4 })
  ok('冷却期内被 cooldown 挡掉', r4 === false && P.lastSkip() === 'cooldown', `skip=${P.lastSkip()}`)

  // 内容真的重复时，仍然会被 duplicate 挡掉（这个判定要保留）
  const dup = P.nudgeAgent(agent, { agentive, sessionId: 'session-test-1', nonce: 3, cooldownMs: 0 })
  ok('相同 nonce → duplicate 仍生效', dup === false && P.lastSkip() === 'duplicate', `skip=${P.lastSkip()}`)
}

// ── 6. proactiveStatus 暴露随机间隔字段 ────────────────────────────
{
  const st = P.proactiveStatus()
  ok('status 有 jitter', typeof st.jitter === 'number', `${st.jitter}`)
  ok('status 有 nextIntervalMs', 'nextIntervalMs' in st)
  ok('status 有 nextFireAt', 'nextFireAt' in st)
  ok('status 有 lastIntervalMs', 'lastIntervalMs' in st)
}

// ── 7. startProactiveLoop 用 setTimeout 链，间隔随机 ───────────────
{
  const ctx = { agents: { list: () => [] } }
  const options = {
    intervalMs: 60 * 1000,
    getAgentive: () => ({ enabled: true }),
  }
  const r = P.startProactiveLoop(ctx, options)
  const st = P.proactiveStatus()
  ok('定时器已启动', st.running === true)
  ok('nextIntervalMs 在 30~90 分钟外（基准1分钟±50%）',
    st.nextIntervalMs >= P.MIN_PROACTIVE_INTERVAL_MS && st.nextIntervalMs <= 90 * 1000,
    `${st.nextIntervalMs}`)
  ok('nextFireAt 在未来', st.nextFireAt > Date.now(), `${st.nextFireAt}`)
  P.stopProactiveLoop()
  ok('停止后 running=false', P.proactiveStatus().running === false)
}

// ── 8. 关闭开关后不再续排 ──────────────────────────────────────────
{
  const ctx = { agents: { list: () => [] } }
  let enabled = true
  P.startProactiveLoop(ctx, { intervalMs: 60 * 1000, getAgentive: () => ({ enabled }) })
  ok('开启时定时器在跑', P.proactiveStatus().running === true)
  enabled = false
  P.stopProactiveLoop()
  P.clearProactiveState()
  ok('clearProactiveState 清掉随机字段',
    P.proactiveStatus().lastIntervalMs === 0 && P.proactiveStatus().nextFireAt === 0)
}

// ── 9. 旧功能没被破坏（16 项基线里的关键几项）───────────────────────
{
  ok('sameSessionId 归一化', P.sameSessionId('session-abc', 'abc') === true)
  ok('inProactiveScope 全局模式',
    P.inProactiveScope(null, { enabled: true, scope: 'all' }, 'session-x') === true)
  ok('inProactiveScope 指定会话',
    P.inProactiveScope(null, { enabled: true, scope: 'session', sessionIds: ['abc'] }, 'session-abc') === true)
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
