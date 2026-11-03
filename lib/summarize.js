/**
 * 每轮对话的摘要生成：把一轮往返压成一条可存下来的记忆。
 *
 * 用户选择的是「自动把每轮对话摘要入库」（方案 B）。摘要要满足三点：
 *   - 短（一两句话，不能把提示词撑爆）
 *   - 有信息量（记结论、记决定，不记流水账）
 *   - 可检索（抽出标签，召回时能命中）
 */

/** 一条摘要最多留这么多字。 */
const MAX_SUMMARY_CHARS = 600

/** 太短的对话不入库（"嗯"、"好" 之类）。 */
const MIN_SUMMARY_CHARS = 12

/**
 * 密钥 / 令牌 / 密码的脱敏。
 *
 * 记忆库是**长期**存储（permanent 寿命），一旦把用户随手贴进来的
 * PAT / API key / 密码写进去，就等于把凭据复制了一份到另一个地方，
 * 而且它会随着召回一起被送进模型提示词。所以入库前一律先脱敏。
 *
 * 覆盖：
 *   - GitHub PAT：ghp_/gho_/ghu_/ghs_/ghr_ + 36 位
 *   - GitHub fine-grained：github_pat_ + 一长串
 *   - OpenAI / Anthropic / 通用：sk- / sk-ant- / xoxb- / AKIA…
 *   - 赋值形式：api_key = "..."、token: '...'、password = ...
 *   - 连接串：scheme://user:password@host
 */
const SECRET_PATTERNS = [
  // GitHub 经典 PAT / fine-grained PAT
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // OpenAI / Anthropic / Slack / AWS / Google
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  // 赋值形式：key = "value" / key: 'value' / key: value
  /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|pwd|token|secret|authorization)\s*[:=]\s*)(["']?)([^\s"'`,;)]{8,})\2/gi,
]

/** 脱敏后的占位符。 */
const REDACTED = '[已脱敏]'

/**
 * 把一段文本里的密钥 / 令牌 / 密码换成占位符。
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = String(text ?? '')
  if (!out) return out
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, (match, ...groups) => {
      // 赋值形式要保留 `key = ` 前缀，只替换值
      if (groups.length >= 3 && groups[2] && groups[0] && /[:=]/.test(groups[0])) {
        return `${groups[0]}${REDACTED}`
      }
      return REDACTED
    })
  }
  // 连接串单独处理：scheme://user:password@host —— 只换掉密码段
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi, (_m, head, _pwd, tail) => `${head}${REDACTED}${tail}`)
  return out
}

/** 判断一段文本里有没有密钥。 */
export function hasSecret(text) {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(String(text ?? ''))) return true
  }
  return false
}

/** 从一句话里抽出可作标签的词。 */
function extractTags(text, limit = 6) {
  const tags = []
  const seen = new Set()
  // 英文/数字词
  for (const token of String(text).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    if (seen.has(token)) continue
    seen.add(token)
    tags.push(token)
  }
  // 中文：优先抓 2-4 字的连续片段里出现次数高的（粗略的关键词抽取）
  const runs = String(text).match(/[\u4e00-\u9fff]{2,}/g) ?? []
  const freq = new Map()
  for (const run of runs) {
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const gram = run.slice(i, i + len)
        freq.set(gram, (freq.get(gram) ?? 0) + 1)
      }
    }
  }
  const ranked = [...freq.entries()]
    .filter(([gram, count]) => count >= 2 || gram.length >= 3)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
  for (const [gram] of ranked) {
    if (tags.length >= limit) break
    if (seen.has(gram)) continue
    seen.add(gram)
    tags.push(gram)
  }
  return tags.slice(0, limit)
}

/** 把过长的文本截断在句子边界上。 */
function clamp(text) {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_SUMMARY_CHARS) return trimmed
  const slice = trimmed.slice(0, MAX_SUMMARY_CHARS)
  const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('. '))
  return (cut > MAX_SUMMARY_CHARS * 0.5 ? slice.slice(0, cut + 1) : slice).trim()
}

/**
 * 这句话值不值得记成长期记忆？
 *
 * 之前只要「用户问 + 助手答」拼起来超过 12 个字就入库，结果库里全是
 * 「继续 → Excellent!」「能改为热加载嘛 → 用户问：能改为热加载嘛。」
 * 这种**没有信息量的对话快照**。它们会污染召回（问一句就召出一堆废话），
 * 还会永久占着记忆库。
 *
 * 判据（满足任意一条就值得记）：
 *   - 长度够（用户那侧至少 20 字，说明是个正经问题）
 *   - 含决策/偏好信号（要 / 改成 / 别 / 记住 / 以后 / 都用 …）
 *   - 含事实信号（路径、版本号、命令、报错）
 * 不值得记的典型：单字回复、「继续」、纯寒暄、纯过程性应答。
 */
const WORTH_KEEPING_SIGNALS =
  /(记住|以后|都(要|用|走|按)|默认|约定|规则|不要|别|必须|禁止|改成|换成|用.{0,6}代替|偏好|习惯|固定|每次|统一|发布|部署|安装|帮我|帮忙|请(你|把)?|能不能|能否|是否可以|需要做|走正常|重启|发一?版|写一?个|做一?个)/

/** 纯过程性 / 寒暄 / 单字回复。 */
const CHITCHAT =
  /^(继续|嗯+|好+|好的|行|OK|ok|收到|谢谢|thanks?|是的|对|没错|来吧|搞起|go|next|继续吧|往下|再继续)[\s。.!！~～]*$/i

/**
 * 助手自己的「过程播报」——不该当成老大的记忆存进去。
 * （2026-11-03，P1-2）
 *
 * 以前只过滤了纯寒暄，助手每说一句「我先看看…」「让我先确认…」都会入库，
 * 于是库里有几十条本鱼自己的工作日志 —— 召回时全是噪音，
 * 还会被「待办」关键词误当成老大交代的事（见 index.js 的 pendingHintsOf）。
 */
