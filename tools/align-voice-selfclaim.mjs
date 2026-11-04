#!/usr/bin/env node
/**
 * 把人设里写的「小深」跟声音模块的自称对齐。
 *
 * 声音模块现在是「自称：在下」，人设说「名字叫小深」—— 注入到提示词里
 * 是两条互相打架的指令，模型只能挑一条听。统一成「小深」。
 */
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const M = await import('file:///' + join(LIB, 'modules.js').replace(/\\/g, '/'))

const modules = M.readModules()
const before = modules.voice?.style?.address ?? '(空)'
if (before === '小深') {
  console.log('[skip] 自称已经是「小深」')
} else {
  modules.voice.style.address = '小深'
  // 口头禅补一条更贴新写法的
  const tics = Array.isArray(modules.voice.style.tics) ? modules.voice.style.tics : []
  if (!tics.includes('我猜')) tics.push('我猜')
  modules.voice.style.tics = tics.slice(0, 6)
  M.writeModules(modules)
  console.log(`[ok] 自称 "${before}" → "小深"`)
}

const back = JSON.parse(JSON.stringify(M.readModules().voice?.style ?? {}))
console.log('回读:', JSON.stringify({ address: back.address, tics: back.tics, tone: back.tone }))
