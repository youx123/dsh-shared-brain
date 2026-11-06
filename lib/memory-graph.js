/**
 * 共享大脑 · 记忆图谱（memory-graph.js）
 *
 * 把扁平的记忆条目变成有节点、有边的网络：
 *   - 节点：记忆条目（memory）+ 实体（entity）
 *   - 边：提及 mentions / 共现 cooccur / 取代 supersedes / 标签 tag
 *
 * 三条硬约束（改这个文件时别破坏）：
 *   1. **只读不改记忆正文** —— 图谱是派生数据，删了重建就行。
 *   2. **遗忘只归档不删除** —— 归档只是打标记（archived / archivedAt / archiveReason），
 *      文本仍在库里，可恢复、可同步。真删除要单独授权。
 *   3. **零 LLM 调用也能跑** —— 实体抽取走规则；LLM 抽取是可插拔的 extractor 回调，
 *      默认不接，避免每条记忆都烧一次调用。
 *
 * 纯函数为主，落盘只做 graph.json 一份派生缓存。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brainDir } from './store.js'
import { readGraphFromDb, replaceGraph, graphStats } from './db.js'

export const GRAPH_VERSION = 1

/** 进程内图谱缓存：召回每轮都读，按 mtime+size 命中，避免反复解析几百 KB JSON。 */
const graphCache = new Map()

/** 图谱文件（派生数据，删了会重建）。 */
export function graphFile() {
  return join(brainDir(), 'graph.json')
}

/**
 * 噪声标签黑名单。
 *
 * 实测共享大脑的 163 条记忆里，107 条带 tag，但高频 tag 全是
 * dsh:16 github:12 users:12 json:9 https:7 profile:7 modules:7 这种
 * 「谁写的、从哪儿同步来的」痕迹，不是语义实体。拿它们当节点，
 * 图会变成一张全是 dsh / json / github 的废网。
 */
// 当"实体"没有语义价值的词：文件后缀、搜索引擎、常见缩写。
// 不放进 NOISE_TAGS 是因为那边管的是 tag，语义不同、以后可能分开调。
const NOISE_ENTITY = new Set([
  'gif', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'svg', 'ico',
  'mp3', 'mp4', 'webm', 'wav', 'ogg', 'mov', 'avi',
  'pdf', 'zip', 'rar', 'tar', 'gz', 'exe', 'msi', 'dll',
  'yml', 'yaml', 'toml', 'ini', 'csv', 'xml', 'log', 'bak', 'tmp',
  'bing', 'google', 'baidu', 'qq', 'www', 'http', 'https',
])

const NOISE_TAGS = new Set([
  'dsh', 'json', 'https', 'http', 'www', 'com', 'cn', 'org', 'net', 'html', 'css', 'js', 'ts',
  'github', 'users', 'user', 'profile', 'modules', 'module', 'status', 'desktop', 'napcat',
  'youx123', 'src', 'lib', 'dist', 'node', 'node_modules', 'api', 'txt', 'md', 'npm', 'pnpm',
  'windows', 'linux', 'macos', 'true', 'false', 'null', 'undefined', 'yes', 'no', 'test',
  'dev', 'app', 'main', 'index', 'config', 'default', 'none', 'todo', 'fixme',
])

/** 中文虚词/泛词：出现得太泛，不该成为实词。 */
const STOP_CN = new Set([
  '这个', '那个', '什么', '怎么', '为什么', '可以', '需要', '应该', '已经', '还是', '就是',
  '不是', '没有', '一个', '一些', '这样', '那样', '时候', '现在', '之后', '之前', '然后',
  '但是', '所以', '因为', '如果', '或者', '而且', '我们', '你们', '他们', '它们', '自己',
  '老大', '东西', '事情', '问题', '感觉', '意思', '有点', '比较', '非常', '真的',
])

/** 英文停用词。 */
const STOP_EN = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'were', 'are',
  'you', 'your', 'they', 'their', 'them', 'its', 'his', 'her', 'she', 'him', 'not', 'but',
  'can', 'will', 'would', 'should', 'could', 'been', 'being', 'into', 'out', 'off', 'over',
  'all', 'any', 'some', 'each', 'than', 'then', 'too', 'very', 'just', 'now', 'here',
])

/**
 * 判断一个 tag 是不是纯噪声。
 * @param {string} tag
 */
