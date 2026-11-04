#!/usr/bin/env node
/**
 * 0.10.1 修复批次 D：数据正确性三项
 *
 * P1-5 删除传播（删除复活）：
 *   remote-sync.js 里模块与人设的删除检测写成了
 *     detectDeletions(goneModuleIds.map((id) => ({ id })), goneModuleIds, now, 'module')
 *   —— 把「待删 id 列表」同时当成 localEntries 和 lastSeenIds 传进去，
 *   于是交集全中、**恒返回 {}**。所以模块条目/人设在别的机器上删了，
 *   下次同步又会被推回来（真实 sync.json 里 26 个墓碑全是 entry，
 *   module=0、persona=0 就是这个原因）。
 *   正确写法：detectDeletions([], goneIds, now, 'module')。
 *
 *   ⚠️ 耦合坑：修的时候**必须同时**给模块路径补 lastSyncAt > 0 守卫。
 *   人设路径本来就有（:717-719），模块路径没有 ——
 *   补上之前，一台**从没同步过**的新机器第一次同步时，
 *   会把远端所有模块条目都判成「本机没有 = 已删除」→ 远端被清空。
 *
 * P1-6 本机态误同步三处：
 *   ① mergePersona 把本机的 bySession（会话→人设绑定）推上云
 *      → 拆分：合并结果不带 bySession，本机的留在本地
 *      → syncBoundary 的 localOnly 清单补一条「会话 → 人设的绑定」
 *   ② mergeModules 用 sanitizeModules 处理**本地**那份，
 *      而 sanitizeModules 会把 agentive.sessionIds 清空 → 「限定自动互动到指定会话」
 *      这个设置被静默清掉还落盘了
 *      → 拆分：sanitizeModules 只用于**推送前**，本地那份只清会话级条目
 *   ③ syncableEntry 只过滤 scope==='session'，不碰 cwd / sessionId
 *      → 127 条里有 75 条带着绝对路径（含 Windows 用户名）和 sessionId 上了云
 *      → 推送时剔除这两个字段（本地留着，跨机没有意义）
 *
 * P1-7 source 双写不一致：
 *   cross-sync.js 无条件 entry.source = 'sync'，把手动加的（manual）冲掉了；
 *   实测 128 条记忆里 manual=0 → 「有待办就一定要说」这条硬规则永远命中零条。
 *   → 改成「只有非 manual 的才改成 sync」；
 *   → pendingHintsOf 放宽到 manual 或 sync（老大亲口说的 + 同步过来的承诺）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'

function patchText(file, from, to, { optional = false } = {}) {
  const p = join(LIB, file)
  const src = readFileSync(p, 'utf8')
  const count = src.split(from).length - 1
  if (count === 0) {
    if (optional) {
      console.log(`[skip] ${file}: 锚点不存在（可选）`)
      return
    }
    throw new Error(`${file}: 找不到锚点 ${JSON.stringify(from.slice(0, 110))}`)
  }
  if (count > 1) throw new Error(`${file}: 锚点出现 ${count} 次，不唯一`)
  writeFileSync(p, src.replace(from, to), 'utf8')
  console.log(`[ok] ${file}`)
}

/* ================================================================== */
/* P1-5 删除传播                                                       */
/* ================================================================== */

// ① 模块路径：补 lastSyncAt 守卫 + 改对 detectDeletions 调用
patchText(
  'remote-sync.js',
  `    const goneModuleIds = remoteModuleItems.filter((id) => !localModuleItems.has(id))
    const moduleDeletions = detectDeletions(
      goneModuleIds.map((id) => ({ id })),
      goneModuleIds,
      now,
      'module',
    )`,
  `    // 2026-11-04（P1-5 审计）：删除检测写错了 —— 把「待删 id 列表」同时当成
    // localEntries 和 lastSeenIds 传进 detectDeletions，交集全中 → **恒返回 {}**。
    // 所以模块条目在别的机器上删掉后，下次同步又被推回来。
    //
    // ⚠️ 而且这条路径**必须**有 lastSyncAt 守卫（人设路径本来就有）：
    // 一台从没同步过的新机器，第一次同步时本机当然没有任何模块条目，
    // 没有守卫就会把远端全部模块条目判成「已删除」→ 远端被清空。
    const goneModuleIds = Number(config.lastSyncAt) > 0
      ? remoteModuleItems.filter((id) => !localModuleItems.has(id))
      : []
    const moduleDeletions = detectDeletions([], goneModuleIds, now, 'module')`,
)

// ② 人设路径：同样把 detectDeletions 调用改对（守卫它本来就有）
patchText(
  'remote-sync.js',
  `    const personaDeletions = detectDeletions(
      gonePersonaIds.map((id) => ({ id })),
      gonePersonaIds,
      now,
      'persona',
    )`,
  `    // 2026-11-04（P1-5 审计）：同模块路径 —— 原来恒返回 {}，删除的人设会复活。
    const personaDeletions = detectDeletions([], gonePersonaIds, now, 'persona')`,
)

