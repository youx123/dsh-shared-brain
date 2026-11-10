/**
 * 内置语义表情（大肥鱼表情包，ai-biaoqingbao 的 240×240 版）
 *
 * 为什么要自带一套：
 *   dsh-emoji 插件能把手写表情渲染成图，但它要求用户另外装插件 + 装表情包。
 *   共享大脑自己带一套，就能做到「不装任何插件，心情上下文里直接给现成的 markdown」，
 *   模型只要原样贴出去，客户端/网页就会把图显示出来。
 *
 * 素材许可（重要，分发/商用前必读）：
 *   assets/emoji/ 下 100 个 GIF 来自 https://github.com/diwer/ai-biaoqingbao
 *   采用 CC BY-NC-SA 4.0（署名 · 非商业 · 相同方式共享），文件名见 NOTICE.txt。
 *   **代码是 MIT，素材不是**；商用需自行取得授权。
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMOJI_USAGE } from './emoji-affinity.js'

/** 静态素材路由前缀（kind: 'prefix'）。 */
export const BUILTIN_EMOJI_ROUTE = '/api/dsh-shared-brain/emoji'

/** 内置包元信息（展示用）。 */
export const BUILTIN_PACK = Object.freeze({
  id: 'dafeiyu',
  name: '大肥鱼表情包',
  version: '1.0.0',
  license: 'CC BY-NC-SA 4.0',
  source: 'https://github.com/diwer/ai-biaoqingbao',
  displayMode: 'inline',
})

/**
 * 40 个语义 key → 具体 GIF 文件。
 * key 与 dsh-emoji 的 dsh-emoji-core@1 契约保持一致，
 * 这样「装了 dsh-emoji」和「没装」两种情况下，共享大脑挑出来的 key 是同一套。
 */
export const BUILTIN_KEY_FILES = Object.freeze({
  happy: '002.gif', // 开心
  sad: '085.gif', // 心累
  confused: '078.gif', // 疑惑
  watching: '045.gif', // 静静看戏
  angry: '005.gif', // 生气
  speechless: '006.gif', // 无语
  doge: '047.gif', // 拿捏了
  overloaded: '070.gif', // CPU烧了
  neutral: '041.gif', // 已老实
  laughing: '029.gif', // 笑死
  crying: '036.gif', // 我裂开了
  sweating: '072.gif', // 让我缓缓
  thinking: '093.gif', // 确认眼神
  okay: '023.gif', // 没问题
  nodding: '025.gif', // 明白
  sleeping: '007.gif', // 困了
  hurt: '004.gif', // 委屈
  peeking: '046.gif', // 吃瓜
  approve: '003.gif', // 点赞
  heart: '013.gif', // 喜欢
  shy: '082.gif', // 害羞
  'star-eyes': '081.gif', // 期待
  'laugh-cry': '031.gif', // 绷不住了
  touched: '048.gif', // 我懂你
  scared: '080.gif', // 紧张
  facepalm: '037.gif', // 麻了
  'eye-roll': '079.gif', // 嫌弃
  sigh: '086.gif', // 好累
  frustrated: '039.gif', // 红温了
  playful: '083.gif', // 偷笑
  snickering: '032.gif', // 离谱
  sarcastic: '050.gif', // 你礼貌吗
  cool: '091.gif', // 满血复活
  celebrate: '094.gif', // 恭喜
  cheer: '016.gif', // 加油
  thanks: '008.gif', // 谢谢
  sorry: '014.gif', // 对不起
  hug: '010.gif', // 抱抱
  please: '028.gif', // 拜托了
  applause: '027.gif', // 辛苦了
})

/** key → 中文名（写进提示词时模型更容易理解语境）。 */
export const BUILTIN_KEY_LABELS = Object.freeze({
  happy: '开心',
  sad: '心累',
  confused: '疑惑',
  watching: '静静看戏',
  angry: '生气',
  speechless: '无语',
  doge: '拿捏了',
  overloaded: 'CPU烧了',
  neutral: '已老实',
  laughing: '笑死',
  crying: '我裂开了',
  sweating: '让我缓缓',
  thinking: '确认眼神',
  okay: '没问题',
  nodding: '明白',
  sleeping: '困了',
  hurt: '委屈',
  peeking: '吃瓜',
  approve: '点赞',
  heart: '喜欢',
  shy: '害羞',
  'star-eyes': '期待',
  'laugh-cry': '绷不住了',
  touched: '我懂你',
  scared: '紧张',
  facepalm: '麻了',
  'eye-roll': '嫌弃',
  sigh: '好累',
  frustrated: '红温了',
  playful: '偷笑',
  snickering: '离谱',
  sarcastic: '你礼貌吗',
  cool: '满血复活',
  celebrate: '恭喜',
  cheer: '加油',
  thanks: '谢谢',
  sorry: '对不起',
  hug: '抱抱',
  please: '拜托了',
  applause: '辛苦了',
})

/** 素材目录（lib/ 的上一级的 assets/emoji）。 */
export function builtinAssetDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'emoji')
}

/**
 * 把一个名字解析成磁盘上的绝对路径；解析不出来（含非法名/越界）返回 null。
 * 允许两种名字：40 个语义 key，或三位数字编号（001…100）。
 */
export function resolveBuiltinAsset(name, dir = builtinAssetDir()) {
  const raw = String(name ?? '').trim().replace(/\.gif$/i, '')
  if (!raw) return null
  let file = null
  if (Object.prototype.hasOwnProperty.call(BUILTIN_KEY_FILES, raw)) file = BUILTIN_KEY_FILES[raw]
  else if (/^\d{1,3}$/.test(raw)) file = String(Number(raw)).padStart(3, '0') + '.gif'
  if (!file) return null
  const full = join(dir, file)
  // 只允许 assets/emoji 直下的文件，挡住 ../ 之类
  if (dirname(full) !== dir) return null
  return existsSync(full) ? full : null
}