export function isNoiseTag(tag) {
  const t = String(tag ?? '').trim().toLowerCase()
  if (!t) return true
  if (NOISE_TAGS.has(t)) return true
  // 「key:value」型：前缀是噪声就整条丢；前缀有意义（项目/仓库/人）就留 value
  const colon = t.indexOf(':')
  if (colon > 0) {
    const prefix = t.slice(0, colon)
    const value = t.slice(colon + 1)
    if (!value) return true
    if (NOISE_TAGS.has(prefix)) return true
    return false
  }
  return false
}

/** 去掉 tag 前缀，只留语义部分。 */
function tagValue(tag) {
  const t = String(tag ?? '').trim()
  const colon = t.indexOf(':')
  return colon > 0 ? t.slice(colon + 1) : t
}

/**
 * 抽取文本里的实词袋。
 *
 * 中文没有分词器，这里用 2-gram 滑窗 + 全局文档频次过滤：
 * 2-gram 天然把「老大最喜欢你」切成「老大/da最/喜欢/欢你」，共现仍然有效；
 * 而出现得太普遍的 gram（老大、什么）在第二遍会被 df 过滤掉。
 *
 * @param {string} text
 * @returns {string[]} 实词列表（可能有重复，调用方自己 Set 化）
 */
export function rawTerms(text) {
  const s = String(text ?? '').toLowerCase()
  const terms = []
  // 英文 / 数字 / 路径片段
  const latin = s.match(/[a-z0-9][a-z0-9_./-]{2,}/g)
  if (latin) {
    for (const w of latin) {
      if (STOP_EN.has(w)) continue
      if (NOISE_TAGS.has(w)) continue
      terms.push(w)
    }
  }
  // 中文 2-gram
  const cn = s.match(/[\u4e00-\u9fa5]+/g)
  if (cn) {
    for (const run of cn) {
      if (run.length === 1) {
        if (!STOP_CN.has(run)) terms.push(run)
        continue
      }
      for (let i = 0; i + 2 <= run.length; i++) {
        const g = run.slice(i, i + 2)
        if (STOP_CN.has(g)) continue
        terms.push(g)
      }
    }
  }
  return terms
}

/**
 * 构建实词袋（带全局 df 过滤）。
 *
 * @param {Array<object>} entries 全量条目
 * @param {Array<string>}[] raw 每条的 rawTerms 结果
 * @param {{ minDf?: number }} options
 * @returns {Set<string>[]} 每条一个词袋
 */
