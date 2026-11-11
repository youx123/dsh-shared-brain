/**
 * DSH → Cursor 规则导出（2026-11-11）。
 *
 * 背景：Cursor 那边能写规则，并且共享大脑会读回来（`importFromCursorRules`），
 * 但反过来一直没有出口 —— 记忆里的底线和钉住的条目只能待在自己的库里。
 *
 * 三条克制原则，都是为了避免「帮倒忙」：
 * 1. **只导出明确该进规则库的东西**：底线条目 + 钉住的条目。工作记忆不进。
 * 2. **只认自己写的文件**：文件名固定 `dsh-<id>.mdc`，正文第一行必须是标记。
 *    文件存在但没有标记（用户手写的）→ 跳过，绝不覆盖。
 * 3. **只在显式命令下动手**：没有自动同步，目标目录由调用方给。
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from './atomic-write.js'

export const MARKER = '<!-- dsh-shared-brain:auto v1 -->'
export const FILE_PREFIX = 'dsh-'

function slugOf(entry) {
  const id = String(entry?.id ?? '').trim()
  const safe = id.replace(/[^\w.-]+/g, '-').slice(0, 60)
  return `${FILE_PREFIX}${safe || 'entry'}.mdc`
}

/** 该不该进 Cursor 规则库。 */
export function isExportable(entry) {
  if (!entry || typeof entry !== 'object') return false
  const text = String(entry.text ?? '').trim()
  if (text.length < 8) return false
  if (entry.archived === true) return false
  return entry.module === 'bottomline' || entry.pinned === true
}

/**
 * 渲染一个 .mdc：Cursor 认 frontmatter，description 用正文首句，
 * alwaysApply 只给底线开（钉住的条目按需引用）。
 */
export function renderRule(entry) {
  const text = String(entry?.text ?? '').trim()
  const firstLine = text.split(/[\n。！？]/).find((s) => s.trim().length > 0) ?? text
  const description = firstLine.trim().slice(0, 60).replace(/"/g, "'")
  const always = entry?.module === 'bottomline' ? 'true' : 'false'
  return [
    MARKER,
    '---',
    `description: "${description}"`,
    `alwaysApply: ${always}`,
    '---',
    '',
    text,
    '',
  ].join('\n')
}

/** 读一个文件的开头，判断是不是我们写的。 */
function isOurs(file) {
  try {
    return readFileSync(file, 'utf8').startsWith(MARKER)
  } catch {
    return false
  }
}

/**
 * 导出。
 * @returns {{ written: string[], updated: string[], unchanged: string[], skipped: {file: string, reason: string}[], removed: string[], dir: string }}
 */
export function exportRules(entries, { dir, dryRun = false, prune = false } = {}) {
  const target = String(dir ?? '').trim()
  const result = { written: [], updated: [], unchanged: [], skipped: [], removed: [], dir: target }
  if (!target) {
    result.skipped.push({ file: '', reason: '没给目标目录' })
    return result
  }
  const list = (Array.isArray(entries) ? entries : []).filter(isExportable)
  if (!dryRun) mkdirSync(target, { recursive: true })

  const wanted = new Set()
  for (const entry of list) {
    const file = join(target, slugOf(entry))
    wanted.add(slugOf(entry))
    const body = renderRule(entry)
    let existing = null
    try {
      existing = readFileSync(file, 'utf8')
    } catch {
      existing = null
    }
    if (existing !== null && !existing.startsWith(MARKER)) {
      // 用户手写/别的工具的文件，同名也不动
      result.skipped.push({ file, reason: '文件已存在且不是共享大脑写的' })
      continue
    }
    if (existing === body) {
      result.unchanged.push(file)
      continue
    }
    if (!dryRun) writeFileAtomicSync(file, body)
    if (existing === null) result.written.push(file)
    else result.updated.push(file)
  }

  if (prune) {
    let names = []
    try {
      names = readdirSync(target)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith('.mdc')) continue
      if (wanted.has(name)) continue
      const file = join(target, name)
      if (!isOurs(file)) continue
      if (!dryRun) rmSync(file, { force: true })
      result.removed.push(file)
    }
  }
  return result
}

/** 给命令/接口用的一句话总结。 */
export function renderExportSummary(result) {
  const r = result ?? {}
  if (!r.dir) return '没给目录，什么都没干。'
  const parts = [
    `新写 ${r.written.length}`,
    `更新 ${r.updated.length}`,
    `未变 ${r.unchanged.length}`,
    `跳过 ${r.skipped.length}`,
  ]
  if (Array.isArray(r.removed) && r.removed.length > 0) parts.push(`清掉 ${r.removed.length}`)
  const head = `导出到 ${r.dir}：${parts.join('｜')}`
  const skip = (r.skipped ?? []).filter((s) => s.reason).slice(0, 3)
  const tail = skip.length > 0 ? `\n跳过原因：${skip.map((s) => s.reason).join('；')}` : ''
  return head + tail
}
