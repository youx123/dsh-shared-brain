#!/usr/bin/env node
/** README：0.10.1 小节补性能段 + 测试条数 289 → 349 */
import { readFileSync, writeFileSync } from 'node:fs'

const P = 'C:/Users/13176/Documents/dsh-shared-brain-patches/README.md'
let src = readFileSync(P, 'utf8')

const ANCHOR = `### 测试

新增 \`tests/audit-0101.test.mjs\`（35 条），每条对应一个审计里实测复现过的现象。更新了 2 条「测的是旧 bug」的断言。`
if (src.split(ANCHOR).length - 1 !== 1) throw new Error('README 测试段锚点不唯一')

const REPLACE = `### 每轮少干点没用的事

审计实测每轮固定开销 15~21ms，73% 是纯文件 I/O，计算只占 1.6ms。改了三处最费的地方：

- **不再每轮重写整个记忆库**：\`hits + 1\` 以前每轮把 108KB 整个重写一遍（6.69ms），而 \`hits\` 根本不参与打分。现在只在内存里累加，5 秒合并落一次盘；新增和删除仍然立即写
- **读盘走 mtime 缓存**：\`readStore\` 2.857 → 0.437ms，\`readModules\` 2.277 → 0.404ms（命中返回深拷贝，因为调用方都会就地改）
- **召回加倒排索引**：2.33 → 0.993ms，但 \`termHits\` 仍然保持 \`includes\` 的子串语义 —— 720 例随机比对逐条验证过结果完全一致，快不能靠改语义

审计还报了一条「人设与声音块重复渲染、能省 257 字符」，**这条是误判**：真实人设正文里根本没有那些块。没有为了凑数字去删渲染。

### 测试

新增 \`tests/audit-0101.test.mjs\`（35 条）+ \`tests/perf.test.mjs\`（24 条），每条对应一个审计里实测复现过的现象。
更新了 2 条「测的是旧 bug」的断言。合计 **349 通过 / 0 失败**。`

src = src.replace(ANCHOR, REPLACE)
src = src.replace(
  'node tools/dev.cjs          # 同步 lib / assets / tests / tools 到仓库，然后跑全部 289 条测试',
  'node tools/dev.cjs          # 同步 lib / assets / tests / tools 到仓库，然后跑全部 349 条测试',
)
src = src.replace('node tools/release.cjs --version 0.10.0        #', 'node tools/release.cjs --version 0.10.1        #')
src = src.replace('node tools/release.cjs --version 0.10.0 --push #', 'node tools/release.cjs --version 0.10.1 --push #')

writeFileSync(P, src, 'utf8')
console.log('[ok] README 已补性能段与 349')
