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
 *   /shared-memory mood               查看心情状态（配置 + 各会话当前心情）
 *   /shared-memory mood on|off        开关心情
 *   /shared-memory mood-config [键 值] 查看/修改心情配置
 *   /shared-memory mood-reset [会话id] 清掉心情（不给 id 就是全部）
 */
import { readStore, brainFile, DEFAULT_TEMPORARY_TTL_MS } from './store.js'
import { tagsForEntry } from './autotag.js'
import { redactSecrets } from './summarize.js'
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
import { runProactiveNow, proactiveStatus, PROACTIVE_INTERVAL_JITTER, clampMaxPerRound } from './proactive.js'
import { bridgeContext, notifyModulesChanged, memoryCheckNow, sessionCatalog, applyItemScope } from './bridge.js'
import { renderCheckLine, junkListing } from './health.js'
import { buildKnowledgeIndex, reviewQueue, bookOf } from './knowledge.js'
import { readEmojiDir, writeEmoji, defaultEmojiDir, emojiStatus, clampEmojiInterval, scanEmojiDir } from './emoji.js'
import {
  activePersona,
  personaFile,
  personaList,
  selectPersona,
  savePersona,
  deletePersona,
  setSessionPersona,
} from './persona.js'
import {
  readEmotionStore,
  writeEmotionStore,
  normalizeMoodConfig,
  moodStatus,
  moodBand,
  emotionFile,
  DIMS,
  MOOD_DEFAULTS,
  INJECT_MODES,
  emotionSemantics,
} from './emotion.js'

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
    const baseMin = Math.max(1, Math.round((proactive.intervalMs ?? 0) / 60000))
    lines.push(`  间隔：基准每 ${baseMin} 分钟主动问一次（实际每次在 ${Math.max(1, Math.round(baseMin * (1 - PROACTIVE_INTERVAL_JITTER)))}~${Math.round(baseMin * (1 + PROACTIVE_INTERVAL_JITTER))} 分钟之间随机）`)
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
  lines.push('心情（情感模块）')
  const moodCfg = normalizeMoodConfig(readEmotionStore().config)
  const moodSessions = Object.values(readEmotionStore().states ?? {})
  lines.push(`  开关：${moodCfg.enabled ? '已开启' : '已关闭'} · ${moodSessions.length} 个会话有心情记录`)
  if (moodSessions.length > 0) {
    for (const s of moodSessions.slice(0, 3)) {
      lines.push(`  · ${String(s.sessionId ?? '').slice(0, 8)}：${Math.round(s.mood ?? 0)}（${moodBand(s.mood ?? 0).label}）`)
    }
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
    const baseMin = Math.max(1, Math.round((bucket.intervalMs ?? 900000) / 60000))
    lines.push(`  主动间隔：基准每 ${baseMin} 分钟问一次（实际在 ${Math.max(1, Math.round(baseMin * (1 - PROACTIVE_INTERVAL_JITTER)))}~${Math.round(baseMin * (1 + PROACTIVE_INTERVAL_JITTER))} 分钟之间随机）`)
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

/**
 * 心情总览：配置 + 各会话当前心情 + 时间线尾部。
 */
function formatMood() {
  const store = readEmotionStore()
  const cfg = normalizeMoodConfig(store.config)
  const modeText = { off: '关闭', label: '只报情绪', event: '报情绪 + 发生的事' }
  const lines = ['心情（情感模块的新维度）']
  lines.push(`  文件：${emotionFile()}`)
  lines.push(`  开关：${cfg.enabled ? '已开启' : '已关闭'} · 说法：${modeText[cfg.injectMode] ?? cfg.injectMode}`)
  lines.push(`  基线 ${cfg.moodBase} · 下限 ${cfg.moodFloor} · 半衰期 ${cfg.decayHalfHours}h · 可信度门槛 ${cfg.injectConfidence} · 每天最多 ${cfg.injectPerDay} 次`)

  const sessions = Object.values(store.states ?? {})
  if (sessions.length === 0) {
    lines.push('')
    lines.push('  还没有心情记录（开启后聊几轮就会有了）。')
    return lines.join('\n')
  }

  for (const s of sessions) {
    lines.push('')
    lines.push(`  会话 ${String(s.sessionId ?? '').slice(0, 8)}：心情 ${Math.round(s.mood ?? 0)}（${moodBand(s.mood ?? 0).label}）`)
    const dims = (DIMS ?? [])
      .map(([key, label]) => `${label} ${Math.round(s.dims?.[key] ?? 0)}`)
      .join(' · ')
    if (dims) lines.push(`    ${dims}`)
    const tl = s.timeline ?? []
    if (tl.length > 0) {
      const last = tl[tl.length - 1]
      lines.push(`    最近：${last.reason || '（没写理由）'}`)
      lines.push(`    共 ${tl.length} 条记录`)
    }
  }
  return lines.join('\n')
}

/**
 * 由 index.js 注入的「联网学习」实现。
 * 抽成注入是因为真正的提炼逻辑要用宿主模型（ctx.llm），只在 index.js 里拿得到；
 * 直接 import 会形成 index → commands → index 的环。
 */
let learnRunner = null

export function setLearnRunner(fn) {
  learnRunner = typeof fn === 'function' ? fn : null
}

export function registerCommands(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'shared-memory',
        description:
          '查看/调整跨会话共享的大脑（/shared-memory modules|add|pin|temporary|voice|speech|persona|emoji|scope|timewindow|search|learn|knowledge|network|agentive|mood|retag|check|junk|clear）',
        // 2026-11-11：保持同步返回。命令 handler 的返回约定没查到宿主会 await，
        // 界面上拿到 Promise 就是一串 [object Promise]。学习是异步活儿，
        // 所以这里先回一句「开始学了」，结果抓完再推回来。
        handler: (args) => {
          const argv = (args ?? []).map((a) => String(a))
          const action = String(argv[0] ?? '').trim().toLowerCase()
          const modules = readModules()

          if (action === 'learn') {
            // 2026-11-11：以前只能 curl 打 /api/dsh-shared-brain/learn，
            // 会话里没有入口。这里给一条命令行通路，共用同一份实现。
            // 抓网页 + 调模型要好几秒，命令本身同步返回，结果事后推一条消息。
            const rest = argv.slice(1)
            const arg = rest.join(' ').trim()
            if (!arg) {
              return { kind: 'error', text: '用法：/shared-memory learn <网址>｜learn text <一段文字>' }
            }
            if (!learnRunner) return { kind: 'error', text: '学习通道还没就绪（插件还在启动）' }
            const isUrl = /^https?:\/\//i.test(arg)
            const asText = rest[0] === 'text' ? rest.slice(1).join(' ').trim() : isUrl ? '' : arg
            if (rest[0] === 'text' && !asText) {
              return { kind: 'error', text: '用法：/shared-memory learn text <一段文字>' }
            }
            const deliver = (text) => {
              // 推回当前会话：命令跑完时这一轮可能已经结束，
              // 只能借主动互动那条通道把结果塞回来。
              try {
                const agents = ctx?.get?.('agents')
                const list = typeof agents?.list === 'function' ? agents.list() : []
                const current = sessionCatalog()?.current ?? ''
                const target = list.find((a) => {
                  const id = a?.session?.header?.id ?? ''
                  return current && id && (id === current || id === `session-${current}` || `session-${id}` === current)
                }) ?? list[0]
                if (typeof target?.followup === 'function') {
                  target.followup({
                    id: `learn-${Date.now()}`,
                    role: 'user',
                    content: [{ type: 'text', text }],
                    source: { kind: 'plugin:dsh-shared-brain', form: 'learn-result' },
                  })
                  return
                }
              } catch {}
              // 没有可用的会话通道就只落日志，别假装送达
              console.warn('[dsh-shared-brain] 学习结果没能推回会话：', text)
            }
            Promise.resolve()
              .then(() => learnRunner({ url: isUrl ? arg : '', text: asText }))
              .then((res) => {
                if (!res?.ok) {
                  deliver(`学习没成：${res?.error ?? '未知原因'}`)
                  return
                }
                const lines = [`从「${res.source || '这段文字'}」提炼 ${res.extracted} 条，入库 ${res.added} 条`]
                if (res.skipped) lines.push(`跳过重复 ${res.skipped} 条`)
                for (const item of res.preview ?? []) lines.push(`  ${item}`)
                deliver(lines.join('\n'))
              })
              .catch((error) => deliver(`学习失败：${String(error?.message ?? error)}`))
            return { kind: 'success', text: `开始学${isUrl ? '这个网页' : '这段文字'}了，抓完我把结果发过来。` }
          }

          if (action === 'knowledge' || action === 'reviewknowledge') {
            // 2026-11-11：知识库三件套以前只有 HTTP 接口（addKnowledge /
            // reviewKnowledge / knowledgeIndex），界面上没入口。这里给命令行。
            const items = Array.isArray(modules.knowledge?.items) ? modules.knowledge.items : []
            const sub = String(argv[1] ?? 'index').trim().toLowerCase()
            if (sub === 'review' || sub === '复习') {
              const queue = reviewQueue(items, { limit: 8 })
              if (!queue.length) return { kind: 'success', text: '没有要复习的：近 30 天要么刚更新过，要么被用过了。' }
              const lines = [`该复习的 ${queue.length} 条（久没更新、也没被用过）：`]
              for (const item of queue) {
                const book = bookOf(item) || '未标注'
                lines.push(`- ${String(item.text ?? '').replace(/\s+/g, ' ').slice(0, 48)}……（${book}｜${item.id}）`)
              }
              return { kind: 'success', text: lines.join('\n') }
            }
            if (sub === 'stats' || sub === '统计') {
              const withSource = items.filter((it) => bookOf(it)).length
              const withTags = items.filter((it) => Array.isArray(it.tags) && it.tags.length > 0).length
              const used = items.filter((it) => Number(it.hits) > 0).length
              return {
                kind: 'success',
                text: [
                  `知识库 ${items.length} 条：带出处 ${withSource}、带标签 ${withTags}、被召回过 ${used}`,
                  '知识库里是「结论」，原文与出处另有阅读层（/shared-memory search 能查到）。',
                ].join('\n'),
              }
            }
            const index = buildKnowledgeIndex(items, { limit: 12 })
            if (!index.length) return { kind: 'success', text: '知识库还是空的。' }
            const lines = [`知识库 ${items.length} 条，按书分：`]
            for (const group of index) {
              const topics = group.topics.length ? `（${group.topics.join('、')}）` : ''
              lines.push(`- ${group.source} · ${group.count} 条${topics}`)
            }
            return { kind: 'success', text: lines.join('\n') }
          }

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
            // 2026-11-04（E1）：情感模块支持显式指定三个语义字段。
            //   /shared-memory add emotion 老大讨厌啰嗦 --sentiment dislike --target 老大 --intimacy 0.9
            // 没给就留空，后面从正文自动推断。
            const rest = argv.slice(2)
            const flags = { intimacy: undefined, sentiment: undefined, target: undefined }
            const words = []
            for (let i = 0; i < rest.length; i += 1) {
              const token = String(rest[i] ?? '')
              const name = token.replace(/^--/, '')
              if (
                (name === 'intimacy' || name === 'sentiment' || name === 'target') &&
                i + 1 < rest.length &&
                !String(rest[i + 1] ?? '').startsWith('--')
              ) {
                const value = String(rest[i + 1] ?? '').trim()
                if (name === 'intimacy') {
                  const num = Number(value)
                  if (!Number.isFinite(num)) {
                    return { kind: 'error', text: '亲密度得是一个 0..1 的数字。' }
                  }
                  flags.intimacy = Math.min(1, Math.max(0, num))
                } else {
                  flags[name] = value
                }
                i += 1
                continue
              }
              words.push(token)
            }
            const text = words.join(' ').trim()
            if (!text) {
              return { kind: 'error', text: '用法：/shared-memory add <模块> <内容>' }
            }
            const pinned = target === 'bottomline'
            const now = Date.now()
            // 手动加的条目也要脱敏——记忆是长期存储，别把密钥写进去
            const safeText = redactSecrets(text)
            // 2026-11-04（E1）：情感条目带 intimacy / sentiment / target，
            // 没显式给就从正文推断（modules.json 与扁平库两份都要带）。
            const emotionFields = target === 'emotion' ? emotionSemantics(flags, safeText) : {}
            const item = {
              id: `mod_manual_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              text: safeText,
              weight: 0.9,
              tags: [],
              hits: 0,
              pinned,
              source: 'manual',
              lifetime: 'permanent',
              expiresAt: 0,
              createdAt: now,
              updatedAt: now,
              ...emotionFields,
            }
            putModuleItem(modules, target, item)
            writeModulesSynced(modules)
            const store = readStore()
            store.entries.push({
              id: `mem_manual_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              text: safeText,
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
              ...emotionFields,
            })
            writeStoreSynced(store)
            const emotionNote =
              target === 'emotion'
                ? `（亲密度 ${emotionFields.intimacy.toFixed(2)}、${emotionFields.sentiment}、对象「${emotionFields.target}」）`
                : ''
            return {
              kind: 'success',
              text: pinned
                ? `已钉进【底线】：${text}（钉住的底线会一直生效，不再依赖相关性。）`
                : `已记入【${MODULE_LABELS[target]}】：${text}${emotionNote}`,
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
              // 2026-11-06 修：这里以前三元两边都是空串，永远只印一个「文件：」。
              lines.push(`  文件：${personaFile()}`)
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
            // scope <模块> <条目> global|workspace|session [路径]
            const moduleKey = resolveModuleKey(argv[1])
            const token = String(argv[2] ?? '').trim()
            const scope = String(argv[3] ?? '').trim()
            if (!moduleKey || !token || !['global', 'workspace', 'session'].includes(scope)) {
              return { kind: 'error', text: '用法：/shared-memory scope <模块> <条目> global|workspace|session [工作区路径]' }
            }
            if (!MEMORY_MODULES.includes(moduleKey)) {
              return { kind: 'error', text: `${MODULE_LABELS[moduleKey]} 不能设作用域` }
            }
            const item = findItem(modules[moduleKey], token)
            if (!item) return { kind: 'error', text: `没找到「${token}」` }
            // 2026-11-11：补上「只在这个会话里用」，以及工作区不填路径时默认用当前目录。
            // 以前只有 global/workspace，界面上能选的会话级在命令行里做不了。
            const catalog = sessionCatalog()
            const currentSession = String(catalog?.current ?? '')
            let currentCwd = ''
            for (const ws of catalog?.workspaces ?? []) {
              for (const session of ws.sessions ?? []) {
                if (session.id === currentSession) currentCwd = String(session.cwd || ws.path || '')
              }
            }
            let scopePath = ''
            let scopeSession = ''
            if (scope === 'workspace') {
              scopePath = argv.slice(4).join(' ').trim() || currentCwd
              if (!scopePath) return { kind: 'error', text: '限到工作区得给路径；不给的话我得知道当前会话在哪个目录' }
            }
            if (scope === 'session') {
              if (!currentSession) return { kind: 'error', text: '定位不到当前会话，先用 global 或 workspace' }
              scopeSession = currentSession
            }
            const result = applyItemScope({
              module: moduleKey,
              id: item.id,
              scope,
              scopePath,
              scopeSession,
            })
            if (!result.ok) return { kind: 'error', text: result.error }
            notifyModulesChanged()
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
                text: `自动互动基准间隔设为每 ${Math.round(ms / 60000)} 分钟主动问一次（实际每次在 ${Math.max(1, Math.round(ms / 60000 * (1 - PROACTIVE_INTERVAL_JITTER)))}~${Math.round(ms / 60000 * (1 + PROACTIVE_INTERVAL_JITTER))} 分钟之间随机）。`,
              }
            }
            if (action === 'agentive' && want === 'max-per-round') {
              // 2026-11-09：一轮最多给几个会话发消息。默认 1，
              // 免得 4 个会话在场时同一秒各收到一条，像刷屏。
              const count = Number(argv[2])
              if (!Number.isFinite(count) || count < 1) {
                return { kind: 'error', text: '用法：/shared-memory agentive max-per-round <个数>（1~20）' }
              }
              modules.agentive.maxPerRound = clampMaxPerRound(count)
              writeModulesSynced(modules)
              const n = modules.agentive.maxPerRound
              return {
                kind: 'success',
                text: `已设为每轮最多给 ${n} 个会话主动发消息，其余顺延到下一轮。`,
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
            // 命令改了开关也要通知一次：以前这里只写盘，定时器不会重启，
            // 于是「/shared-memory agentive on」看起来开了，实际一次都不会触发。
            notifyModulesChanged()
            const label = MODULE_LABELS[action]
            return {
              kind: 'success',
              text: `【${label}】已${want === 'on' ? '开启' : '关闭'}。`,
            }
          }

          if (action === 'list' || action === '') {
            return { kind: 'success', text: formatStatus() }
          }

          // ── 补标签（老条目一次性补，只补不删）────────────────────
          if (action === 'retag') {
            const store = readStore()
            const all = argv[1] === 'all'
            const dryRun = argv[1] === 'dry' || argv[2] === 'dry'
            let changed = 0
            for (const entry of store.entries ?? []) {
              // 默认只补知识类（读过的书、知识点）—— 那是最值钱的一批，
              // 而且标签明确（书名/作者/篇名）。工作记忆里混着英文思考碎片，
              // 全量补会把「Now」「let」也变成标签，要补得显式加 all。
              if (!all && entry.module !== 'knowledge') continue
              const before = Array.isArray(entry.tags) ? entry.tags : []
              const next = tagsForEntry(entry)
              if (next.length === before.length && next.every((t, i) => t === before[i])) continue
              changed += 1
              // 不动 updatedAt：补标签不该让老条目伪装成「刚更新」，否则新鲜度加权全乱。
              if (!dryRun) entry.tags = next
            }
            if (changed > 0 && !dryRun) writeStoreSynced(store)
            return {
              kind: 'success',
              text: dryRun
                ? `有 ${changed} 条记忆能补上标签（dry 模式没写）。去掉 dry 再跑一次就落盘。`
                : changed === 0
                  ? '这些记忆的标签都齐了，不用补。'
                  : `给 ${changed} 条记忆补了标签（原有标签保留，只补不删）。`,
            }
          }

          // ── 记忆体检（只读）──────────────────────────────────────
          if (action === 'junk' || action === 'clean') {
            // 只列不删：里面可能有唯一副本，删之前得老大点头。
            const check = memoryCheckNow()
            const lines = ['数据目录里可清理的东西：', '']
            lines.push(...junkListing(check.junk ?? null))
            return { kind: 'success', text: lines.join('\n') }
          }

          if (action === 'check' || action === 'health') {
            const check = memoryCheckNow()
            const lines = [renderCheckLine(check), '']
            const mods = Object.entries(check.byModule ?? {})
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${MODULE_LABELS[k] ?? k} ${n}`)
            if (mods.length) lines.push(`分布：${mods.join(' / ')}`)
            lines.push(`作用域：global ${check.scope.global} / workspace ${check.scope.workspace} / session ${check.scope.session}`)
            lines.push(`来源：auto ${check.source.auto} / sync ${check.source.sync} / manual ${check.source.manual}`)
            if (check.dbBytes) {
              const kb = (n) => `${Math.round(n / 1024)}KB`
              lines.push(`库文件：brain.db ${kb(check.dbBytes)}，WAL ${kb(check.walBytes)}`)
            }
            if (check.duplicates.length) {
              lines.push('', '重复的正文：')
              for (const dup of check.duplicates.slice(0, 3)) {
                lines.push(`  · ${String(dup.text ?? '').slice(0, 40)}（${dup.count} 条）`)
              }
            }
            const notes = (check.suggestions ?? []).filter((s) => s.level !== 'ok')
            if (notes.length) {
              lines.push('', '建议：')
              for (const note of notes) lines.push(`  ${note.level === 'warn' ? '⚠' : '·'} ${note.text}`)
            } else {
              lines.push('', '没发现需要动的。')
            }
            return { kind: 'success', text: lines.join('\n') }
          }

          // ── 心情（mood）──────────────────────────────────────────
          if (action === 'mood') {
            return { kind: 'success', text: formatMood() }
          }

          if (action === 'mood-on' || action === 'mood-off') {
            const store = readEmotionStore()
            const want = action === 'mood-on'
            store.config = normalizeMoodConfig({ ...store.config, enabled: want })
            store.updatedAt = Date.now()
            writeEmotionStore(store)
            notifyModulesChanged()
            return {
              kind: 'success',
              text: want
                ? '心情已开启：以后每轮聊完本鱼会自己判断一次，变化够大才会说出来。'
                : '心情已关闭：不再判断，也不再把心情说给你听。',
            }
          }

          if (action === 'mood-config') {
            const store = readEmotionStore()
            const sub2 = String(argv[1] ?? '').trim().toLowerCase()
            if (!sub2) {
              const cfg = normalizeMoodConfig(store.config)
              const modeText = { off: '关闭', label: '只报情绪', event: '报情绪 + 发生的事' }
              return {
                kind: 'success',
                text: [
                  '心情配置',
                  `  开关：${cfg.enabled ? '已开启' : '已关闭'}`,
                  `  说法：${modeText[cfg.injectMode] ?? cfg.injectMode}`,
                  `  基线心情：${cfg.moodBase}（心情会慢慢回到这个值）`,
                  `  心情下限：${cfg.moodFloor}`,
                  `  半衰期：${cfg.decayHalfHours} 小时（情绪本身 90 分钟淡下去）`,
                  `  可信度门槛：${cfg.injectConfidence}（低于这个只记在心里不说）`,
                  `  每天最多说：${cfg.injectPerDay} 次`,
                  `  显著阈值：心情 ±${cfg.sigMood}、单轮原始幅度 ±${cfg.sigMoodRaw}、某根情绪 ${cfg.sigDim}`,
                  `  判定模型：${cfg.judgeProvider || '（跟随当前会话）'}${cfg.judgeModel ? ` / ${cfg.judgeModel}` : ''}`,
                  '  用法：/shared-memory mood-config <键> <值>',
                  '  可改键：injectMode(off|label|event) moodBase moodFloor decayHalfHours injectConfidence injectPerDay sigMood sigMoodRaw sigDim judgeProvider judgeModel aliases',
                ].join('\n'),
              }
            }
            const key = String(argv[1] ?? '').trim()
            const current = normalizeMoodConfig(store.config)
            const patch = {}
            if (key === 'injectMode') {
              const mode = String(argv[2] ?? '').trim().toLowerCase()
              if (!INJECT_MODES.includes(mode)) {
                return { kind: 'error', text: `用法：/shared-memory mood-config injectMode ${INJECT_MODES.join('|')}` }
              }
              patch.injectMode = mode
            } else if (key === 'moodBase' || key === 'moodFloor' || key === 'decayHalfHours'
              || key === 'injectConfidence' || key === 'injectPerDay' || key === 'sigMood' || key === 'sigMoodRaw' || key === 'sigDim') {
              const value = Number(argv[2])
              if (!Number.isFinite(value)) {
                return { kind: 'error', text: `${key} 得是一个数字。` }
              }
              patch[key] = value
            } else if (key === 'judgeProvider' || key === 'judgeModel' || key === 'aliases') {
              patch[key] = String(argv.slice(2).join(' '))
            } else {
              return {
                kind: 'error',
                text: '可改键：injectMode / moodBase / moodFloor / decayHalfHours / injectConfidence / injectPerDay / sigMood / sigMoodRaw / sigDim / judgeProvider / judgeModel / aliases',
              }
            }
            const next = normalizeMoodConfig({ ...current, ...patch })
            store.config = next
            store.updatedAt = Date.now()
            writeEmotionStore(store)
            notifyModulesChanged()
            const shown = key === 'injectMode' ? next.injectMode : (patch[key] ?? '')
            return { kind: 'success', text: `心情配置已改：${key} = ${shown}` }
          }

          if (action === 'mood-reset') {
            const store = readEmotionStore()
            const sessionId = String(argv[1] ?? '').trim()
            const before = Object.keys(store.states ?? {}).length
            if (sessionId) {
              // key 是去前缀后的会话 id，两种写法都试一遍
              const key = sessionId.replace(/^session-/, '')
              if (store.states?.[key]) delete store.states[key]
            } else {
              store.states = {}
            }
            const after = Object.keys(store.states ?? {}).length
            store.updatedAt = Date.now()
            writeEmotionStore(store)
            return {
              kind: 'success',
              text: sessionId
                ? (before === after ? '这个会话本来就没有心情记录。' : '这个会话的心情已清空。')
                : `心情已全部清空（${before} 份）。`,
            }
          }

          const target = resolveModuleKey(action)
          if (target) {
            return { kind: 'success', text: formatModuleDetail(target) }
          }

          // 2026-11-06 修：这份清单以前跟实际实现脱节（少了六个）。按 315–947 行的
          // 实际分支重列一遍，以后加命令记得同步改这里。
          return {
            kind: 'error',
            text: `未知参数「${action}」。可用：list / modules / module / weight / add / pin / unpin / permanent / temporary / remove / scope / voice / speech / voice-params / persona / emoji / search / find / learn / network / agentive / timewindow / window / mood / mood-on / mood-off / mood-config / mood-reset / check / junk / retag / clear`,
          }
        },
      }),
    'dsh-shared-brain: /shared-memory command',
  )
}
