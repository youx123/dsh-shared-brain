// 老大刚说过话的时候别插嘴（ACTIVE_GRACE_MS）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-active-'))
process.env.DSH_HOME = home

const { appendChat } = await import('../lib/db.js')
const { nudgeAgent, lastSkip, recentlyActive, SKIP_REASON, ACTIVE_GRACE_MS } = await import('../lib/proactive.js')

const results = []
const check = (name, ok, extra = '') => results.push({ name, ok: Boolean(ok), extra })

const AGENTIVE = {
  enabled: true,
  scope: 'all',
  sessionIds: [],
  intervalMs: 15 * 60 * 1000,
  selfContinue: false,
  timeWindow: { enabled: false, start: '00:00', end: '23:59' },
  mood: { enabled: false, maxPerDay: 999, quietPeriodMs: 0, lowMood: 45, highMood: 78 },
}

function makeAgent() {
  const sent = []
  const agent = {
    session: { header: { id: 'session-active-test', createdAt: Date.now(), title: '测试' } },
    followup: (message) => sent.push(message),
    inject: (message) => sent.push(message),
  }
  return { agent, sent }
}

const baseOptions = () => ({
  agentive: AGENTIVE,
  sessionId: 'session-active-test',
  cwd: 'D:\\微信web开发者工具',
  title: '测试',
  moodState: null,
  moodConfig: AGENTIVE.mood,
  pending: [],
})

const now = Date.now()

// 1. 一分钟前刚说过话 → 跳过，原因 active
{
  appendChat('user', 'cognition', '这一轮的摘要', now - 60 * 1000)
  const { agent, sent } = makeAgent()
  const ok = nudgeAgent(agent, baseOptions())
  check('刚说过话时不发', ok === false && sent.length === 0, `ok=${ok} sent=${sent.length}`)
  check('跳过原因是 active', lastSkip() === SKIP_REASON.active, lastSkip())
}

// 2. 宽限期调短到 30 秒 → 一分钟前的话不再算「正在说」
{
  check('一分钟前的话在 5 分钟宽限内算活跃', recentlyActive(ACTIVE_GRACE_MS) === true)
  check('同样的话在 30 秒宽限外不算活跃', recentlyActive(30 * 1000) === false)
  check('activeGraceMs=0 永远不算活跃', recentlyActive(0) === false)
}

// 3. 手动触发（force）不被挡
{
  const { agent, sent } = makeAgent()
  const ok = nudgeAgent(agent, { ...baseOptions(), force: true })
  check('force 时照发', ok === true && sent.length === 1, `ok=${ok} sent=${sent.length}`)
}

// 4. activeGraceMs=0 等于关掉这条规则
{
  const { agent } = makeAgent()
  nudgeAgent(agent, { ...baseOptions(), activeGraceMs: 0 })
  check('activeGraceMs=0 时不按 active 跳过', lastSkip() !== SKIP_REASON.active, lastSkip())
}

// 5. 常量是 5 分钟
check('ACTIVE_GRACE_MS 是 5 分钟', ACTIVE_GRACE_MS === 5 * 60 * 1000, String(ACTIVE_GRACE_MS))

// Windows 上 SQLite 句柄可能还没释放，删不掉就算了，临时目录留着不碍事。
try {
  rmSync(home, { recursive: true, force: true })
} catch {
  // ignore
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  ' + r.extra}`)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