function buildBags(entries, raw, options = {}) {
  const df = new Map()
  for (const list of raw) {
    for (const term of new Set(list)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  // 太普遍的词没有区分度：要么出现在很多条里，要么就一两条（拼写噪声）
  const maxDf = Math.max(6, Math.floor(entries.length * 0.28))
  const minDf = Math.max(1, options.minDf ?? 1)
  return raw.map((list) => {
    const bag = new Set()
    for (const term of list) {
      const count = df.get(term) ?? 0
      if (count < minDf || count > maxDf) continue
      bag.add(term)
    }
    return bag
  })
}

/** Jaccard 相似度。 */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const term of small) if (large.has(term)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * 建图。
 *
 * @param {Array<object>} entries 记忆条目（normalizeStore 之后的形状）
 * @param {{
 *   entityExtractor?: null | ((entry: object) => string[]),
 *   cooccurThreshold?: number,
 *   maxCooccurNeighbors?: number,
 *   includeArchived?: boolean,
 *   now?: number,
 * }} options
 * @returns {{ version: number, nodes: object[], edges: object[], stats: object, updatedAt: number }}
 */
/**
 * 中文正文关键词：没有分词器，就用「被多少条记忆共用」把碎片筛掉。
 *
 * 为什么需要这条：原来实体只来自 tag 和 target。tag 一旦被滤掉噪声（都是
 * dsh/json/https 这类），实体就所剩无几，图谱从一千多条边塌成十几条，
 * 顺边召回自然带不出邻居。正文才是记忆真正的共同点。
 */
/**
 * 粘着字黑名单：2-gram 是无分词切出来的，必然跨词边界。
 * 「老大跟桌宠说」会切出「大跟 / 跟桌 / 宠说」，这些碎片度数很高却很没用。
 * 它们共同的特征是含功能字（跟、说、了、个…）—— 含一个就整词丢掉。
 */
const GLUE_CHARS = new Set(
  '的跟说了着过吗呢吧啊呀哦嘛们个这那就都也还把被让给对从向和与或而则即其之此很太更最不没要会能可是在有'.split(
    '',
  ),
)
const STOP_TERMS = new Set([
  '的了', '的是', '是在', '是我', '是他', '是她', '我们', '你们', '他们', '这个', '那个',
  '什么', '怎么', '因为', '所以', '但是', '如果', '就是', '可以', '需要', '已经', '还是',
  '没有', '不是', '一个', '一些', '这些', '那些', '时候', '现在', '之后', '之前', '以后',
  '以前', '一直', '一定', '应该', '可能', '或者', '而且', '对于', '关于', '通过', '由于',
  '虽然', '然而', '因此', '于是', '以及', '其中', '之一', '这样', '那样', '如何', '为何',
  '是否', '以上', '以下', '其他', '其它', '方式', '方法', '东西', '事情', '地方', '情况',
  '问题', '进行', '表示', '认为', '属于', '成为', '作为', '相关', '相应', '各种', '每个',
  '所有', '非常', '比较', '相当', '十分', '特别', '尤其', '例如', '比如', '包括', '包含',
  '注意', '记得', '要求', '支持', '提供', '实现', '完成', '开始', '结束', '出现', '发生',
  '存在', '同时', '然后', '而且', '并且', '只有', '只要', '不过', '还有', '一次', '一样',
])

/** 抽 2~3 字的中文词（不加分词，靠共现频次过滤碎片） */
export function contentTerms(text) {
  const out = new Set()
  // 脱敏标记是系统加的，不是内容，先剥掉免得切出「已脱」这种实体
  const clean = String(text ?? '').replace(/\[已脱敏\]/g, ' ')
  const chunks = clean.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
  for (const chunk of chunks) {
    for (let n = 2; n <= 3; n += 1) {
      for (let i = 0; i + n <= chunk.length; i += 1) {
        const term = chunk.slice(i, i + n)
        if (STOP_TERMS.has(term)) continue
        // 含粘着字的一律当碎片丢掉
        let glue = false
        for (const ch of term) {
          if (GLUE_CHARS.has(ch)) {
            glue = true
            break
          }
        }
        if (glue) continue
        out.add(term)
      }
    }
  }
  return out
}

export function buildGraph(entries, options = {}) {
  const now = options.now ?? Date.now()
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e.text === 'string' && e.text.trim(),
  )
  const includeArchived = options.includeArchived === true
  const active = includeArchived ? list : list.filter((e) => e.archived !== true)

  const nodes = []
  const edges = []
  const nodeIndex = new Map()
  const entityIndex = new Map() // name → entity node

  const addMemoryNode = (entry) => {
    if (nodeIndex.has(entry.id)) return nodeIndex.get(entry.id)
    const node = {
      id: entry.id,
      type: 'memory',
      label: String(entry.text).replace(/\s+/g, ' ').slice(0, 60),
      module: entry.module ?? 'cognition',
      weight: Number.isFinite(entry.weight) ? entry.weight : 0.5,
      hits: Number.isFinite(entry.hits) ? entry.hits : 0,
      lifetime: entry.lifetime ?? 'permanent',
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : now,
      archived: entry.archived === true,
      degree: 0,
    }
    nodes.push(node)
    nodeIndex.set(node.id, node)
    return node
  }

  const addEntityNode = (name) => {
    const clean = String(name ?? '').trim()
    if (!clean || clean.length > 40) return null
    const key = clean.toLowerCase()
    if (NOISE_ENTITY.has(key)) return null
    if (/^[0-9._/-]+$/.test(key)) return null
    if (entityIndex.has(key)) return entityIndex.get(key)
    const node = {
      id: `ent:${key}`,
      type: 'entity',
      label: clean,
      count: 0,
      degree: 0,
    }
    nodes.push(node)
    entityIndex.set(key, node)
    nodeIndex.set(node.id, node)
    return node
  }

  const link = (from, to, kind, weight) => {
    if (!from || !to || from.id === to.id) return
    edges.push({ from: from.id, to: to.id, kind, weight: Number(weight.toFixed(4)) })
    from.degree++
    to.degree++
  }

  for (const entry of active) addMemoryNode(entry)

  // ---- 边 1：实体提及（mentions） ----------------------------------------
  // 三个来源：显式 target 字段、规则 extractor 返回、干净的 tag
  for (const entry of active) {
    const memNode = nodeIndex.get(entry.id)
    if (!memNode) continue
    const names = new Set()
    if (typeof entry.target === 'string' && entry.target.trim()) names.add(entry.target.trim())
    if (Array.isArray(entry.tags)) {
      for (const tag of entry.tags) {
        if (isNoiseTag(tag)) continue
        const value = tagValue(tag)
        if (value) names.add(value)
      }
    }
    if (typeof options.entityExtractor === 'function') {
      try {
        const extra = options.entityExtractor(entry)
        if (Array.isArray(extra)) for (const name of extra) if (name) names.add(String(name).trim())
      } catch {
        /* extractor 失败不该拖垮建图 */
      }
    }
    for (const name of names) {
      const entNode = addEntityNode(name)
      if (!entNode) continue
      entNode.count++
      link(memNode, entNode, 'mentions', 1)
    }
  }

  // ---- 边 1b：正文关键词（mentions，低权重） ------------------------------
  //
  // 只保留「至少两条记忆共用」的词：只出现过一次的多半是这句话独有的碎片，
  // 连不成网。上限按条目总数自适应，避免"的/是/在"这类超高频词把图糊死。
  if (options.contentEntities !== false) {
    const df = new Map()
    const perEntry = new Map()
    for (const entry of active) {
      const terms = contentTerms(entry.text)
      perEntry.set(entry.id, terms)
      for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1)
    }
    const maxDf = Math.max(3, Math.min(24, Math.ceil(active.length * 0.05)))
    const minDf = options.contentMinDf ?? 2
    // 候选实体总数封顶：按 df 降序留最"概念化"的那批
    const maxEntities = options.contentMaxEntities ?? 4000
    const ranked = [...df.entries()]
      .filter(([term, n]) => n >= minDf && n <= maxDf && term.length >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxEntities)
    const allowed = new Set(ranked.map(([term]) => term))
    const weight = Number(options.contentEntityWeight ?? 0.45)
    const perMemory = Number(options.contentPerMemory ?? 6)

    for (const entry of active) {
      const memNode = nodeIndex.get(entry.id)
      if (!memNode) continue
      const terms = perEntry.get(entry.id)
      if (!terms) continue
      // 同一句话里越"稀有"的词越能代表它，按 df 升序取前 N
      const picked = [...terms]
        .filter((t) => allowed.has(t))
        .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0))
        .slice(0, perMemory)
      for (const term of picked) {
        const entNode = addEntityNode(term)
        if (!entNode) continue
        entNode.count++
        link(memNode, entNode, 'mentions', weight)
      }
    }
  }

  // ---- 边 2：取代（supersedes） ------------------------------------------
  for (const entry of active) {
    if (!entry.supersedes) continue
    const memNode = nodeIndex.get(entry.id)
    const other = nodeIndex.get(entry.supersedes)
    if (memNode && other) link(memNode, other, 'supersedes', 1)
  }

  // ---- 边 3：共现（cooccur） ---------------------------------------------
  // 记忆 ↔ 记忆：共享实词够多就连；记忆 ↔ 实体：同一实体天然连
  const threshold = options.cooccurThreshold ?? 0.34
  const maxNeighbors = options.maxCooccurNeighbors ?? 6
  const raw = active.map((entry) => rawTerms(entry.text))
  const bags = buildBags(active, raw)
  for (let i = 0; i < active.length; i++) {
    const candidates = []
    for (let j = i + 1; j < active.length; j++) {
      const sim = jaccard(bags[i], bags[j])
      if (sim >= threshold) candidates.push({ j, sim })
    }
    candidates.sort((a, b) => b.sim - a.sim)
    const memNode = nodeIndex.get(active[i].id)
    for (const { j, sim } of candidates.slice(0, maxNeighbors)) {
      const otherNode = nodeIndex.get(active[j].id)
      link(memNode, otherNode, 'cooccur', sim)
    }
  }

  // 实体 ↔ 实体：被同一条记忆一起提到
  const byEntry = new Map()
  for (const edge of edges) {
    if (edge.kind !== 'mentions') continue
    const list = byEntry.get(edge.from) ?? []
    list.push(edge.to)
    byEntry.set(edge.from, list)
  }
  for (const [memId, entIds] of byEntry) {
    if (entIds.length < 2) continue
    const memNode = nodeIndex.get(memId)
    for (let i = 0; i < entIds.length; i++) {
      for (let j = i + 1; j < entIds.length; j++) {
        const a = nodeIndex.get(entIds[i])
        const b = nodeIndex.get(entIds[j])
        if (a && b) link(a, b, 'cooccur', 0.4)
      }
    }
    void memNode
  }

  // 邻接表（顺边召回要用）
  const adjacency = new Map()
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, [])
    adjacency.get(edge.from).push(edge)
    adjacency.get(edge.to).push(edge)
  }

  return {
    version: GRAPH_VERSION,
    nodes,
    edges,
    adjacency: [...adjacency.entries()].map(([id, list]) => [id, list]),
    stats: {
      memories: active.length,
      entities: entityIndex.size,
      edges: edges.length,
      archived: list.length - active.length,
      // 最新一条记忆的 updatedAt：调用方用它判断缓存的图谱是不是过期了
      // （条数不变但内容更新过时，光比条数会漏掉）。
      newest: active.reduce((max, e) => Math.max(max, Number(e.updatedAt) || 0), 0),
      builtAt: now,
    },
    updatedAt: now,
  }
}

