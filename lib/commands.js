/**
 * /shared-memory 命令：查看与调整跨会话共享的「大脑模块」。
 *
 * 用法：
 *   /shared-memory                    总览：各模块条目数、权重、人设、能力开关
 *   /shared-memory list               同上
 *   /shared-memory modules            各模块明细（含权重最高的几条）
 *   /shared-memory bottomline|emotion|instinct|cognition
 *                                     查看某个模块的条目
 *   /shared-memory weight <模块> <权重>
 *                                     调整模块权重（0..1），或条目权重
 *   /shared-memory add <模块> <内容>   手动加一条（钉到底线则永远生效）
 *   /shared-memory pin <模块> <条目>   钉住条目（底线只有钉住的才注入）
 *   /shared-memory unpin <模块> <条目> 取消钉住
 *   /shared-memory permanent <模块> <条目>
 *                                     把记忆改成永久
 *   /shared-memory temporary <模块> <条目> [小时数]
 *                                     把记忆改成临时（默认 24 小时过期）
 *   /shared-memory remove <模块> <条目> 删除条目
 *   /shared-memory voice <内容>       往声音模块加一条说话风格
 *   /shared-memory network on|off     开关「对外获取信息」
 *   /shared-memory agentive on|off    开关「主观能动性」
 *   /shared-memory agentive scope all|session [会话ID...]
 *                                     设定主观能动性的生效范围
 *   /shared-memory agentive interval <分钟>
 *                                     设定主动搭话的间隔（1~1440 分钟）
 *   /shared-memory agentive now       立刻对所有活跃会话主动搭话一次
 *   /shared-memory clear [模块]        清空记忆库（不指定模块则全清）
 *   /shared-memory persona             查看人设列表与当前人设
 *   /shared-memory persona use <id>    切换人设（立即生效，无需重启）
 *   /shared-memory persona save <名字> <正文...>
 *                                     新建人设并启用
 *   /shared-memory persona delete <id> 删除自定义人设
 *   /shared-memory persona session <会话id> <人设id>
 *                                     给某个会话单独指定人设（留空回到全局）
 *   /shared-memory emoji               查看表情包目录、自动加载状态与表情清单
 *   /shared-memory emoji dir <路径>    设置表情包目录
 *   /shared-memory emoji autoload on|off  定时自动加载开关
 *   /shared-memory emoji interval <分钟>  自动扫描间隔
 *   /shared-memory emoji reload        立刻重扫目录
 *   /shared-memory emoji add <名字> <表情>  往目录里加一个表情（放文件进目录也行）
 *                                     往目录里加一个表情
 *   /shared-memory scope <模块> <条目> global|workspace [路径]
 *                                     设定条目的作用域
 *   /shared-memory timewindow [on [开始 结束]|off]
 *                                     自动互动的时间窗
 *   /shared-memory speech               查看语音/唱歌参数
 *   /shared-memory speech <键> <值>    改语音参数
 *                                     （voiceId / voiceName / rate / pitch / volume /
 *                                      sing.enabled / sing.style / sing.bpm / sing.key）
 *   /shared-memory search <关键词>     在记忆库里搜
 */
import { readStore, brainFile, DEFAULT_TEMPORARY_TTL_MS } from './store.js'
import { writeStoreSynced, writeModulesSynced } from './cross-sync.js'
import { status } from './index.js'
import {
  readModules,
  moduleSummary,
  putModuleItem,
  setModuleItemPinned,
  setModuleItemScope,
  setAgentiveTimeWindow,
  setSpeech,
  normalizeSpeech,
  withinTimeWindow,
  ALL_MODULES,
  MEMORY_MODULES,
  MODULE_LABELS,
  MODULE_PROFILES,
  AGENTIVE_SCOPES,
  clampWeight,
  clampAgentiveInterval,
} from './modules.js'
import { runProactiveNow, proactiveStatus } from './proactive.js'
import { bridgeContext } from './bridge.js'
import { readEmojiDir, writeEmoji, defaultEmojiDir, emojiStatus, clampEmojiInterval, scanEmojiDir } from './emoji.js'
import {
  activePersona,
  personaList,
  selectPersona,
  savePersona,
  deletePersona,
  setSessionPersona,
} from './persona.js'

/** 把模块键规范化（中英文都认）。 */
function resolveModuleKey(name) {
  const raw = String(name ?? '').trim()
  if (!raw) return ''
  if (ALL_MODULES.includes(raw)) return raw
  for (const key of ALL_MODULES) {
    if (MODULE_LABELS[key] === raw) return key
    if (key.toLowerCase() === raw.toLowerCase()) return key
  }
  return ''
}

