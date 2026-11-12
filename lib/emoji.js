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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, extname, relative, isAbsolute } from 'node:path'
import { builtinStatus } from './emoji-builtin.js'

/** 表情目录的默认位置。 */
export function defaultEmojiDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-shared-brain', 'emoji')
}

// ────────────────────────────────────────────────────────────────────
// dsh-emoji 表情包（阶段 B2，只读）
// ────────────────────────────────────────────────────────────────────
//
// dsh-emoji 那套协议解决的是「怎么把表情渲染成图」，包放在
// `$DSH_HOME/emoji-packs/<id>@<version>/`，里面是
// `pack.json` + `images/<key>.png`（40 个 key，一个不少）。
//
// 共享大脑**不写这个目录**，也不抢渲染的活 —— 只是读一读「装了哪些包、
// 有哪些 key 可用」，好在提示词里说清楚「可以挑这些」。装了 dsh-emoji 就由它
// 负责把 Unicode 改写成图片；没装的话这里只是一句建议，不会出错。

/** dsh-emoji 的包目录（只读）。 */
export function emojiPacksDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'emoji-packs')
}

/** 契约名。别自己发明 keySet —— 认不出来就当没有。 */
export const EMOJI_PACK_KEYSET = 'dsh-emoji-core@1'

/**
 * 扫描已安装的 dsh-emoji 表情包（只读，不创建目录）。
 *
 * 返回 `{ dir, packs: [{ id, name, version, keys }] }`。
 * 坏包（缺 pack.json、keySet 不认识、images 里没有 png）直接跳过，不报错 ——
 * 表情是锦上添花，不该因为它把提示词生成搞挂。
 */
/** 单个表情包最多允许多少张图（防塞一整个硬盘进来）。 */
export const EMOJI_PACK_MAX_KEYS = 200

/** 单张图最大字节数（8MB，跟文字表情的门槛一致）。 */
export const EMOJI_PACK_MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** 图片最大边长（像素）—— 超过就是「不是表情，是壁纸」。 */
export const EMOJI_PACK_MAX_DIMENSION = 1024

/** PNG 文件头：89 50 4E 47 0D 0A 1A 0A */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 读 PNG 头里的宽高（IHDR 在文件开头 8+8+4+4 处）。
 * 读不出来就返回 null —— 宁可当成不合格，也不冒险。
 */
function pngSize(file) {
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return null
  }
  if (buf.length < 24) return null
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  return { width, height, bytes: buf.length }
}

/**
 * 校验一个表情包，返回这份清单。
 *
 * 返回 `{ ok, id, name, version, keys, problems }`：
 *   - ok=false 表示这个包不合格，不该被提示词引用
 *   - problems 是人话版的毛病清单（给设置页显示）
 *
 * 校验项：manifest 齐全、keySet 对得上、图数在上限内、每张图
 * 真是 PNG、没超出尺寸/体积上限。
 */
export function validateEmojiPack(packDir, manifest, keys) {
  const problems = []
  const id = String(manifest?.id ?? '')
  const name = String(manifest?.name ?? manifest?.id ?? '')
  const version = String(manifest?.version ?? '')
  if (!id) problems.push('pack.json 里没有 id')
  if (!name) problems.push('pack.json 里没有 name')
  if (!version) problems.push('pack.json 里没有 version')
  if (String(manifest?.keySet ?? '') !== EMOJI_PACK_KEYSET) {
    problems.push(`keySet 不是 ${EMOJI_PACK_KEYSET}`)
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    problems.push('images 里没有 png')
    return { ok: false, id, name, version, keys: [], problems }
  }
  if (keys.length > EMOJI_PACK_MAX_KEYS) {
    problems.push(`图太多（${keys.length} 张，上限 ${EMOJI_PACK_MAX_KEYS} 张）`)
  }
  const imagesDir = join(packDir, 'images')
  const good = []
  for (const key of keys) {
    const file = join(imagesDir, `${key}.png`)
    const size = pngSize(file)
    if (!size) {
      problems.push(`${key}.png 不是合法的 PNG`)
      continue
    }
    if (size.bytes > EMOJI_PACK_MAX_IMAGE_BYTES) {
      problems.push(`${key}.png 太大（${size.bytes} 字节）`)
      continue
    }
    if (size.width > EMOJI_PACK_MAX_DIMENSION || size.height > EMOJI_PACK_MAX_DIMENSION) {
      problems.push(`${key}.png 尺寸太大（${size.width}x${size.height}）`)
      continue
    }
    good.push(key)
  }
  return {
    ok: problems.length === 0 && good.length > 0,
    id,
    name,
    version,
    keys: good.sort(),
    problems,
  }
}

