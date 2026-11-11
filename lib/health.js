/**
 * 记忆体检（2026-11-11，方案 §5.4）。
 *
 * 目的：不用打开数据库也能回答「现在记忆库健不健康」——
 * 多少条、哪些模块空着、有没有重复、多少条没出处、多久没动过、
 * WAL 是不是该 checkpoint 了。`/status` 与 `/shared-memory check` 共用这一份结果。
 *
 * 这里只读不写：不该因为「看一眼体检」就顺手改库。
 */

/** 同一模块下正文前 60 字相同，就算重复（脱敏可能把不同条目变成同一句）。 */
const DUP_PREFIX = 60

/** 多少天没更新算陈旧。 */
const STALE_DAYS = 90

/** 超过这个条数就提醒该清理了（MAX_ENTRIES 是 2000）。 */
const WARN_TOTAL = 1500

function textOf(entry) {
  return String(entry?.text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * @param {object} input
 * @param {Array} input.entries 扁平库条目
 * @param {object} input.modules 模块配置（用来判断底线是否镜像、哪些模块是空的）
 * @param {number} [input.now]
 * @param {number} [input.walBytes] brain.db-wal 字节数
 * @param {number} [input.dbBytes] brain.db 字节数
 * @param {number} [input.lastWriteAt] meta.entries_updated_at
 */
export function memoryCheck(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries.filter(Boolean) : []
  const modules = input.modules && typeof input.modules === 'object' ? input.modules : {}
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const walBytes = Math.max(0, Number(input.walBytes ?? 0) || 0)
  const dbBytes = Math.max(0, Number(input.dbBytes ?? 0) || 0)

  const byModule = {}
  const scope = { global: 0, workspace: 0, session: 0 }
  const source = { auto: 0, sync: 0, manual: 0, other: 0 }
  const seen = new Map()
  const duplicates = []
  let pinned = 0
  let archived = 0
  let expired = 0
  let noSource = 0
  let stale = 0
  let oldestAt = 0
  let newestAt = 0
  const staleCutoff = now - STALE_DAYS * 24 * 60 * 60 * 1000

  for (const entry of entries) {
    const module = String(entry.module ?? 'unknown')
    byModule[module] = (byModule[module] ?? 0) + 1

    if (entry.scope === 'workspace') scope.workspace += 1
    else if (entry.scope === 'session') scope.session += 1
    else scope.global += 1

    const src = String(entry.source ?? '')
    if (src === 'auto' || src === 'sync' || src === 'manual') source[src] += 1
    else source.other += 1

    if (entry.pinned === true) pinned += 1
    if (entry.archived === true) archived += 1
    if (entry.lifetime === 'temporary' && Number.isFinite(entry.expiresAt) && entry.expiresAt <= now) expired += 1

    // knowledge 缺出处：读过的书没标出处，召回时分不出是哪本。
    if (module === 'knowledge' && !String(entry.sourceRef ?? '').trim()) noSource += 1

    const updatedAt = Number(entry.updatedAt ?? 0) || 0
    if (updatedAt > 0) {
      if (oldestAt === 0 || updatedAt < oldestAt) oldestAt = updatedAt
      if (updatedAt > newestAt) newestAt = updatedAt
      if (updatedAt < staleCutoff && entry.pinned !== true) stale += 1
    }

    const text = textOf(entry)
    if (text) {
      const key = `${module}\u0000${text.slice(0, DUP_PREFIX)}`
      const prev = seen.get(key)
      if (prev) {
        const group = duplicates.find((d) => d.key === key)
        if (group) group.ids.push(String(entry.id ?? ''))
        else duplicates.push({ key, module, text: text.slice(0, DUP_PREFIX), ids: [prev, String(entry.id ?? '')] })
      } else {
        seen.set(key, String(entry.id ?? ''))
      }
    }
  }

  // 底线：模块桶里有、扁平库里没有 = 没镜像过去（召回时按扁平库走，会漏）。
  const bottomBucket = Array.isArray(modules?.bottomline?.items) ? modules.bottomline.items.length : 0
  const bottomFlat = byModule.bottomline ?? 0
  const bottomUnmirrored = Math.max(0, bottomBucket - bottomFlat)

  const emptyModules = ['bottomline', 'cognition', 'emotion', 'instinct', 'knowledge'].filter((key) => {
    if (key === 'bottomline') return bottomBucket === 0 && bottomFlat === 0
    return (byModule[key] ?? 0) === 0 && (modules?.[key]?.items?.length ?? 0) === 0
  })

  const suggestions = []
  if (entries.length >= WARN_TOTAL) {
    suggestions.push({ level: 'warn', text: `记忆已 ${entries.length} 条，接近上限（2000），建议归档一批旧的。` })
  }
  if (bottomUnmirrored > 0) {
    suggestions.push({ level: 'warn', text: `底线有 ${bottomUnmirrored} 条只存在模块桶里、没进扁平库，召回会漏；下次写模块时会自动镜像。` })
  }
  if (noSource > 0) {
    suggestions.push({ level: 'info', text: `有 ${noSource} 条知识没有出处，召回时分不出是哪本书。` })
  }
  if (duplicates.length > 0) {
    suggestions.push({ level: 'info', text: `发现 ${duplicates.length} 组重复条目（同模块同正文），下次写入会自动去重。` })
  }
  if (expired > 0) {
    suggestions.push({ level: 'info', text: `${expired} 条临时记忆已过期，下次召回时会清掉（钉住的不动）。` })
  }
  if (stale > 0) {
    suggestions.push({ level: 'info', text: `${stale} 条超过 ${STALE_DAYS} 天没动过，可以考虑归档。` })
  }
  if (walBytes > dbBytes && walBytes > 0) {
    suggestions.push({ level: 'info', text: `WAL 文件 ${Math.round(walBytes / 1024)}KB，比主库还大，下次写库会 checkpoint。` })
  }
  if (suggestions.length === 0) suggestions.push({ level: 'ok', text: '没发现明显问题。' })

  return {
    at: now,
    total: entries.length,
    byModule,
    pinned,
    archived,
    expired,
    stale,
    staleDays: STALE_DAYS,
    duplicates: duplicates.map((d) => ({ module: d.module, text: d.text, count: d.ids.length })),
    noSource,
    bottomUnmirrored,
    scope,
    source,
    emptyModules,
    oldestAt,
    newestAt,
    lastWriteAt: Number(input.lastWriteAt ?? 0) || 0,
    walBytes,
    dbBytes,
    suggestions,
    // 2026-11-11：顺带把「目录里那些可以清的垃圾」也算出来。只统计，不删。
    junk: junkReport(input.files ?? [], { now }),
  }
}

/**
 * 数据目录里那些「留着没用、删了心疼」的东西：调试探针、时间戳备份、坏文件副本、
 * 归档转存。**只统计**——删不删是老大说了算，插件不替人做主。
 *
 * @param {Array<{name:string,size:number,mtimeMs:number}>} files
 */
export function junkReport(files, { now = Date.now(), staleMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f.name === 'string') : []
  const rules = [
    { kind: 'probe', label: '调试探针', test: (name) => /-probe\.json$/i.test(name) },
    { kind: 'backup', label: '时间戳备份', test: (name) => /\.bak[-.]/i.test(name) },
    { kind: 'broken', label: '坏文件副本', test: (name) => /\.(broken|unreadable)-/i.test(name) },
    { kind: 'archive', label: '归档转存', test: (name) => /^memory-(archive|expired)\.jsonl$/i.test(name) },
  ]
  const groups = []
  for (const rule of rules) {
    const hit = list.filter((f) => rule.test(f.name))
    if (hit.length === 0) continue
    const bytes = hit.reduce((sum, f) => sum + Math.max(0, Number(f.size ?? 0) || 0), 0)
    const oldest = Math.min(...hit.map((f) => Number(f.mtimeMs ?? now) || now))
    groups.push({
      kind: rule.kind,
      label: rule.label,
      count: hit.length,
      bytes,
      oldestAt: oldest,
      stale: now - oldest > staleMs,
      examples: hit.slice(0, 3).map((f) => f.name),
    })
  }
  const totalBytes = groups.reduce((sum, g) => sum + g.bytes, 0)
  return {
    total: groups.reduce((sum, g) => sum + g.count, 0),
    totalBytes,
    groups,
  }
}

/** 一行摘要，给命令行用。 */
export function renderCheckLine(check) {
  if (!check) return '体检没有结果。'
  const parts = [
    `共 ${check.total} 条`,
    `钉住 ${check.pinned}`,
    `过期 ${check.expired}`,
    `陈旧 ${check.stale}`,
    `重复 ${check.duplicates.length} 组`,
    `缺出处 ${check.noSource}`,
  ]
  const warns = check.suggestions.filter((s) => s.level === 'warn').length
  const junkLine = check.junk && check.junk.total > 0
    ? `｜可清理 ${check.junk.total} 个（${(check.junk.totalBytes / 1024 / 1024).toFixed(1)}MB）`
    : ''
  return `${parts.join('｜')}${warns > 0 ? `｜⚠ ${warns} 条提醒` : ''}${junkLine}`
}
