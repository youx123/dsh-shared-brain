#!/usr/bin/env node
/**
 * 设置页的开关「看不出是开还是关」。
 *
 * 现状：按钮文字只有「启用 / 停用」两个词 —— 它描述的是状态还是动作，全靠猜。
 * 老大点了以后不知道生效没有，加上「勾选的会话自己取消」（那是后端 bug，
 * 已单独修）更让人怀疑按钮没用。
 *
 * 改法：
 *  1. 按钮文字直接写清「当前状态 + 点它会怎样」：「已开启 · 点此关闭」/「已关闭 · 点此开启」；
 *  2. 关闭态加一个空心圆、开启态加实心圆，不靠颜色也能分辨；
 *  3. 按钮加 title，悬停也有同样的说明；
 *  4. 能力卡片标题旁加一行汇总：「已开启 1 / 2」。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'client.js')
let src = readFileSync(p, 'utf8')

function once(from, to, label) {
  const n = src.split(from).length - 1
  if (n !== 1) throw new Error(`${label}：锚点出现 ${n} 次`)
  src = src.replace(from, to)
}

// ① 中文文案
once(
  `\t\t\tenabled: "启用",`,
  `\t\t\tenabled: "已开启 · 点此关闭",\n\t\t\tdisabledLabel: "已关闭 · 点此开启",\n\t\t\tcapSummary: "已开启",`,
  '中文文案',
)

// ② 英文文案
once(
  `\t\t\tenabled: "Enabled",`,
  `\t\t\tenabled: "On · click to turn off",\n\t\t\tdisabledLabel: "Off · click to turn on",\n\t\t\tcapSummary: "on",`,
  '英文文案',
)

// ③ 按钮：加圆点 + title + 新文案
once(
  `\t\t\t\t\t\tjsxRuntime.jsx("button", {
\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\tstyle: module.enabled ? styles.toggleOn : styles.toggle,
\t\t\t\t\t\t\tdisabled: busy,
\t\t\t\t\t\t\tonClick: () => onToggle(entry.id, !module.enabled),
\t\t\t\t\t\t\tchildren: module.enabled ? t("enabled") : t("disabled"),
\t\t\t\t\t\t}, "cap-toggle-" + entry.id),`,
  `\t\t\t\t\t\tjsxRuntime.jsx("button", {
\t\t\t\t\t\t\ttype: "button",
\t\t\t\t\t\t\t// 开启态：实心圆 + 填色；关闭态：空心圆 + 描边。
\t\t\t\t\t\t\t// 文字直接写「当前状态 · 点它会怎样」，不让人猜。
\t\t\t\t\t\t\tstyle: module.enabled ? styles.toggleOn : styles.toggleOff,
\t\t\t\t\t\t\tdisabled: busy,
\t\t\t\t\t\t\ttitle: module.enabled ? t("enabled") : t("disabledLabel"),
\t\t\t\t\t\t\t"aria-pressed": module.enabled ? "true" : "false",
\t\t\t\t\t\t\tonClick: () => onToggle(entry.id, !module.enabled),
\t\t\t\t\t\t\tchildren: (module.enabled ? "● " : "○ ") + (module.enabled ? t("enabled") : t("disabledLabel")),
\t\t\t\t\t\t}, "cap-toggle-" + entry.id),`,
  '能力卡片按钮',
)

// ④ 卡片标题加汇总
once(
  `jsxRuntime.jsx("h3", { style: styles.subHeading, children: t("capTitle") }, "cap-heading"),`,
  `jsxRuntime.jsxs("div", { style: styles.cardHead, children: [
\t\t\t\t\tjsxRuntime.jsx("h3", { style: styles.subHeading, children: t("capTitle") }, "cap-heading"),
\t\t\t\t\tjsxRuntime.jsx("span", { style: styles.cardHeadNote, children: t("capSummary") + " " + entries.filter((entry) => (modules[entry.id] || {}).enabled).length + " / " + entries.length }, "cap-summary"),
\t\t\t\t] }, "cap-head"),`,
  '能力卡片标题',
)

// ⑤ 新样式：toggleOff（空心圆）/ cardHead / cardHeadNote
once(
  `\t\t\tlist: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" },`,
  `\t\t\t// 关闭态：虚线描边 + 透明底 —— 跟开启态的实心填色一眼能分开，
\t\t\t// 也不靠颜色（色弱也能看出圆点是空心的）
\t\t\ttoggleOff: {
\t\t\t\tfont: "inherit",
\t\t\t\tfontSize: "12px",
\t\t\t\tpadding: "3px 10px",
\t\t\t\tborderRadius: "999px",
\t\t\t\tborder: "1px dashed var(--dsw-alias-border-l2)",
\t\t\t\tbackground: "transparent",
\t\t\t\tcolor: "inherit",
\t\t\t\topacity: 0.75,
\t\t\t\tcursor: "pointer",
\t\t\t\twhiteSpace: "nowrap",
\t\t\t},
\t\t\tcardHead: {
\t\t\t\tdisplay: "flex",
\t\t\t\talignItems: "baseline",
\t\t\t\tjustifyContent: "space-between",
\t\t\t\tgap: "8px",
\t\t\t},
\t\t\tcardHeadNote: {
\t\t\t\tfontSize: "11px",
\t\t\t\topacity: 0.7,
\t\t\t\twhiteSpace: "nowrap",
\t\t\t},
\t\t\tlist: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" },`,
  '样式',
)

writeFileSync(p, src, 'utf8')
console.log('[ok] client.js：开关文案 / 圆点 / 汇总 / 新样式')