/* ================================================================== */
/* P1-6 本机态误同步                                                  */
/* ================================================================== */

// ① mergePersona：返回结果不带 bySession
patchText(
  'remote-sync.js',
  `  // 本机的会话级映射原样保留（远端来的一律不认）
  const bySession = local.bySession && typeof local.bySession === 'object' ? { ...local.bySession } : {}

  return {
    version: 1,
    current,
    currentAt: Math.max(localStamp, remoteStamp),
    personas: [...byId.values()].sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0)),
    bySession,
    updatedAt: Math.max(localAt, remoteAt),
    mergeStats: { added, updated, dropped, total: byId.size },
  }`,
  `  return {
    version: 1,
    current,
    currentAt: Math.max(localStamp, remoteStamp),
    personas: [...byId.values()].sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0)),
    // 2026-11-04（P1-6 审计）：**不带 bySession**。
    // 会话 → 人设的绑定是本机的事（别的机器上没有这些会话），
    // 以前它跟着合并结果一起写进远端 persona.json → 本机布局泄露到云上，
    // 而且远端回来时又会把本机的绑定覆盖掉。
    // 本机的 bySession 由 syncOnce 落地时单独保留（见 writePersonaStore 那行）。
    updatedAt: Math.max(localAt, remoteAt),
    mergeStats: { added, updated, dropped, total: byId.size },
  }`,
)

// syncOnce：落地时把本机 bySession 合并回去
patchText(
  'remote-sync.js',
  `    const nextStore = { ...local, entries: mergedMemory.entries, updatedAt: now }
    writeStore(nextStore)
    writePersonaStore(personaNext)`,
  `    const nextStore = { ...local, entries: mergedMemory.entries, updatedAt: now }
    writeStore(nextStore)
    // 2026-11-04（P1-6 审计）：本机的「会话 → 人设」绑定要留住。
    // mergePersona 不再返回 bySession（那是要推给远端的形状），
    // 所以在这里从本地那份取回来补上。
    writePersonaStore({ ...personaNext, bySession: personaLocal?.bySession ?? {} })`,
)

// syncBoundary：localOnly 补一条
patchText(
  'remote-sync.js',
  `      { key: 'emoji-assets', label: '表情素材', detail: '内置表情包随插件走，不进仓库' },`,
  `      { key: 'emoji-assets', label: '表情素材', detail: '内置表情包随插件走，不进仓库' },
      { key: 'persona-by-session', label: '会话里用哪个人设', detail: '每个会话各自选的人设是本机的安排，不跟着走' },`,
)

// ② sanitizeModules：拆成「只清会话级条目」和「推送前再清 sessionIds」
patchText(
  'remote-sync.js',
  `export function sanitizeModules(modules) {
  const normalized = normalizeModules(modules ?? {})
  for (const module of Object.values(normalized)) {
    if (!module || typeof module !== 'object') continue
    if (Array.isArray(module.items)) module.items = module.items.filter((item) => item?.scope !== 'session')
  }
  if (normalized.agentive) normalized.agentive.sessionIds = []
  return normalized
}`,
  `/**
 * 清掉**不该跨机**的模块内容：会话级条目 + 会话 id 列表。
 *
 * 2026-11-04（P1-6 审计）：以前这个函数被用在**本地**那份上，
 * 于是 agentive.sessionIds（"限定自动互动到指定会话"）被清空并落盘 ——
 * 用户的设置被静默抹掉。现在拆成两个：
 *   - stripSessionItems：只清会话级条目（本地合并时用，不动 sessionIds）
 *   - sanitizeModules：上面那个 + 再清 sessionIds（**推送前**用）
 */
export function stripSessionItems(modules) {
  const normalized = normalizeModules(modules ?? {})
  for (const module of Object.values(normalized)) {
    if (!module || typeof module !== 'object') continue
    if (Array.isArray(module.items)) module.items = module.items.filter((item) => item?.scope !== 'session')
  }
  return normalized
}

export function sanitizeModules(modules) {
  const normalized = stripSessionItems(modules)
  if (normalized.agentive) normalized.agentive.sessionIds = []
  return normalized
}`,
)

// mergeModules：本地那份只用 stripSessionItems
patchText(
  'remote-sync.js',
  `  const localMods = sanitizeModules(local ?? {})
  const remoteMods = sanitizeModules(remote ?? {})`,
  `  // 2026-11-04（P1-6 审计）：本地那份只用 stripSessionItems —— 不能动
  // agentive.sessionIds（"限定自动互动到指定会话"是本机设置，静默清掉是 bug）。
  // 推送前的那份仍然是 sanitizeModules（远端不需要知道本机的会话 id）。
  const localMods = stripSessionItems(local ?? {})
  const remoteMods = sanitizeModules(remote ?? {})`,
)