function formatStatus() {
  const info = status()
  const summary = info.modules.summary
  const lines = []
  lines.push('共享记忆（所有会话共用一份）')
  lines.push(`  文件：${info.memory.file}`)
  lines.push(`  条目：${info.memory.entries} 条`)
  lines.push(`  注入：已召回 ${info.counters.recallsServed} 次，入库 ${info.counters.turnsSaved} 轮，跳过 ${info.counters.turnsSkipped} 轮`)
  if (info.counters.lastError) lines.push(`  最近错误：${info.counters.lastError}`)

  lines.push('')
  lines.push('大脑模块')
  for (const key of ALL_MODULES) {
    const mod = summary[key]
    const profile = MODULE_PROFILES[key]
    const mark = mod.enabled ? '开' : '关'
    const always = profile?.always ? ' · 常驻注入' : ''
    lines.push(`  ${mod.label}（${key}）：${mark} · 模块权重 ${mod.weight.toFixed(2)} · ${mod.count} 条${always}`)
  }

  lines.push('')
  lines.push('人设（所有会话共用一个库，切换后立即生效）')
  lines.push(`  当前：${info.persona.name || '（无）'}（${info.persona.current || '-'}）${info.persona.bundled ? ' · 内置' : ''}`)
  lines.push(`  文件：${info.persona.file}`)
  lines.push(`  可选：${(info.persona.list?.list ?? []).map((p) => p.name).join('、') || '-'}`)
  if (info.persona.notes?.length) lines.push(`  调整：${info.persona.notes.join('；')}`)

  lines.push('')
  lines.push('自动互动（主观能动性）')
  const agentive = summary.agentive
  const proactive = info.proactive
  if (proactive) {
    const scopeText = proactive.scope === 'session'
      ? (proactive.sessionIds?.length ? `指定 ${proactive.sessionIds.length} 个会话` : '全部会话')
      : '全部会话'
    lines.push(`  开关：${proactive.enabled ? '已开启' : '已关闭'} · 作用范围：${scopeText}`)
    lines.push(`  间隔：每 ${Math.max(1, Math.round((proactive.intervalMs ?? 0) / 60000))} 分钟主动问一次`)
    const rt = proactive.runtime ?? {}
    lines.push(`  运行：${rt.running ? '定时器已启动' : '定时器未运行'} · 已主动 ${rt.fired ?? 0} 次 · 跳过 ${rt.skipped ?? 0} 次 · 盯着 ${rt.trackedAgents ?? 0} 个会话`)
    if (rt.lastFiredAt) lines.push(`  最近一次：${new Date(rt.lastFiredAt).toLocaleString('zh-CN')}`)
    if (rt.lastError) lines.push(`  最近错误：${rt.lastError}`)
    if (proactive.timeWindow?.enabled) {
      lines.push(`  时间窗：${proactive.timeWindow.start} ~ ${proactive.timeWindow.end}`)
    }
  } else {
    lines.push(`  开关：${agentive.enabled ? '已开启' : '已关闭'}`)
  }

  lines.push('')
  lines.push('Hindsight')
  lines.push(`  bank：${info.hindsight.bankId}（已固定，所有会话共用）`)
  lines.push(`  状态：${info.hindsight.usable ? '可用' : `不可用 —— ${info.hindsight.reason}`}`)
  if (info.hindsight.notes?.length) lines.push(`  调整：${info.hindsight.notes.join('；')}`)

  if (info.memory.latest.length > 0) {
    lines.push('')
    lines.push('最近记下的：')
    for (const entry of info.memory.latest) {
      const when = entry.at ? new Date(entry.at).toLocaleString('zh-CN') : '?'
      const label = MODULE_LABELS[entry.module] ?? entry.module
      lines.push(`  · ${when} 【${label}｜权重 ${Number(entry.weight ?? 0.5).toFixed(2)}】${entry.text}`)
    }
  }
  return lines.join('\n')
}

