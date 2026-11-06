/**
 * 联网学习（2026-11-06）：从网上取一份资料，提炼成知识条目。
 *
 * 为什么单独一个文件：抓网页、清洗、提炼是三件不同的事，
 * 塞进 learning.js 会把"从对话里抽"和"从资料里抽"搅在一起。
 *
 * 边界（很重要）：
 *   - 只抓**明确给定的** URL，不自己乱爬
 *   - 抓下来的文本先截断再交给模型，防止把整站内容灌进 prompt
 *   - 提炼仍然是「事实 + 表达」两类，跟对话学习同一套判据
 *   - 出处记到 sourceRef（域名或标题），索引里能看出这是网上学的
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 一次最多送进模型多少字（太多会挤掉真正要紧的部分，也费钱） */
export const MAX_MATERIAL_CHARS = 6000

/** 抓一个网页并清洗成纯文本。失败返回 {ok:false, error} —— 不抛。 */
export async function fetchPageText(url, options = {}) {
  const raw = String(url ?? '').trim()
  if (!raw) return { ok: false, error: '链接是空的' }
  let target
  try {
    target = new URL(raw)
  } catch {
    return { ok: false, error: '这不是一个合法的链接' }
  }
  // 只允许 http(s)：file:// 之类的协议绝不能从这里进
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, error: `不支持的协议 ${target.protocol}` }
  }
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  try {
    const res = await fetch(target.toString(), {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status }
    const type = String(res.headers.get('content-type') ?? '')
    if (type && !/text|html|json|xml/i.test(type)) {
      return { ok: false, error: `不是文本内容（${type}）` }
    }
    const body = await res.text()
    return {
      ok: true,
      url: target.toString(),
      host: target.hostname.replace(/^www\./, ''),
      title: cleanTitle(extractTitle(body), { max: Number.isFinite(options.titleMax) ? options.titleMax : 40 }),
      text: htmlToText(body).slice(0, Number.isFinite(options.maxChars) ? options.maxChars : MAX_MATERIAL_CHARS),
      bytes: body.length,
    }
  } catch (error) {
    return { ok: false, error: String(error?.cause?.code || error?.message || error) }
  }
}

/**
 * 把网页标题洗成人能看的短出处。
 *
 * 真实抓到的标题长这样：
 *   泰山深度游与小众玩法：岱庙、十八盘、玉皇顶与封禅文化摄影攻略 山东旅游攻略 游记攻略 _西安康辉旅行社官网
 * 原样当 sourceRef 会把知识索引撑得没法看，所以要：
 *   ① 按 _ | 切掉站点名后缀  ② 还长就按空格取前两个短语  ③ 仍然超长直接截断
 */
export function cleanTitle(title, options = {}) {
  const max = Number.isFinite(options.max) ? options.max : 40
  let t = String(title ?? "").replace(/\s+/g, " ").trim()
  if (!t) return ""
  // 站点名后缀：`xxx _站点名`、`xxx | 站点名`、`xxx-站点名`
  t = t.split(/[_|]/)[0].trim()
  // 「A 山东旅游攻略 游记攻略」这种关键词堆叠，取前两段就够
  if (t.length > max) {
    const parts = t.split(/\s+/)
    if (parts.length > 2) t = parts.slice(0, 2).join(" ")
  }
  if (t.length > max) t = t.slice(0, max).trim() + "…"
  return t
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(String(html ?? ''))
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : ''
}

/** 把 HTML 压成一段能读的纯文本。 */
export function htmlToText(html) {
  let s = String(html ?? '')
  // 这些标签里的东西一律不是正文
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
  s = s.replace(/<header[\s\S]*?<\/header>/gi, ' ')
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
  s = s.replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  // 块级标签换行，行内标签变空格
  s = s.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article)[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  // 逐行压空白、丢掉极短的行（导航条、版权声明这类碎片）
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.replace(/[\t\u00a0]+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((l) => l.length >= 8)
  return lines.join('\n')
}

function decodeEntities(text) {
  const map = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&middot;': '·', '&mdash;': '—', '&hellip;': '…' }
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => map[m.toLowerCase()] ?? m)
}

/** 从资料里提炼知识用的系统提示（跟对话学习同一套判据，但输入是一篇文章）。 */
export function buildMaterialSystem() {
  return [
    '你的任务：从下面这份资料里，提炼出**值得长期记住**的东西。',
    '这是"读一篇文章"，不是"整理笔记"——只要真正有信息量的部分。',
    '',
    '两类，分开判断：',
    '',
    '【知识 kind="fact"】',
    '- 定义、原理、公式、结论',
    '- 明确的事实：时间、地点、人物、数量',
    '- 可迁移的规律或方法',
    '每条要能脱离原文独立成立，不超过 120 字。',
    '',
    '【表达 kind="style"】',
    '- 这段里写得好的句式、修辞、起承转合，值得以后照着写',
    '写成「手法 + 一句示例」，20~80 字。原文里的好句子可以引用，但要短。',
    '',
    '不要：',
    '- 导航、广告、版权声明、目录',
    '- 原文大段照抄（那是搬运，不是学习）',
    '- 只有这份资料里成立的一次性细节',
    '- 你已经知道的常识（宁可少写）',
    '',
    '输出格式：只输出一个 JSON 数组，最多 8 项。',
    '每一项形如：{"kind":"fact","text":"一句话完整的知识点","tags":["主题词"]}',
  ].join('\n')
}

export function buildMaterialUser({ source, text }) {
  return [
    `**来源：**${String(source ?? '未知').slice(0, 200)}`,
    '',
    '**资料正文：**',
    String(text ?? '').slice(0, MAX_MATERIAL_CHARS),
    '',
    '请只输出 JSON 数组。',
  ].join('\n')
}