/**
 * 从已有图谱恢复邻接表（图谱从磁盘读回来时用）。
 * @param {object} graph
 */
export function withAdjacency(graph) {
  if (!graph || typeof graph !== 'object') return graph
  if (Array.isArray(graph.adjacency) && graph.adjacency.length) return graph
  const adjacency = new Map()
  for (const edge of graph?.edges ?? []) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, [])
    adjacency.get(edge.from).push(edge)
    adjacency.get(edge.to).push(edge)
  }
  graph.adjacency = [...adjacency.entries()]
  return graph
}

/**
 * 顺边召回：命中一条记忆后，把它在图上的邻居也带回来。
 *
 * 只带 memory 邻居（实体不进提示词，那是噪音）；实体的关系另行返回，
 * 让调用方决定要不要在 UI 上画出来。
 *
 * @param {Array<{entry: object, score: number}>} hits 原召回结果
 * @param {object} graph 图谱（要有 adjacency）
 * @param {Map<string, object>|object} entryIndex id → entry
 * @param {{ limit?: number, decay?: number, minEdgeWeight?: number }} options
 * @returns {{ neighbors: Array<object>, entities: Array<object> }}
 */
export function expandWithNeighbors(hits, graph, entryIndex, options = {}) {
  const limit = options.limit ?? 3
  const decay = options.decay ?? 0.55
  const minEdgeWeight = options.minEdgeWeight ?? 0.3
  const index = entryIndex instanceof Map ? entryIndex : new Map(Object.entries(entryIndex ?? {}))
  const adjacency = new Map(graph?.adjacency ?? [])
  const nodeById = new Map((graph?.nodes ?? []).map((n) => [n.id, n]))
  const hitIds = new Set((hits ?? []).map((h) => h?.entry?.id).filter(Boolean))
  const hitScore = new Map((hits ?? []).map((h) => [h?.entry?.id, h?.score ?? 0]))

  const candidates = []
  const entityHits = new Map()

  for (const hit of hits ?? []) {
    const id = hit?.entry?.id
    if (!id) continue
    const edges = adjacency.get(id) ?? []
    for (const edge of edges) {
      if (edge.weight < minEdgeWeight) continue
      const otherId = edge.from === id ? edge.to : edge.from
      const other = nodeById.get(otherId)
      if (!other) continue
      if (other.type === 'entity') {
        const prev = entityHits.get(otherId)
        if (!prev || prev.weight < edge.weight) {
          entityHits.set(otherId, {
            id: otherId,
            label: other.label,
            weight: edge.weight,
            kind: edge.kind,
            sourceId: id,
          })
        }
        continue
      }
      if (other.type !== 'memory') continue
      if (hitIds.has(otherId)) continue
      const entry = index.get(otherId)
      if (!entry) continue
      const base = hitScore.get(id) ?? 0
      const score = base * decay * edge.weight
      const prev = candidates.find((c) => c.entry.id === otherId)
      if (prev) {
        if (score > prev.score) {
          prev.score = score
          prev.via = otherId
          prev.viaKind = edge.kind
        }
      } else {
        candidates.push({ entry, score, via: otherId, viaKind: edge.kind })
      }
    }
  }

  // 二跳：命中 → 共用实体 → 其它记忆。
  // 文本相似度门槛太严，记忆之间常常连不上；两段记忆提到同一个实体，
  // 基本就是同一件事的不同侧面，这条路径比降门槛可靠得多。
  const bridgeWeight = options.bridgeWeight ?? 0.6
  const hubDamping = options.hubDamping !== false
  const maxEntityDegree = options.maxEntityDegree ?? 0
  const maxPerEntity = options.maxPerEntity ?? 2
  for (const [entityId, info] of entityHits) {
    const edges = adjacency.get(entityId) ?? []
    // 枢纽实体（被大量记忆共用的词，比如「表情」）拉进来的关系大多不相关：
    // 按 1/sqrt(度数) 压权重；度数超过 maxEntityDegree（可选，默认不限）就不桥。
    const degree = edges.filter((e) => e.kind === 'mentions').length
    if (maxEntityDegree > 0 && degree > maxEntityDegree) continue
    const damping = hubDamping ? 1 / Math.sqrt(Math.max(1, degree)) : 1
    let taken = 0
    for (const edge of edges) {
      if (edge.kind !== 'mentions') continue
      if (edge.weight < minEdgeWeight) continue
      const otherId = edge.from === entityId ? edge.to : edge.from
      if (otherId === entityId) continue
      if (hitIds.has(otherId)) continue
      const other = nodeById.get(otherId)
      if (!other || other.type !== 'memory') continue
      const entry = index.get(otherId)
      if (!entry) continue
      const base = hitScore.get(info.sourceId) ?? 0
      if (!base) continue
      // 两跳各衰减一次，再乘桥梁系数 —— 保证永远排在直接邻居后面
      // 两跳各衰减一次，再乘桥梁系数与枢纽阻尼 —— 保证永远排在直接邻居后面
      const score = base * decay * decay * edge.weight * bridgeWeight * damping
      const prev = candidates.find((c) => c.entry.id === otherId)
      if (prev) {
        if (score > prev.score) {
          prev.score = score
          prev.via = entityId
          prev.viaKind = 'entity'
        }
      } else {
        // 同一实体最多带 maxPerEntity 条，免得一个枢纽词占满全部邻居名额
        if (taken >= maxPerEntity) break
        taken += 1
        candidates.push({
          entry,
          score,
          via: entityId,
          viaKind: 'entity',
          viaEntity: info.label,
        })
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return {
    neighbors: candidates.slice(0, limit),
    entities: [...entityHits.values()].sort((a, b) => b.weight - a.weight).slice(0, limit),
  }
}

/**
 * 归档候选：够久没人命中、图上也几乎没人理、还不是 pinned 的认知类记忆。
 *
 * 判据全部可调，且**只标候选**，真正打标记要显式调 markArchived。
 *
 * @param {Array<object>} entries
 * @param {object} graph
 * @param {{
 *   now?: number, minAgeDays?: number, strongMinAgeDays?: number,
 *   maxHits?: number, maxDegree?: number, modules?: string[],
 * }} options
 */
export function archiveCandidates(entries, graph, options = {}) {
  const now = options.now ?? Date.now()
  const minAgeDays = options.minAgeDays ?? 90
  const strongMinAgeDays = options.strongMinAgeDays ?? 180
  const maxHits = options.maxHits ?? 1
  const maxDegree = options.maxDegree ?? 1
  const modules = options.modules ?? ['cognition']
  const nodeById = new Map((graph?.nodes ?? []).map((n) => [n.id, n]))

  const out = []
  for (const entry of entries ?? []) {
    if (!entry || entry.archived === true) continue
    if (entry.pinned === true) continue
    // 知识永不进归档候选（2026-11-06）：读过的东西不该因为"好久没提"就被淘汰。
    // 默认 modules 里本来就没有 knowledge，这里再挡一道 —— 防止有人把
    // modules 传成包含 knowledge 的值，把这条底线绕过去。
    if (entry.module === 'knowledge') continue
    if (!modules.includes(entry.module ?? 'cognition')) continue
    const hits = Number.isFinite(entry.hits) ? entry.hits : 0
    if (hits > maxHits) continue
    const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : now
    const ageDays = Math.max(0, (now - updatedAt) / 86_400_000)
    if (ageDays < minAgeDays) continue
    const node = nodeById.get(entry.id)
    const degree = node?.degree ?? 0
    const isolated = degree === 0
    if (degree > maxDegree) continue
    const tier = isolated && ageDays >= strongMinAgeDays && hits === 0 ? 'strong' : 'normal'
    out.push({
      id: entry.id,
      text: String(entry.text ?? '').slice(0, 120),
      module: entry.module,
      ageDays: Math.round(ageDays),
      hits,
      degree,
      tier,
      reason: isolated
        ? `图上孤立（0 邻居）· ${Math.round(ageDays)} 天没更新 · ${hits} 次命中`
        : `${degree} 个弱邻居 · ${Math.round(ageDays)} 天没更新 · ${hits} 次命中`,
    })
  }
  out.sort((a, b) => (a.tier === b.tier ? b.ageDays - a.ageDays : a.tier === 'strong' ? -1 : 1))
  return out
}

/**
 * 打归档标记 —— **不删除任何文本**，只标记，可一键恢复。
 *
 * @param {Array<object>} entries
 * @param {Iterable<string>} ids
 * @param {string} reason
 * @param {number} now
 * @returns {{ entries: Array<object>, changed: number }}
 */
export function markArchived(entries, ids, reason = 'graph-isolated', now = Date.now()) {
  const idSet = new Set(ids ?? [])
  let changed = 0
  const next = (entries ?? []).map((entry) => {
    if (!entry || !idSet.has(entry.id)) return entry
    if (entry.archived === true) return entry
    changed++
    return { ...entry, archived: true, archivedAt: now, archiveReason: reason }
  })
  return { entries: next, changed }
}

/** 取消归档标记（恢复）。 */
export function unmarkArchived(entries, ids, now = Date.now()) {
  const idSet = new Set(ids ?? [])
  let changed = 0
  const next = (entries ?? []).map((entry) => {
    if (!entry || !idSet.has(entry.id)) return entry
    if (entry.archived !== true) return entry
    changed++
    const restored = { ...entry }
    delete restored.archived
    delete restored.archivedAt
    delete restored.archiveReason
    void now
    return restored
  })
  return { entries: next, changed }
}

/**
 * 读图谱（派生缓存，坏掉就当没有）。
 * @param {string} file
 */
export function readGraph(file = graphFile(), options = {}) {
  // 表优先（2026-11-06）：图谱是派生物，存表后不必解析整个 JSON。
  // 表空（还没迁移 / 别的地方写了 JSON）就回退文件，两边都能读。
  try {
    // options.source === 'file' 时跳过表：那是"我就是要看这个文件"的场景（测试、比对、排障）。
    if (options.source !== 'file' && graphStats().nodes > 0) {
      const cached = graphCache.get('__db__')
      const stamp = `${graphStats().nodes}:${graphStats().edges}`
      if (cached && cached.stamp === stamp) return cached.value
      const fromDb = readGraphFromDb()
      if (fromDb && (fromDb.nodes?.length ?? 0) > 0) {
        const value = withAdjacency(fromDb)
        graphCache.set('__db__', { stamp, value })
        return value
      }
    }
  } catch (error) {
    console.warn('[dsh-shared-brain] 图谱读表失败，退回 graph.json：' + String(error?.message ?? error))
  }

  try {
    const stat = statSync(file)
    const cached = graphCache.get(file)
    // 图谱是每轮召回都要读的派生物，几十万字节：按 mtime+size 命中就直接复用，
    // 放过 JSON.parse（实测 3.5ms/次，一场长对话要读上百次）。
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || raw.version !== GRAPH_VERSION) return null
    const value = withAdjacency(raw)
    graphCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    return value
  } catch {
    return null
  }
}

/**
 * 写图谱（原子写）。
 * @param {object} graph
 * @param {string} file
 */
export function writeGraph(graph, file = graphFile()) {
  const dir = join(file, '..')
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const payload = { ...graph, updatedAt: Date.now() }

  // 表是权威（增量查邻居、单条更新都靠它），JSON 留快照供人工查看与降级。
  try {
    replaceGraph(payload.nodes ?? [], payload.edges ?? [])
    graphCache.delete('__db__')
  } catch (error) {
    console.warn('[dsh-shared-brain] 图谱写表失败，只留了 graph.json：' + String(error?.message ?? error))
  }

  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, file)
  // 刚写完的图直接进缓存，省掉「写盘→马上又读回来解析一遍」
  try {
    const stat = statSync(file)
    graphCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value: withAdjacency(payload) })
  } catch {
    graphCache.delete(file)
  }
  return payload
}
