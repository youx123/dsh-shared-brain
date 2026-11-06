#!/usr/bin/env node
/** proactive-mood 测试：加「待办跳过 paced 但仍受每日上限」两条 */
import { readFileSync, writeFileSync } from 'node:fs'

const P = 'C:/Users/13176/Documents/dsh-shared-brain-patches/tests/proactive-mood.test.mjs'
const lines = readFileSync(P, 'utf8').split('\n')

const idx = lines.findIndex((l) => l.startsWith('process.stdout.write(') && l.includes('pass'))
if (idx < 0) throw new Error('找不到汇总行')

const block = [
  "test('待办跳过均匀铺开：额度还剩、但被 paced 压住的间隔内，待办照样能说', () => {",
  '  // 3 次/天铺在 14 小时里 → evenGap ≈ 4.7 小时。',
  '  // 待办不该被这个间隔压住（「答应过的事不能拖」），但仍受 maxPerDay 硬上限。',
  '  const decision = PM.decideProactive({',
  '    moodState: moodState({ mood: 60 }),',
  "    history: history({ lastSpokeAt: NOW - 20 * MIN, pending: ['答应老大回头把文档整理好'], spokeToday: 0 }),",
  '    config: PM.normalizeProactiveMoodConfig(),',
  '    endTs: NOW + 10 * HOUR,',
  '    now: NOW,',
  '  })',
  "  assert.equal(decision.reason, 'pending', '不该被 paced 拦下')",
  '})',
  '',
  "test('待办不突破每日上限：额度用完照样闭嘴', () => {",
  '  const config = PM.normalizeProactiveMoodConfig()',
  '  const decision = PM.decideProactive({',
  '    moodState: moodState({ mood: 60 }),',
  "    history: history({ lastSpokeAt: NOW - 20 * MIN, pending: ['答应老大回头把文档整理好'], spokeToday: config.maxPerDay }),",
  '    config,',
  '    endTs: NOW + 10 * HOUR,',
  '    now: NOW,',
  '  })',
  "  assert.equal(decision.action, 'silent')",
  "  assert.equal(decision.reason, 'daily-limit')",
  '})',
  '',
]

lines.splice(idx, 0, ...block)
writeFileSync(P, lines.join('\n'), 'utf8')
console.log(`[ok] 在 ${idx + 1} 行前插入 2 条待办闸门测试`)
