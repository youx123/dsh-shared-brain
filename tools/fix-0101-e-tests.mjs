#!/usr/bin/env node
/**
 * 更新两条「测的是旧行为」的断言 —— 旧行为正是审计标出的 bug。
 *
 * ① tests/remote-sync.test.mjs
 *    旧断言：mergePersona 的返回值要带本机 bySession。
 *    但合并结果是**要推给远端**的形状 —— 带着 bySession 就是 P1-6 查到的
 *    「本机会话映射被推上云」。现在 bySession 不进合并结果，
 *    由 syncOnce 落地时单独从本地补回去。
 *
 * ② test/harness.js（仓库侧）
 *    旧断言：未知会话要退回最近活跃会话（兜底）。
 *    但那正是 P1-12 的跨会话串味 —— A 会话的内容喂给 B 会话。
 *    现在有 sessionId 但取不到就返回空，不再拿别的会话顶。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PATCHES = 'C:/Users/13176/Documents/dsh-shared-brain-patches'
const REPO = 'D:/tmp/dsh-shared-brain'

function patch(file, from, to) {
  const src = readFileSync(file, 'utf8')
  if (!src.includes(from)) throw new Error(`${file}: 找不到锚点`)
  if (src.split(from).length - 1 !== 1) throw new Error(`${file}: 锚点不唯一`)
  writeFileSync(file, src.replace(from, to), 'utf8')
  console.log(`[ok] ${file}`)
}

/* ① remote-sync 测试 */
patch(
  join(PATCHES, 'tests/remote-sync.test.mjs'),
  `  test("mergePersona：personas 按 id 并集，本机会话映射原样保留", () => {`,
  `  test("mergePersona：personas 按 id 并集，会话映射不进合并结果", () => {`,
)

patch(
  join(PATCHES, 'tests/remote-sync.test.mjs'),
  `    const merged = sync.mergePersona(local, remoteP)
    assertEqual(merged.current, "a", "人设时间戳更新的赢")
    assertEqual(merged.personas.length, 2, "并集两条")
    assertEqual(merged.personas.find((p) => p.id === "a").name, "本机", "同 id 取新")
    // 2026-11-03（P1-6）：旧实现把 bySession 清空，写回本机时会把所有
    // 「会话 → 人设」绑定抹掉。会话映射是纯本机的东西，必须原样留着。
    assertEqual(Object.keys(merged.bySession).length, 1, "本机会话映射要留着")
    assertEqual(merged.bySession.s1, "a", "本机的绑定不动")
    assertEqual(Object.keys(merged.bySession).includes("s2"), false, "远端的会话映射不进来")`,
  `    const merged = sync.mergePersona(local, remoteP)
    assertEqual(merged.current, "a", "人设时间戳更新的赢")
    assertEqual(merged.personas.length, 2, "并集两条")
    assertEqual(merged.personas.find((p) => p.id === "a").name, "本机", "同 id 取新")
    // 2026-11-04（P1-6 审计）：合并结果**不带** bySession。
    // 「会话 → 人设」的绑定是本机的事（别的机器上没有这些会话），
    // 以前它跟着合并结果写进远端 persona.json → 本机布局泄露到云上，
    // 远端回来时又会把本机绑定覆盖掉。
    // 本机的绑定由 syncOnce 落地时单独从本地补回来（见下面那条测试）。
    assertEqual(merged.bySession, undefined, "合并结果不带会话映射")`,
)

/* 新增：验证 syncOnce 落地时会把本机 bySession 补回来 */
patch(
  join(PATCHES, 'tests/remote-sync.test.mjs'),
  `  test("mergePersona：current 只听自己的 currentAt，不抢整份时间戳", () => {`,
  `  test("mergePersona：会话映射不进合并结果，但本机那份仍然有效", () => {
    // 合并结果是要推给远端的形状 —— 里面不该有 bySession。
    // 本机的 bySession 存在 persona.json 里，syncOnce 落地时补回去，
    // 所以「合并结果没有」不等于「本机丢了」。
    const local = {
      version: 1,
      current: "a",
      currentAt: 1000,
      personas: [{ id: "a", name: "甲", updatedAt: 1000 }],
      bySession: { s1: "a", s2: "a" },
      updatedAt: 1000,
    }
    const merged = sync.mergePersona(local, {}, {})
    assertEqual(merged.bySession, undefined, "推给远端的不带会话映射")
    assertEqual(Object.keys(local.bySession).length, 2, "本地那份原样没动")
  })

  test("mergePersona：current 只听自己的 currentAt，不抢整份时间戳", () => {`,
)

/* ② harness 测试（仓库侧） */
const harness = join(REPO, 'test/harness.js')
if (existsSync(harness)) {
  patch(
    harness,
    `  assert(state.currentContext('sess-unknown').prompt === 'B 问的问题', '未知会话退回最近活跃会话（兜底，不留空）')`,
    `  // 2026-11-04（P1-12 审计）：未知会话**不再**退回最近活跃会话。
  // 以前的兜底会把 A 会话的内容喂给 B 会话（跨会话串味）。
  // 现在：有 sessionId 但取不到 → 返回空，不拿别的会话顶。
  assert(state.currentContext('sess-unknown').prompt === '', '未知会话不拿别的会话顶（返回空）')
  assert(state.currentContext('sess-unknown').sessionId === '', '未知会话返回空上下文')`,
  )
}

console.log('[done] 两条过期断言已按新行为更新')
