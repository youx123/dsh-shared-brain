#!/usr/bin/env node
/**
 * 开关文案统一（第二版）。
 *
 * 第一版只改了能力卡片，其余四个真开关（模块卡片、心情驱动、语义表情、唱歌）
 * 还是「启用 / 停用」——状态还是动作，全靠猜，而且同一页两种说法更乱。
 *
 * 统一成：
 *   按钮文字 = 状态（● 已开启 / ○ 已关闭）
 *   title   = 动作（点此关闭 / 点此开启）
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

// ① 中文：状态词 + 动作词分开
once(
  `\t\t\tenabled: "已开启 · 点此关闭",\n\t\t\tdisabledLabel: "已关闭 · 点此开启",`,
  `\t\t\tenabled: "已开启",\n\t\t\tdisabled: "已关闭",\n\t\t\tenabledLabel: "点此关闭",\n\t\t\tdisabledLabel: "点此开启",`,
  '中文文案',
)
once(
  `\t\t\tdisabled: "停用",\n`,
  ``,
  '删旧 disabled',
)

// ② 英文
once(
  `\t\t\tenabled: "On · click to turn off",\n\t\t\tdisabledLabel: "Off · click to turn on",`,
  `\t\t\tenabled: "On",\n\t\t\tdisabled: "Off",\n\t\t\tenabledLabel: "click to turn off",\n\t\t\tdisabledLabel: "click to turn on",`,
  '英文文案',
)
once(
  `\t\t\tdisabled: "Disabled",\n`,
  ``,
  '删旧英文 disabled',
)

// ③ 能力卡片：文字回归纯状态，title 带动作
once(
  `\t\t\t\t\t\t\ttitle: module.enabled ? t("enabled") : t("disabledLabel"),`,
  `\t\t\t\t\t\t\ttitle: module.enabled ? t("enabledLabel") : t("disabledLabel"),`,
  '能力卡片 title',
)

// ④ 模块卡片
once(
  `\t\t\t\t\t\t\tchildren: module.enabled ? t("enabled") : t("disabled"),`,
  `\t\t\t\t\t\t\ttitle: module.enabled ? t("enabledLabel") : t("disabledLabel"),
\t\t\t\t\t\t\t"aria-pressed": module.enabled ? "true" : "false",
\t\t\t\t\t\t\tchildren: (module.enabled ? "● " : "○ ") + (module.enabled ? t("enabled") : t("disabled")),`,
  '模块卡片',
)

// ⑤ 心情驱动
once(
  `\t\t\t\t\t\tchildren: enabled ? t("enabled") : t("disabled"),`,
  `\t\t\t\t\t\ttitle: enabled ? t("enabledLabel") : t("disabledLabel"),
\t\t\t\t\t\t"aria-pressed": enabled ? "true" : "false",
\t\t\t\t\t\tchildren: (enabled ? "● " : "○ ") + (enabled ? t("enabled") : t("disabled")),`,
  '心情驱动',
)

// ⑥ 语义表情
once(
  `\t\t\t\t\t\tchildren: semanticOn ? t("enabled") : t("disabled"),`,
  `\t\t\t\t\t\ttitle: semanticOn ? t("enabledLabel") : t("disabledLabel"),
\t\t\t\t\t\t"aria-pressed": semanticOn ? "true" : "false",
\t\t\t\t\t\tchildren: (semanticOn ? "● " : "○ ") + (semanticOn ? t("enabled") : t("disabled")),`,
  '语义表情',
)

// ⑦ 唱歌
once(
  `\t\t\t\t\t\tchildren: sing.enabled === true ? t("enabled") : t("disabled"),`,
  `\t\t\t\t\t\ttitle: sing.enabled === true ? t("enabledLabel") : t("disabledLabel"),
\t\t\t\t\t\t"aria-pressed": sing.enabled === true ? "true" : "false",
\t\t\t\t\t\tchildren: (sing.enabled === true ? "● " : "○ ") + (sing.enabled === true ? t("enabled") : t("disabled")),`,
  '唱歌',
)

writeFileSync(p, src, 'utf8')
console.log('[ok] 五个真开关统一成「● 已开启 / ○ 已关闭」+ title 写动作')
