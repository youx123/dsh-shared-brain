/**
 * 记忆召回的「路径扩展」：命中一条含路径的记忆时，顺着目录图谱把相关文件带出来。
 *
 * 设计要点：
 *   - **不 import dsh-dir-graph**，只读它落盘的索引文件（~/.dsh/storages/dsh-dir-graph/index.json）。
 *     两个插件互不依赖：图谱插件没了，共享大脑照常工作（只是没有扩展）。
 *   - 索引不存在 / 坏了 / 是旧版本 → 直接返回空，不影响召回。
 *   - 扩展结果只是「线索」，标注清楚是图谱推出来的，模型可以自行取舍。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 反斜杠：正则里用字符串拼，避免手写转义出错。 */
const BS = String.fromCharCode(92)

/** 分隔符：空白 + 常见中英文标点，用来把一句话切成候选路径。 */
const SEPARATOR_RE = new RegExp(
  '[' +
    BS + 's' +
    ',' + String.fromCharCode(0xff0c) + String.fromCharCode(0x3001) +
    ';' + String.fromCharCode(0xff1b) +
    '()' + String.fromCharCode(0xff08) + String.fromCharCode(0xff09) +
    BS + '[' + BS + ']' +
    String.fromCharCode(0x3010) + String.fromCharCode(0x3011) +
    ']+',
)

/** URL 判定。 */
const URL_RE = new RegExp('[a-z]+:' + BS + '/' + BS + '/', 'i')
/** 中文字符判定。 */
const CN_RE = new RegExp('[' + BS + 'u4e00-' + BS + 'u9fff]')
/** Windows 绝对路径判定。 */
const WIN_ABS_RE = new RegExp('^[a-z]:[' + BS + BS + '/]', 'i')
/** POSIX 绝对路径判定。 */
const POSIX_ABS_RE = new RegExp('^' + BS + '/(?!' + BS + '/)')

/** 图谱索引文件路径。 */
export function graphIndexFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-dir-graph', 'index.json')
}

/**
 * 从文本里抠出像路径的片段。
 *
 * 规则（比 dsh-dir-graph 那边更保守）：
 *   - 不含空白、不含中文
 *   - 不是 URL
 *   - 绝对路径（Windows 盘符 / UNC / POSIX 开头）直接收
 *   - 相对路径必须至少两段
 */
