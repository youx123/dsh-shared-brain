#!/usr/bin/env node
/**
 * E2 接线：让情感条目真正流到主动搭话的决策层。
 *
 * 链路：index.js 提供 getEmotions(sessionId)
 *   → proactive.js 的 tick 传给 nudgeAgent
 *   → nudgeAgent 传进 decideProactive
 *   → decideProactive 传给 readMoodSignal（已在批次 F 改好）
 *   → emotionBiasOf 折算成 level 偏向
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

// ① tick 传 emotions
patchText(
  'proactive.js',
  `          moodConfig: options.getMoodConfig?.() ?? options.moodConfig ?? {},
          pending: options.getPending?.(sessionId) ?? [],
        })`,
  `          moodConfig: options.getMoodConfig?.() ?? options.moodConfig ?? {},
          pending: options.getPending?.(sessionId) ?? [],
          // 2026-11-04（E2）：把对这个会话成立的情感条目一起带下去，
          // 让「老大讨厌啰嗦」这类记忆真的影响搭话的调子。
          emotions: options.getEmotions?.(sessionId) ?? [],
        })`,
)

// ② nudgeAgent 里传给 decideProactive
patchText(
  'proactive.js',
  `    config: options.moodConfig ?? {},
    now,
    dayEnd: dayEndOf(agentive, now),`,
  `    config: options.moodConfig ?? {},
    // 2026-11-04（E2）：情感条目 → readMoodSignal → level 偏向
    emotions: options.emotions ?? [],
    now,
    dayEnd: dayEndOf(agentive, now),`,
)

// ③ index.js 提供 getEmotions
patchText(
  'index.js',
  `      // 待办线索：共享记忆里带「承诺 / 待办 / 还没做完」这类词的高权重条目
      getPending: (sessionId) => pendingHintsOf(sessionId),`,
  `      // 待办线索：共享记忆里带「承诺 / 待办 / 还没做完」这类词的高权重条目
      getPending: (sessionId) => pendingHintsOf(sessionId),
      // 2026-11-04（E2）：这个会话成立的情感条目（情感模块 + 扁平库里 module=emotion 的）。
      // 主动搭话的决策层用它判断「老大最近对这个话题是什么态度」，
      // 以前这些字段只影响召回排序，不影响任何行为。
      getEmotions: (sessionId) => emotionEntriesOf(sessionId),`,
)

// ④ 新增 emotionEntriesOf（放在 pendingHintsOf 后面）
patchText(
  'index.js',
  `/**
 * 从一段消息列表里取出用户发来的文本。`,
  `/**
 * 取对某个会话成立的情感条目（主动搭话决策层要用）。
 *
 * 2026-11-04（E2）：情感记忆以前没有下游 —— intimacy/sentiment/target
 * 只影响召回排序和括号注释，不影响任何决策。现在把这份清单交给
 * proactive-mood 的 emotionBiasOf，让它能影响搭话的调子。
 *
 * @param {string} sessionId 会话 id（用来做作用域过滤）
 * @returns {Array} 情感条目（最多 20 条，按亲密度降序）
 */
function emotionEntriesOf(sessionId = '') {
  try {
    const store = readStore()
    const out = []
    for (const entry of store.entries ?? []) {
      if (!entry || entry.module !== 'emotion') continue
      if (!isAlive(entry)) continue
      const scope = entry.scope ?? 'global'
      if (scope === 'session' && !sameSessionKey(entry.sessionId ?? '', sessionId)) continue
      out.push(entry)
    }
    out.sort((a, b) => (Number(b.intimacy ?? b.weight ?? 0) - Number(a.intimacy ?? a.weight ?? 0)))
    return out.slice(0, 20)
  } catch {
    return []
  }
}

/**
 * 从一段消息列表里取出用户发来的文本。`,
)

console.log('[done] E2 接线完成')