export function scanEmojiPacks(dir = emojiPacksDir()) {
  const root = String(dir ?? '').trim() || emojiPacksDir()
  if (!existsSync(root)) return { dir: root, packs: [] }

  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
  } catch {
    return { dir: root, packs: [] }
  }

  const packs = []
  const rejected = []
  for (const name of names.sort()) {
    const packDir = join(root, name)
    try {
      const manifestFile = join(packDir, 'pack.json')
      if (!existsSync(manifestFile)) continue
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
      if (String(manifest?.keySet ?? '') !== EMOJI_PACK_KEYSET) continue
      const imagesDir = join(packDir, 'images')
      if (!existsSync(imagesDir)) continue
      const keys = readdirSync(imagesDir)
        .filter((file) => extname(file).toLowerCase() === '.png')
        .map((file) => file.slice(0, -4))
      if (keys.length === 0) continue
      const checked = validateEmojiPack(packDir, manifest, keys)
      if (!checked.ok) {
        // 不合格的包不引用，但把毛病记下来给设置页显示
        rejected.push({
          id: checked.id || name,
          name: checked.name || name,
          version: checked.version,
          dir: packDir,
          problems: checked.problems,
        })
        continue
      }
      packs.push({
        id: checked.id || name,
        name: checked.name || name,
        version: checked.version,
        dir: packDir,
        keys: checked.keys,
      })
    } catch {
      // 坏包跳过
    }
  }
  return { dir: root, packs, rejected }
}

/** 包扫描缓存：提示词每轮都会渲染，别每轮都去 readdir。 */
let packCache = { at: 0, dir: "", info: null }
const PACK_CACHE_TTL_MS = 60 * 1000

/**
 * 带缓存的包扫描（60 秒 TTL）。
 *
 * 为什么要缓存：`renderVoice` 每轮都跑，`renderEmoji` 又要读包目录；
 * 不缓存就是每说一句话 readdir 一遍 `$DSH_HOME/emoji-packs`。
 * 60 秒足够「刚装完包切回来就生效」，也不至于把磁盘当磁盘阵列使。
 */
export function scanEmojiPacksCached(root = emojiPacksDir(), now = Date.now()) {
  const dir = String(root ?? "").trim() || emojiPacksDir()
  if (packCache.info && packCache.dir === dir && now - packCache.at < PACK_CACHE_TTL_MS) {
    return packCache.info
  }
  const info = scanEmojiPacks(dir)
  packCache = { at: now, dir, info }
  return info
}

/** 测试用：清掉包缓存。 */
export function clearEmojiPackCache() {
  packCache = { at: 0, dir: "", info: null }
}

