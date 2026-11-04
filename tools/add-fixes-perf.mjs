#!/usr/bin/env node
/** FIXES.md 的 0.10.1 小节：补性能段 + 把测试合计写成 349 */
import { readFileSync, writeFileSync } from 'node:fs'

const P = 'C:/Users/13176/Documents/dsh-shared-brain-patches/FIXES.md'
let src = readFileSync(P, 'utf8')

const ANCHOR = '### 测试\n\n新增 `tests/audit-0101.test.mjs`（35 条）'
if (src.split(ANCHOR).length - 1 !== 1) throw new Error('测试段锚点不唯一')

const PERF = `### 性能：每轮固定开销

审计实测每轮固定成本 **15~21ms**（重轮 31.7ms），其中 73% 是纯文件 I/O，计算只占 1.6ms。
六项改造，每一改都配了等价性测试——性能优化最怕「快了但结果不一样」。

- **PERF-1 hits 不再每轮重写整个库**（\`lib/store.js\` + \`lib/index.js\`）
  「这条记忆被召回了几次」的 \`hits + 1\` 以前每轮都把 108KB 的记忆库整个重写一遍（实测 6.69ms），而 **\`hits\` 根本不参与打分**。
  现在只累加在内存里的 \`pendingMutations\`，5 秒 debounce 合并落盘，进程退出和 \`agent/disposed\` 兜底 flush；新增和删除记忆仍然立即写。
  写盘从「每轮必写」变成「5 秒最多一次」，而且能和同一时段的其他写入共用一次落盘。
- **PERF-2 读盘走 mtime 缓存**（\`lib/store.js\` + \`lib/modules.js\`）
  \`readStore\` 一轮被调 2~3 次、\`readModules\` 3 次，每次都 JSON.parse + 逐条脱敏正则。
  现在按 \`mtime + ctime + size\` 判命中，写完清缓存。**命中必须返回深拷贝** —— bridge / commands / importFromCursorRules 都会就地改数组。
  实测 \`readStore\` 2.857 → 0.437ms，\`readModules\` 2.277 → 0.404ms。
- **PERF-3 召回加倒排索引**（\`lib/recall.js\`）
  打分瓶颈是 80 个查询词 × 129 条 = 上万次 \`text.includes\`。
  注意 **\`includes\` 是子串匹配**（查「记忆」能命中 token「记忆库」），所以倒排只能用来算 Jaccard 的 shared，\`termHits\` 仍然以子串语义为准 —— 不能图快把语义换掉。
  等价性验证：随机 60 组 × 12 查询共 720 例，逐条比对 \`recall()\` 与 \`scoreEntry()\` 的 id + score 完全相等，含「改条目后索引失效」「标签权重」。实测 2.33 → 0.993ms。
- **PERF-4 目录图谱索引加缓存**（\`lib/graph-expand.js\`）：每轮都要读 107KB + parse，加 mtime 缓存。
- **PERF-5 人设行级去重**（\`lib/weighted-recall.js\`）
  ⚠️ **审计这条报错了**：审计说人设正文里已经含【声音】【网络】等块、与 \`renderVoice\` / \`renderCapabilities\` 重复渲染、能省 257 字符。
  核实真实数据：当前人设 \`xiaoshen\` 正文 965 字符，那些块**一个都不在里面**，它们本来就只由这两个函数渲染 —— 不存在重复，真实注入体积不会变小。
  所以没有删那两个渲染块（删了会丢音色和表情），只做了「人设里真有整行完全相等才去掉」的防御性去重，测试用合成人设证明它有效。
- **PERF-6 表情状态复用缓存**（\`lib/emoji.js\`）：\`emojiStatus\` 用的是每次都重新扫盘的 \`scanEmojiPacks()\`，改用同文件已有的 \`scanEmojiPacksCached()\`（60 秒 TTL）。

**没有做的**：审计提的「modules.json 没有条目上限」只是记了一笔，没动 —— 加上限意味着静默丢用户的条目，这种事不该顺手做。

### 测试

`

src = src.replace(ANCHOR, PERF + '新增 `tests/audit-0101.test.mjs`（35 条）')

// 测试合计
const COUNT_ANCHOR = '另按新行为更新了 2 条「测的是旧 bug」的断言（`mergePersona` 的 `bySession`、`currentContext` 的跨会话兜底）。'
if (src.split(COUNT_ANCHOR).length - 1 !== 1) throw new Error('合计锚点不唯一')
src = src.replace(
  COUNT_ANCHOR,
  `${COUNT_ANCHOR}
新增 \`tests/perf.test.mjs\`（24 条）：PERF-1 5 条（pending 累加 / 5 秒合并 / 写失败保留 / 新增立即写 / 退出 flush）、
PERF-2 6 条（命中返回深拷贝 / 改文件失效 / 写完清缓存 / modules 同款）、
PERF-3 4 条（与 \`scoreEntry\` 逐条等价 / 子串命中 / 改条目失效 / 标签权重）、PERF-4 3 条、PERF-5 4 条、PERF-6 2 条。

合计：**349 通过 / 0 失败**（emotion 66 / audit-fixes 50 / audit-0101 35 / proactive-mood 41 / remote-sync 35 / persona-sync 33 / ui-render 24 / emoji-builtin 33 / perf 24 / tools 7 / harness）。`,
)

writeFileSync(P, src, 'utf8')
console.log('[ok] FIXES.md 补上性能段与测试合计')
