/**
 * 长文分块（2026-11-11）。
 *
 * 起因：`/learn` 抓网页默认只取 6000 字就送去提炼，长文章后半截等于没读，
 * 而且界面上看不出「只读了开头」。这里只做一件很朴素的事：
 * 按段落 / 句子把正文切成若干块，每块不超过 CHUNK_CHARS，块序连续，
 * 交给调用方逐块提炼；覆盖了多少字由 coverageSummary 如实算出来。
 *
 * 刻意不在这里做摘要或调模型 —— 纯函数，能被单元测试钉住。
 */

export const CHUNK_CHARS = 1200
export const MAX_CHUNKS = 3

/** 段落分隔优先，其次句末标点，实在不行才硬切。 */
const PARA_SPLIT = /\n\s*\n/
const SENT_SPLIT = /(?<=[。！？!?；;：:…])/

function splitLong(piece, size) {
  if (piece.length <= size) return [piece]
  const parts = piece.split(SENT_SPLIT).filter((s) => s.length > 0)
  const out = []
  let buf = ''
  for (const part of parts) {
    if (part.length > size) {
      // 单句都超长（比如没有标点的列表），退回硬切
      if (buf) {
        out.push(buf)
        buf = ''
      }
      for (let i = 0; i < part.length; i += size) out.push(part.slice(i, i + size))
      continue
    }
    if ((buf + part).length > size) {
      out.push(buf)
      buf = part
    } else {
      buf += part
    }
  }
  if (buf) out.push(buf)
  return out
}

/**
 * @param {string} text 原文
 * @param {{ size?: number, maxChunks?: number }} options
 * @returns {{ index: number, text: string, chars: number, offset: number }[]}
 */
export function chunkText(text, { size = CHUNK_CHARS, maxChunks = MAX_CHUNKS } = {}) {
  const limit = Number.isFinite(size) && size > 0 ? Math.floor(size) : CHUNK_CHARS
  const max = Number.isFinite(maxChunks) && maxChunks > 0 ? Math.floor(maxChunks) : MAX_CHUNKS
  const clean = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!clean) return []

  const paragraphs = clean.split(PARA_SPLIT).filter((p) => p.trim().length > 0)
  const pieces = []
  for (const para of paragraphs) pieces.push(...splitLong(para.trim(), limit))

  // 段落之间能拼的就拼，别把一块切得太碎
  const merged = []
  let buf = ''
  for (const piece of pieces) {
    if (!buf) {
      buf = piece
      continue
    }
    if ((buf + '\n' + piece).length > limit) {
      merged.push(buf)
      buf = piece
    } else {
      buf += '\n' + piece
    }
  }
  if (buf) merged.push(buf)

  let offset = 0
  return merged.slice(0, max).map((chunk, index) => {
    const item = { index, text: chunk, chars: chunk.length, offset }
    offset += chunk.length
    return item
  })
}

/**
 * 老实交代读了多少：块数、字数、占原文比例、后面还剩多少没读。
 */
export function coverageSummary(chunks, totalChars) {
  const list = Array.isArray(chunks) ? chunks : []
  const total = Number.isFinite(totalChars) ? Math.max(0, Math.floor(totalChars)) : 0
  const chars = list.reduce((sum, c) => sum + (Number(c?.chars) || 0), 0)
  const ratio = total > 0 ? Math.min(1, chars / total) : 0
  return {
    chunks: list.length,
    chars,
    total,
    ratio: Math.round(ratio * 1000) / 1000,
    truncated: total > 0 && chars < total,
  }
}
