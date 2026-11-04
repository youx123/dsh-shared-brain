#!/usr/bin/env node
/**
 * 把 shouldContinueTurn 接上（0.10.1 收尾第 2 件）。
 *
 * 现状：`lib/proactive.js` 里 `shouldContinueTurn` / `roundOf` 是死代码 ——
 * 注释把设计写得挺清楚（「只在模型明确留下『还有事没说完』的信号时才续接，
 * 一个会话最多 3 轮」），但没有任何地方调用它们。
 *
 * 接线的三个决定：
 *  1. **信号从哪来**：宿主的 `agent/turn-stopping` 只给 `{ agent }`，没有 reason。
 *     所以判据必须是本地能观察到的东西 —— 用「本轮最后一条助手消息末尾的续接标记」。
 *     标记用 HTML 注释 `<!-- 继续：理由 -->`，渲染 markdown 时看不见，不会污染回复。
 *  2. **闸门**：agentive.enabled 为真 + `selfContinue` 不为 false + 作用范围命中
 *     + 时间窗内 + 最多 3 轮（后面这些原本就在 shouldContinueTurn 里）。
 *  3. **补一个坑**：原来的 `lastRound` 只增不减 —— 一个会话续接满 3 轮以后，
 *     这台机器上它就**永远**不能再续接了。现在老大真说话（mode === 'user'）时清零。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'

function patch(file, pairs) {
  const p = join(LIB, file)
  let src = readFileSync(p, 'utf8')
  for (const [from, to] of pairs) {
    const n = src.split(from).length - 1
    if (n === 0) throw new Error(`${file}: 找不到锚点 ${JSON.stringify(from.slice(0, 90))}`)
    if (n > 1) throw new Error(`${file}: 锚点出现 ${n} 次 ${JSON.stringify(from.slice(0, 60))}`)
    src = src.replace(from, to)
  }
  writeFileSync(p, src, 'utf8')
  console.log(`[ok] ${file}`)
}

// ── 1. modules.js：agentive 加 selfContinue 开关（默认开） ──────────────
patch('modules.js', [
  [
    `      // 时间窗：只在某个时段里主动（'HH:MM' ~ 'HH:MM'，跨午夜也支持）
      timeWindow: {`,
    `      // 续接轮次（2026-11-04）：模型在本轮回复末尾留了续接标记时，
      // 让这一轮接着往下跑，而不是停下来等老大再说一句。
      // 只在模型显式留信号时触发，一个会话最多续 3 轮。
      selfContinue: true,
      // 时间窗：只在某个时段里主动（'HH:MM' ~ 'HH:MM'，跨午夜也支持）
      timeWindow: {`,
  ],
  [
    `      if (incoming.mood && typeof incoming.mood === 'object') {
        base.agentive.mood = normalizeAgentiveMood(incoming.mood, base.agentive.mood)
      }`,
    `      if (incoming.mood && typeof incoming.mood === 'object') {
        base.agentive.mood = normalizeAgentiveMood(incoming.mood, base.agentive.mood)
      }
      // 2026-11-04：续接轮次开关。只有明确写成 false 才关，其余都按默认（开）。
      if (incoming.selfContinue !== undefined) {
        base.agentive.selfContinue = incoming.selfContinue !== false
      }`,
  ],
])

// ── 2. proactive.js：续接标记解析 + 轮次清零 ──────────────────────────
patch('proactive.js', [
  [
    `/**
 * 轮次收尾时判断要不要续接。`,
    `/**
 * 续接标记：HTML 注释，渲染 markdown 时看不见，不会出现在老大眼里。
 *
 * 之所以要用「标记」而不是去猜「这句话好像没说完」：
 * 猜错的代价是 AI 自己跟自己聊起来，那个比不续接烦人得多。
 * 让模型自己声明「我这轮还没做完」，误判的概率就只取决于它诚不诚实。
 */
const CONTINUE_MARKS = [
  // <!-- 继续：把测试跑完 -->
  /<!--\\s*继续\\s*[：:]\\s*([^<>\\n]{1,120}?)\\s*-->/,
  // 兜底：有些地方会把 HTML 注释吃掉，留一个纯文本形态
  /\\[\\[继续\\s*[：:]\\s*([^\\]\\n]{1,120}?)\\]\\]/,
]

