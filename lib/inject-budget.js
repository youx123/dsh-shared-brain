/**
 * 注入配额的守门人。
 *
 * 记忆召回是一段越长越有用的东西，可它没有上限：八条命中、每条几百字，
 * 再加上「读过的书」与知识索引，一段就能顶掉几千字上下文。上下文贵，
 * 而且过长的记忆段落会把真正要紧的指令挤到后面（模型对开头结尾更敏感）。
 *
 * 这里的策略很土但可预测：按行截，保留前半段，末尾追加一句说明。
 * 不做「智能摘要」——那要再调一次模型，为省上下文反而多花一次。
 */

/** 记忆段落的预算（字符）。4000 大约是一屏中文，够放八条短记忆加书目索引。 */
export const INJECT_BUDGET_CHARS = 4000

/** 截断时用来收尾的那句话，长度要算进预算里。 */
const NOTE_PREFIX = '…（记忆太长，后面还有 '
const NOTE_SUFFIX = ' 行没放进来）'

/**
 * 把一段文本压进预算。
 *
 * @param {string} text 原始文本（记忆段落、心情段落等）
 * @param {{ budget?: number }} [options]
 * @returns {{ text: string, trimmed: boolean, droppedLines: number }}
 */
export function fitToBudget(text, options = {}) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const budget = Number.isFinite(Number(options?.budget)) ? Math.max(0, Number(options.budget)) : INJECT_BUDGET_CHARS
  if (!raw) return { text: '', trimmed: false, droppedLines: 0 }
  if (raw.length <= budget) return { text: raw, trimmed: false, droppedLines: 0 }

  const lines = raw.split('\n')
  // 留出写「还有 N 行」的位置；至少给 40 字，否则预算太小时一句话都放不下。
  const reserve = Math.max(40, NOTE_PREFIX.length + NOTE_SUFFIX.length + 8)
  const room = Math.max(0, budget - reserve)

  const kept = []
  let used = 0
  for (const line of lines) {
    const cost = line.length + 1
    if (used + cost > room) break
    kept.push(line)
    used += cost
  }

  // 一行都放不下（比如没有换行的超长单行）：硬切，但别切出半个代理对。
  if (kept.length === 0) {
    const cut = raw.slice(0, room)
    const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
    const dropped = lines.length - 1 > 0 ? lines.length - 1 : 1
    return {
      text: `${safe}${NOTE_PREFIX}${dropped}${NOTE_SUFFIX}`,
      trimmed: true,
      droppedLines: dropped,
    }
  }

  const droppedLines = Math.max(0, lines.length - kept.length)
  return {
    text: `${kept.join('\n')}\n${NOTE_PREFIX}${droppedLines}${NOTE_SUFFIX}`,
    trimmed: true,
    droppedLines,
  }
}

/** 给日志/状态用的一句话概括。 */
export function describeBudget(result) {
  if (!result || result.trimmed !== true) return '注入未截断'
  return `注入已截断：少了 ${result.droppedLines} 行`
}
