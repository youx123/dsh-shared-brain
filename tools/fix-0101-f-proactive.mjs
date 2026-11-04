#!/usr/bin/env node
/**
 * 0.10.1 修复批次 F：主动搭话闸门 + 情感接行为 + 死代码
 *
 * P1-10（审计 B14/B17）：
 *   ① `rollDay` 用 UTC 日期（toISOString().slice(0,10)），
 *      而 emotion.js 的 localDay 用本地日期 → UTC+8 的凌晨 0:00-08:00 差 8 小时，
 *      「今天说了几次」会在错误的时间点清零。
 *   ② 开关关掉时 tick 记录 skip 之后**不再排下一次定时器** ——
 *      用户重新打开开关，要等宿主重启才会恢复。
 *
 * E2 / P1-8（审计 B5）：情感记忆没有下游。
 *   `intimacy` / `sentiment` / `target` 只影响召回排序和括号注释，
 *   不影响任何决策 —— 「记住老大讨厌啰嗦」和「记住老大讨厌啰嗦但亲密度 0.9」
 *   对 AI 行为完全一样。现在把召回到的情感条目汇入心情信号：
 *   对老大的负向情感（讨厌/不悦/担心）累积到一定程度 → level 判低，
 *   于是主动搭话改用更 soft 的调子。
 *
 * DEAD：index.js 里 `return rendered` 之后的三行不可达代码（引用未定义变量 result）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'

function patchText(file, from, to) {
  const p = join(LIB, file)
  const src = readFileSync(p, 'utf8')
  const count = src.split(from).length - 1
  if (count === 0) throw new Error(`${file}: 找不到锚点 ${JSON.stringify(from.slice(0, 110))}`)
  if (count > 1) throw new Error(`${file}: 锚点出现 ${count} 次`)
  writeFileSync(p, src.replace(from, to), 'utf8')
  console.log(`[ok] ${file}`)
}

/* ================================================================== */
/* P1-10 ① 日期用本地时区                                             */
/* ================================================================== */
patchText(
  'proactive.js',
  `/** 今天过了就清零「今天说了几次」。 */
function rollDay(history, now = Date.now()) {
  const stamp = new Date(now).toISOString().slice(0, 10)`,
  `/** 今天过了就清零「今天说了几次」。 */
function rollDay(history, now = Date.now()) {
  // 2026-11-04（P1-10 审计 B17）：用**本地日期**，不用 UTC。
  // 以前这里 toISOString().slice(0,10) 是 UTC 日期，而 emotion.js 的
  // localDay 用的是本地日期 —— UTC+8 的凌晨 0:00-08:00 两边差一天，
  // 「今天说了几次」会在错误的时间点清零（额度算错、深夜里额度突然回来）。
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}\``,
)

/* ================================================================== */
/* P1-10 ② 开关关掉时仍然排下一次                                     */
/* ================================================================== */
patchText(
  'proactive.js',
  `    timer = setTimeout(() => {
      tick()
      // 开关被关掉时 tick 只记录 skip，不再排下一次。
      const agentive = options.getAgentive?.() ?? options.agentive ?? {}
      if (agentive?.enabled) schedule()
      else {
        timer = null
        nextFireAt = 0
      }
    }, actual)`,
  `    timer = setTimeout(() => {
      tick()
      // 2026-11-04（P1-10 审计）：开关关掉时**照样排下一次**。
      // 以前这里 enabled=false 就把定时器停了 —— 用户重新打开开关，
      // 要等宿主重启才会恢复自动互动，看起来像「开了也没用」。
      // tick 在关掉时只记一次 skip，成本可以忽略。
      schedule()
    }, actual)`,
)

/* ================================================================== */
/* DEAD 死代码                                                        */
/* ================================================================== */
patchText(
  'index.js',
  `          return rendered
          if (result.hits.length === 0 && result.always.length === 0) return ''
          state.recallsServed += 1
          return renderModuleRecall(result)`,
  `          return rendered`,
)

