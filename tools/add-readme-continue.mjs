#!/usr/bin/env node
/** README：补「续接轮次」一段到 0.10.1 小节里 */
import { readFileSync, writeFileSync } from 'node:fs'

const P = 'C:/Users/13176/Documents/dsh-shared-brain-patches/README.md'
const A = '### 测试\n\n新增 `tests/audit-0101.test.mjs`（37 条）'
let s = readFileSync(P, 'utf8')
if (s.split(A).length - 1 !== 1) throw new Error('anchor')

const ADD = `### 没干完可以自己接着干

\`shouldContinueTurn\` / \`roundOf\` 这两个函数 0.9.7 就写好了，但**一个调用点都没有**——一直是死代码。现在接上了，接得比较保守：

- **信号由模型自己给**。宿主在「一轮即将结束」时只告诉插件「哪个会话」，没说「为什么停」，猜不出来。所以让它在回复末尾单独写一行 HTML 注释 \`<!-- 继续：下一步要干什么 -->\`——渲染出来看不见，不污染正文，正文中间提「继续」也不会误触
- **受自动互动总开关管**。关了主动搭话，这个也一起停，不留后门；另有一个 \`selfContinue\` 可以单独关
- **一个会话最多续 3 轮**，且在作用范围和时间窗内
- 顺手补了个真 bug：原来「续接了几轮」只增不减，一个会话续满 3 轮之后**这台机器上就永远不能再续了**。现在老大真说话时清零

实测数据不吹：这套只验证到「标记能被解析、闸门会按 3 轮掐断、配置和提示词都跟着开关走」，**没在真实会话里跑过一整轮续接**——那要等模型自己写出标记才看得见。

### 测试

新增 \`tests/audit-0101.test.mjs\`（37 条）`

s = s.replace(A, ADD)
writeFileSync(P, s, 'utf8')
console.log('[ok] README 补续接段')
