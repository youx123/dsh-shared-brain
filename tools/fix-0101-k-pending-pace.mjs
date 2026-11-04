#!/usr/bin/env node
/**
 * P1-10 收尾：「有真待办一定要说」被均匀铺开(aced)挡掉了。
 *
 * 现状（0.9.7 的设计，注释写得对，代码跟注释打架）：
 *   注释说「待办的做法是『额度内优先说它』，而不是『突破额度』」。
 *   但代码里 `paced` 那道闸门对 pending 一样生效：
 *   3 次/天铺在 14 小时里，evenGap ≈ 4.7 小时 ——
 *   也就是「老大答应过的事」最多 4.7 小时才提一次，比不提醒还容易忘。
 *
 * 改法：pending 不走 paced 的均匀间隔，但仍然受 maxPerDay 硬上限约束。
 *   → 最坏情况一天 3 次（还是被 daily-limit 卡住的），不会回到 0.9.7 之前
 *     「每 15 分钟一次、一天 57 遍」那档。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'proactive-mood.js')
const src = readFileSync(p, 'utf8')

const from = `  if (!exempt && config.maxPerDay > 0) {
    const remainingQuota = config.maxPerDay - spokeToday`
const to = `  // 2026-11-04（P1-10）：有真待办时不走「均匀铺开」。
  // 上面第 3 条的注释写的就是「额度内优先说它」—— 可均匀间隔把
  // 「答应过的事」压到 4.7 小时一轮（3 次/天铺满 14 小时），
  // 比不提醒更容易忘。这里让它跳过 paced，但仍然受 maxPerDay 硬上限约束：
  // 最坏情况一天 3 次，不会回到 0.9.7 之前「一天 57 遍」那档。
  if (!exempt && pending.length === 0 && config.maxPerDay > 0) {
    const remainingQuota = config.maxPerDay - spokeToday`

const count = src.split(from).length - 1
if (count !== 1) throw new Error(`锚点出现 ${count} 次`)
writeFileSync(p, src.replace(from, to), 'utf8')
console.log('[ok] proactive-mood.js：pending 跳过 paced（仍受 maxPerDay 约束）')
