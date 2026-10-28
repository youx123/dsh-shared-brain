/**
 * 会话目录：把「宿主里有哪些会话」整理成设置页能直接勾选的样子。
 *
 * 为什么单独一个文件：这件事要用三样宿主服务（活跃会话 / 持久化快照 / 工作区
 * 注册表），而且 durable 那份是异步、可能慢的，不能卡住 status 请求。所以这里
 * 做成「后台刷新 + 读缓存」：界面随时能拿到上一份快照，刷新在后台进行。
 */

import { basename } from 'node:path'

/** 两次刷新之间至少隔这么久，避免设置页连点把宿主读爆。 */
const REFRESH_MIN_MS = 3000

/** 一次最多列多少会话（再多界面也没法挑）。 */
const MAX_SESSIONS = 300

/**
 * 从 ctx 取服务。
 *
 * 注意：cordis 里 **没在 `inject` 里声明的服务不会变成 ctx 上的属性**，但
 * `ctx.get(name)` 仍能取到（它只查服务表，不要求调用者声明依赖）。所以这里
 * 一定先走 get()；属性访问只是给别的运行时兜底。
 */
function pickService(ctx, name) {
  for (const owner of [ctx, ctx?.root]) {
    if (!owner) continue
    try {
      if (typeof owner.get === 'function') {
        const value = owner.get(name)
        if (value !== undefined) return value
      }
    } catch {
      // ctx.get 对未知服务可能抛错，忽略
    }
    // strict=false：即使服务的提供者当前不是 ACTIVE 状态也取出来用
    try {
      if (owner.reflect && typeof owner.reflect.get === 'function') {
        const value = owner.reflect.get(name, false)
        if (value !== undefined) return value
      }
    } catch {
      // reflect 也可能不可用
    }
    try {
      const value = owner[name]
      if (value !== undefined) return value
    } catch {
      // 属性访问也可能抛错
    }
  }
  return undefined
}

