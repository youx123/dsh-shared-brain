/**
 * 配置层自动调参（2026-11-16）
 *
 * 做什么：每天最多一次，拿真实运行数据给三个「有明确反馈信号」的旋钮算新值：
 *   - 主动搭话间隔  agentive.intervalMs      信号：发出/跳过比
 *   - 心情判定额度  emotion.config.judgePerDay 信号：前一天额度是否打满
 *   - 自主学习额度  learning.perDay            信号：前一天额度是否用光
 *
 * 不做什么：不碰代码、不碰提示词结构、不碰人设。只调数字，单次幅度 <=25%，
 * 一律钳到硬边界。每次调完把理由记进 kv 键 autoTune，日志和界面都能查。
 *
 * 为什么只调这三项：别的旋钮（心情基线、模块权重、语气）没有可靠信号，
 * 硬调就是拍脑袋 —— 那不是自动进化，是自己给自己找事。
 *
 * 为什么要看「前一天」的数据：当天数据只跑了几小时就下结论，会把
 * 「今天还没开始用」误判成「额度用不完」，然后一天天往下砍。
 */

import { getValue, setValue } from './db.js'
import { readModules, writeModules, clampAgentiveInterval } from './modules.js'
import { readEmotionStore, writeEmotionStore, normalizeMoodConfig } from './emotion.js'
import { readLearningConfig, writeLearningConfig, learningConfig } from './learning.js'

export const AUTO_TUNE_KEY = 'autoTune'

/** 硬边界：怎么调都不许出这个范围。 */
export const TUNE_LIMITS = {
  intervalMs: [5 * 60 * 1000, 60 * 60 * 1000],
  judgePerDay: [6, 60],
  learnPerDay: [2, 20],
}

/** 检查间隔：半小时看一次有没有跨天，跨了就调一次。 */
export const TUNE_CHECK_MS = 30 * 60 * 1000

/**
 * 判定失败率红线（2026-11-16 老大定）：失败率高就说明「额度不是不够用，
 * 是判不出来」——这时候往上加额度只会让失败次数更多，所以先不加。
 */
export const JUDGE_FAIL_RATE_LIMIT = 0.3

