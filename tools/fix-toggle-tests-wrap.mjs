#!/usr/bin/env node
/**
 * 把上一版「用 ok() 裸断言」的测试块改成 test() 包裹。
 *
 * 教训：这个文件里的 ok() 只是抛错，不涨计数；只有 test(name, fn) 才会 ✓ 并计数。
 * 上一版写在顶层，断言过了也看不见，失败还会整文件崩掉。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.SB_PATCHES || 'C:/Users/13176/Documents/dsh-shared-brain-patches'
const p = join(ROOT, 'tests', 'ui-render.test.mjs')
const src = readFileSync(p, 'utf8')

const START = '/* 开关文案：按钮上必须能直接读出「开」还是「关」'
const END = 'console.log(`\\n${passed} 通过 / ${failed} 失败`)'
const si = src.indexOf(START)
const ei = src.indexOf(END)
if (si < 0 || ei < 0 || ei < si) throw new Error('锚点')

// 保留 START 前面的分隔线
const head = src.slice(0, si)
const tail = src.slice(ei)

const block = `/* 开关文案：按钮上必须能直接读出「开」还是「关」                        */
/* ------------------------------------------------------------------ */

const cards2 = loadClient()
const tZh = (key) => ({
  capTitle: "能力开关",
  capSummary: "已开启",
  enabled: "已开启",
  disabled: "已关闭",
  enabledLabel: "点此关闭",
  disabledLabel: "点此开启",
  network: "网络",
  networkNote: "允许取外部信息",
  agentive: "自动互动",
  agentiveNote: "没事找你说两句",
}[key] ?? key)

function capCard(modules) {
  return cards2.capabilityCard({ t: tZh, busy: false, modules, onToggle: () => {} })
}

function buttonsOf(node) {
  const out = []
  const walk = (n) => {
    if (!n || typeof n !== "object") return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === "button") out.push(n.props)
    if (n.props && n.props.children !== undefined) {
      const kids = n.props.children
      if (Array.isArray(kids)) kids.forEach(walk)
      else walk(kids)
    }
  }
  walk(node)
  return out
}

group("开关文案（必须有明显的开 / 关信息）")

test("开启态按钮写着「● 已开启」，关闭态写着「○ 已关闭」", () => {
  const text = renderText(capCard({ network: { enabled: true }, agentive: { enabled: false } }))
  ok(text.includes("● 已开启"), "开启态按钮上有实心圆 + 已开启")
  ok(text.includes("○ 已关闭"), "关闭态按钮上有空心圆 + 已关闭")
})

test("不再出现「启用 / 停用」这种状态动作两可的词", () => {
  const text = renderText(capCard({ network: { enabled: true }, agentive: { enabled: false } }))
  ok(!text.includes("启用"), "不该出现「启用」")
  ok(!text.includes("停用"), "不该出现「停用」")
})

test("卡片标题旁有汇总「已开启 N / M」", () => {
  const text = renderText(capCard({ network: { enabled: true }, agentive: { enabled: false } }))
  ok(text.includes("已开启 1 / 2"), "汇总应为 已开启 1 / 2，实际：" + text.slice(0, 80))
})

test("按钮 title 写的是动作（点此关闭 / 点此开启），不重复状态", () => {
  const buttons = buttonsOf(capCard({ network: { enabled: true }, agentive: { enabled: false } }))
  ok(buttons.length === 2, "两张能力卡片各一个按钮，实际 " + buttons.length)
  ok(buttons[0].title === "点此关闭", "开启态 title 应为「点此关闭」，实际 " + buttons[0].title)
  ok(buttons[1].title === "点此开启", "关闭态 title 应为「点此开启」，实际 " + buttons[1].title)
})

test("按钮带 aria-pressed，读屏也能知道开关状态", () => {
  const buttons = buttonsOf(capCard({ network: { enabled: true }, agentive: { enabled: false } }))
  ok(buttons[0]["aria-pressed"] === "true", "开启态 aria-pressed 应为 true")
  ok(buttons[1]["aria-pressed"] === "false", "关闭态 aria-pressed 应为 false")
})

test("两个都开时汇总显示 2 / 2", () => {
  const text = renderText(capCard({ network: { enabled: true }, agentive: { enabled: true } }))
  ok(text.includes("已开启 2 / 2"), "汇总应为 已开启 2 / 2")
})

`

writeFileSync(p, head + block + tail, 'utf8')
console.log('[ok] 改用 test() 包裹，6 条用例')
