/**
 * 表情包目录：把「表情」从单个 emoji 字符升级成一整个目录。
 *
 * 之前的做法是 `style.emoji = "🐟"` —— 只能填一个字符，想要「(๑•̀ㅂ•́)و✧」
 * 这种长表情就塞不下，插件作者想表达的情绪也就那么几种。
 *
 * 现在改成：
 *   - 用户在设置页指定一个**目录**（默认 `~/.dsh/storages/dsh-shared-brain/emoji`）
 *   - 目录里放 .txt / .md / .emojilist 文件，每个文件一个表情（文件名即表情名）
 *   - 也支持图片表情（.png / .jpg / .gif …），文件名就是情绪名
 *   - 插件把目录里的表情整理成一份清单，注入提示词，告诉模型「可以挑这些用」
 *   - 目录会被**定时自动扫描**（默认 5 分钟一次），往里丢文件不用再来设置页加一遍
 *
 * 为什么用目录而不是内置清单：内置清单永远追不上用户想要的表情，
 * 而且用户自己的梗只有他自己有。目录是最诚实的做法 —— 放什么就是什么。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, extname } from 'node:path'

/** 表情目录的默认位置。 */
export function defaultEmojiDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-shared-brain', 'emoji')
}

/** 支持的文本表情文件后缀。 */
const EMOJI_EXTENSIONS = ['.txt', '.md', '.emojilist', '.emoji']

/** 支持的图片表情后缀（文件名就是表情名）。 */
export const EMOJI_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']

/** 一个表情最多多长（防止有人塞一整篇进去）。 */
const MAX_EMOJI_LENGTH = 120

/** 目录里最多读多少个表情。 */
const MAX_EMOJI_FILES = 200

/** 单个图片表情最大字节数，超过就直接跳过（免得有人把电影丢进来）。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** 自动扫描的默认间隔：5 分钟。 */
export const DEFAULT_EMOJI_INTERVAL_MS = 5 * 60 * 1000

/** 自动扫描间隔下限：30 秒。 */
export const MIN_EMOJI_INTERVAL_MS = 30 * 1000

/** 自动扫描间隔上限：24 小时。 */
export const MAX_EMOJI_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 把用户/界面给的间隔夹到合理区间。 */
export function clampEmojiInterval(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EMOJI_INTERVAL_MS
  return Math.min(MAX_EMOJI_INTERVAL_MS, Math.max(MIN_EMOJI_INTERVAL_MS, Math.round(n)))
}

/**
 * 规整一个表情条目。
 *
 * 表情可以是：
 *   - 单个 emoji 字符（🐟）
 *   - 一段文本表情（(๑•̀ㅂ•́)و✧）
 *   - 带名字的组合（happy: (๑•̀ㅂ•́)و✧）—— 名字方便模型按语义挑
 */
export function normalizeEmoji(raw, name) {
  const text = String(raw ?? '').replace(/\r/g, '').trim()
  if (!text) return null
  const first = text.split('\n')[0].trim()
  if (!first) return null
  // 文件里可能写成「名字: 表情」——名字取前缀，正文只留表情
  const tagged = first.match(/^([\w\u4e00-\u9fa5-]{1,40})\s*[:：]\s*(.+)$/)
  const rawName = String(name ?? '').trim()
  const parsedName = tagged ? tagged[1] : ''
  const body = tagged ? tagged[2].trim() : first
  if (!body) return null
  const value = body.slice(0, MAX_EMOJI_LENGTH)
  return {
    name: rawName || parsedName || value.slice(0, 12),
    value,
  }
}

/**
 * 读一个表情目录，返回表情清单。
 *
 * 目录不存在时返回空清单（前端提示「目录还没有表情，放几个进去就行」）。
 * 目录里有坏文件时跳过那个文件，不影响其它表情。
 * 图片表情只记名字和文件路径（提示词里没法把图片塞进文字，只能让模型按名字挑）。
 *
 * @param {string} dir 表情目录
 * @returns {{ dir: string, exists: boolean, items: Array<object>, count: number, textCount: number, imageCount: number, signature: string, error?: string }}
 */
