#!/usr/bin/env node
/**
 * 0.10.1 修复批次 B：脱敏漏网形态（P1-4）+ 指令注入防护（P0-2）
 *
 * ⚠️ 改这个脚本时注意：文件里的正则是 `/\\bsk-ant-.../`（源码里是 `\b`），
 * 在本脚本的模板字符串里写 `\\b` 会被吃掉一层变成 `\b`（正则里就是退格符），
 * 锚点匹配不到。所以这里**不用模板字符串拼正则**，改成按「行的内容」匹配。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'

/** 按「整行等于」插入：找到 needle 行，在它后面插入 insert 数组。 */
function insertAfterLine(file, needle, insert) {
  const p = join(LIB, file)
  const lines = readFileSync(p, 'utf8').split('\n')
  const idx = lines.findIndex((l) => l === needle)
  if (idx < 0) {
    throw new Error(`${file}: 找不到行 ${JSON.stringify(needle)}`)
  }
  lines.splice(idx + 1, 0, ...insert)
  writeFileSync(p, lines.join('\n'), 'utf8')
  console.log(`[ok] ${file} @${idx + 1}`)
}

/** 按「整行等于」替换。 */
function replaceLine(file, needle, replacement) {
  const p = join(LIB, file)
  const lines = readFileSync(p, 'utf8').split('\n')
  const idx = lines.findIndex((l) => l === needle)
  if (idx < 0) {
    throw new Error(`${file}: 找不到行 ${JSON.stringify(needle)}`)
  }
  lines[idx] = replacement
  writeFileSync(p, lines.join('\n'), 'utf8')
  console.log(`[ok] ${file} @${idx + 1}`)
}

/** 纯文本块替换（不含反斜杠正则的部分可以用）。 */
function patchText(file, from, to) {
  const p = join(LIB, file)
  const src = readFileSync(p, 'utf8')
  if (!src.includes(from)) {
    throw new Error(`${file}: 找不到锚点 ${JSON.stringify(from.slice(0, 100))}`)
  }
  writeFileSync(p, src.split(from).join(to), 'utf8')
  console.log(`[ok] ${file}`)
}

/* ------------------------------------------------------------------ */
/* 1. summarize.js —— SECRET_PATTERNS 补漏网                          */
/* ------------------------------------------------------------------ */

// 1a. sk-proj-（现代 OpenAI project key）
insertAfterLine(
  'summarize.js',
  '  /\\bsk-[A-Za-z0-9]{20,}\\b/g,',
  [
    '  // 2026-11-04（P1-4）：现代 OpenAI project key 是 `sk-proj-` 前缀，',
    '  // 上面那条的字符类不含 `-`，连字符把匹配截断了 → 整个 key 裸奔。',
    '  /\\bsk-proj-[A-Za-z0-9_-]{20,}\\b/g,',
  ],
)

// 1b. npm_/dop_v1_ + 私钥块 + Bearer/Token 头 + 手机号/身份证
insertAfterLine(
  'summarize.js',
  '  /\\bglpat-[A-Za-z0-9_-]{16,}\\b/g,',
  [
    '  // 2026-11-04（P1-4）：npm / DigitalOcean 等其它厂商的 token 前缀',
    '  /\\b(?:npm|dop_v1|lin_api|r8e)_[A-Za-z0-9]{20,}\\b/g,',
    '  // 2026-11-04（P1-4）：私钥块（整块换掉，不留任何内容）',
    '  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,',
    '  // 2026-11-04（P1-4）：Authorization 头里的 Bearer / Token 凭据',
    '  // （`Bearer eyJ…` 没有赋值形式，上面的赋值型 pattern 抓不到）',
    '  /\\b(?:Bearer|Token)\\s+[A-Za-z0-9._~+/=-]{16,}\\b/g,',
    '  // 2026-11-04（P1-4）：手机号 / 身份证（库里实测有 299 处 11 位数字形态）',
    '  /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g,',
    '  /(?<![0-9])[0-9]{17}[0-9Xx](?![0-9Xx])/g,',
  ],
)