/** 拼出可以直接贴进 markdown 的图片地址。 */
export function builtinEmojiUrl(port, name) {
  const key = String(name ?? '').trim()
  if (!key) return ''
  return `http://127.0.0.1:${String(port)}${BUILTIN_EMOJI_ROUTE}/${encodeURIComponent(key)}.gif`
}

/** 一段现成的 markdown 图片（模型照抄即可，避免它自己拼错 URL）。 */
export function builtinEmojiMarkdown(port, key) {
  const url = builtinEmojiUrl(port, key)
  if (!url) return ''
  return `![${BUILTIN_KEY_LABELS[key] || key}](${url})`
}

/**
 * 把「这次适合用哪几个表情」渲染成提示词片段。
 * 只发**现成的 markdown**，不发 URL 模板 —— 模型拼 URL 十有八九会拼错。
 */
export function renderBuiltinEmojiHint(proposal, port) {
  if (!proposal || !port) return ''
  const mode = String(proposal.mode || 'auto')
  if (mode === 'off') return ''
  const limit = Number(proposal.limit ?? 0)
  if (!(limit > 0)) return ''
  // 2026-11-10：摆出来给模型挑的多一点（最多 6 张），但一轮能用的还是 limit 个。
  // 以前只摆 3 张，档位又不变，于是天天都是同样三张图。
  const keys = Array.isArray(proposal.keys) ? proposal.keys.slice(0, Math.max(limit, 6)) : []
  if (keys.length === 0) return ''
  // 2026-11-10：把「什么时候用」写进 alt 文字（![偷笑·想逗一下](url)）。
  // alt 不显示，所以不会破坏画面；模型照抄整段就行，选图时有依据。
  const snippets = keys
    .map((key) => {
      const url = builtinEmojiUrl(port, key)
      if (!url) return ''
      const label = BUILTIN_KEY_LABELS[key] || key
      const usage = EMOJI_USAGE[key]
      return `![${usage ? `${label}·${usage}` : label}](${url})`
    })
    .filter(Boolean)
  if (snippets.length === 0) return ''
  return [
    '（表情图）想用表情就原样贴下面这段，一个字都别改（别改网址、别换名字）：',
    snippets.join('  '),
    `一轮最多 ${String(limit)} 个，挑最贴那句话的一张，别每句都放，也别硬凑。`,
  ].join('\n')
}

/** 内置素材概况（状态页/设置页用）。 */
export function builtinStatus(dir = builtinAssetDir()) {
  const empty = { dir, exists: false, count: 0, bytes: 0, mapped: 0, missing: [], pack: BUILTIN_PACK }
  if (!existsSync(dir)) return empty
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.gif'))
  } catch {
    return empty
  }
  const set = new Set(files)
  const missing = Object.values(BUILTIN_KEY_FILES).filter((f) => !set.has(f))
  let bytes = 0
  for (const f of files) {
    try {
      bytes += statSync(join(dir, f)).size
    } catch {
      /* 单个文件读不到不算错 */
    }
  }
  return {
    dir,
    exists: true,
    count: files.length,
    bytes,
    mapped: Object.keys(BUILTIN_KEY_FILES).length - missing.length,
    missing,
    pack: BUILTIN_PACK,
  }
}

function isLoopback(address) {
  // 2026-11-06 修：原来空地址也算回环，等于「拿不到来源就放行」。
  const value = String(address || '')
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function send(response, status, headers, body) {
  response.writeHead?.(status, headers)
  if (body === undefined) response.end?.()
  else response.end?.(body)
}

/**
 * 静态素材 handler（挂在 BUILTIN_EMOJI_ROUTE 的 prefix 路由上）。
 * 只认 GET/HEAD，只认本机回环，其余一律 404/403 —— 素材是本地资源，不该被外网抓。
 */
export function handleBuiltinEmojiRequest(request, response, options = {}) {
  const dir = options.dir || builtinAssetDir()
  try {
    const method = String(request.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      send(response, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, 'method not allowed')
      return true
    }
    const remote = request.socket?.remoteAddress
    if (!isLoopback(remote)) {
      send(response, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'forbidden')
      return true
    }
    const parsed = new URL(String(request.url || '/'), 'http://127.0.0.1')
    let pathname = parsed.pathname
    if (!pathname.startsWith(BUILTIN_EMOJI_ROUTE + '/')) {
      send(response, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
      return true
    }
    let rest = pathname.slice(BUILTIN_EMOJI_ROUTE.length + 1)
    try {
      rest = decodeURIComponent(rest)
    } catch {
      send(response, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
      return true
    }
    if (!rest.toLowerCase().endsWith('.gif')) {
      send(response, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
      return true
    }
    const name = rest.slice(0, -4)
    const file = resolveBuiltinAsset(name, dir)
    if (!file) {
      send(response, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found')
      return true
    }
    const size = statSync(file).size
    const headers = {
      'content-type': 'image/gif',
      'content-length': String(size),
      'cache-control': 'public, max-age=86400, immutable',
    }
    response.writeHead?.(200, headers)
    if (method === 'HEAD') {
      response.end?.()
      return true
    }
    createReadStream(file).pipe(response)
    return true
  } catch {
    try {
      send(response, 500, { 'content-type': 'text/plain; charset=utf-8' }, 'internal error')
    } catch {
      /* 连接已经断了就算了 */
    }
    return true
  }
}
