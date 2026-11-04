/**
 * dsh-shared-brain — 人设同步（共享大脑 → dsh-persona-dafeiyu「养鱼」插件）
 *
 * 老大要的效果：在**共享大脑**里切人设 / 改人设正文，养鱼那个人设插件也跟着变，
 * 不用两边各配一遍。
 *
 * 做法（单向镜像，共享大脑是唯一权威）：
 *   1. 把共享大脑人设库里的每一条，写进养鱼插件 `personas` 里，id 加 `sb-` 前缀；
 *   2. 养鱼插件的 `current` 指向对应的镜像 id（共享大脑当前是内置人设时，镜像 id 是 `sb-dafeiyu` 这种）；
 *   3. 共享大脑里删掉的人设，镜像条目一并删掉；
 *   4. 养鱼插件里**不是** `sb-` 开头的条目（用户自己导的）一律不碰；
 *   5. 只在「共享大脑人设库真的变了」时才写盘 —— 这样用户在养鱼插件里手动切人设不会被 15 秒一次的同步覆盖回去。
 *
 * 另外还会把**当前人设**同步进 `dsh-bili-whale`（养鱼插件）：
 *   `~/.dsh/bili-whale.config.json` 的 persona.name / persona.selfClaim，
 *   以及 `~/.bili-ai/persona.md`（她专属的人设正文，注入时取前 3000 字）。
 *   这样设置页「养鱼」里的角色名 / 自称 / 人设正文都跟着共享大脑走。
 *
 * 为什么镜像而不是直接改内置人设：养鱼插件的内置人设正文写在它的源码里（`BUNDLED_DAFEIYU`），
 * 改源码会被下次插件升级覆盖；写成人设库条目才是稳的。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { readPersona, BUNDLED_PERSONAS } from './persona.js'
import { readModules } from './modules.js'

/** 镜像条目的 id 前缀。 */
export const MIRROR_PREFIX = 'sb-'

/** 同步间隔（毫秒）。 */
export const PERSONA_SYNC_INTERVAL_MS = 15_000

/** 默认配置。 */
export const PERSONA_SYNC_DEFAULTS = { enabled: true }

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 养鱼插件的人设库文件。 */
export function pluginPersonaFile() {
  return join(dshHome(), 'storages', 'dsh-persona-dafeiyu', 'personas.json')
}

/** 同步状态文件。 */
export function personaSyncFile() {
  return join(dshHome(), 'storages', 'dsh-shared-brain', 'persona-sync.json')
}

function readJson(file) {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** dsh-bili-whale（设置页里的「养鱼」）的配置文件。 */
export function whaleConfigFile() {
  return join(dshHome(), 'bili-whale.config.json')
}

/** dsh-bili-whale 的「她专属人设」正文文件。 */
export function whalePersonaFile() {
  // DSH_BILI_HOME 只给测试/多环境用：默认还是用户主目录
  return join(process.env.DSH_BILI_HOME || homedir(), '.bili-ai', 'persona.md')
}

/**
 * 探一下养鱼插件的配置文件是什么状况（2026-11-03，P2-4）。
 *
 * 为什么要有这个：`readWhaleConfig()` 读不出来会退化成 `{}`，
 * 而写入是 `{ ...cfg, persona }` —— 也就是「配置坏了 = 当成空的 = 把用户
 * 其它设置全清零」。养鱼插件的配置跟共享大脑是共用的，绝不能这么干。
 *
 * @returns {{ file: string, exists: boolean, ok: boolean, reason: string, keys: string[], personaType: string }}
 */
export function probeWhaleConfig() {
  const file = whaleConfigFile()
  const base = { file, exists: false, ok: true, reason: 'absent', keys: [], personaType: 'absent' }
  if (!existsSync(file)) return base

  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ...base, exists: true, ok: false, reason: 'unreadable' }
  }
  if (!text.trim()) {
    // 空文件：可以安全当成空配置（首次使用就是这个样子）
    return { ...base, exists: true, ok: true, reason: 'empty' }
  }

  let raw = null
  try {
    raw = JSON.parse(text)
  } catch {
    return { ...base, exists: true, ok: false, reason: 'not-json' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...base, exists: true, ok: false, reason: 'not-object' }
  }

  const persona = raw.persona
  const personaType = persona === undefined ? 'absent' : Array.isArray(persona) ? 'array' : typeof persona
  if (persona !== undefined && (typeof persona !== 'object' || persona === null || Array.isArray(persona))) {
    // persona 被写成字符串 / 数组 / null —— 结构不认识，别乱碰
    return { ...base, exists: true, ok: false, reason: 'persona-not-object', keys: Object.keys(raw), personaType }
  }
  return { ...base, exists: true, ok: true, reason: 'ok', keys: Object.keys(raw), personaType }
}