// mergeModules 返回值：推送用的形状仍然是 sanitizeModules（要清 sessionIds）
patchText(
  'remote-sync.js',
  `  const sanitized = sanitizeModules(out)
  sanitized.mergeStats = stats
  return sanitized`,
  `  // 推送形状要清 sessionIds；但**落地到本地**时会把本机的 sessionIds 带回来。
  const sanitized = sanitizeModules(out)
  sanitized.mergeStats = stats
  return sanitized`,
)

// ③ syncableEntry：剔除 cwd / sessionId
patchText(
  'remote-sync.js',
  `/** 记忆条目在跨机同步里要不要带：会话级的不带（换台机器召回不到）。 */
export function syncableEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (typeof entry.id !== 'string' || !entry.id) return false
  if (!isAlive(entry)) return false
  if (entry.scope === 'session') return false
  return typeof entry.text === 'string' && entry.text.trim().length > 0
}`,
  `/**
 * 记忆条目在跨机同步里要不要带：会话级的不带（换台机器召回不到）。
 *
 * 2026-11-04（P1-6 审计）：本机路径（cwd）和会话 id 不上云。
 * 实测 127 条里有 75 条带着绝对路径（含 Windows 用户名）和 sessionId，
 * 而它们的 scope 全是 global —— scope 过滤挡不住。
 * 别的机器上这些路径没有意义，路径本身就是隐私。
 */
export function syncableEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (typeof entry.id !== 'string' || !entry.id) return false
  if (!isAlive(entry)) return false
  if (entry.scope === 'session') return false
  return typeof entry.text === 'string' && entry.text.trim().length > 0
}

/**
 * 把条目收拾成「可以推到远端」的形状：抹掉本机路径与会话 id。
 *
 * 本地那份保留这两项（作用域过滤、路径判断要用），
 * 只有推上云的那份才抹。
 */
export function stripLocalPaths(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const out = { ...entry }
  delete out.cwd
  delete out.sessionId
  delete out.scopeSession
  return out
}`,
)

// mergeEntries：输出侧用 stripLocalPaths
patchText(
  'remote-sync.js',
  `  for (const entry of byId.values()) {
    if (typeof entry.text === 'string') entry.text = redactSecrets(entry.text)
    if (Array.isArray(entry.tags)) {
      entry.tags = entry.tags.map((tag) => redactSecrets(String(tag))).filter((tag) => tag !== '[已脱敏]')
    }
  }`,
  `  for (const entry of byId.values()) {
    if (typeof entry.text === 'string') entry.text = redactSecrets(entry.text)
    if (Array.isArray(entry.tags)) {
      entry.tags = entry.tags.map((tag) => redactSecrets(String(tag))).filter((tag) => tag !== '[已脱敏]')
    }
    // 2026-11-04（P1-6 审计）：推上云的条目不带本机路径和会话 id。
    delete entry.cwd
    delete entry.sessionId
    delete entry.scopeSession
  }`,
)

/* ================================================================== */
/* P1-7 source 双写一致                                               */
/* ================================================================== */
patchText(
  'cross-sync.js',
  `    entry.source = 'sync'`,
  `    // 2026-11-04（P1-7 审计）：以前无条件改成 'sync'，把老大手动加的
    // （source='manual'）冲掉了。实测 128 条记忆里 manual=0 ——
    // 于是「有待办就一定要说」这条硬规则永远命中零条。
    // 现在：手动加的保持 manual，其余才标成 sync。
    if (entry.source !== 'manual') entry.source = 'sync'`,
)

// pendingHintsOf：放宽到 manual 或 sync
patchText(
  'index.js',
  `      // 2026-11-03（P0-2）：只认老大亲口说的（source === 'manual'）。
      // 以前只看正文里的「待办」「继续」等关键词，于是本鱼自己写的
      // 工作日志快照（source='auto'）也被当成老大交代的待办 ——
      // 内部日志在偷偷决定对老大说什么。
      if (entry.source !== 'manual') continue`,
  `      // 2026-11-03（P0-2）：只认老大亲口说的（source === 'manual'）。
      // 以前只看正文里的「待办」「继续」等关键词，于是本鱼自己写的
      // 工作日志快照（source='auto'）也被当成老大交代的待办 ——
      // 内部日志在偷偷决定对老大说什么。
      //
      // 2026-11-04（P1-7 审计）：放宽到 manual **或** sync。
      // 老大在别的机器上亲口说的承诺（同步过来的 source='sync'）也是承诺。
      // 但仍然排除 'auto' —— 那是我们自己的工作日志，不该替老大决定说什么。
      if (entry.source !== 'manual' && entry.source !== 'sync') continue`,
)

console.log('[done] 批次 D（删除传播 + 本机态 + source 统一）已改')