export function dayOf(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function clampTo(n, [lo, hi], step = 1) {
  const v = Math.round(Number(n) / step) * step
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

/** 上次调参的记录（没有就是 null）。 */
export function tuneStatus() {
  try {
    return getValue(AUTO_TUNE_KEY) ?? null
  } catch {
    return null
  }
}

/**
 * 算出这一轮要调什么。纯函数：不读盘、不写盘，单测直接喂数据。
 *
 * @returns {{day: string, skipped?: string, changes: Array<{key: string, from: number, to: number, why: string}>}}
 */
export function planTuning(input = {}) {
  const now = input.now ?? Date.now()
  const day = dayOf(now)
  const last = input.last ?? null
  if (last?.day === day) return { day, skipped: '今天已经调过', changes: [] }

  const changes = []
  // 没调、但有话要说的地方（比如「额度打满了但失败率太高，先不加」）——
  // 不给个出口的话，用户只能看到「什么都没动」，会以为是功能坏了。
  const notes = []

  // ── 1. 主动搭话间隔 ────────────────────────────────────────────
  // 数据窗口是「宿主本次启动以来」的累计：样本太少不动，免得一次巧合就改节奏。
  const agentive = input.agentive ?? {}
  const runtime = input.runtime ?? {}
  const fired = Number(runtime.fired) || 0
  const skipped = Number(runtime.skipped) || 0
  const intervalFrom = clampAgentiveInterval(agentive.intervalMs)
  if (fired + skipped >= 6) {
    let next = intervalFrom
    let why = ''
    if (skipped >= fired * 2) {
      next = Math.round(intervalFrom * 1.25)
      why = `发出 ${fired} 次、跳过 ${skipped} 次，间隔太密，拉到 ${Math.round(next / 60000)} 分钟`
    } else if (fired >= 3 && skipped <= Math.ceil(fired * 0.4)) {
      next = Math.round(intervalFrom * 0.85)
      why = `发出 ${fired} 次、只跳过 ${skipped} 次，间隔还能再密一点，收到 ${Math.round(next / 60000)} 分钟`
    }
    next = clampTo(next, TUNE_LIMITS.intervalMs, 60000)
    if (why && Math.abs(next - intervalFrom) >= 60000) {
      changes.push({ key: 'intervalMs', from: intervalFrom, to: next, why })
    }
  }

  // ── 2. 心情判定额度 ────────────────────────────────────────────
  // 只认「上一天的完整账」：judgeLog.day !== 今天，才说明这是昨天跑满一天的数。
  const emotionConfig = normalizeMoodConfig(input.emotionConfig ?? {})
  const judge = input.judgeLog ?? {}
  const judgeLimit = Number(emotionConfig.judgePerDay) || 20
  const judgeUsed = Number(judge.count) || 0
  // 失败率：判不出来（模型没给结果 / 这一轮没切出对话）的次数占比。
  // 2026-11-16 老大定：失败率高就先不加额度 —— 那种情况额度不是不够，是判不动。
  const judgeFailed = Number(judge.failed) || 0
  const judgeTotal = judgeUsed + (Number(judge.skipped) || 0) + judgeFailed
  const judgeFailRate = judgeTotal > 0 ? judgeFailed / judgeTotal : 0
  if (judge.day && judge.day !== day) {
    if (judgeUsed >= judgeLimit) {
      if (judgeFailRate > JUDGE_FAIL_RATE_LIMIT) {
        notes.push(
          `判定额度停在 ${judgeLimit} 条：${judge.day} 失败 ${judgeFailed}/${judgeTotal} 次（${Math.round(judgeFailRate * 100)}%），额度不是不够用，是判不出来，先不加`,
        )
      } else {
        const next = clampTo(judgeLimit * 1.5, TUNE_LIMITS.judgePerDay)
        if (next !== judgeLimit) {
          changes.push({
            key: 'judgePerDay',
            from: judgeLimit,
            to: next,
            why: `${judge.day} 判定额度 ${judgeLimit} 条打满（跳过 ${Number(judge.skipped) || 0} 次、失败 ${judgeFailed} 次），加到 ${next} 条`,
          })
        }
      }
    } else if (judgeLimit > 12 && judgeUsed < judgeLimit * 0.25) {
      const next = clampTo(judgeLimit * 0.8, TUNE_LIMITS.judgePerDay)
      if (next !== judgeLimit) {
        changes.push({
          key: 'judgePerDay',
          from: judgeLimit,
          to: next,
          why: `${judge.day} 只用了 ${judgeUsed}/${judgeLimit} 条，额度下调到 ${next} 条`,
        })
      }
    }
  }

  // ── 3. 自主学习额度 ────────────────────────────────────────────
  const learn = learningConfig({}, input.learning ?? undefined)
  const perDay = Number(learn.perDay) || 8
  const learnState = input.learnState ?? {}
  if (learnState.day && learnState.day !== day) {
    const used = Number(learnState.count) || 0
    if (used >= perDay) {
      const next = clampTo(perDay + 2, TUNE_LIMITS.learnPerDay)
      if (next !== perDay) {
        changes.push({
          key: 'learnPerDay',
          from: perDay,
          to: next,
          why: `${learnState.day} 学习额度 ${perDay} 条用满、记了 ${used} 条，加到 ${next} 条`,
        })
      }
    } else if (used === 0 && perDay > 6) {
      const next = clampTo(perDay - 1, TUNE_LIMITS.learnPerDay)
      changes.push({
        key: 'learnPerDay',
        from: perDay,
        to: next,
        why: `${learnState.day} 一条都没学到，额度下调到 ${next} 条`,
      })
    }
  }

  return { day, changes, notes }
}

/**
 * 执行一次调参：读配置 → 算 → 写回 → 记账。
 *
 * @param {object} options { now, runtime, logger, onIntervalChanged }
 */
export function applyTuning(options = {}) {
  const now = options.now ?? Date.now()
  const day = dayOf(now)
  const last = tuneStatus()
  const plan = planTuning({
    now,
    last,
    agentive: (() => {
      try {
        return readModules().agentive ?? {}
      } catch {
        return {}
      }
    })(),
    runtime: options.runtime ?? {},
    emotionConfig: (() => {
      try {
        return readEmotionStore().config ?? {}
      } catch {
        return {}
      }
    })(),
    judgeLog: (() => {
      try {
        return readEmotionStore().judgeLog ?? null
      } catch {
        return null
      }
    })(),
    learning: readLearningConfig() ?? undefined,
    learnState: (() => {
      try {
        return getValue('learnState') ?? null
      } catch {
        return null
      }
    })(),
  })

  const applied = []
  if (plan.changes.length > 0) {
    const intervalChange = plan.changes.find((c) => c.key === 'intervalMs')
    const judgeChange = plan.changes.find((c) => c.key === 'judgePerDay')
    const learnChange = plan.changes.find((c) => c.key === 'learnPerDay')

    if (intervalChange) {
      try {
        const modules = readModules()
        modules.agentive = { ...(modules.agentive ?? {}), intervalMs: intervalChange.to }
        writeModules(modules)
        applied.push(intervalChange)
        if (typeof options.onIntervalChanged === 'function') {
          options.onIntervalChanged(intervalChange.to)
        }
      } catch (error) {
        options.logger?.warn?.(`自动调参：改间隔失败 ${String(error?.message ?? error)}`)
      }
    }

    if (judgeChange) {
      try {
        const store = readEmotionStore()
        store.config = { ...normalizeMoodConfig(store.config ?? {}), judgePerDay: judgeChange.to }
        writeEmotionStore(store)
        applied.push(judgeChange)
      } catch (error) {
        options.logger?.warn?.(`自动调参：改判定额度失败 ${String(error?.message ?? error)}`)
      }
    }

    if (learnChange) {
      try {
        writeLearningConfig({ perDay: learnChange.to })
        applied.push(learnChange)
      } catch (error) {
        options.logger?.warn?.(`自动调参：改学习额度失败 ${String(error?.message ?? error)}`)
      }
    }
  }

  const record = {
    day,
    at: now,
    applied: applied.map((c) => ({ key: c.key, from: c.from, to: c.to, why: c.why })),
    notes: Array.isArray(plan.notes) ? plan.notes : [],
    skipped: applied.length === 0 ? (plan.skipped ?? '没有需要调的地方') : '',
  }
  try {
    setValue(AUTO_TUNE_KEY, record)
  } catch {
    // 记账失败不影响已经改好的配置
  }
  if (applied.length > 0) {
    options.logger?.info?.(`自动调参：${applied.map((c) => `${c.key} ${c.from}→${c.to}`).join('，')}`)
  }
  return { ...plan, applied }
}

/**
 * 挂上每日检查。半小时看一次，跨天就调一次 —— 不另起一套复杂调度。
 * 返回 stop 函数，插件卸载时调用。
 */
/** 每天一次的自我观察：把各项指标写成一句话，进知识库当自己的「体检记录」。 */
export const SELF_CHECK_KEY = 'selfCheck'

/**
 * 生成一条自我观察。纯函数，不写盘、不调模型。
 *
 * 为什么要有（2026-11-16）：异常以前只活在内存 state 和日志里，
 * 一重启就没了，它自己也不知道「我这几天哪儿别扭」。每天留一条，
 * 下次问「最近怎么样」才有据可依，而不是现编。
 */
export function planSelfCheck(input = {}, now = Date.now()) {
  const day = dayOf(now)
  const runtime = input.runtime ?? {}
  const judge = input.judge ?? {}
  const learn = input.learn ?? {}
  const reflect = input.reflect ?? {}
  const parts = []
  const warns = []

  const fired = Math.max(0, Number(runtime.fired) || 0)
  const skipped = Math.max(0, Number(runtime.skipped) || 0)
  const sameDir = Math.max(0, Number(runtime.sameDirSkipped) || 0)
  if (fired + skipped + sameDir > 0) {
    parts.push(`主动搭话发出 ${fired} 次、跳过 ${skipped} 次${sameDir > 0 ? `（同目录挡掉 ${sameDir} 次）` : ''}`)
    if (fired > 0 && skipped >= fired * 3 && skipped >= 6) {
      warns.push('主动搭话跳过远多于发出，间隔可能还是偏短')
    }
  }

  const judgeUsed = Math.max(0, Number(judge.count) || 0)
  const judgeLimit = Math.max(0, Number(judge.limit) || 0)
  const judgeFailed = Math.max(0, Number(judge.failed) || 0)
  const judgeSkipped = Math.max(0, Number(judge.skipped) || 0)
  if (judgeLimit > 0) {
    const total = judgeUsed + judgeSkipped + judgeFailed
    parts.push(`心情判定 ${judgeUsed}/${judgeLimit} 次（失败 ${judgeFailed}）`)
    if (total > 0 && judgeFailed / total > JUDGE_FAIL_RATE_LIMIT) {
      warns.push(`判定失败 ${judgeFailed}/${total} 次，是判据或素材的问题，不是额度不够`)
    }
    if (judge.lastError) warns.push(`最近一次判定失败：${String(judge.lastError).slice(0, 60)}`)
  }

  const learnUsed = Math.max(0, Number(learn.used) || 0)
  const learnLimit = Math.max(0, Number(learn.perDay) || 0)
  if (learnLimit > 0) parts.push(`自主学习 ${learnUsed}/${learnLimit} 条`)

  const reflectUsed = Math.max(0, Number(reflect.used) || 0)
  const reflectLimit = Math.max(0, Number(reflect.perDay) || 0)
  if (reflectLimit > 0) parts.push(`复盘 ${reflectUsed}/${reflectLimit} 次`)

  if (parts.length === 0) return null
  const level = warns.length > 0 ? 'warn' : 'ok'
  const text = `自检 ${day}：${parts.join('；')}。${warns.length > 0 ? `留意：${warns.join('；')}` : '各项正常。'}`
  return { day, at: now, level, text, lines: parts, warns }
}

/** 一天只跑一次：攒一条自我观察交给外面记账（外面通常写进知识库）。 */
function runSelfCheck(options = {}, runtime = {}) {
  const now = Date.now()
  const state = getValue(SELF_CHECK_KEY)
  if (state && state.day === dayOf(now)) return null
  const extra = typeof options.getSelfCheck === 'function' ? options.getSelfCheck() : null
  const input = { ...(extra ?? {}), runtime: extra?.runtime ?? runtime }
  // 插件刚起来那一刻计数器全是 0，这时候记一条「复盘 0/6 次」纯属噪音。
  // 等攒出点动静再记（下一次检查是 30 分钟后，不写 kv 就会再试）。
  const signals =
    (Number(input.runtime?.fired) || 0) +
    (Number(input.runtime?.skipped) || 0) +
    (Number(input.judge?.count) || 0) +
    (Number(input.learn?.used) || 0) +
    (Number(input.reflect?.used) || 0)
  if (signals <= 0) return null
  const report = planSelfCheck(input, now)
  if (!report) return null
  setValue(SELF_CHECK_KEY, { day: report.day, at: report.at, level: report.level })
  try {
    options.onSelfCheck?.(report)
  } catch (error) {
    options.logger?.warn?.(`自检记账失败：${String(error?.message ?? error)}`)
  }
  return report
}

export function startAutoTuneLoop(options = {}) {
  let stopped = false
  const check = () => {
    if (stopped) return
    try {
      // 每次检查都要现取运行时统计：定时器是常驻的，启动那一刻的 fired/skipped
      // 早就过期了（拿旧快照调参＝按第一天的数据永远调同一边）。
      const runtime =
        typeof options.getRuntime === 'function'
          ? options.getRuntime()
          : options.runtime
      applyTuning({ ...options, runtime })
      runSelfCheck(options, runtime)
    } catch (error) {
      options.logger?.warn?.(`自动调参失败：${String(error?.message ?? error)}`)
    }
  }
  // 启动时立刻看一次：昨天跨天的话，别等到半小时后。
  const timer = setInterval(check, TUNE_CHECK_MS)
  if (typeof timer.unref === 'function') timer.unref()
  check()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
