/**
 * 从 DSH 会话事件里提取对话轮次。
 *
 * 宿主把会话事件放在 agent.session.snapshotEvents() / agent.session.events 里，
 * 事件的形状（与 hindsight 插件读法一致）：
 *   { type: "user/message", data: { message: {...} }, time }
 *   { type: "assistant/message", data: { message: {...} }, time }
 *   { type: "tool/call", data: { name, arguments } }
 */

/** 从一条 message 里取纯文本。 */
export function messageText(message) {
  if (!message) return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 记住的注入内容不参与摘要（否则会自己总结自己）。 */
function stripInjected(text) {
  return String(text ?? '')
    .replace(/<shared-memory-injection>[\s\S]*?<\/shared-memory-injection>/g, '')
    .trim()
}

/**
 * 把事件流切成「一轮对话」。
 * 一轮 = 一条用户消息 + 其后的助手消息（可含工具调用事件）。
 *
 * includeSelfTalk（2026-11-03，P1-9）：
 *   false（默认）—— 只切老大说的话（老语义）
 *   true        —— 连「我们自己主动搭话」那种轮次也切出来，
 *                  并在 turn.sourceKind 上标出它是谁说的
 *
 * 以前插件自己的消息被 kind !== 'user' 直接跳过，于是主动搭话那一轮
 * 根本没被切成 turn，我们的回复挂到了上一轮（串味）或被丢掉 ——
 * 心情判定读到的「我说了什么」是模板，不是真话。
 */
export function extractTurns(events, options = {}) {
  const includeSelfTalk = options.includeSelfTalk === true
  const turns = []
  let current = null

  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue

    if (event.type === 'user/message') {
      const message = event.data?.message ?? event.data
      const kind = message?.source?.kind
      const isSelfTalk = Boolean(kind) && kind !== 'user'
      if (isSelfTalk && !includeSelfTalk) continue
      if (!kind && message?.role && message.role !== 'user') continue
      const text = stripInjected(messageText(message))
      if (!text) continue
      if (current) turns.push(current)
      current = {
        user: text,
        assistant: '',
        tools: [],
        time: event.time,
        sourceKind: String(kind ?? 'user'),
        selfTalk: isSelfTalk,
      }
      continue
    }

    if (!current) continue

    if (event.type === 'assistant/message') {
      const text = stripInjected(messageText(event.data?.message ?? event.data))
      if (text) current.assistant = current.assistant ? `${current.assistant}\n${text}` : text
      continue
    }

    if (event.type === 'tool/call') {
      const name = event.data?.name
      if (typeof name === 'string' && name) current.tools.push(name)
      continue
    }
  }

  if (current) turns.push(current)
  return turns
}

/**
 * 兜底：切不出轮次时，直接从事件流尾部抠一对「最近的老大消息 + 我的回复」。
 *
 * 为什么需要（2026-11-16）：线上 judgeLog 里失败最多的原因就是
 * 「这一轮没切出对话（事件流里没有可判的轮次）」。extractTurns 要求
 * 一条 user/message 打头才建 current，而续接轮、只插了运行时上下文的轮、
 * 以及宿主改过事件顺序的时候，尾部往往是「有 assistant 没有 user」，
 * 于是整轮被丢掉、判定直接失败、额度白花。
 * 这里不追求严格配对：只要拿到一段我的回复，就配上它前面最近的一条
 * 老大消息（拿不到就空着，判定仍然能跑）。
 */
export function fallbackTurn(events) {
  const list = Array.isArray(events) ? events : []
  let assistant = ''
  let user = ''
  let at = 0
  let index = -1

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i]
    if (!event || typeof event !== 'object') continue
    if (event.type !== 'assistant/message') continue
    const text = stripInjected(messageText(event.data?.message ?? event.data))
    if (!text) continue
    assistant = text
    at = typeof event.time === 'number' ? event.time : 0
    index = i
    break
  }
  if (!assistant) return null

  for (let i = index - 1; i >= 0; i -= 1) {
    const event = list[i]
    if (!event || typeof event !== 'object') continue
    if (event.type !== 'user/message') continue
    const message = event.data?.message ?? event.data
    const kind = message?.source?.kind
    if (kind && kind !== 'user') continue
    if (!kind && message?.role && message.role !== 'user') continue
    const text = stripInjected(messageText(message))
    if (!text) continue
    user = text
    break
  }

  return {
    user,
    assistant,
    tools: [],
    time: at,
    sourceKind: 'user',
    selfTalk: false,
    fallback: true,
  }
}

/** 取会话的事件流。 */
export function sessionEvents(session) {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      return session.snapshotEvents() ?? session.events ?? []
    } catch {
      return session.events ?? []
    }
  }
  return session.events ?? []
}
