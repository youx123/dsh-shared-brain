/**
 * 把「模块桶里手工加的条目」并进召回用的桶，去重。
 *
 * 以前的写法是每来一条就把整个桶扫两遍（先比 id、再比正文前 40 字）：
 * 560 条记忆、七个模块，一轮就要几万次字符串比较，而且比较量随条目数平方增长。
 * 这里先把桶里的 id 与前缀建成两张表，再来一条查一次就够。
 */

/** 正文前缀多长算「同一条」。40 字是老口径，别动 —— 动了会把以前合掉的又拆开。 */
export const PREFIX_LEN = 40

/** 取正文前缀，统一去空白。 */
export function textPrefix(text, len = PREFIX_LEN) {
  return String(text ?? '').trim().slice(0, len)
}

/**
 * 把 candidates 里「桶里没有的」并进 existing。
 *
 * @param {Array<{id?: string, text?: string}>} existing 已有的桶条目
 * @param {Array<{id?: string, text?: string}>} candidates 待并的条目
 * @param {{ accept?: (item: any) => boolean }} [options] accept 返回 false 的直接跳过（比如刚过期删掉的正文）
 * @returns {{ items: Array<any>, added: number, skipped: number }}
 */
export function mergeBucketItems(existing, candidates, options = {}) {
  const items = Array.isArray(existing) ? existing.slice() : []
  const ids = new Set()
  const prefixes = new Set()
  for (const item of items) {
    if (item?.id) ids.add(item.id)
    prefixes.add(textPrefix(item?.text))
  }

  const accept = typeof options?.accept === 'function' ? options.accept : null
  let added = 0
  let skipped = 0
  for (const item of Array.isArray(candidates) ? candidates : []) {
    if (accept && accept(item) === false) {
      skipped += 1
      continue
    }
    const prefix = textPrefix(item?.text)
    if (item?.id && ids.has(item.id)) {
      skipped += 1
      continue
    }
    if (prefixes.has(prefix)) {
      skipped += 1
      continue
    }
    items.push(item)
    if (item?.id) ids.add(item.id)
    prefixes.add(prefix)
    added += 1
  }

  return { items, added, skipped }
}