/** 读养鱼插件的用户配置（只读用户那份，不做默认值合并）。 */
export function readWhaleConfig() {
  const probe = probeWhaleConfig()
  if (!probe.ok) return {}
  const raw = readJson(whaleConfigFile())
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/** 读养鱼插件的人设正文。 */
export function readWhalePersona() {
  try {
    return readFileSync(whalePersonaFile(), 'utf8')
  } catch {
    return ''
  }
}

/** 共享大脑当前人设那一行。 */
function currentPersonaRow(snapshot) {
  const rows = Array.isArray(snapshot?.personas) ? snapshot.personas : []
  return rows.find((p) => p.id === snapshot.current) || rows[0] || null
}

/** 共享大脑里设的自称（voice.style.address），没设就空串。 */
function selfClaimOf() {
  try {
    const style = readModules()?.voice?.style ?? {}
    return typeof style.address === 'string' ? style.address.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 把共享大脑的**当前人设**同步进 dsh-bili-whale（养鱼插件）。
 *
 * 写两处：
 *   1. `~/.dsh/bili-whale.config.json` 的 `persona.name` / `persona.selfClaim`；
 *      `persona.ownerTitle`（她怎么称呼你）保持用户原来的值。
 *   2. `~/.bili-ai/persona.md` 写成当前人设正文。
 *
 * 其它配置项（夜间、偏好、直播、通知…）一概不碰。
 */
export function syncPersonaToWhale(options = {}) {
  const snapshot = sharedPersonaSnapshot()
  const row = currentPersonaRow(snapshot)
  const probe = probeWhaleConfig()
  const cfg = probe.ok ? readWhaleConfig() : {}
  const persona = cfg.persona && typeof cfg.persona === 'object' && !Array.isArray(cfg.persona) ? cfg.persona : {}
  const name = row ? String(row.name || '') : ''
  const selfClaim = selfClaimOf() || (typeof persona.selfClaim === 'string' && persona.selfClaim ? persona.selfClaim : '我')
  const stored = readPersonaSyncConfig()
  const ownerTitle = stored.ownerTitle || (typeof persona.ownerTitle === 'string' && persona.ownerTitle ? persona.ownerTitle : '主人')
  const text = row ? String(row.text || '') : ''
  const beforeText = readWhalePersona()
  const titleChanged = persona.ownerTitle !== ownerTitle
  const nameChanged = persona.name !== name
  const selfChanged = persona.selfClaim !== selfClaim
  const textChanged = beforeText.trim() !== text.trim()
  const result = {
    changed: nameChanged || selfChanged || textChanged || titleChanged,
    reason: nameChanged || selfChanged || textChanged || titleChanged ? 'changed' : 'unchanged',
    name,
    ownerTitle,
    selfClaim,
    personaBytes: Buffer.byteLength(text, 'utf8'),
    configFile: whaleConfigFile(),
    personaFile: whalePersonaFile(),
  }
  // 配置文件的格式不认识（不是 JSON / 不是对象 / persona 结构怪）→
  // **一个字节都不写**，只把问题报出去。宁可不生效，也不能把别人的配置覆盖掉。
  const configWritable = probe.ok
  result.configWritable = configWritable
  if (!configWritable) {
    result.reason = 'config-unrecognized'
    result.problem = probe.reason
    result.configKeys = probe.keys
  }
  if (options.dryRun) return result

  if (configWritable) {
    // 配置：只改 persona 里那三个字段，其余原样保留
    writeJson(whaleConfigFile(), { ...cfg, persona: { ...persona, name, ownerTitle, selfClaim } })
  }

  // 人设正文是完全独立的一份文件（`~/.bili-ai/persona.md`），不依赖配置结构，
  // 所以配置写不进去也照样更新她的人设。
  if (result.changed || !configWritable) {
    mkdirSync(dirname(whalePersonaFile()), { recursive: true })
    if (readWhalePersona().trim() !== text.trim()) {
      writeFileSync(whalePersonaFile(), text.trim() ? `${text.trim()}\n` : '', 'utf8')
    }
  }
  return result
}

/** 读养鱼插件的人设库；没有 / 坏了都退一份空库（不写盘）。 */
export function readPluginStore() {
  const raw = readJson(pluginPersonaFile())
  const base = {
    version: 1,
    mode: 'single',
    current: 'dafeiyu',
    disabled: [],
    personas: [],
    workspaces: [],
  }
  if (!raw || typeof raw !== 'object') return { exists: false, store: base, raw: null }
  return {
    exists: true,
    raw,
    store: {
      version: 1,
      mode: typeof raw.mode === 'string' && raw.mode ? raw.mode : base.mode,
      current: typeof raw.current === 'string' && raw.current ? raw.current : base.current,
      disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((id) => typeof id === 'string' && id) : [],
      personas: Array.isArray(raw.personas) ? raw.personas : [],
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [],
    },
  }
}

/** 写养鱼插件的人设库（保留我们没管的字段）。 */
export function writePluginStore(store) {
  const file = pluginPersonaFile()
  const raw = readJson(file)
  const next = raw && typeof raw === 'object' ? { ...raw } : {}
  next.version = 1
  next.mode = store.mode || next.mode || 'single'
  next.current = store.current || next.current || 'dafeiyu'
  next.disabled = Array.isArray(store.disabled) ? store.disabled : []
  next.personas = Array.isArray(store.personas) ? store.personas : []
  next.workspaces = Array.isArray(store.workspaces) ? store.workspaces : []
  writeJson(file, next)
  return next
}

/** 镜像 id：`dafeiyu` → `sb-dafeiyu`。 */
export function mirrorId(id) {
  const clean = String(id ?? '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .slice(0, 48)
  if (!clean) return ''
  return clean.startsWith(MIRROR_PREFIX) ? clean : MIRROR_PREFIX + clean
}

function isMirror(entry) {
  return Boolean(entry && typeof entry.id === 'string' && entry.id.startsWith(MIRROR_PREFIX))
}

/** 共享大脑当前人设库的快照（含内置的正文，保证内置人设也有完整内容）。 */
export function sharedPersonaSnapshot() {
  const { store } = readPersona()
  const seen = new Set()
  const out = []
  for (const entry of Array.isArray(store.personas) ? store.personas : []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue
    if (entry.id === 'config') continue
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (!text) continue
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push({ id: entry.id, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id, text })
  }
  // 内置人设即使库里没有条目也要有（库里那条正文可能是用户改过的，优先用库里的）
  for (const bundled of BUNDLED_PERSONAS) {
    if (seen.has(bundled.id)) continue
    seen.add(bundled.id)
    out.push({ id: bundled.id, name: bundled.name, text: String(bundled.text || '').trim() })
  }
  return { personas: out, current: store.current || 'dafeiyu', bySession: store.bySession || {} }
}

/** 计算「共享大脑人设库」的指纹：只用它判断有没有变。 */
export function snapshotHash(snapshot) {
  const rows = (snapshot?.personas ?? []).map((p) => `${p.id}\u0000${p.name}\u0000${p.text}`)
  return JSON.stringify({ current: snapshot?.current ?? '', rows })
}

/**
 * 把共享大脑的人设镜像到养鱼插件。
 *
 * @param {{ force?: boolean, dryRun?: boolean }} options `force` 忽略指纹比较直接写
 * @returns {{ changed: boolean, reason: string, written: number, removed: number, current: string, target: string }}
 */
export function syncPersonaToPlugin(options = {}) {
  const snapshot = sharedPersonaSnapshot()
  // v2：把「自称」也算进指纹（改了自称要同步）；前缀让旧版本的 lastHash 失效、重跑一次
  const hash = 'v2:' + snapshotHash(snapshot) + '|' + selfClaimOf()
  const state = readJson(personaSyncFile()) || {}
  const enabled = state.enabled !== false

  if (!enabled) {
    return { changed: false, reason: 'disabled', written: 0, removed: 0, current: snapshot.current, target: '', whale: null }
  }
  if (!options.force && state.lastHash === hash) {
    return { changed: false, reason: 'unchanged', written: 0, removed: 0, current: snapshot.current, target: state.lastCurrent || '', whale: inspectWhale() }
  }

  const { store } = readPluginStore()
  const foreign = store.personas.filter((entry) => entry && !isMirror(entry))
  const before = store.personas.filter(isMirror)
  const mirrored = snapshot.personas.map((p) => ({
    id: mirrorId(p.id),
    name: p.name,
    text: p.text,
    createdAt: (before.find((entry) => entry.id === mirrorId(p.id)) || {}).createdAt || new Date().toISOString(),
  }))
  const target = mirrored.some((p) => p.id === mirrorId(snapshot.current))
    ? mirrorId(snapshot.current)
    : (mirrored[0] || {}).id || store.current
  const removed = before.filter((entry) => !mirrored.some((p) => p.id === entry.id)).length

  const next = {
    ...store,
    // 只有当前用的就是这个镜像人设时才动 current，避免抢用户的手动选择
    current: target || store.current,
    personas: [...foreign, ...mirrored],
    disabled: store.disabled.filter((id) => !isMirror({ id })),
  }

  if (!options.dryRun) writePluginStore(next)
  const changed = removed > 0 || next.current !== store.current || JSON.stringify(before) !== JSON.stringify(mirrored) || options.force === true
  if (!options.dryRun) {
    writeJson(personaSyncFile(), {
      ...state, // 保留 ownerTitle 等设置项，别被状态覆盖掉
      version: 1,
      enabled: true,
      lastHash: hash,
      lastCurrent: target,
      lastSyncedAt: Date.now(),
    })
  }
  // 养鱼插件（dsh-bili-whale）：当前人设 → config.persona + ~/.bili-ai/persona.md
  let whale = null
  try {
    whale = syncPersonaToWhale({ dryRun: options.dryRun })
  } catch {
    // 养鱼插件那边写不进去不该影响人设镜像本身
    whale = null
  }

  return {
    changed: changed || removed > 0 || Boolean(whale?.changed),
    reason: options.force === true ? 'forced' : 'changed',
    written: mirrored.length,
    removed,
    current: snapshot.current,
    target,
    whale,
  }
}

/** 只看养鱼插件现在是什么状态（不写盘）。 */
function inspectWhale() {
  try {
    return syncPersonaToWhale({ dryRun: true })
  } catch {
    return null
  }
}

/** 读同步开关状态。 */
export function readPersonaSyncConfig() {
  const state = readJson(personaSyncFile()) || {}
  return {
    enabled: state.enabled !== false,
    lastSyncedAt: Number(state.lastSyncedAt) || 0,
    lastCurrent: typeof state.lastCurrent === 'string' ? state.lastCurrent : '',
    ownerTitle: typeof state.ownerTitle === 'string' ? state.ownerTitle : '',
  }
}

/** 开关 / 立即同步（设置页用）。 */
export function applyPersonaSync(patch = {}) {
  const state = readJson(personaSyncFile()) || {}
  const next = {
    ...state,
    version: 1,
    enabled: patch.enabled === undefined ? state.enabled !== false : Boolean(patch.enabled),
  }
  if (patch.ownerTitle !== undefined) {
    const title = String(patch.ownerTitle ?? '').trim().slice(0, 24)
    next.ownerTitle = title
  }
  writeJson(personaSyncFile(), next)
  if (next.enabled !== true) {
    return { ok: true, enabled: false, note: '人设同步已关闭：共享大脑不再往养鱼插件写人设' }
  }
  const result = syncPersonaToPlugin({ force: true })
  return {
    ok: true,
    enabled: true,
    note: `人设同步已开启：镜像 ${result.written} 条，当前指向 ${result.target || '（未变）'}`,
    result,
  }
}

/** 运行状态（给设置页 / 状态接口）。 */
export function personaSyncStatus() {
  const config = readPersonaSyncConfig()
  const plugin = readPluginStore()
  const mirrored = plugin.store.personas.filter(isMirror)
  let pluginExists = false
  try {
    pluginExists = existsSync(pluginPersonaFile())
  } catch {
    pluginExists = false
  }
  // 养鱼插件（dsh-bili-whale）：设置页「养鱼」里的角色名 / 自称 / 人设正文
  let whale = null
  try {
    const dry = syncPersonaToWhale({ dryRun: true })
    whale = {
      target: 'dsh-bili-whale',
      configFile: dry.configFile,
      personaFile: dry.personaFile,
      name: dry.name,
      ownerTitle: dry.ownerTitle,
      selfClaim: dry.selfClaim,
      personaBytes: dry.personaBytes,
      configExists: existsSync(dry.configFile),
      personaExists: existsSync(dry.personaFile),
      synced: !dry.changed,
    }
  } catch {
    whale = null
  }

  return {
    enabled: config.enabled,
    target: 'dsh-persona-dafeiyu',
    file: pluginPersonaFile(),
    pluginExists,
    mirrored: mirrored.length,
    pluginCurrent: plugin.store.current,
    sharedCurrent: readPersona().store.current,
    lastSyncedAt: config.lastSyncedAt,
    lastCurrent: config.lastCurrent,
    whale,
  }
}

let timer = null

/** 起一个 15 秒的看门狗（人设改了就镜像一次；没改什么都不做）。 */
export function startPersonaSync(options = {}) {
  stopPersonaSync()
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : PERSONA_SYNC_INTERVAL_MS
  try {
    syncPersonaToPlugin({})
  } catch {
    // 养鱼插件没装 / 目录不可写都不该把宿主带崩
  }
  timer = setInterval(() => {
    try {
      syncPersonaToPlugin({})
    } catch {
      /* 同上，静默 */
    }
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return { intervalMs }
}

/** 停掉看门狗。 */
export function stopPersonaSync() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
