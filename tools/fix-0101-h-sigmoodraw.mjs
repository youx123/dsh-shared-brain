#!/usr/bin/env node
/**
 * P0-3 补丁：`sigMoodRaw` 调到 1 时不起作用。
 *
 * 原因：`applyMoodDelta` 里 `if (step === 0 && !dimChanged)` 会**提前 return**，
 * 而这一步发生在显著性判定之前 —— rawDelta = −1 时 step = round(−1/3) = 0，
 * 于是直接走「这一轮没变化」，`sigMoodRaw` 根本没机会生效。
 *
 * 改法：提前返回的条件多看一眼原始幅度。默认 sigMoodRaw = 2 时行为完全不变
 * （raw −1 依旧算没变化），只有把阈值调小才会走到主路径。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'emotion.js')
const src = readFileSync(p, 'utf8')

const from = `  if (step === 0 && !dimChanged) {
    // 这一轮真没变化：不记账，也不更新时间戳
    state.minor = true
    state.updatedAt = now
    return { state, changed: false, minor: true, step: 0 }
  }`

const to = `  // 2026-11-04（P0-3 补）：原始幅度够大时，折算后 step 为 0 也不能当「没变化」。
  // 否则把 sigMoodRaw 调小毫无意义 —— 这里先 return 了，根本走不到显著性判定。
  // 默认 sigMoodRaw = 2：rawDelta = −1 仍然算没变化，行为与以前一致。
  const rawMagnitude = Math.abs(rawDelta)
  const rawEnough = rawMagnitude >= (Number(options.sigMoodRaw) || MOOD_DEFAULTS.sigMoodRaw)
  if (step === 0 && !dimChanged && !rawEnough) {
    // 这一轮真没变化：不记账，也不更新时间戳
    state.minor = true
    state.updatedAt = now
    return { state, changed: false, minor: true, step: 0 }
  }`

const count = src.split(from).length - 1
if (count !== 1) throw new Error(`锚点出现 ${count} 次，中止`)
writeFileSync(p, src.replace(from, to), 'utf8')
console.log('[ok] emotion.js：提前返回分支加原始幅度判断')
