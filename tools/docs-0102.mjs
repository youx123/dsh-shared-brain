#!/usr/bin/env node
/**
 * 0.10.2 文档：FIXES.md 加一节 + 两处测试合计改成 371。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.SB_PATCHES || 'C:/Users/13176/Documents/dsh-shared-brain-patches'

function once(src, from, to, label) {
  const n = src.split(from).length - 1
  if (n !== 1) throw new Error(`${label}：锚点出现 ${n} 次`)
  return src.replace(from, to)
}

/* ---------------- FIXES.md ---------------- */
{
  const p = join(ROOT, 'FIXES.md')
  let src = readFileSync(p, 'utf8')

  src = once(
    src,
    '合计：**362 通过 / 0 失败**（emotion 66 / audit-fixes 50 / audit-0101 37 / proactive-mood 52 / remote-sync 35 / persona-sync 33 / ui-render 24 / emoji-builtin 33 / perf 24 / tools 7 / harness）。',
    '合计：**362 通过 / 0 失败**（emotion 66 / audit-fixes 50 / audit-0101 37 / proactive-mood 52 / remote-sync 35 / persona-sync 33 / ui-render 24 / emoji-builtin 33 / perf 24 / tools 7 / harness）。\n\n> 后续（0.10.2）补了两处修复，见下一节；合计升到 **371 通过**（remote-sync 38 / ui-render 30）。',
    'FIXES 合计',
  )

  const section = `## 2026-11-04 补充 20：0.10.2 —— 勾选的会话不再被同步清掉 + 开关文案

老大反馈两句：「自动互动勾选了会话总是自己取消」，「点击按钮这些需要明显的提示开启或者关闭的信息」。
前一个是真 bug（每 10 分钟丢一次配置），后一个是真看不出来。

### 一、勾选的会话每同步一次就被清空

**根因**：\`mergeModules\` 返回前无条件 \`sanitizeModules(out)\`，把 \`agentive.sessionIds\` 清空。
这本身没错 —— 会话 id 是本机的东西，不该推上云。错在 \`syncOnce\` 把这个**推送形状**直接
\`writeModulesSynced()\` 写回了本地：每同步一次（默认 10 分钟）就把用户勾的会话清一遍。

人设那边早踩过同一个坑（\`mergePersona\` 返回体去掉 \`bySession\`，落地时再补回来），模块这边漏了。

**改法**：
- 新增导出 \`restoreLocalAgentive(merged, local)\`（\`lib/remote-sync.js\`）：把 \`scope\` / \`sessionIds\`
  从本机读到的值盖回去；\`scope\` 不是 \`'session'\` 一律退回 \`'all'\`，\`sessionIds\` 过滤非字符串与空串。
  同时剥掉 \`mergeStats\`（诊断字段既不能落盘也不能上云，否则统计一变就多一个 commit）。
- \`syncOnce\`：推远端用 \`modulesPushShape\`（干净形状），写本地用
  \`restoreLocalAgentive(modulesPushShape, localModules)\`。
- 回归 3 条（\`tests/remote-sync.test.mjs\` 38 通过）：勾选的会话同步后还在 / \`mergeStats\` 被剥掉 /
  本机没勾时不会被塞脏值。

### 二、开关看不出是开还是关

原来按钮文字只有「启用 / 停用」—— 它描述的是**状态**还是**动作**，全靠猜；点完也不知道生效没有。

**改法**（\`lib/client.js\`，五个真开关统一：模块卡片、能力卡片、心情驱动、语义表情、唱歌）：
- 按钮文字 = 状态：**\`● 已开启\` / \`○ 已关闭\`**（实心圆 / 空心圆，不靠颜色也能分）；
- \`title\` = 动作：\`点此关闭\` / \`点此开启\`（悬停也能看到）；
- 关闭态改成虚线描边 + 透明底 + 透明度 0.75，跟开启态的实心填色一眼分开；
- 加 \`aria-pressed\`，读屏也能读出状态；
- 能力卡片标题旁加汇总「已开启 N / M」。

回归 6 条（\`tests/ui-render.test.mjs\` 30 通过）：两种状态的文案与圆点 / 不再出现「启用」「停用」/
汇总数字对得上 / \`title\` 写的是动作 / \`aria-pressed\` 正确 / 两个都开时 2 / 2。

### 三、合计

**371 通过 / 0 失败**（emotion 66 / audit-fixes 50 / audit-0101 37 / proactive-mood 52 / remote-sync 38 /
persona-sync 33 / ui-render 30 / emoji-builtin 33 / perf 24 / tools 7 / harness）。

---

`
  src = once(src, '## 2026-11-04 补充 19', section + '## 2026-11-04 补充 19', 'FIXES 插入位置')
  writeFileSync(p, src, 'utf8')
  console.log('[ok] FIXES.md')
}

/* ---------------- README.md ---------------- */
{
  const p = join(ROOT, 'README.md')
  let src = readFileSync(p, 'utf8')

  src = once(
    src,
    '更新了 2 条「测的是旧 bug」的断言。合计 **362 通过 / 0 失败**。',
    '更新了 2 条「测的是旧 bug」的断言。合计 **362 通过 / 0 失败**。\n\n'
      + '### 0.10.2\n\n'
      + '- **勾选的会话不再被同步清掉**：`mergeModules` 返回的「推送形状」会被写回本地，'
      + '而它已经把 `agentive.sessionIds` 清空了 —— 每同步一次（10 分钟）就丢一次用户勾的会话。'
      + '现在推远端用干净形状，写本地用 `restoreLocalAgentive()` 把 `scope` / `sessionIds` 盖回去。\n'
      + '- **开关能一眼看出开还是关**：五个真开关的按钮统一成 `● 已开启` / `○ 已关闭`，'
      + '`title` 写清「点此关闭 / 点此开启」，关闭态改虚线描边，并加 `aria-pressed`；'
      + '能力卡片标题旁加「已开启 N / M」汇总。\n'
      + '- 测试合计 **371 通过 / 0 失败**（remote-sync 38 / ui-render 30）。',
    'README 合计',
  )
  writeFileSync(p, src, 'utf8')
  console.log('[ok] README.md')
}