export function extractPathHints(text) {
  const out = []
  const source = String(text ?? '')
  const candidates = []

  // 1) 引号里包着的片段最可能是路径
  const quoted = source.match(/["'`]([^"'`]{2,200})["'`]/g) ?? []
  for (const chunk of quoted) {
    candidates.push(chunk.slice(1, -1))
  }

  // 2) 按分隔符切成候选
  for (const piece of source.split(SEPARATOR_RE)) {
    candidates.push(piece)
  }

  for (const candidate of candidates) {
    let value = String(candidate ?? '').trim()
    // 引号包裹的残渣
    value = value.replace(/^["'`]+/, '').replace(/["'`]+$/, '')
    if (!value) continue
    if (value.indexOf(' ') >= 0) continue
    if (URL_RE.test(value)) continue
    if (CN_RE.test(value)) continue
    const looksAbsolute =
      WIN_ABS_RE.test(value) ||
      value.startsWith(BS + BS) ||
      POSIX_ABS_RE.test(value)
    const hasSep = value.indexOf('/') >= 0 || value.indexOf(BS) >= 0
    if (!looksAbsolute && !hasSep) continue
    if (!looksAbsolute) {
      // 相对路径至少两段，且每段不能是纯数字（避免把 10/27 这种日期当路径）
      const segments = value.split('/').filter(Boolean)
      if (segments.length < 2) continue
      if (segments.every((segment) => /^\d+$/.test(segment))) continue
    }
    if (value.length > 200) continue
    out.push(value.split(BS).join('/'))
  }
  return [...new Set(out)]
}

/** 归一化：统一正斜杠、小写。 */
function norm(value) {
  return String(value ?? '')
    .split(BS).join('/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * PERF-4：图谱索引缓存。
 *
 * 索引 ~108KB，每轮召回都要 parse 一次（~0.741ms），而它只在 dir-graph 重建索引
 * 时才变。用 mtime + ctime + 大小做 key。返回的是共享引用 —— 本文件只读它。
 */
let graphIndexCache = null // { file, key, index }

function graphStatKey(file) {
  try {
    const st = statSync(file)
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`
  } catch {
    return ''
  }
}

/** 读图谱索引；失败返回 null。导出是给回归测试验证缓存用的。 */
export function readGraphIndex() {
  const file = graphIndexFile()
  const key = graphStatKey(file)
  if (!key) {
    graphIndexCache = null
    return null
  }
  if (graphIndexCache && graphIndexCache.file === file && graphIndexCache.key === key) {
    return graphIndexCache.index
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.nodes || !parsed.roots) return null
    graphIndexCache = { file, key, index: parsed }
    return parsed
  } catch {
    graphIndexCache = null
    return null
  }
}

/**
 * 找出与给定路径最接近的图谱节点。
 * 先按完整路径匹配，再按相对路径后缀匹配，最后按文件名匹配。
 */
function matchNode(index, hint) {
  const key = norm(hint)
  if (!key) return null
  const nodes = Object.values(index.nodes ?? {})

  // 1) 完整路径
  let fallback = null
  for (const node of nodes) {
    const path = norm(node.path)
    const rel = norm(node.rel)
    if (path && (path === key || path.endsWith('/' + key))) return node
    if (rel && (rel === key || rel.endsWith('/' + key))) {
      // 同一个相对路径可能出现在多个根下，先记一个兜底
      if (!fallback) fallback = node
    }
  }
  if (fallback) return fallback

  // 2) 文件名
  const base = key.split('/').filter(Boolean).pop() ?? ''
  if (base.length >= 3) {
    for (const node of nodes) {
      if (norm(node.name) === base) return node
    }
  }
  return null
}

/**
 * 取节点的邻居：谁引用它、它引用谁、同目录。
 */
function neighborsOf(index, nodeId) {
  const out = []
  const seen = new Set()
  for (const edge of Object.values(index.edges ?? {})) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue
    const otherId = edge.from === nodeId ? edge.to : edge.from
    if (seen.has(otherId)) continue
    seen.add(otherId)
    const other = index.nodes?.[otherId]
    if (!other) continue
    out.push({
      id: otherId,
      path: other.path ?? other.rel ?? otherId,
      name: other.name ?? '',
      kind: other.kind ?? other.type ?? '',
      relation:
        edge.kind === 'references'
          ? (edge.from === nodeId ? '引用了' : '被引用')
          : '同目录',
      rootId: other.root ?? '',
    })
  }
  return out
}

/**
 * 按命中记忆里的路径扩展出相关文件。
 *
 * @param {Array<{entry?: object, item?: object, text?: string}>} hits 召回命中的条目
 * @param {{ limit?: number }} options
 * @returns {{ paths: string[], related: Array<{path,relation,via}> }} 扩展结果
 */
export function expandByPaths(hits, options = {}) {
  const limit = options.limit ?? 6
  const index = readGraphIndex()
  if (!index) return { paths: [], related: [] }

  const paths = []
  const related = []
  const seenPath = new Set()
  const seenNode = new Set()

  for (const hit of hits ?? []) {
    const entry = hit?.entry ?? hit?.item ?? hit
    const text = String(entry?.text ?? hit?.text ?? '')
    if (!text) continue
    for (const hint of extractPathHints(text)) {
      const node = matchNode(index, hint)
      if (!node) continue
      const nodePath = node.path ?? node.rel ?? ''
      if (nodePath && !seenPath.has(nodePath)) {
        seenPath.add(nodePath)
        paths.push(nodePath)
      }
      if (seenNode.has(node.id)) continue
      seenNode.add(node.id)
      for (const neighbor of neighborsOf(index, node.id)) {
        if (related.length >= limit) break
        if (seenPath.has(neighbor.path)) continue
        seenPath.add(neighbor.path)
        related.push({ ...neighbor, via: nodePath || hint })
      }
    }
  }

  return {
    paths: paths.slice(0, limit),
    related: related.slice(0, limit),
  }
}

/**
 * 渲染成注入提示词的一段文字。
 * 没有扩展结果时返回空字符串（调用方直接跳过）。
 */
export function renderPathExpansion(expand) {
  const { paths = [], related = [] } = expand ?? {}
  if (paths.length === 0 && related.length === 0) return ''
  const lines = []
  lines.push('【路径线索】命中记忆里提到的文件在目录图谱里的关联（供快速定位，不是硬约束）：')
  for (const path of paths) {
    lines.push(`- ${path}`)
  }
  for (const item of related) {
    lines.push(`- ${item.path}（${item.relation}${item.via ? ` · 来自 ${item.via}` : ''}）`)
  }
  lines.push('如需继续挖，可用 dir_graph_search / dir_graph_related / dir_graph_path 工具。')
  return lines.join('\n')
}