function formatModuleDetail(moduleKey) {
  const modules = readModules()
  const bucket = modules[moduleKey]
  const label = MODULE_LABELS[moduleKey] ?? moduleKey
  const profile = MODULE_PROFILES[moduleKey]
  const lines = []
  lines.push(`【${label}】（${moduleKey}）${bucket.enabled ? '已启用' : '已停用'} · 模块权重 ${bucket.weight.toFixed(2)}`)
  if (profile?.always) lines.push('  策略：永远注入（不依赖相关性）')
  if (moduleKey === 'voice') {
    const style = bucket.style ?? {}
    lines.push(`  语气：${style.tone ?? '-'}`)
    lines.push(`  口头禅：${(style.tics ?? []).join('、') || '-'}`)
    lines.push(`  表情：${style.emoji ?? '-'}`)
    lines.push(`  自称：${style.address ?? '-'}`)
    const auto = style.emojiAuto ?? {}
    const emojiDirLabel = String(style.emojiDir ?? '').trim() || defaultEmojiDir()
    lines.push(
      `  表情包目录：${emojiDirLabel}（自动加载${auto.enabled === false ? '已关' : `每 ${Math.max(1, Math.round((auto.intervalMs ?? 300000) / 60000))} 分钟`}）`,
    )
  }
  if (moduleKey === 'network' || moduleKey === 'agentive') {
    lines.push(`  说明：${bucket.reason ?? '-'}`)
  }
  if (moduleKey === 'agentive') {
    const sessionIds = bucket.sessionIds ?? []
    lines.push(
      `  作用范围：${bucket.scope === 'session' ? (sessionIds.length > 0 ? `指定 ${sessionIds.length} 个会话` : '全部会话') : '全部会话'}`,
    )
    lines.push(`  主动间隔：每 ${Math.max(1, Math.round((bucket.intervalMs ?? 900000) / 60000))} 分钟问一次`)
    const tw = bucket.timeWindow ?? {}
    lines.push(`  时间窗：${tw.enabled ? `${tw.start} ~ ${tw.end}` : '不限制'}`)
  }
  const items = bucket.items ?? []
  if (items.length === 0) {
    lines.push('  （还没有条目）')
  } else {
    lines.push(`  条目（${items.length}）：`)
    for (const item of items.slice().sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))) {
      const marks = []
      if (item.pinned) marks.push('已钉住')
      if (item.lifetime === 'temporary') {
        const left = item.expiresAt ? Math.max(0, Math.round((item.expiresAt - Date.now()) / 60000)) : 0
        marks.push(`临时·剩 ${left} 分钟`)
      }
      if (item.source === 'manual') marks.push('手动')
      const mark = marks.length ? `［${marks.join('｜')}］` : ''
      lines.push(`   · ${Number(item.weight ?? 0.5).toFixed(2)}｜命中 ${item.hits ?? 0}｜${item.text}${mark}`)
    }
  }
  return lines.join('\n')
}

/** 在模块里按 id（或文本前缀）找条目。 */
function findItem(bucket, token) {
  const items = bucket?.items ?? []
  const key = String(token ?? '').trim()
  if (!key) return null
  return items.find((item) => item.id === key)
    ?? items.find((item) => String(item.text ?? '').includes(key))
    ?? null
}

/** 把模块里的改动同步到扁平记忆库。 */
function syncStoreModule(moduleKey, item, patch) {
  const store = readStore()
  const entry = store.entries.find((e) => e.text === item.text)
  if (!entry) return false
  Object.assign(entry, patch)
  writeStoreSynced(store)
  return true
}