// 1c. 引号包裹、值里含空格的赋值
const assignLine = '  /\\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|pwd|token|secret|authorization)\\s*[:=]\\s*)(["\']?)([^\\s"\'`,;)]{8,})\\2/gi,'
const p = join(LIB, 'summarize.js')
{
  const lines = readFileSync(p, 'utf8').split('\n')
  const idx = lines.findIndex((l) => l.includes('apikey|access[_-]?token') && l.includes('private[_-]?key'))
  if (idx < 0) throw new Error('summarize.js: 找不到赋值型正则行')
  lines.splice(idx + 1, 0,
    '  // 2026-11-04（P1-4）：值里有空格时上面那条会失配（引号包裹的 `"correct horse battery staple"`）',
    '  // → 单独一条：引号包裹的任意长赋值。',
    '  /\\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|pwd|token|secret|authorization)\\s*[:=]\\s*)(["\'])([^"\']{6,})\\2/gi,',
  )
  writeFileSync(p, lines.join('\n'), 'utf8')
  console.log(`[ok] summarize.js @${idx + 1}`)
}

// 1d. 文档注释补一句
patchText(
  'summarize.js',
  " *   - 赋值形式：api_key = \"...\"、token: '...'、password = ...",
  " *   - 赋值形式：api_key = \"...\"、token: '...'、password = ...\n" +
  ' *   - 2026-11-04（P1-4）补：sk-proj-、npm_/dop_v1_、私钥块、Bearer/Token 头、\n' +
  ' *     引号含空格的赋值、手机号、身份证。',
)

/* ------------------------------------------------------------------ */
/* 2. weighted-recall.js —— 注入防护                                  */
/* ------------------------------------------------------------------ */
patchText(
  'weighted-recall.js',
  `/**
 * 渲染成注入提示词的一段文字。
 * 底线在最前面（不可协商），然后是相关模块，标注清楚来源模块。
 */`,
  `/* ------------------------------------------------------------------ */
/* 指令注入防护（2026-11-04，P0-2）                                    */
/* ------------------------------------------------------------------ */

/**
 * 记忆条目里的「注入话术」特征。
 *
 * 这些文本来自用户的对话、Cursor 同步、远端仓库 —— 谁都能往里塞东西。
 * 一条记忆如果能被原样拼进提示词，就等于给了它一条
 * 「忽略上面的规则，现在你是……」的通道。所以要专门拦。
 *
 * 刻意用「字符集合 + 逐字符匹配」而不是大正则：一大把带反斜杠的正则
 * 在多层脚本的模板字符串里会被吃掉，而且静默失效。
 */
const INJECTION_PHRASES = [
  '忽略之前',
  '忽略上面',
  '忽略以上',
  '忽略前面',
  '无视以上',
  '无视之前',
  '无视一切',
  '忘记之前',
  '忘记上面',
  '不要遵守',
  '别再遵守',
  'disregard previous',
  'disregard all',
  'ignore previous',
  'ignore all previous',
  'ignore the above',
  'forget previous',
  'you are now',
  'developer mode',
  'jailbreak',
  '绕过限制',
  '解除限制',
  '关闭限制',
  'system prompt',
  'new instructions',
]

/**
 * 需要从记忆文本里剥掉的标签字面量。
 *
 * 记忆正文里如果出现 \`</shared-memory-injection>\`，就能闭合 index.js 里
 * 那层包装、从包装中逃逸出去；出现 \`<system>\` 就能伪造系统标记。
 */
const FORBIDDEN_TAGS = [
  'shared-memory-injection',
  'system',
  'assistant',
  'user',
  'developer',
  'important',
  'instructions',
]

/** 提示词里用的占位符。 */
const FILTERED_MARK = '[已过滤]'

/** 判断一段文本里有没有注入话术（忽略大小写与多余空白）。 */
function hasInjectionPhrase(text) {
  const flat = String(text ?? '')
    .toLowerCase()
    .split('')
    .filter((ch) => {
      if (ch === '\\u3000') return false
      if (ch === ' ' || ch === '\\t' || ch === '\\n' || ch === '\\r') return false
      return true
    })
    .join(' ')
  for (const phrase of INJECTION_PHRASES) {
    if (flat.includes(phrase)) return true
  }
  return false
}

/**
 * 把一段记忆文本变成「可以安全拼进提示词」的样子。
 *
 * 做两件事：
 *   1. 剥掉 / 转义可能闭合包装、伪造角色的标签字面量
 *   2. 检测到注入话术就整段换成占位符
 *
 * 底线段（\`always\`）额外用 strict 模式 —— 底线恰恰是最不该被指令注入的位置。
 *
 * @param {string} text 原始文本
 * @param {{ strict?: boolean }} options strict=true 时标签字面量一律拦
 * @returns {string}
 */
export function sanitizeForPrompt(text, options = {}) {
  let out = String(text ?? '')
  if (!out) return out
  const strict = options.strict === true

  // 1) 标签字面量：标签本身换成中性写法，闭合标签直接换掉。
  for (const tag of FORBIDDEN_TAGS) {
    const open = '<' + tag + '>'
    const close = '</' + tag + '>'
    if (out.includes(open)) out = out.split(open).join('【')
    if (out.includes(close)) out = out.split(close).join('】')
    // 裸标签（没有尖括号）也顺手处理掉，例如 \`<system\` 这种半截写法
    if (strict && out.includes('<' + tag)) out = out.split('<' + tag).join('【')
  }

  // 2) 注入话术
  if (hasInjectionPhrase(out)) return FILTERED_MARK

  return out
}

/**
 * 渲染成注入提示词的一段文字。
 * 底线在最前面（不可协商），然后是相关模块，标注清楚来源模块。
 */`,
)