export function readEmojiDir(dir) {
  const empty = (resolved, error) => ({
    dir: resolved,
    exists: false,
    items: [],
    count: 0,
    textCount: 0,
    imageCount: 0,
    signature: '',
    error,
  })
  const target = String(dir ?? '').trim()
  if (!target) return empty('', '没有设置表情目录')
  const resolved = resolve(target)
  if (!existsSync(resolved)) return empty(resolved, '目录还不存在')
  try {
    if (!statSync(resolved).isDirectory()) return empty(resolved, '这不是一个目录')
  } catch (error) {
    return empty(resolved, String(error?.message ?? error))
  }

  const items = []
  const stamps = []
  let names = []
  try {
    names = readdirSync(resolved)
  } catch (error) {
    return { ...empty(resolved, undefined), exists: true, error: String(error?.message ?? error) }
  }

  for (const fileName of names.sort()) {
    if (items.length >= MAX_EMOJI_FILES) break
    const ext = extname(fileName).toLowerCase()
    const filePath = join(resolved, fileName)
    const base = fileName.replace(/\.[^.]+$/, '')

    if (EMOJI_IMAGE_EXTENSIONS.includes(ext)) {
      try {
        const stat = statSync(filePath)
        if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue
        items.push({ name: base.slice(0, 40), value: '', kind: 'image', file: filePath, size: stat.size })
        stamps.push(`${fileName}:${stat.size}:${Math.round(stat.mtimeMs)}`)
      } catch {
        // 坏文件跳过
      }
      continue
    }

    if (!EMOJI_EXTENSIONS.includes(ext)) continue
    try {
      const stat = statSync(filePath)
      if (!stat.isFile()) continue
      const raw = readFileSync(filePath, 'utf8')
      // 允许一个文件里写多行，每行一个表情（名字取行首的 name: 前缀）
      const lines = raw.split('\n').filter((line) => line.trim())
      if (lines.length > 1) {
        for (const line of lines) {
          if (items.length >= MAX_EMOJI_FILES) break
          const match = line.match(/^\s*([A-Za-z0-9_\-]{1,40})\s*[:：]\s*(.+)$/)
          const item = match
            ? normalizeEmoji(match[2], match[1])
            : normalizeEmoji(line, '')
          if (item) items.push({ ...item, kind: 'text' })
        }
        stamps.push(`${fileName}:${stat.size}:${Math.round(stat.mtimeMs)}`)
        continue
      }
      const item = normalizeEmoji(raw, base)
      if (item) items.push({ ...item, kind: 'text' })
      stamps.push(`${fileName}:${stat.size}:${Math.round(stat.mtimeMs)}`)
    } catch {
      // 坏文件跳过，不影响其它表情
    }
  }

  const textCount = items.filter((item) => item.kind !== 'image').length
  return {
    dir: resolved,
    exists: true,
    items,
    count: items.length,
    textCount,
    imageCount: items.length - textCount,
    signature: stamps.join('|'),
  }
}

/**
 * 写一个表情文件（设置页的「加一个表情」用；放文件进目录也行）。
 */
