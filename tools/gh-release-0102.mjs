#!/usr/bin/env node
/**
 * 给 v0.10.2 建 GitHub Release 并上传 tgz 附件。
 *
 * 沿用之前踩过的三条：
 *  1. Windows 上 node 不能 shell:'/bin/bash' → execFileSync('git', ['credential','fill'], {input})
 *  2. 本机直连 github.com 会 ECONNRESET → 只走 api.github.com，验证也走 API 回读
 *  3. 上传附件必须显式带 content-length
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

const REPO = 'youx123/dsh-shared-brain'
const TAG = 'v0.10.2'
const TGZ = 'C:/Users/13176/.dsh/profiles/desktop/vendor/dsh-shared-brain-0.10.2.tgz'

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  for (const line of out.split('\n')) {
    if (line.startsWith('password=')) return line.slice('password='.length).trim()
  }
  throw new Error('git credential fill 没给 password')
}

const BODY = `0.10.2 — 勾选的会话不再被同步清掉 + 开关文案能一眼看出开还是关

## 一、自动互动勾选的会话总是自己取消（真 bug）

\`mergeModules\` 返回前会 \`sanitizeModules\`，把 \`agentive.sessionIds\` 清空 —— 这是**推送形状**，
会话 id 本来就不该上云。错在 \`syncOnce\` 把这个推送形状直接 \`writeModulesSynced()\` 写回了本地：
每同步一次（默认 10 分钟）就把用户勾的会话清一遍。

人设那边早踩过同一个坑（\`mergePersona\` 去 \`bySession\`，落地时补回来），模块这边漏了。

- 新增导出 \`restoreLocalAgentive(merged, local)\`：把 \`scope\` / \`sessionIds\` 从本机值盖回去；
  \`scope\` 不是 \`session\` 一律退回 \`all\`，\`sessionIds\` 过滤非字符串与空串；同时剥掉 \`mergeStats\`
  （诊断字段既不能落盘也不能上云，否则统计一变就多一个 commit = 无脑空推）
- \`syncOnce\`：推远端用干净形状 \`modulesPushShape\`，写本地用 \`restoreLocalAgentive(...)\`
- 回归 3 条：勾选的会话同步后还在 / \`mergeStats\` 被剥掉 / 本机没勾时不会被塞脏值

## 二、开关看不出是开还是关

原来按钮只有「启用 / 停用」两个词 —— 描述的是状态还是动作，全靠猜；点完也不知道生效没有。

五个真开关（模块卡片、能力开关、心情驱动、语义表情、唱歌）统一：

- 按钮文字 = 状态：**● 已开启 / ○ 已关闭**（实心圆 / 空心圆，不靠颜色也能分）
- \`title\` = 动作：点此关闭 / 点此开启
- 关闭态改虚线描边 + 透明底 + 透明度 0.75
- 加 \`aria-pressed\`，读屏也能读
- 能力卡片标题旁加「已开启 N / M」汇总

回归 6 条：两种状态的文案与圆点 / 不再出现「启用」「停用」/ 汇总数字对得上 /
\`title\` 写的是动作 / \`aria-pressed\` 正确 / 两个都开时 2 / 2

## 测试

**371 通过 / 0 失败**
emotion 66 · audit-fixes 50 · audit-0101 37 · proactive-mood 52 · remote-sync 38 ·
persona-sync 33 · ui-render 30 · emoji-builtin 33 · perf 24 · tools 7 · harness

## 没验证的

真实的 10 分钟同步循环没跑满一轮（要等宿主跑够时间），做到单测 + 代码路径确认。
\`client.js\` 改的是前端，要重载宿主才看得到新按钮。
`

const tk = token()
const headers = {
  Authorization: `Bearer ${tk}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dsh-shared-brain-release',
}

async function main() {
  // ① 已存在就复用
  let release = null
  const getRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers })
  if (getRes.status === 200) {
    release = await getRes.json()
    console.log(`[skip] Release 已存在：id ${release.id}`)
  } else if (getRes.status === 404) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: TAG, name: 'v0.10.2 — 勾选的会话不再被清 + 开关能看出开还是关', body: BODY, draft: false, prerelease: false }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`建 Release 失败 HTTP ${res.status}: ${text.slice(0, 400)}`)
    release = JSON.parse(text)
    console.log(`[ok] Release 建好：id ${release.id} ${release.html_url}`)
  } else {
    throw new Error(`查询 Release 失败 HTTP ${getRes.status}`)
  }

  // ② 传附件（存在就跳过）
  const buf = readFileSync(TGZ)
  const size = statSync(TGZ).size
  const name = TGZ.split('/').pop()
  const existing = (release.assets || []).find((a) => a.name === name)
  if (existing && existing.size === size) {
    console.log(`[skip] 附件已存在：${name} ${existing.size} 字节 state=${existing.state}`)
  } else {
    const up = await fetch(
      `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/gzip', 'Content-Length': String(size) },
        body: buf,
        duplex: 'half',
      },
    )
    const text = await up.text()
    if (!up.ok) throw new Error(`上传附件失败 HTTP ${up.status}: ${text.slice(0, 400)}`)
    const asset = JSON.parse(text)
    console.log(`[ok] 附件上传：${asset.name} ${asset.size} 字节 state=${asset.state}`)
  }

  // ③ 回读校验
  const check = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers })
  if (check.status !== 200) throw new Error(`回读失败 HTTP ${check.status}`)
  const r = await check.json()
  const a = (r.assets || [])[0]
  console.log('回读：', JSON.stringify({
    id: r.id, tag: r.tag_name, name: r.name, draft: r.draft, prerelease: r.prerelease,
    bodyLen: (r.body || '').length,
    asset: a ? { name: a.name, size: a.size, state: a.state } : null,
    url: r.html_url,
  }, null, 2))
}

main().catch((e) => {
  console.error('[FAIL]', e.message)
  process.exit(1)
})