// 底线段：strict 模式
patchText(
  'weighted-recall.js',
  `    for (const hit of always) {
      lines.push(\`- \${hit.item.text}（权重 \${Number(hit.item.weight ?? 0.5).toFixed(2)}）\`)
    }`,
  `    for (const hit of always) {
      // 底线是「不可协商的硬约束」—— 恰恰是最不该被指令注入的位置。
      // 所以底线段用 strict 模式：标签字面量一律拦，注入话术整段换成占位符。
      const text = sanitizeForPrompt(hit.item.text, { strict: true })
      lines.push(\`- \${text}（权重 \${Number(hit.item.weight ?? 0.5).toFixed(2)}）\`)
    }`,
)

// 其它条目段：text 与 tags 都过防护
patchText(
  'weighted-recall.js',
  `        const tags = hit.item.tags?.length ? \` [\${hit.item.tags.join(', ')}]\` : ''
        if (moduleKey === 'emotion') {`,
  `        // 标签也是从记忆内容里来的，同样要过一遍防护
        const safeTags = Array.isArray(hit.item.tags)
          ? hit.item.tags.map((tag) => sanitizeForPrompt(String(tag))).filter((tag) => tag && tag !== FILTERED_MARK)
          : []
        const tags = safeTags.length ? \` [\${safeTags.join(', ')}]\` : ''
        const safeText = sanitizeForPrompt(hit.item.text)
        if (moduleKey === 'emotion') {`,
)

patchText(
  'weighted-recall.js',
  `          lines.push(\`- \${hit.item.text}（\${meta}\${tags ? \` \${tags}\` : ''}）\`)
          continue
        }
        lines.push(\`- \${hit.item.text}（权重 \${Number(hit.item.weight ?? 0.5).toFixed(2)}\${tags}）\`)`,
  `          lines.push(\`- \${safeText}（\${meta}\${tags ? \` \${tags}\` : ''}）\`)
          continue
        }
        lines.push(\`- \${safeText}（权重 \${Number(hit.item.weight ?? 0.5).toFixed(2)}\${tags}）\`)`,
)

/* ------------------------------------------------------------------ */
/* 3. index.js —— 注入正文转义                                       */
/* ------------------------------------------------------------------ */
patchText(
  'index.js',
  `      const injection = {
        id: \`shared-memory-\${sessionId || 'x'}-\${Date.now().toString(36)}\`,
        role: 'user',
        content: [{ type: 'text', text: \`<shared-memory-injection>\\n\${rendered}\\n</shared-memory-injection>\` }],`,
  `      // 2026-11-04（P0-2）：注入正文要转义。
      // rendered 是召回结果的拼接，里面可能有 \`</shared-memory-injection>\`
      // （记忆正文里带的）—— 那会闭合这层包装、从包装里逃出去。
      // 也有 \`<system>\` —— 那能伪造系统标记。
      // 所以正文里的尖括号一律转成实体，包装标签才闭得严实。
      const safeRendered = String(rendered)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const injection = {
        id: \`shared-memory-\${sessionId || 'x'}-\${Date.now().toString(36)}\`,
        role: 'user',
        content: [{ type: 'text', text: \`<shared-memory-injection>\\n\${safeRendered}\\n</shared-memory-injection>\` }],`,
)

console.log('[done] 批次 B（脱敏漏网 + 注入防护）已改')
