#!/usr/bin/env node
/**
 * 检查 P1-7 放宽 source 过滤后，待办线索会不会爆炸。
 *
 * 背景：0.9.7 修过一个「有真待办时每 15 分钟说一次、一天刷 57 遍」的 bug。
 * 0.9.8 的修法是「只认 manual」，但实测 manual=0，于是待办恒为空。
 * 现在放宽到 manual + sync —— 必须确认不会把一堆 auto 日志重新变成待办。
 *
 * 只读，不改任何数据。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const MEM = 'C:/Users/13176/.dsh/storages/dsh-shared-brain/memory.json'

const { PENDING_HINTS } = await import('file:///' + join(LIB, 'index.js').replace(/\\/g, '/')).catch(() => ({}))
// index.js 是插件入口，直接 import 会触发宿主依赖 —— 改成从源码里抠关键词表
const src = readFileSync(join(LIB, 'index.js'), 'utf8')
const m = src.match(/const PENDING_HINTS = \[([\s\S]*?)\]/)
const hints = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
console.log(`待办关键词 ${hints.length} 个：${hints.join(' / ')}`)

const store = JSON.parse(readFileSync(MEM, 'utf8'))
const entries = store.entries ?? []
console.log(`\n记忆库共 ${entries.length} 条`)

const bySource = {}
for (const e of entries) bySource[e.source ?? '?'] = (bySource[e.source ?? '?'] ?? 0) + 1
console.log('source 分布:', JSON.stringify(bySource))

function eligible(e, allowSources) {
  if (!allowSources.includes(e.source)) return false
  if (e.module === 'bottomline') return false
  if (Number(e.weight ?? 0) < 0.5) return false
  if (e.expiresAt && e.expiresAt < Date.now()) return false
  const text = String(e.text ?? '').trim()
  if (!text) return false
  return hints.some((h) => text.includes(h))
}

const strict = entries.filter((e) => eligible(e, ['manual']))
const relaxed = entries.filter((e) => eligible(e, ['manual', 'sync']))
const withAuto = entries.filter((e) => eligible(e, ['manual', 'sync', 'auto']))

console.log(`\n旧行为（只认 manual）：${strict.length} 条`)
console.log(`新行为（manual + sync）：${relaxed.length} 条`)
console.log(`如果连 auto 也认：${withAuto.length} 条 ← 这就是当年刷 57 次的原因`)

if (relaxed.length > 0) {
  console.log('\n新行为选中的条目：')
  for (const e of relaxed.slice(0, 8)) {
    console.log(`  [${e.weight}] ${String(e.text).slice(0, 70).replace(/\n/g, ' ')}`)
  }
}
if (withAuto.length > relaxed.length) {
  console.log(`\n⚠️ 被排除掉的 auto 条目有 ${withAuto.length - relaxed.length} 条 —— 确认它们确实是工作日志`)
  for (const e of withAuto.filter((x) => x.source === 'auto').slice(0, 5)) {
    console.log(`  [auto ${e.weight}] ${String(e.text).slice(0, 70).replace(/\n/g, ' ')}`)
  }
}
