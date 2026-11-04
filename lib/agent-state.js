/**
 * 按会话（agent）保存上下文。
 *
 * 为什么单独一个文件：以前插件把「当前提示词 / 当前会话 / 当前工作目录」放在
 * 模块级变量里，结果多个会话并发时互相覆盖——子代理（task-board、im、ssh 等
 * 插件开的会话）拿到的会是父会话的提示词，记忆召回也因此串味。
 *
 * 现在的做法：以 `agent.session.header.id` 为键存一份上下文，取的时候用
 * 「当前 agent → 当前会话 → 全局兜底」三级查找，和宿主里
 * `@vectorize-io/hindsight-coding-agents` 的做法一致。
 */

/** 每个会话的上下文。 */
const contexts = new Map()

/** 每个会话上一次注入的记忆文本（用来去重，别每步都塞一遍）。 */
const injected = new Map()

/** 记住一个会话的上下文。 */
export function setAgentContext(sessionId, context) {
  if (!sessionId) return
  const previous = contexts.get(sessionId) ?? {}
  contexts.set(sessionId, { ...previous, ...context, updatedAt: Date.now() })
}

/** 读某个会话的上下文。 */
export function getAgentContext(sessionId) {
  if (!sessionId) return undefined
  return contexts.get(sessionId)
}

/** 取某个键，缺省退回全局值。 */
export function getScopedValue(sessionId, key, fallback = undefined) {
  const context = getAgentContext(sessionId)
  if (context && context[key] !== undefined && context[key] !== null && context[key] !== '') {
    return context[key]
  }
  return fallback
}

/**
 * 找出「最近一次有活动的会话」。
 *
 * 系统提示词是在组装时统一生成的，那时拿不到具体是哪个 agent 在组装，
 * 所以用「最近活跃的那个会话」作为兜底上下文——总比全局陈旧值强。
 */
export function latestContext() {
  let best
  let bestAt = -1
  for (const context of contexts.values()) {
    const at = Number(context?.updatedAt ?? 0)
    if (at >= bestAt) {
      bestAt = at
      best = context
    }
  }
  return best
}

/**
 * 取「当前上下文」。
 *
 * 2026-11-04（E4）：以前的兜底是「找不到这个会话就拿最近活跃的那个」——
 * 结果 A 会话的提示词会喂给 B 会话（串味）。
 * 现在默认**不跨会话兜底**：
 *   - 给了 sessionId 且取不到 → 返回空（这个会话就是还没建立上下文）；
 *   - 连 sessionId 都没给 → 才退回「最近活跃的会话」（那种场景本来
 *     就是全局组装的场景，拿全局值不算串味）。
 * 需要显式跨会话兜底的调用点可以传 { allowFallback: true }。
 *
 * @param {string} sessionId 已知会话 id（可空）
 * @param {object} [options] { allowFallback } 是否允许在没给 sessionId 时退回全局最近值
 * @returns {{ sessionId: string, title: string, cwd: string, prompt: string }}
 */
export function currentContext(sessionId = '', options = {}) {
  const allowFallback = options?.allowFallback !== false
  const id = String(sessionId ?? '').trim()
  // 有会话 id：只认这个会话，取不到就是取不到（不拿别的会话顶）。
  // 真的「还没建立上下文」和「有但取不到」在这里被区分开了。
  if (id) {
    const context = getAgentContext(id)
    if (!context) {
      return { sessionId: '', title: '', cwd: '', prompt: '' }
    }
    return {
      sessionId: String(context.sessionId ?? ''),
      title: String(context.title ?? ''),
      cwd: String(context.cwd ?? ''),
      prompt: String(context.prompt ?? ''),
    }
  }
  // 连会话都没给：只有显式允许（或默认允许）才退回全局最近值。
  const context = allowFallback ? latestContext() : undefined
  if (!context) {
    return { sessionId: '', title: '', cwd: '', prompt: '' }
  }
  return {
    sessionId: String(context.sessionId ?? ''),
    title: String(context.title ?? ''),
    cwd: String(context.cwd ?? ''),
    prompt: String(context.prompt ?? ''),
  }
}

/** 记下这个会话已经注入过什么（用于去重）。 */
export function setLastInjected(sessionId, payload) {
  if (!sessionId) return
  injected.set(sessionId, String(payload ?? ''))
}

/** 这个会话上次注入的内容。 */
export function lastInjected(sessionId) {
  if (!sessionId) return ''
  return injected.get(sessionId) ?? ''
}

/** 清掉一个会话的状态（会话结束时调用）。 */
export function clearAgentContext(sessionId) {
  if (!sessionId) return
  contexts.delete(sessionId)
  injected.delete(sessionId)
}

/** 清掉全部（插件卸载时调用）。 */
export function clearAll() {
  contexts.clear()
  injected.clear()
}

/** 当前跟踪着多少个会话（给状态接口看）。 */
export function trackedCount() {
  return contexts.size
}
