#!/usr/bin/env node
/** FIXES.md：补「续接轮次接线」小节 + 测试合计 353 → 362 */
import { readFileSync, writeFileSync } from 'node:fs'

const P = 'C:/Users/13176/Documents/dsh-shared-brain-patches/FIXES.md'
const A = '### 0.10.1 补丁 2：重载后发现的泄漏回路'
let s = readFileSync(P, 'utf8')
if (s.split(A).length - 1 !== 1) throw new Error('anchor')

const ADD = `### 续接轮次接线（shouldContinueTurn / roundOf）

这两个函数在 0.9.7 就写好了，注释把设计说得挺清楚 —— 但**一个调用点都没有**，一直是死代码。

「让 AI 没干完就接着干」这件事风险不对称：续接对了省一次来回，续接错了就是它自己跟自己聊起来，后者烦人得多。所以接线时做了三个保守选择：

1. **信号必须由模型自己声明**。宿主的 \`agent/turn-stopping\` 只给 \`{ agent }\`，没有「为什么停下来」这种字段，猜不出来。改成让模型在回复末尾单独写一行 HTML 注释：\`<!-- 继续：把测试跑完 -->\`。渲染 markdown 时看不见，不会污染正文；\`continueReasonOf()\` 只往后 400 字符里找，正文中间提到「继续」不会误触。
2. **受自动互动开关管**。\`agentive.enabled\` 关着就完全不动 —— 续接也是「主动性」，不该有一个绕过总开关的后门。另外加了个 \`selfContinue\`（默认开），想单独关掉这个功能不用连带关掉主动搭话。作用范围、时间窗、**一个会话最多 3 轮**由原来的 \`shouldContinueTurn\` 判。
3. **顺手补一个真 bug**：原来的 \`lastRound\` 只增不减 —— 一个会话续满 3 轮之后，这台机器上它**永远**不能再续接了。现在老大真说话时（\`mode === 'user'\`）清零。不补这个，接线等于接了个一次性的。

提示词那边同步加了一句（\`renderCapabilities\`），只在开着的时候说；关了就不占位置。

测试新增 9 条（标记解析 4、闸门与清零 3、配置默认值 1、提示词 1），\`proactive-mood\` 43 → 52。

`

s = s.replace(A, ADD + A)
s = s.split('353 通过').join('362 通过')
s = s.split('proactive-mood 43').join('proactive-mood 52')
writeFileSync(P, s, 'utf8')
console.log('[ok] FIXES 补续接段，合计改 362')