/* ================================================================== */
/* E2 情感条目汇入心情信号                                            */
/* ================================================================== */
// 先补导入：emotionBiasOf 要用 SENTIMENTS 的 polarity
patchText(
  'proactive-mood.js',
  `import { DIMS, moodBand } from './emotion.js'`,
  `import { DIMS, moodBand, SENTIMENTS } from './emotion.js'

/** 情感极性：喜欢 +1、讨厌 −1、中性 0。 */
function polarityOf(sentiment) {
  const meta = SENTIMENTS[sentiment]
  return Number(meta?.polarity) || 0
}`,
)

patchText(
  'proactive-mood.js',
  `export function readMoodSignal(moodState, config = PROACTIVE_MOOD_DEFAULTS) {
  const cfg = normalizeProactiveMoodConfig(config)`,
  `/**
 * 把召回到的情感条目折算成一个「对老大的态度偏向」。
 *
 * 2026-11-04（E2 / 审计 P1-8）：情感记忆以前没有下游 ——
 * intimacy/sentiment/target 只影响召回排序和括号里的一行注释，
 * 「记住老大讨厌啰嗦」和「记住老大讨厌啰嗦但亲密度 0.9」对行为完全一样。
 * 现在按极性 × 亲密度累加出一个偏向值，负向到一定程度就把 level 判低
 * （于是主动搭话改用更 soft 的调子、来得更勤）。
 *
 * @param {Array} emotions 情感条目（memory.json 或 modules 里 emotion 模块的）
 * @returns {{ bias: number, hits: number }}
 */
export function emotionBiasOf(emotions = []) {
  let bias = 0
  let hits = 0
  for (const item of Array.isArray(emotions) ? emotions : []) {
    if (!item || typeof item !== 'object') continue
    // 只认「对老大」或「不限定对象」的 —— 对别的东西的好恶不该影响对老大说话
    const target = item.target
    if (target && target !== 'general' && target !== 'owner' && target !== '老大') continue
    const polarity = polarityOf(item.sentiment)
    if (polarity === 0) continue
    const intimacy = Number.isFinite(item.intimacy)
      ? Number(item.intimacy)
      : Number.isFinite(item.weight)
        ? Number(item.weight)
        : 0.5
    bias += polarity * intimacy
    hits += 1
  }
  return { bias, hits }
}

export function readMoodSignal(moodState, config = PROACTIVE_MOOD_DEFAULTS, emotions = []) {
  const cfg = normalizeProactiveMoodConfig(config)`,
)

patchText(
  'proactive-mood.js',
  `  return {
    band,
    mood,
    dominant,
    dominantValue,
    level,
    dims,
  }
}`,
  `  // 2026-11-04（E2）：情感记忆接进行为。
  // 对老大的负向情感（讨厌/不悦/担心）累积到 -0.9 以上 → 判低落，
  // 主动搭话改用 soft 调子。正向情感不改 level（本来就不该因为「关系好」
  // 就更亢奋），只记在 emotionBias 里供渲染用。
  const { bias: emotionBias, hits: emotionHits } = emotionBiasOf(emotions)
  if (cfg.enabled !== false && level === 'neutral' && emotionBias <= -0.9) {
    level = 'low'
  }

  return {
    band,
    mood,
    dominant,
    dominantValue,
    level,
    dims,
    emotionBias,
    emotionHits,
  }
}`,
)

// decideProactive 把 emotions 传进 readMoodSignal
patchText(
  'proactive-mood.js',
  `  const signal = readMoodSignal(config.enabled ? input.moodState : null, config)`,
  `  // E2：把召回到的情感条目一起交给信号层（不传就是空数组，行为不变）
  const signal = readMoodSignal(config.enabled ? input.moodState : null, config, input.emotions ?? [])`,
)

console.log('[done] 批次 F（主动搭话闸门 + 情感接行为 + 死代码）已改')
