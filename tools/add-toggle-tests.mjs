#!/usr/bin/env node
/**
 * 给「开关看不出来是开还是关」加回归测试。
 *
 * 断言的是老大抱怨的那一点：按钮上必须能直接读出当前状态（● 已开启 / ○ 已关闭），
 * 而不是只有「启用 / 停用」这种状态动作两可的词。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.SB_PATCHES || 'C:/Users/13176/Documents/dsh-shared-brain-patches'
const p = join(ROOT, 'tests', 'ui-render.test.mjs')
let src = readFileSync(p, 'utf8')

// ① 把 CapabilityCard 也暴露出来
const exposeFrom = '      + " brainPanel: typeof BrainPanel === \\"function\\" ? BrainPanel : null"'
if (src.split(exposeFrom).length - 1 !== 1) throw new Error('暴露锚点')
src = src.replace(
  exposeFrom,
  '      + " capabilityCard: typeof CapabilityCard === \\"function\\" ? CapabilityCard : null"'
  + '\n' + exposeFrom,
)

// ② 测试组插在汇总打印之前
const marker = 'console.log(`\\n${passed} 通过 / ${failed} 失败`)'
if (src.split(marker).length - 1 !== 1) throw new Error('汇总锚点')

const block = `
/* ------------------------------------------------------------------ */
/* 开关文案：按钮上必须能直接读出「开」还是「关」                        */
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

{
  const onCard = cards2.capabilityCard({
    t: tZh,
    busy: false,
    modules: { network: { enabled: true }, agentive: { enabled: false } },
    onToggle: () => {},
  })
  const text = renderText(onCard)

  ok(text.includes("● 已开启"), "开启态按钮上有实心圆 + 已开启")
  ok(text.includes("○ 已关闭"), "关闭态按钮上有空心圆 + 已关闭")
  ok(!text.includes("启用"), "不再出现「启用」这种状态/动作两可的词")
  ok(!text.includes("停用"), "不再出现「停用」")
  ok(text.includes("已开启 1 / 2"), "卡片标题旁有汇总：已开启 1 / 2")

  // title 写的是「点它会怎样」，不是重复一遍状态
  const buttons = []
  const walk = (node) => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === "button") buttons.push(node.props)
    if (node.props && node.props.children) {
      const kids = node.props.children
      if (Array.isArray(kids)) kids.forEach(walk)
      else walk(kids)
    }
  }
  walk(onCard)
  ok(buttons.length === 2, "两张能力卡片各一个按钮")
  ok(buttons[0].title === "点此关闭", "开启态 title 提示「点此关闭」")
  ok(buttons[0]["aria-pressed"] === "true", "开启态 aria-pressed=true")
  ok(buttons[1].title === "点此开启", "关闭态 title 提示「点此开启」")
  ok(buttons[1]["aria-pressed"] === "false", "关闭态 aria-pressed=false")
}

`

src = src.replace(marker, block + marker)
writeFileSync(p, src, 'utf8')
console.log('[ok] ui-render：加 10 条开关文案断言')
