#!/usr/bin/env node
/** 给续接轮次接线加回归测试（插在 proactive-mood 汇总打印之前） */
import { readFileSync, writeFileSync } from 'node:fs'

const P = 'C:/Users/13176/Documents/dsh-shared-brain-patches/tests/proactive-mood.test.mjs'
const lines = readFileSync(P, 'utf8').split('\n')
const idx = lines.findIndex((l) => l.startsWith('process.stdout.write(') && l.includes('pass'))
if (idx < 0) throw new Error('找不到汇总行')

const block = String.raw`
// ─────────────────────────────────────────────────────────────
console.log('== 续接轮次接线 ==')
// ─────────────────────────────────────────────────────────────

test('continueReasonOf：认得 HTML 注释形态的续接标记', () => {
  const text = '先把 A 做完。\n<!-- 继续：把测试跑完 -->'
  assert.equal(PM.continueReasonOf(text), '把测试跑完')
})

test('continueReasonOf：也认纯文本兜底形态', () => {
  assert.equal(PM.continueReasonOf('中间一句\n[[继续: 补文档]]'), '补文档')
})

test('continueReasonOf：正文中间提到「继续」不算信号', () => {
  assert.equal(PM.continueReasonOf('我继续看了一下代码，没问题。'), '')
  assert.equal(PM.continueReasonOf(''), '')
  assert.equal(PM.continueReasonOf(null), '')
})

test('continueReasonOf：标记在该看的位置之外就不认（只看末尾 400 字）', () => {
  const text = '<!-- 继续：很早以前 -->' + '填充'.repeat(400) + '\n收尾'
  assert.equal(PM.continueReasonOf(text), '')
})

test('shouldContinueTurn：没理由不续、超过 3 轮不续', () => {
  const agentive = { enabled: true, scope: 'all', sessionIds: [], timeWindow: { enabled: false } }
  PM.resetContinueRound('s-cont')
  assert.equal(PM.shouldContinueTurn('s-cont', agentive, ''), false, '没理由不续')
  assert.equal(PM.shouldContinueTurn('s-cont', agentive, '一'), true)
  assert.equal(PM.shouldContinueTurn('s-cont', agentive, '二'), true)
  assert.equal(PM.shouldContinueTurn('s-cont', agentive, '三'), true)
  assert.equal(PM.shouldContinueTurn('s-cont', agentive, '四'), false, '第 4 轮该停')
  assert.equal(PM.roundOf('s-cont'), 3)
})

test('resetContinueRound：老大说话后轮次清零（不然一个会话续满 3 轮就永远死了）', () => {
  const agentive = { enabled: true, scope: 'all', sessionIds: [], timeWindow: { enabled: false } }
  PM.resetContinueRound('s-reset')
  for (let i = 0; i < 3; i++) PM.shouldContinueTurn('s-reset', agentive, '第 ' + i)
  assert.equal(PM.roundOf('s-reset'), 3)
  PM.resetContinueRound('s-reset')
  assert.equal(PM.roundOf('s-reset'), 0)
  assert.equal(PM.shouldContinueTurn('s-reset', agentive, '重新开始'), true)
})

test('shouldContinueTurn：不在作用范围的会话不续', () => {
  const agentive = { enabled: true, scope: 'session', sessionIds: ['only-this'], timeWindow: { enabled: false } }
  PM.resetContinueRound('other')
  assert.equal(PM.shouldContinueTurn('other', agentive, '想做点啥'), false)
})

test('agentive 默认带 selfContinue，只有写 false 才关', () => {
  const on = M.normalizeModules({ agentive: { enabled: true } })
  assert.equal(on.agentive.selfContinue, true, '默认开')
  const off = M.normalizeModules({ agentive: { enabled: true, selfContinue: false } })
  assert.equal(off.agentive.selfContinue, false, '写 false 就关')
  const junk = M.normalizeModules({ agentive: { enabled: true, selfContinue: 'nope' } })
  assert.equal(junk.agentive.selfContinue, true, '乱写的值不当成关闭')
})

const WR = await import(\`file:///\${LIB}/weighted-recall.js\`)

test('renderCapabilities：续接开关决定提示词里提不提这个标记', () => {
  const base = {
    network: { enabled: false },
    agentive: { enabled: true, scope: 'all', sessionIds: [], timeWindow: { enabled: false } },
  }
  const withHint = WR.renderCapabilities({ ...base, agentive: { ...base.agentive, selfContinue: true } })
  assert.ok(withHint.includes('<!-- 继续：'), '开着就有标记说明')
  const withoutHint = WR.renderCapabilities({ ...base, agentive: { ...base.agentive, selfContinue: false } })
  assert.equal(withoutHint.includes('<!-- 继续：'), false, '关掉就别再提')
})
`

lines.splice(idx, 0, ...block.split('\n'))
writeFileSync(P, lines.join('\n'), 'utf8')
console.log(`[ok] 在 ${idx + 1} 行前插入续接测试`)