export function writeEmoji(dir, name, value) {
  const target = String(dir ?? '').trim()
  if (!target) return { ok: false, note: '没有设置表情目录' }
  const item = normalizeEmoji(value, name)
  if (!item) return { ok: false, note: '表情不能为空' }
  const resolved = resolve(target)
  try {
    mkdirSync(resolved, { recursive: true })
    const safe = (item.name || item.value.slice(0, 12)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'emoji'
    const filePath = join(resolved, `${safe}.txt`)
    writeFileSync(filePath, `${item.name}: ${item.value}\n`, 'utf8')
    return { ok: true, note: `已加入表情「${item.name}」`, file: filePath }
  } catch (error) {
    return { ok: false, note: String(error?.message ?? error) }
  }
}

/**
 * 渲染表情清单，注入提示词。
 *
 * 只在没有单个 emoji 时才提示用目录里的；两个都设了就都告诉模型。
 */
export function renderEmoji(style, dirInfo) {
  const lines = []
  const single = String(style?.emoji ?? '').trim()
  if (single) lines.push(`默认表情：${single}`)
  const items = dirInfo?.items ?? []
  const textItems = items.filter((item) => item.kind !== 'image')
  const imageItems = items.filter((item) => item.kind === 'image')
  if (textItems.length > 0) {
    const list = textItems.map((item) => `${item.name}:${item.value}`).join('、')
    lines.push(
      `表情包（可挑选使用，按语境选一个合适的，别一次全甩出来）：${list}`,
    )
  }
  if (imageItems.length > 0) {
    const names = imageItems.slice(0, 60).map((item) => item.name).join('、')
    const more = imageItems.length > 60 ? ` 等 ${imageItems.length} 个` : ''
    lines.push(`表情图（图片表情，情绪浓的时候按名字挑一个，共 ${imageItems.length} 个）：${names}${more}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 定时自动加载：目录里的表情由定时器自己扫进来，不用每次手动「加一个」
// ---------------------------------------------------------------------------

/** 单进程内的扫描状态（一个宿主只关心一个表情目录）。 */
const loader = {
  dir: '',
  enabled: false,
  intervalMs: DEFAULT_EMOJI_INTERVAL_MS,
  timer: null,
  info: null,
  scannedAt: 0,
  changes: [],
  error: '',
}

/** 从声音模块的 style 里解析出自动加载配置。 */
export function emojiAutoConfig(style) {
  const dir = resolve(String(style?.emojiDir ?? '').trim() || defaultEmojiDir())
  const auto = style?.emojiAuto && typeof style.emojiAuto === 'object' ? style.emojiAuto : {}
  return {
    dir,
    enabled: auto.enabled !== false,
    intervalMs: clampEmojiInterval(auto.intervalMs),
  }
}

function stopTimer() {
  if (loader.timer) {
    clearInterval(loader.timer)
    loader.timer = null
  }
}

function startTimer() {
  stopTimer()
  if (!loader.enabled || loader.intervalMs <= 0) return
  const timer = setInterval(() => {
    try {
      scanEmojiDir(loader.dir)
    } catch {
      // 扫描失败也不算错，下一轮再试
    }
  }, loader.intervalMs)
  // 别因为一个定时器把宿主进程吊着不退出
  if (typeof timer.unref === 'function') timer.unref()
  loader.timer = timer
}

/** 对比两次扫描，记下新增/删除的表情名（给界面显示「最近变更」）。 */
function rememberChanges(prev, next) {
  if (!prev || !prev.items) return
  const before = new Set(prev.items.map((item) => item.name))
  const after = new Set(next.items.map((item) => item.name))
  const added = [...after].filter((name) => !before.has(name)).slice(0, 20)
  const removed = [...before].filter((name) => !after.has(name)).slice(0, 20)
  if (!added.length && !removed.length) return
  loader.changes.unshift({ at: Date.now(), added, removed, count: next.count })
  if (loader.changes.length > 20) loader.changes.length = 20
}

/** 立刻扫一次目录（定时器和「立即重扫」按钮都走这里）。 */
export function scanEmojiDir(dir) {
  const info = readEmojiDir(dir)
  if (!loader.dir || loader.dir === info.dir) rememberChanges(loader.info, info)
  loader.dir = info.dir || loader.dir
  loader.info = info
  loader.scannedAt = Date.now()
  loader.error = info.error ?? ''
  return info
}

/** 当前自动加载状态（给界面、/shared-memory emoji 用）。 */
export function loaderSummary() {
  const info = loader.info
  return {
    enabled: loader.enabled,
    intervalMs: loader.intervalMs,
    dir: loader.dir,
    scannedAt: loader.scannedAt,
    exists: info?.exists === true,
    count: info?.count ?? 0,
    textCount: info?.textCount ?? 0,
    imageCount: info?.imageCount ?? 0,
    error: loader.error || info?.error || '',
    changes: loader.changes.slice(0, 10),
  }
}

/**
 * 按配置确保定时器在跑：配置没变就不动（所以可以放心在每次渲染提示词时调用）。
 */
export function ensureEmojiLoader(style) {
  const cfg = emojiAutoConfig(style)
  const same = cfg.dir === loader.dir && cfg.enabled === loader.enabled && cfg.intervalMs === loader.intervalMs
  if (same) {
    if (cfg.enabled && !loader.info) scanEmojiDir(cfg.dir)
    if (cfg.enabled && !loader.timer) startTimer()
    return loaderSummary()
  }
  stopTimer()
  loader.dir = cfg.dir
  loader.enabled = cfg.enabled
  loader.intervalMs = cfg.intervalMs
  if (cfg.enabled) {
    scanEmojiDir(cfg.dir)
    startTimer()
  }
  return loaderSummary()
}

/** 关掉定时器（插件卸载 / 测试收尾用）。 */
export function stopEmojiLoader() {
  stopTimer()
  loader.enabled = false
}

/**
 * 表情目录状态：目录内容 + 自动加载信息。
 *
 * @param {object} style 声音模块的 style
 * @param {{ scan?: boolean }} options scan=true 表示「现在立刻重扫一遍」
 */
export function emojiStatus(style, options = {}) {
  ensureEmojiLoader(style)
  const cfg = emojiAutoConfig(style)
  if (options.scan === true) scanEmojiDir(cfg.dir)
  const info = loader.info && loader.info.dir === cfg.dir ? loader.info : readEmojiDir(cfg.dir)
  return {
    ...info,
    configured: String(style?.emojiDir ?? '').trim() !== '',
    defaultDir: defaultEmojiDir(),
    auto: loaderSummary(),
  }
}
