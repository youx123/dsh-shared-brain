#!/usr/bin/env node
/** remote-sync 测试：加「勾选的会话同步后不丢」两条 */
import { readFileSync, writeFileSync } from 'node:fs'

const P = 'C:/Users/13176/Documents/dsh-shared-brain-patches/tests/remote-sync.test.mjs'
const lines = readFileSync(P, 'utf8').split('\n')
const idx = lines.findIndex((l) => l.startsWith('console.log(') && l.includes('通过 / '))
if (idx < 0) throw new Error('找不到汇总行')

const block = [
  "test('restoreLocalAgentive：本机勾选的会话同步后还在（以前每同步一次就被清）', () => {",
  '  // mergeModules 返回的是推送形状（sessionIds 被清空），',
  '  // 直接写回本地就等于每次同步都把「限定自动互动到指定会话」清一遍。',
  "  const local = { agentive: { enabled: true, scope: 'session', sessionIds: ['session-abc', 'session-def'] } }",
  "  const merged = { version: 1, agentive: { enabled: true, scope: 'session', sessionIds: [], mergeStats: { added: 1 } } }",
  '  const next = RS.restoreLocalAgentive(merged, local)',
  "  assert.deepEqual(next.agentive.sessionIds, ['session-abc', 'session-def'], '勾选的会话要留住')",
  "  assert.equal(next.agentive.scope, 'session', 'scope 也要留住')",
  '})',
  '',
  "test('restoreLocalAgentive：剥掉 mergeStats（诊断字段不能落盘、更不能上云）', () => {",
  "  const next = RS.restoreLocalAgentive({ agentive: {}, mergeStats: { added: 2 } }, { agentive: { scope: 'all' } })",
  "  assert.equal(next.mergeStats, undefined, 'mergeStats 要剥掉')",
  '})',
  '',
  "test('restoreLocalAgentive：本机没勾会话时不会被塞进脏值', () => {",
  "  const next = RS.restoreLocalAgentive({ agentive: {} }, { agentive: { scope: 'weird', sessionIds: ['', '  ', 42] } })",
  "  assert.equal(next.agentive.scope, 'all', '非法 scope 退回 all')",
  '  assert.deepEqual(next.agentive.sessionIds, [], \'空串 / 非字符串都滤掉\')',
  '})',
  '',
]

lines.splice(idx, 0, ...block)
writeFileSync(P, lines.join('\n'), 'utf8')
console.log(`[ok] 在 ${idx + 1} 行前插入 3 条`)
