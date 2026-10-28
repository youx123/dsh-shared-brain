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
 */
export function extractTurns(events) {
  const turns = []
  let current = null

  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue

    if (event.type === 'user/message') {
      const message = event.data?.message ?? event.data
      const kind = message?.source?.kind
      if (kind && kind !== 'user') continue
      if (!kind && message?.role && message.role !== 'user') continue
      const text = stripInjected(messageText(message))
      if (!text) continue
      if (current) turns.push(current)
      current = { user: text, assistant: '', tools: [], time: event.time }
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