/** 路径归一：统一分隔符、去尾斜杠、小写（Windows 大小写不敏感）。 */
function normPath(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return text.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 一个会话该显示成什么名字：优先标题，否则「目录名 · 时间」。 */
function titleOf(entry) {
  const meta = entry.meta || {}
  for (const key of ['title', 'name', 'summary', 'label']) {
    const value = meta[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80)
  }
  const cwd = String(entry.header?.cwd ?? '').trim()
  const folder = cwd ? basename(cwd.replace(/\\/g, '/')) || cwd : ''
  const at = Number(entry.header?.createdAt)
  let stamp = ''
  if (Number.isFinite(at) && at > 0) {
    const date = new Date(at)
    const pad = (n) => String(n).padStart(2, '0')
    stamp = `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
  if (folder && stamp) return `${folder} · ${stamp}`
  if (folder) return folder
  if (stamp) return stamp
  return entry.id.slice(0, 8)
}

/**
 * 建一个会话目录。
 *
 * @param {object} ctx 插件上下文
 * @returns {{ refresh: (options?: {force?: boolean}) => Promise<object>, snapshot: () => object }}
 */
export function createSessionCatalog(ctx) {
  const state = {
    workspaces: [],
    flat: [],
    total: 0,
    live: 0,
    current: '',
    updatedAt: 0,
    error: '',
    scanning: false,
  }

  let lastScanAt = 0
  let inflight = null
  let warnedMissing = false

  function setCurrent(sessionId) {
    state.current = typeof sessionId === 'string' ? sessionId : ''
  }

  /** 扫描一遍：活跃会话 + 持久化会话，合成扁平清单与工作区分组。 */
  async function scan() {
    const registry = pickService(ctx, 'workspaceRegistry')
    const sessions = pickService(ctx, 'sessions')
    const persistence = pickService(ctx, 'sessionPersistence')

    const found = new Map()
    const problems = []

    // 1) 活跃会话（当前进程里开着/开过的）
    if (sessions && typeof sessions.list === 'function') {
      try {
        for (const session of sessions.list() ?? []) {
          const header = session?.header ?? {}
          const id = typeof header.id === 'string' ? header.id : typeof session?.id === 'string' ? session.id : ''
          if (!id) continue
          found.set(id, { id, header, meta: session?.meta ?? {}, live: true })
        }
      } catch (error) {
        problems.push(`活跃会话读取失败：${String(error?.message ?? error)}`)
      }
    } else {
      problems.push('宿主没有 sessions 服务')
    }

    // 2) 持久化快照（磁盘上所有会话，含当前没打开的）
    if (persistence && typeof persistence.list === 'function') {
      try {
        const snapshots = (await persistence.list()) ?? []
        for (const snapshot of snapshots) {
          const header = snapshot?.header ?? {}
          const id = typeof header.id === 'string' ? header.id : ''
          if (!id || found.has(id)) continue
          found.set(id, { id, header, meta: snapshot?.meta ?? {}, live: false })
        }
      } catch (error) {
        problems.push(`持久会话读取失败：${String(error?.message ?? error)}`)
      }
    }

    // 3) 工作区（同步，列表已按持久序排好）
    let workspaceList = []
    if (registry && typeof registry.list === 'function') {
      try {
        workspaceList = registry.list() ?? []
      } catch (error) {
        problems.push(`工作区读取失败：${String(error?.message ?? error)}`)
      }
    } else {
      problems.push('宿主没有 workspaceRegistry 服务')
    }

    // 扁平清单：按创建时间倒序（最近的会话排前面）
    const flat = [...found.values()]
      .sort((a, b) => Number(b.header?.createdAt ?? 0) - Number(a.header?.createdAt ?? 0))
      .slice(0, MAX_SESSIONS)
      .map((entry) => ({
        id: entry.id,
        title: titleOf(entry),
        cwd: typeof entry.header?.cwd === 'string' ? entry.header.cwd : '',
        createdAt: Number(entry.header?.createdAt ?? 0) || 0,
        live: entry.live === true,
        current: entry.id === state.current,
      }))

    // 分组：工作区路径是会话 cwd 的前缀就归它；归不上的放「其他会话」
    const byId = new Map(flat.map((item) => [item.id, item]))
    const used = new Set()
    const workspaces = []
    for (const workspace of workspaceList) {
      const path = typeof workspace?.path === 'string' ? workspace.path : ''
      const id = typeof workspace?.id === 'string' ? workspace.id : ''
      if (!id) continue
      const normalized = normPath(path)
      const members = []
      for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
        const item = byId.get(sessionId)
        if (!item || used.has(sessionId)) continue
        used.add(sessionId)
        members.push(item)
      }
      if (normalized) {
        for (const item of flat) {
          if (used.has(item.id)) continue
          const cwd = normPath(item.cwd)
          if (!cwd) continue
          if (cwd === normalized || cwd.startsWith(`${normalized}/`)) {
            used.add(item.id)
            members.push(item)
          }
        }
      }
      members.sort((a, b) => b.createdAt - a.createdAt)
      workspaces.push({
        id,
        title: typeof workspace?.title === 'string' && workspace.title ? workspace.title : path || id,
        path,
        sessions: members,
      })
    }

    const leftovers = flat.filter((item) => !used.has(item.id))
    if (leftovers.length > 0) {
      workspaces.push({
        id: '__other__',
        title: '其他会话',
        path: '',
        sessions: leftovers,
      })
    }

    // 一个工作区都没有但确实有会话时，仍然给界面一份能选的清单
    if (workspaces.length === 0 && flat.length > 0) {
      workspaces.push({ id: '__all__', title: '会话', path: '', sessions: flat })
    }

    state.workspaces = workspaces
    state.flat = flat
    state.total = flat.length
    state.live = flat.filter((item) => item.live).length
    state.updatedAt = Date.now()
    state.error = problems.join('；')

    if (!registry && !warnedMissing) {
      warnedMissing = true
      ctx?.logger?.warn?.('dsh-shared-brain: 拿不到 workspaceRegistry，会话选择只能列出扁平清单')
    }
    return state
  }

  /**
   * 刷新快照。
   *
   * 默认节流：3 秒内的重复调用直接返回缓存；force 跳过节流（例如点了「刷新」）。
   * 并发调用共享同一个 promise，不会重复扫。
   */
  function refresh(options = {}) {
    const now = Date.now()
    if (inflight) return inflight
    if (options.force !== true && now - lastScanAt < REFRESH_MIN_MS) {
      return Promise.resolve(state)
    }
    lastScanAt = now
    state.scanning = true
    inflight = scan()
      .catch((error) => {
        state.error = String(error?.message ?? error)
        return state
      })
      .finally(() => {
        state.scanning = false
        inflight = null
      })
    return inflight
  }

  /** 读当前快照（同步，永不读盘）。 */
  function snapshot() {
    return {
      workspaces: state.workspaces,
      flat: state.flat,
      total: state.total,
      live: state.live,
      current: state.current,
      updatedAt: state.updatedAt,
      error: state.error,
      scanning: state.scanning,
    }
  }

  return { refresh, snapshot, setCurrent }
}