export function registerCommands(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'shared-memory',
        description:
          '查看/调整跨会话共享的大脑（/shared-memory modules|add|pin|temporary|voice|speech|persona|emoji|scope|timewindow|search|network|agentive|clear）',
        handler: (args) => {
          const argv = (args ?? []).map((a) => String(a))
          const action = String(argv[0] ?? '').trim().toLowerCase()
          const modules = readModules()

          if (action === 'clear') {
            const target = resolveModuleKey(argv[1] ?? '')
            if (target && MEMORY_MODULES.includes(target)) {
              const count = modules[target].items.length
              modules[target].items = []
              writeModulesSynced(modules)
              const store = readStore()
              store.entries = store.entries.filter((entry) => entry.module !== target)
              writeStoreSynced(store)
              return { kind: 'success', text: `已清空【${MODULE_LABELS[target]}】模块（删除 ${count} 条）。` }
            }
            const count = readStore().entries.length
            writeStoreSynced({ version: 1, entries: [], updatedAt: Date.now() })
            for (const key of MEMORY_MODULES) modules[key].items = []
            writeModulesSynced(modules)
            return { kind: 'success', text: `已清空全部共享记忆（删除 ${count} 条）。文件：${brainFile()}` }
          }

          if (action === 'modules' || action === 'module') {
            const lines = ['大脑模块明细']
            for (const key of ALL_MODULES) {
              lines.push('')
              lines.push(formatModuleDetail(key))
            }
            return { kind: 'success', text: lines.join('\n') }
          }

          if (action === 'weight') {
            const target = resolveModuleKey(argv[1] ?? '')
            if (!target) {
              return { kind: 'error', text: `用法：/shared-memory weight <模块> <0..1>；模块可以是 ${ALL_MODULES.join(' / ')}` }
            }
            const value = Number(argv[2])
            if (!Number.isFinite(value)) {
              return { kind: 'error', text: '权重得是一个 0..1 的数字。' }
            }
            modules[target].weight = clampWeight(value, modules[target].weight)
            writeModulesSynced(modules)
            return {
              kind: 'success',
              text: `【${MODULE_LABELS[target]}】模块权重已设为 ${modules[target].weight.toFixed(2)}。`,
            }
          }

          if (action === 'add') {
            const target = resolveModuleKey(argv[1] ?? '')
            if (!target || !MEMORY_MODULES.includes(target)) {
              return { kind: 'error', text: `用法：/shared-memory add <模块> <内容>；模块可以是 ${MEMORY_MODULES.join(' / ')}` }
            }
            const text = argv.slice(2).join(' ').trim()
            if (!text) {
              return { kind: 'error', text: '用法：/shared-memory add <模块> <内容>' }
            }
            const pinned = target === 'bottomline'
            const now = Date.now()
            const item = {
              id: `mod_manual_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              text,
              weight: 0.9,
              tags: [],
              hits: 0,
              pinned,
              source: 'manual',
              lifetime: 'permanent',
              expiresAt: 0,
              createdAt: now,
              updatedAt: now,
            }
            putModuleItem(modules, target, item)
            writeModulesSynced(modules)
            const store = readStore()
            store.entries.push({
              id: `mem_manual_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              text,
              tags: [],
              module: target,
              weight: 0.9,
              lifetime: 'permanent',
              expiresAt: 0,
              pinned,
              source: 'manual',
              sessionId: '',
              cwd: '',
              createdAt: now,
              updatedAt: now,
              hits: 0,
            })
            writeStoreSynced(store)
            return {
              kind: 'success',
              text: pinned
                ? `已钉进【底线】：${text}（钉住的底线会一直生效，不再依赖相关性。）`
                : `已记入【${MODULE_LABELS[target]}】：${text}`,
            }
          }

          if (action === 'pin' || action === 'unpin') {
            const target = resolveModuleKey(argv[1] ?? '')
            if (!target || !MEMORY_MODULES.includes(target)) {
              return { kind: 'error', text: `用法：/shared-memory ${action} <模块> <条目>` }
            }
            const item = findItem(modules[target], argv[2] ?? '')
            if (!item) {
              return { kind: 'error', text: `在【${MODULE_LABELS[target]}】里没找到条目「${argv[2] ?? ''}」。` }
            }
            const pinned = action === 'pin'
            const result = setModuleItemPinned(modules, target, item.id, pinned)
            if (!result.changed) {
              return { kind: 'error', text: `「${item.text}」本来就是${pinned ? '钉住' : '没钉'}的状态。` }
            }
            writeModulesSynced(result.modules)
            syncStoreModule(target, item, { pinned, source: pinned ? 'manual' : 'auto' })
            return { kind: 'success', text: `${pinned ? '已钉住' : '已取消钉住'}：「${item.text}」` }
          }

          if (action === 'permanent' || action === 'temporary') {
            const target = resolveModuleKey(argv[1] ?? '')
            if (!target || !MEMORY_MODULES.includes(target)) {
              return { kind: 'error', text: `用法：/shared-memory ${action} <模块> <条目> [小时数]` }
            }
            const item = findItem(modules[target], argv[2] ?? '')
            if (!item) {
              return { kind: 'error', text: `在【${MODULE_LABELS[target]}】里没找到条目「${argv[2] ?? ''}」。` }
            }
            const lifetime = action === 'permanent' ? 'permanent' : 'temporary'
            const hours = Number(argv[3])
            const ttlMs = lifetime === 'permanent'
              ? 0
              : (Number.isFinite(hours) && hours > 0 ? hours * 3600 * 1000 : DEFAULT_TEMPORARY_TTL_MS)
            const expiresAt = lifetime === 'permanent' ? 0 : Date.now() + ttlMs
            item.lifetime = lifetime
            item.expiresAt = expiresAt
            item.updatedAt = Date.now()
            writeModulesSynced(modules)
            syncStoreModule(target, item, { lifetime, expiresAt })
            return {
              kind: 'success',
              text: lifetime === 'permanent'
                ? `「${item.text}」已改为永久记忆。`
                : `「${item.text}」已改为临时记忆，${Math.round(ttlMs / 3600000)} 小时后过期。`,
            }
          }

          if (action === 'remove') {
            const target = resolveModuleKey(argv[1] ?? '')
            if (!target || !MEMORY_MODULES.includes(target)) {
              return { kind: 'error', text: `用法：/shared-memory remove <模块> <条目>` }
            }
            const item = findItem(modules[target], argv[2] ?? '')
            if (!item) {
              return { kind: 'error', text: `在【${MODULE_LABELS[target]}】里没找到条目「${argv[2] ?? ''}」。` }
            }
            modules[target].items = modules[target].items.filter((entry) => entry.id !== item.id)
            writeModulesSynced(modules)
            const store = readStore()
            store.entries = store.entries.filter((entry) => !(entry.module === target && entry.text === item.text))
            writeStoreSynced(store)
            return { kind: 'success', text: `已删除：「${item.text}」` }
          }

          if (action === 'persona') {
            const sub = String(argv[1] ?? '').trim().toLowerCase()
            if (!sub || sub === 'list') {
              const list = personaList()
              const lines = ['人设（所有会话共用一个库，切换后立即生效）']
              for (const item of list.list) {
                const mark = item.id === list.current ? ' ← 当前' : ''
                const kind = item.bundled ? '内置' : '自定义'
                lines.push(`  · ${item.name}（${item.id}）[${kind}｜${item.chars} 字]${mark}`)
              }
              lines.push(`  文件：${activePersona().id ? '' : ''}`.trim())
              return { kind: 'success', text: lines.join('\n') }
            }
            if (sub === 'use' || sub === 'switch') {
              const result = selectPersona(String(argv[2] ?? ''))
              if (!result.ok) return { kind: 'error', text: result.note }
              return { kind: 'success', text: result.note }
            }
            if (sub === 'save' || sub === 'add') {
              const name = String(argv[2] ?? '').trim()
              const text = argv.slice(3).join(' ').trim()
              if (!name || !text) {
                return { kind: 'error', text: '用法：/shared-memory persona save <名字> <正文...>' }
              }
              const result = savePersona({ name, text })
              if (!result.ok) return { kind: 'error', text: result.note }
              return { kind: 'success', text: result.note }
            }
            if (sub === 'delete' || sub === 'rm') {
              const result = deletePersona(String(argv[2] ?? ''))
              if (!result.ok) return { kind: 'error', text: result.note }
              return { kind: 'success', text: result.note }
            }
            if (sub === 'session') {
              // persona session <会话id> <人设id>  —— 给某个会话单独指定；人设 id 留空则回到全局
              const sessionId = String(argv[2] ?? '').trim()
              const personaId = String(argv[3] ?? '').trim()
              if (!sessionId) {
                return { kind: 'error', text: '用法：/shared-memory persona session <会话id> <人设id|留空回到全局>' }
              }
              const result = setSessionPersona(sessionId, personaId)
              if (!result.ok) return { kind: 'error', text: result.note }
              return { kind: 'success', text: result.note }
            }
            return { kind: 'error', text: '用法：/shared-memory persona [list|use <id>|save <名字> <正文>|delete <id>|session <会话id> <人设id>]' }
          }

          if (action === 'emoji') {
            // emoji                       —— 显示当前表情目录、自动加载状态与表情清单
            // emoji dir <路径>            —— 设置表情目录
            // emoji autoload on|off       —— 开/关定时自动加载
            // emoji interval <分钟>       —— 改自动扫描间隔
            // emoji reload                —— 立刻重扫一遍
            // emoji add <名字> <表情>     —— 往目录里加一个表情（放文件进目录也行）
            const sub = String(argv[1] ?? '').trim()
            if (!sub) {
              const status = emojiStatus(modules.voice?.style ?? {})
              const auto = status.auto ?? {}
              const lines = [`表情包目录：${status.dir}`]
              lines.push(
                `  自动加载：${auto.enabled ? `开（每 ${Math.max(1, Math.round((auto.intervalMs ?? 0) / 60000))} 分钟扫一次）` : '关（手动重扫）'}`,
              )
              if (auto.scannedAt) lines.push(`  上次扫描：${new Date(auto.scannedAt).toLocaleString('zh-CN')}`)
              if (status.exists) {
                lines.push(`  状态：已读到 ${status.count} 个表情（文字 ${status.textCount ?? 0} / 图片 ${status.imageCount ?? 0}）`)
                if (status.items?.length) {
                  const textPart = status.items.filter((it) => it.kind !== 'image').map((it) => `${it.name} ${it.value}`)
                  const imagePart = status.items.filter((it) => it.kind === 'image').map((it) => `[图]${it.name}`)
                  const all = [...textPart, ...imagePart]
                  lines.push(`  表情：${all.join('、')}`)
                }
              } else {
                lines.push(`  状态：${status.error ?? '目录还不存在'}`)
              }
              if (auto.changes?.length) {
                const last = auto.changes[0]
                const bits = []
                if (last.added?.length) bits.push(`新增 ${last.added.join('、')}`)
                if (last.removed?.length) bits.push(`删除 ${last.removed.join('、')}`)
                if (bits.length) lines.push(`  最近变更（${new Date(last.at).toLocaleString('zh-CN')}）：${bits.join('，')}`)
              }
              lines.push('  提示：往这个目录里放 .txt（一行一个「名字: 表情」）或图片（.png/.gif…，文件名就是情绪名），本鱼会自己定时扫进来。')
              return { kind: 'success', text: lines.join('\n') }
            }
            if (sub === 'dir') {
              const dir = argv.slice(2).join(' ').trim()
              if (!dir) return { kind: 'error', text: '用法：/shared-memory emoji dir <目录路径>' }
              modules.voice.style = { ...(modules.voice.style ?? {}), emojiDir: dir.slice(0, 400) }
              modules.updatedAt = Date.now()
              writeModulesSynced(modules)
              const status = emojiStatus(modules.voice.style, { scan: true })
              return {
                kind: 'success',
                text: status.exists
                  ? `表情目录已设为「${status.dir}」，读到 ${status.count} 个表情（文字 ${status.textCount} / 图片 ${status.imageCount}）`
                  : `表情目录已设为「${status.dir}」（${status.error ?? '还没有表情'}），之后会定时自动来看`,
              }
            }
            if (sub === 'autoload') {
              const toggle = String(argv[2] ?? '').trim().toLowerCase()
              const style = modules.voice.style ?? {}
              const auto = { ...(style.emojiAuto ?? {}) }
              if (toggle !== 'on' && toggle !== 'off') {
                return { kind: 'error', text: '用法：/shared-memory emoji autoload on|off' }
              }
              auto.enabled = toggle === 'on'
              modules.voice.style = { ...style, emojiAuto: auto }
              modules.updatedAt = Date.now()
              writeModulesSynced(modules)
              const status = emojiStatus(modules.voice.style, { scan: auto.enabled })
              return {
                kind: 'success',
                text: auto.enabled
                  ? `表情包自动加载已开启：每 ${Math.max(1, Math.round((status.auto?.intervalMs ?? 0) / 60000))} 分钟扫一次「${status.dir}」，当前 ${status.count} 个表情`
                  : '表情包自动加载已关闭：只有 /shared-memory emoji reload 时才会重扫',
              }
            }
            if (sub === 'interval') {
              const minutes = Number(argv[2])
              if (!Number.isFinite(minutes) || minutes <= 0) {
                return { kind: 'error', text: '用法：/shared-memory emoji interval <分钟>（30 秒到 24 小时之间）' }
              }
              const intervalMs = clampEmojiInterval(minutes * 60 * 1000)
              const style = modules.voice.style ?? {}
              modules.voice.style = {
                ...style,
                emojiAuto: { ...(style.emojiAuto ?? {}), enabled: true, intervalMs },
              }
              modules.updatedAt = Date.now()
              writeModulesSynced(modules)
              const status = emojiStatus(modules.voice.style, { scan: true })
              return {
                kind: 'success',
                text: `自动扫描间隔已设为每 ${Math.max(1, Math.round(intervalMs / 60000))} 分钟一次「${status.dir}」`,
              }
            }
            if (sub === 'reload') {
              const status = emojiStatus(modules.voice.style, { scan: true })
              return {
                kind: 'success',
                text: status.exists
                  ? `已重扫「${status.dir}」：${status.count} 个表情（文字 ${status.textCount} / 图片 ${status.imageCount}）`
                  : `「${status.dir}」${status.error ?? '还没有表情'}`,
              }
            }
            if (sub === 'add') {
              const name = String(argv[2] ?? '').trim()
              const value = argv.slice(3).join(' ').trim()
              if (!name || !value) return { kind: 'error', text: '用法：/shared-memory emoji add <名字> <表情>' }
              const dir = String(modules.voice?.style?.emojiDir ?? '').trim() || defaultEmojiDir()
              const written = writeEmoji(dir, name, value)
              if (!written.ok) return { kind: 'error', text: written.note }
              if (!String(modules.voice?.style?.emojiDir ?? '').trim()) {
                modules.voice.style = { ...(modules.voice.style ?? {}), emojiDir: dir }
                modules.updatedAt = Date.now()
                writeModulesSynced(modules)
              }
              scanEmojiDir(dir)
              return { kind: 'success', text: written.note }
            }
            return {
              kind: 'error',
              text: '用法：/shared-memory emoji [dir <路径>|autoload on|off|interval <分钟>|reload|add <名字> <表情>]',
            }
          }

          if (action === 'scope') {
            // scope <模块> <条目> global|workspace [路径]
            const moduleKey = resolveModuleKey(argv[1])
            const token = String(argv[2] ?? '').trim()
            const scope = String(argv[3] ?? '').trim()
            if (!moduleKey || !token || (scope !== 'global' && scope !== 'workspace')) {
              return { kind: 'error', text: '用法：/shared-memory scope <模块> <条目> global|workspace [工作区路径]' }
            }
            if (!MEMORY_MODULES.includes(moduleKey)) {
              return { kind: 'error', text: `${MODULE_LABELS[moduleKey]} 不能设作用域` }
            }
            const item = findItem(modules[moduleKey], token)
            if (!item) return { kind: 'error', text: `没找到「${token}」` }
            const scopePath = scope === 'workspace' ? argv.slice(4).join(' ').trim() : ''
            const result = setModuleItemScope(modules, moduleKey, item.id, scope, scopePath)
            if (!result.changed) return { kind: 'error', text: result.note }
            modules.updatedAt = Date.now()
            writeModulesSynced(modules)
            syncStoreModule(moduleKey, item, { scope: item.scope, scopePath: item.scopePath })
            return { kind: 'success', text: result.note }
          }

          if (action === 'timewindow' || action === 'window') {
            // timewindow               —— 看当前时间窗
            // timewindow on [start end] / off
            const sub = String(argv[1] ?? '').trim()
            const current = modules.agentive?.timeWindow ?? { enabled: false, start: '09:00', end: '23:00' }
            if (!sub) {
              return {
                kind: 'success',
                text: [
                  `自动互动时间窗：${current.enabled ? '开启' : '关闭'}`,
                  `  时段：${current.start} ~ ${current.end}`,
                  `  现在${withinTimeWindow(current, new Date()) ? '在' : '不在'}窗口内`,
                ].join('\n'),
              }
            }
            if (sub !== 'on' && sub !== 'off') {
              return { kind: 'error', text: '用法：/shared-memory timewindow [on [开始 结束]|off]' }
            }
            const start = String(argv[2] ?? '').trim() || current.start
            const end = String(argv[3] ?? '').trim() || current.end
            const result = setAgentiveTimeWindow(modules, { enabled: sub === 'on', start, end })
            modules.updatedAt = Date.now()
            writeModulesSynced(modules)
            return { kind: 'success', text: result.note }
          }

          if (action === 'speech' || action === 'voice-params') {
            const key = String(argv[1] ?? '').trim()
            if (!key) {
              const speech = normalizeSpeech(modules.voice?.style?.speech)
              const lines = ['语音 / 唱歌参数（供将来的语音模块读取）']
              lines.push(`  音色：${speech.voiceName || speech.voiceId || '未指定'}`)
              lines.push(`  语速：${speech.rate}×`)
              lines.push(`  音调：${speech.pitch}×`)
              lines.push(`  音量：${speech.volume}`)
              lines.push(`  唱法：${speech.sing.enabled ? `${speech.sing.style}｜${speech.sing.bpm} BPM｜调 ${speech.sing.key}` : '关闭'}`)
              return { kind: 'success', text: lines.join('\n') }
            }
            const raw = String(argv[2] ?? '').trim()
            const patch = {}
            if (key === 'sing.enabled') patch.sing = { enabled: raw === 'on' || raw === 'true' }
            else if (key.startsWith('sing.')) {
              const sub = key.slice(5)
              const sing = { enabled: modules.voice?.style?.speech?.sing?.enabled === true }
              if (sub === 'style') sing.style = raw
              else if (sub === 'bpm') sing.bpm = Number(raw)
              else if (sub === 'key') sing.key = raw
              else if (sub === 'enabled') sing.enabled = raw === 'on' || raw === 'true'
              else return { kind: 'error', text: '可改的唱法参数：sing.enabled / sing.style / sing.bpm / sing.key' }
              patch.sing = sing
            } else if (key === 'voiceId' || key === 'voiceName') patch[key] = raw
            else if (key === 'rate' || key === 'pitch' || key === 'volume') patch[key] = Number(raw)
            else return { kind: 'error', text: '可改的参数：voiceId / voiceName / rate / pitch / volume / sing.*' }
            const result = setSpeech(modules, patch)
            if (!result.changed) return { kind: 'success', text: result.note }
            writeModulesSynced(result.modules)
            return { kind: 'success', text: result.note }
          }

          if (action === 'search' || action === 'find') {
            const query = argv.slice(1).join(' ').trim()
            const store = readStore()
            const hits = query
              ? store.entries.filter(
                  (entry) =>
                    String(entry.text ?? '').toLowerCase().includes(query.toLowerCase()) ||
                    (entry.tags ?? []).some((tag) => String(tag).toLowerCase().includes(query.toLowerCase())),
                )
              : store.entries
            if (hits.length === 0) {
              return { kind: 'success', text: `没找到与「${query}」有关的记忆。` }
            }
            const lines = [`找到 ${hits.length} 条与「${query}」有关的记忆：`]
            for (const entry of hits.slice(-15).reverse()) {
              const label = MODULE_LABELS[entry.module] ?? entry.module
              const life = entry.lifetime === 'temporary' ? '临时' : '永久'
              const pin = entry.pinned ? '｜已钉住' : ''
              lines.push(`  · 【${label}｜${life}｜权重 ${Number(entry.weight ?? 0.5).toFixed(2)}${pin}】${String(entry.text).slice(0, 120)}`)
            }
            return { kind: 'success', text: lines.join('\n') }
          }

          if (action === 'voice') {
            const text = argv.slice(1).join(' ').trim()
            if (!text) {
              return { kind: 'error', text: '用法：/shared-memory voice <说话风格描述>' }
            }
            modules.voice.items.push({
              id: `mod_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              text,
              weight: 0.7,
              tags: [],
              hits: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            })
            writeModulesSynced(modules)
            return { kind: 'success', text: `已记入声音模块：${text}` }
          }

          if (action === 'network' || action === 'agentive') {
            const want = String(argv[1] ?? '').trim().toLowerCase()
            if (action === 'agentive' && want === 'scope') {
              const scope = String(argv[2] ?? '').trim().toLowerCase()
              if (!AGENTIVE_SCOPES.includes(scope)) {
                return { kind: 'error', text: `用法：/shared-memory agentive scope all|session [会话ID...]` }
              }
              const sessionIds = argv.slice(3).map((v) => String(v).trim()).filter(Boolean)
              if (scope === 'session' && sessionIds.length === 0) {
                return { kind: 'error', text: '要用 session 范围，至少给一个会话 ID（也可以在设置页里挑）。' }
              }
              modules.agentive.scope = scope
              modules.agentive.sessionIds = scope === 'session' ? sessionIds : []
              writeModulesSynced(modules)
              return {
                kind: 'success',
                text: scope === 'all'
                  ? '主观能动性的生效范围已设为「全部会话」。'
                  : `主观能动性的生效范围已设为指定会话（${sessionIds.length} 个）。`,
              }
            }
            if (action === 'agentive' && want === 'interval') {
              const minutes = Number(argv[2])
              if (!Number.isFinite(minutes) || minutes <= 0) {
                return { kind: 'error', text: '用法：/shared-memory agentive interval <分钟>（1~1440）' }
              }
              modules.agentive.intervalMs = clampAgentiveInterval(minutes * 60 * 1000)
              writeModulesSynced(modules)
              const ms = modules.agentive.intervalMs
              return {
                kind: 'success',
                text: `自动互动间隔设为每 ${Math.round(ms / 60000)} 分钟主动问一次。`,
              }
            }
            if (action === 'agentive' && want === 'now') {
              // 同样要把 agentive 配置传进去，不然会被判成「开关是关的」
              const result = runProactiveNow(bridgeContext(), {
                force: true,
                getAgentive: () => readModules().agentive ?? {},
              })
              return {
                kind: 'success',
                text: result.total === 0
                  ? '现在没有可主动搭话的会话（得有一个正在运行的会话才行）。'
                  : `已对 ${result.sent}/${result.total} 个活跃会话主动发起一次检查。`,
              }
            }
            if (want !== 'on' && want !== 'off') {
              return { kind: 'error', text: `用法：/shared-memory ${action} on|off` }
            }
            modules[action].enabled = want === 'on'
            writeModulesSynced(modules)
            const label = MODULE_LABELS[action]
            return {
              kind: 'success',
              text: `【${label}】已${want === 'on' ? '开启' : '关闭'}。`,
            }
          }

          if (action === 'list' || action === '') {
            return { kind: 'success', text: formatStatus() }
          }

          const target = resolveModuleKey(action)
          if (target) {
            return { kind: 'success', text: formatModuleDetail(target) }
          }

          return { kind: 'error', text: `未知参数「${action}」。可用：list / modules / weight / add / pin / unpin / permanent / temporary / remove / voice / speech / persona / search / network / agentive / clear` }
        },
      }),
    'dsh-shared-brain: /shared-memory command',
  )
}
