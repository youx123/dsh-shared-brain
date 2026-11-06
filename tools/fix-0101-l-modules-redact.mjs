#!/usr/bin/env node
/**
 * P0-1 补漏：`modules.js` 的写盘路径没有脱敏收口。
 *
 * 审计时只补了 `store.js` 的 writeStore（记忆库）和 remote-sync 的 mergeEntries，
 * 漏了模块配置这条写路径。实测后果：一条含明文 token 的记忆被摘要写进
 * `modules.json`，插件重载后新代码照样把它原样写盘 —— 因为
 * `normalizeModules` 只在**读**的时候脱敏，写的时候是把内存里那份直接落盘。
 *
 * 改法：`writeModules` 落盘前对每个模块的每条条目 text / tags 过一遍
 * `redactSecrets`。只碰这两个字段，别的一概不动；不改调用方传进来的对象
 * （index.js 之后还要用）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'modules.js')
let src = readFileSync(p, 'utf8')

// ① 确认 redactSecrets 有导入
const importLine = src.split('\n').find((l) => l.includes("from './summarize.js'"))
if (!importLine) throw new Error('modules.js 没有 summarize.js 的导入行')
console.log('现行导入：', importLine.trim())

// ② 在 writeModules 前面加一个写前脱敏函数
const ANCHOR = `/** 写模块配置（先写临时文件再 rename）。 */
export function writeModules(modules) {`

if (!src.includes(ANCHOR)) throw new Error('找不到 writeModules 定义')

const HELPER = `/**
 * 2026-11-04（P0-1 补漏）：写盘前的脱敏收口。
 *
 * \`normalizeModules\` 只在读的时候脱敏，写的时候是把内存里那份**直接落盘**，
 * 所以一条含明文凭据的条目照样会进 modules.json —— 实测发生过。
 * 这里只处理条目正文和标签，其余字段原样带过，也不改调用方传进来的对象。
 */
function redactModulesForWrite(modules = {}) {
  const out = { ...modules }
  for (const [key, moduleValue] of Object.entries(modules)) {
    if (!moduleValue || typeof moduleValue !== 'object' || !Array.isArray(moduleValue.items)) continue
    out[key] = {
      ...moduleValue,
      items: moduleValue.items.map((item) => {
        if (!item || typeof item !== 'object') return item
        const next = { ...item }
        if (typeof next.text === 'string') next.text = redactSecrets(next.text)
        if (Array.isArray(next.tags)) next.tags = next.tags.map((tag) => (typeof tag === 'string' ? redactSecrets(tag) : tag))
        return next
      }),
    }
  }
  return out
}

${ANCHOR}`

src = src.replace(ANCHOR, HELPER)

// ③ 落盘前套一层
const FROM = `  const payload = { ...modules, updatedAt: Date.now() }
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')`
const TO = `  // 写前脱敏收口（见 redactModulesForWrite 注释）
  const payload = { ...redactModulesForWrite(modules), updatedAt: Date.now() }
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')`

const n = src.split(FROM).length - 1
if (n !== 1) throw new Error(`落盘锚点出现 ${n} 次`)
src = src.replace(FROM, TO)

writeFileSync(p, src, 'utf8')
console.log('[ok] modules.js：writeModules 落盘前脱敏')