const ASSISTANT_NOISE =
  /(我(先|来|这就|这就先|这就来)?(先)?(看看|看下|查一下|查查|确认一下|确认下|翻一下|翻翻|找找|搜一下|搜搜|扒一下|扒扒|摸一下|摸清|摸清一下|研究一下|研究下|试试|试试看|试一下|试试能不能|动手|开工|去拿|去翻|去查|去挖|去扒)|让我(先|来)?(先)?(看看|看下|查一下|确认|翻|找|搜|扒|摸|研究|试)|现在(先|来)?(看看|查|确认|翻|找|搜|扒|摸)|开(始|动)动手|先(看看|查|确认|翻|找|搜|扒|摸|试)|这(就)?(来|先)?(看看|查|确认|翻|找|搜|扒|摸)|找到了|找到了！|已经?(定位|确认|找到|找到关键线索)|根因(定位|确认)?(了)?|问题(定位|确认)?(了)?|先说结论|让我(先)?(分析|梳理|整理)|我(来|先)?(分析|梳理|整理)一(下|下)|分析已就绪|我(需要|得)(一切|全部)?(信息|资料)都(齐了|有)|Everything I need)/

/**
 * 老大明确表达偏好/情感 —— 这类话最该记住。
 * （2026-11-03，P1-2 补：加了噪音过滤后，偏好句差点被一起滤掉）
 */
const PREFERENCE_SIGNALS =
  /(喜欢|讨厌|偏好|习惯|最爱|受不了|讨厌别人|希望|不想|不乐意|反感|恶心|受不了了|感觉不错|挺好的|我想要|我要的是|以后(都)?(用|走|说|做|要)|统一用|一律)/

/** 判断一句话是否值得记。 */
export function isWorthRemembering(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return false
  if (CHITCHAT.test(trimmed)) return false
  // 偏好/情感优先判定 —— 老大明确说过口味一定要记住，
  // 哪怕它同时长得像一句过程播报。
  if (PREFERENCE_SIGNALS.test(trimmed)) return true
  // 助手自己的过程播报：不是老大的事实，不入库。
  if (ASSISTANT_NOISE.test(trimmed)) return false
  // 决策 / 请求信号优先——哪怕短，也是重要的事
  if (WORTH_KEEPING_SIGNALS.test(trimmed)) return true
  if (trimmed.length >= 20) return true
  // 带路径 / 版本 / 命令 / 报错的短句也是事实
  if (/(?:[A-Za-z]:\\|\/[\w.-]+\/|v\d+\.\d+|error|错误|报错|命令|npm |pnpm |git )/i.test(trimmed)) return true
  return false
}

/**
 * 从一轮对话（用户消息 + 助手回复）生成摘要。
 *
 * @param {{ user?: string, assistant?: string }} turn
 * @returns {{ text: string, tags: string[] } | null} 不值得记的时候返回 null
 */
export function summarizeTurn(turn) {
  const user = String(turn?.user ?? '').trim()
  const assistant = String(turn?.assistant ?? '').trim()
  if (!user && !assistant) return null

  // 整轮都不值得记 → 直接不入库（避免污染召回）
  if (!isWorthRemembering(user) && !isWorthRemembering(assistant)) return null
  // 助手那半边是过程播报的话，就别拿它来撑长度（否则老大一句「继续」也会变成一条记忆）。
  const keepAssistant = isWorthRemembering(assistant)

  // 摘要的主干：用户问的是什么 + 助手答了什么（各取一句）
  const userPart = firstSentence(user)
  const assistantPart = firstSentence(assistant)
  const body = [userPart, keepAssistant ? assistantPart : ''].filter(Boolean).join(' → ')

  if (body.length < MIN_SUMMARY_CHARS) {
    // 老大自己那句虽短，但明确是「不要 / 以后 / 必须…」这类硬要求时，
    // 以前是靠助手那句回话把长度撑过去的；现在助手的过程播报被滤掉了，
    // 这些短要求反而会漏记 —— 所以这里给它们单独放行。
    const userOnly = userPart.length >= 4 && isWorthRemembering(user)
    if (!userOnly) return null
  }

  // 记忆是长期存储的，密钥绝不能进去——入库前一律脱敏
  const safe = redactSecrets(body)
  const tags = extractTags(`${redactSecrets(user)} ${redactSecrets(assistant)}`)
  return { text: clamp(safe), tags }
}

/** 取第一句（中文句号/问号/感叹号或英文句点）。 */
function firstSentence(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return ''
  const m = trimmed.match(/^[\s\S]{1,300}?([。！？.!?]\s|$)/)
  if (!m) return trimmed.slice(0, 300).trim()
  return m[0].trim()
}

/**
 * 判断这条记忆和库里已有的某条是不是同一件事，避免重复堆积。
 * 判据：标签重合度高，或正文高度相似。
 */
export function isDuplicate(entry, candidate) {
  if (!entry || !candidate) return false
  const a = new Set((entry.tags ?? []).map((t) => String(t).toLowerCase()))
  const b = new Set((candidate.tags ?? []).map((t) => String(t).toLowerCase()))
  if (a.size > 0 && b.size > 0) {
    let shared = 0
    for (const tag of b) if (a.has(tag)) shared += 1
    if (shared / Math.min(a.size, b.size) >= 0.7) return true
  }
  // 正文前 120 字完全相同 → 同一件事
  const prefixA = entry.text.slice(0, 120)
  const prefixB = candidate.text.slice(0, 120)
  return prefixA.length > 20 && prefixA === prefixB
}
