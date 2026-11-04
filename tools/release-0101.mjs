#!/usr/bin/env node
/**
 * 给已推上去的 v0.10.1 打一个 Release 并上传 tgz 附件。
 *
 * 令牌来源：`git credential fill`（复用本机已有的 GitHub 凭据，不落盘、不打印）。
 * 附件上传必须显式带 content-length，否则 GitHub 会拒。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

const OWNER = 'youx123'
const REPO = 'dsh-shared-brain'
const TAG = 'v0.10.1'
const PKG = 'C:/Users/13176/.dsh/profiles/desktop/vendor/dsh-shared-brain-0.10.1.tgz'
const NOTES = `## v0.10.1 — 审计修复与续接轮次

0.10.0 之后做了三路专项审计（安全 / 情感与自主意识 / 性能），查出 30 处问题，这一版全修了。
逐条细节见 [FIXES.md](https://github.com/youx123/dsh-shared-brain/blob/main/FIXES.md) 的「补充 19」。

### 会真泄露 / 真失效的

- **磁盘上的明文凭据终于被擦掉了**：脱敏以前只擦内存 —— 读路径的写回判断看「擦掉了几条」，
  可规整函数早就先擦过一遍，所以永远是 0，磁盘上那份从来没更新过。跨机同步的写入又是裸写、
  不过脱敏，从远端拉下来的脏条目还会被再推上去。现在三条写路径全部收口。
- **模块配置的写盘路径同样裸写**（重载后才发现）：脱敏只在「读」时做，写的时候把内存那份直接落盘。
- **记忆条目不再能被当成指令**：注入话术整段过滤、标签剥掉、注入正文 HTML 转义。
- **心情终于能影响说话了**：以前要求「心情变化 ≥3 才算显著」，而判定提示词让模型只给 −1~−3 ——
  模型越听话越永远过不去闸门，心情播报恒为空。现在看原始幅度。
- **表情提示不再被心情闸门陪葬**：原来心情没变化就直接返回空，表情那一段一次都没跑过。

### 别再往云上推的

- 本机路径 / 会话 id 不上云（127 条记忆里 75 条带着含用户名的绝对路径）
- 「会话 → 人设」绑定只留本机
- 选中会话的自动互动设置不再被同步清空

### 删了的东西真的会消失

模块条目和自定义人设的删除**从来没传播过** —— 删除检测把待删列表同时当成「现有条目」和
「上次见过」，交集全中，恒返回空。修的时候同时补了「第一次同步不判删除」的守卫，
不然新机器一连上就会把远端清空。

### 情感记忆接上了行为

\`intimacy\` / \`sentiment\` / \`target\` 以前只影响召回排序，对行为没有任何影响。现在对老大的
负向情感累积到一定程度会把心情判低，主动搭话改用更 soft 的调子。

### 续接轮次接线

\`shouldContinueTurn\` / \`roundOf\` 0.9.7 就写好了但**一个调用点都没有**。现在接上了：
模型在回复末尾写 \`<!-- 继续：下一步 -->\` 就能自己接着干，受自动互动总开关管，
一个会话最多续 3 轮。顺手修了「续接轮次只增不减、续满 3 轮后永远不能再续」的老 bug。

### 性能

- \`hits + 1\` 不再每轮把 108KB 整个重写（6.69ms → 0，5 秒 debounce 合并落盘）
- 读盘走 mtime 缓存：\`readStore\` 2.857 → 0.437ms，\`readModules\` 2.277 → 0.404ms
- 召回加倒排索引：2.33 → 0.993ms，720 例随机比对逐条验证结果完全一致

### 测试

**362 通过 / 0 失败**（11 个批次）。
`

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (!line) throw new Error('git credential 没给出密码')
  return line.slice('password='.length).trim()
}

const TOK = token()
const H = {
  Authorization: `Bearer ${TOK}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dsh-shared-brain-release',
}

// 1) 建 Release（已存在就复用）
let rel = null
const existing = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { headers: H })
if (existing.ok) {
  rel = await existing.json()
  console.log(`[skip] Release 已存在 id=${rel.id}`)
} else {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      name: 'v0.10.1 — 审计修复与续接轮次',
      body: NOTES,
      draft: false,
      prerelease: false,
    }),
  })
  if (!r.ok) throw new Error(`建 Release 失败 HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
  rel = await r.json()
  console.log(`[ok] Release 已创建 id=${rel.id}`)
}

// 2) 上传附件（已存在就跳过）
const name = PKG.split('/').pop()
const size = statSync(PKG).size
const assets = Array.isArray(rel.assets) ? rel.assets : []
const same = assets.find((a) => a.name === name)
if (same && same.size === size) {
  console.log(`[skip] 附件已在（${same.size} 字节，state=${same.state}）`)
} else {
  if (same) {
    await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${same.id}`, { method: 'DELETE', headers: H })
    console.log('[ok] 旧附件已删')
  }
  const buf = readFileSync(PKG)
  const up = await fetch(`https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      ...H,
      'Content-Type': 'application/gzip',
      'content-length': String(buf.length),
    },
    body: buf,
  })
  if (!up.ok) throw new Error(`上传失败 HTTP ${up.status}: ${(await up.text()).slice(0, 300)}`)
  const asset = await up.json()
  console.log(`[ok] 附件已上传 ${asset.name} ${asset.size} 字节 state=${asset.state}`)
}

// 3) 回读校验
const check = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { headers: H })
const back = await check.json()
console.log('--- 回读 ---')
console.log('HTTP', check.status, '| tag:', back.tag_name, '| draft:', back.draft, '| prerelease:', back.prerelease)
console.log('附件:', (back.assets || []).map((a) => `${a.name} ${a.size}B ${a.state}`).join(', '))
console.log('正文长度:', (back.body || '').length)