/**
 * 从一段助手文本里取出续接理由；没有标记返回空串。
 *
 * 只看**末尾**（最后 400 字符）—— 标记本来就该写在回复最后一行，
 * 正文中间提到「继续」两个字不该触发。
 */
export function continueReasonOf(text) {
  const raw = String(text ?? '')
  if (!raw) return ''
  const tail = raw.slice(-400)
  for (const re of CONTINUE_MARKS) {
    const m = re.exec(tail)
    if (m && m[1]) return m[1].trim()
  }
  return ''
}

/** 老大真的说话了：续接轮次从头开始算。 */
export function resetContinueRound(sessionId) {
  if (sessionId) lastRound.delete(sessionId)
}

/**
 * 轮次收尾时判断要不要续接。`,
  ],
])

// ── 3. index.js：turn-stopping 里接线 + pre-step 里清零 ───────────────
patch('index.js', [
  [
    `  PROACTIVE_INTERVAL_JITTER,
} from './proactive.js'`,
    `  PROACTIVE_INTERVAL_JITTER,
  continueReasonOf,
  shouldContinueTurn,
  roundOf,
  resetContinueRound,
} from './proactive.js'`,
  ],
  [
    `    // 心情判定：这一轮说完了，才知道心情怎么变的。
    // 异步跑，不阻塞这一轮结束。
    void judgeMoodForTurn(ctx, agent, logger)`,
    `    // 续接轮次：模型在这一轮回复末尾留了续接标记，就把这一轮接着跑下去。
    // 门槛在 shouldContinueTurn 里（作用范围 / 时间窗 / 最多 3 轮）。
    tryContinueTurn(agent, logger)
    // 心情判定：这一轮说完了，才知道心情怎么变的。
    // 异步跑，不阻塞这一轮结束。
    void judgeMoodForTurn(ctx, agent, logger)`,
  ],
  [
    `    // 这一轮是「老大说的」还是「我们自己搭话说的」。
    const mode = judgeModeOf(lastTurn.sourceKind)
    if (!mode) return`,
    `    // 这一轮是「老大说的」还是「我们自己搭话说的」。
    const mode = judgeModeOf(lastTurn.sourceKind)
    if (!mode) return

    // 老大真说话了 → 续接轮次重新计数。
    // 不然一个会话续满 3 轮之后，这台机器上它就永远不能再续接了。
    if (mode === 'user') resetContinueRound(sessionIdOf(agent))`,
  ],
  [
    `function persistTurn(agent) {`,
    `/**
 * 续接轮次：模型在本轮回复末尾留了 \`<!-- 继续：理由 -->\` 就再续一轮。
 *
 * 这里刻意做得很保守：
 *  - 只有模型**自己声明**还有事没做完才续（不猜）；
 *  - \`agentive.enabled\` 关着就完全不动 —— 续接也是「主动性」，得受同一个开关管；
 *  - 作用范围 / 时间窗 / 3 轮上限由 shouldContinueTurn 判。
 *
 * 理由同时也写进日志，方便事后看「它到底自己续着干了什么」。
 */
function tryContinueTurn(agent, logger) {
  try {
    const agentive = readModules().agentive ?? {}
    if (!agentive.enabled) return
    if (agentive.selfContinue === false) return
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return
    const turns = extractTurns(sessionEvents(agent?.session))
    const last = turns[turns.length - 1]
    const reason = continueReasonOf(last?.assistant ?? '')
    if (!reason) return
    if (!shouldContinueTurn(sessionId, agentive, reason)) return
    const round = roundOf(sessionId)
    const message = \`继续：\${reason}\`
    if (typeof agent?.followup === 'function') agent.followup(message)
    else if (typeof agent?.inject === 'function') agent.inject(message)
    else return
    state.turnsContinued = (Number(state.turnsContinued) || 0) + 1
    logger?.info?.(\`续接第 \${round} 轮：\${reason}\`)
  } catch (error) {
    state.lastError = String(error?.message ?? error)
    logger?.warn?.(\`续接轮次失败：\${state.lastError}\`)
  }
}

function persistTurn(agent) {`,
  ],
])

console.log('[done] shouldContinueTurn 接线完成')