/** 把表情包渲染成提示词里的一行（没装包就返回空串）。 */
export function renderEmojiPacks(info) {
  const packs = info?.packs ?? []
  if (packs.length === 0) return ''
  const names = packs.map((pack) => (pack.version ? `${pack.name} ${pack.version}` : pack.name))
  const total = packs.reduce((sum, pack) => sum + pack.keys.length, 0)
  return `语义表情包（dsh-emoji 协议，共 ${packs.length} 个包 / ${total} 张图）：${names.join('、')}。表情名用语义 key（happy / hug / sigh …），具体挑哪个由情绪亲和度决定。`
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
/**
 * 路径安全：拒绝 UNC / 设备路径 / 带 `..` 的路径。
 *
 * 2026-11-06 修：之前 dir 完全由请求给，`\\host\share` 会让宿主去连 SMB
 * （带出 NTLM 凭据），`.txt` 又能落到任意可写目录。这里先把外连路径堵掉。
 * 2026-11-12 补：`..` 一律不收 —— 设置页给的就是绝对路径，带层级跳转只可能是想越权；
 * 另外空字节、设备名也一并挡掉。
 */
export function isUnsafeEmojiPath(target) {
  const raw = String(target ?? '').trim()
  if (!raw) return true
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return true
  if (/[\0\r\n]/.test(raw)) return true
  if (raw.split(/[\\/]+/).some((part) => part === '..')) return true
  return false
}

/** 能解析符号链接就解析，路径不存在就按原样算（不抛）。 */
function realOrSelf(target) {
  const abs = resolve(String(target ?? ''))
  try {
    return realpathSync.native(abs)
  } catch {
    return abs
  }
}

/**
 * 表情目录不能设在这些地方。
 *
 * 2026-11-12 加：设置页允许自己挑目录（老大的表情包就在 D:\zh 下面），所以不能做白名单，
 * 只能反过来挡「明摆着不该往里放东西」的地方：系统目录、程序目录、盘根、AppData。
 * 挡的不是「读不到」，是「往那儿写 .txt」—— 往 Program Files 或 C:\Windows 里落文件是提权的前奏。
 */
const FORBIDDEN_DIR_NAMES = ['windows', 'program files', 'program files (x86)', 'programdata', 'system32', '$recycle.bin', 'recovery', 'boot', 'perflogs']

export function isForbiddenEmojiRoot(target) {
  const abs = realOrSelf(target)
  if (!abs) return true
  // 盘根（C:\ 或 D:）—— 往里丢文件太脏
  if (/^[a-z]:[\\/]*$/i.test(abs)) return true
  const lower = abs.toLowerCase().replace(/[\\/]+$/, '')
  const roots = []
  for (const key of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'APPDATA', 'LOCALAPPDATA']) {
    const value = String(process.env[key] ?? '').trim()
    if (value) roots.push(resolve(value).toLowerCase().replace(/[\\/]+$/, ''))
  }
  for (const root of roots) {
    if (!root) continue
    if (lower === root || lower.startsWith(root + '\\') || lower.startsWith(root + '/')) return true
  }
  // 环境变量不全的时候按目录名兜一层
  const parts = lower.split(/[\\/]+/).filter(Boolean)
  if (parts.some((part) => FORBIDDEN_DIR_NAMES.includes(part))) return true
  return false
}

/**
 * child 是否落在 root 之下（同一目录也算）。root 为空表示不限制。
 *
 * 2026-11-12：两边都先按真实路径解析一遍 —— 否则 root 下放一个指向 `C:\\Windows`
 * 的 symlink / junction，`relative()` 看路径字符串是「在下面」，实际写进去的是别处。
 */
export function isInsideDir(root, child) {
  const base = String(root ?? '').trim()
  if (!base) return true
  const rel = relative(realOrSelf(base), realOrSelf(child))
  if (!rel) return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 读一个表情目录，返回表情清单。
 */
export function readEmojiDir(dir, options = {}) {
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
  if (isUnsafeEmojiPath(target)) return empty(resolved, '不允许的路径（不支持网络路径）')
  if (!isInsideDir(options?.root, resolved)) return empty(resolved, '不在允许的表情根目录下')
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
export function writeEmoji(dir, name, value, options = {}) {
  const target = String(dir ?? '').trim()
  if (!target) return { ok: false, note: '没有设置表情目录' }
  if (isUnsafeEmojiPath(target)) return { ok: false, note: '不允许的路径（不支持网络路径）' }
  const item = normalizeEmoji(value, name)
  if (!item) return { ok: false, note: '表情不能为空' }
  const resolved = resolve(target)
  // 2026-11-06 修：只允许写进当前表情根目录（默认目录或用户显式设的那个）。
  if (!isInsideDir(options?.root, resolved)) return { ok: false, note: '只能写在表情根目录下' }
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
export function renderEmoji(style, dirInfo, packInfo) {
  const lines = []
  // 装了 dsh-emoji 的包就在提示词里点名（B2）——只读，不写它的目录。
  const packLine = renderEmojiPacks(packInfo)
  if (packLine) lines.push(packLine)
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
  // PERF-6：和 renderVoice 用同一份缓存（60s TTL），别每次设置页/状态查询都重扫目录
  const packs = options.packs === false ? { dir: '', packs: [] } : scanEmojiPacksCached()
  // 内置表情包（2026-11-03）：插件自带 100 张大肥鱼 GIF，不走 $DSH_HOME/emoji-packs，
  // 所以这里单独报一份，设置页能把「内置」和「用户自己装的」分开显示。
  let builtin = null
  if (options.builtin !== false) {
    try {
      builtin = builtinStatus()
    } catch {
      builtin = null
    }
  }
  return {
    ...info,
    configured: String(style?.emojiDir ?? '').trim() !== '',
    defaultDir: defaultEmojiDir(),
    auto: loaderSummary(),
    packs: packs.packs,
    packsDir: packs.dir,
    packsRejected: packs.rejected ?? [],
    builtin,
  }
}
