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

import { lookup } from 'node:dns/promises'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 一次最多送进模型多少字（太多会挤掉真正要紧的部分，也费钱） */
export const MAX_MATERIAL_CHARS = 6000

/** 最多跟几次跳转（每跳都重新体检，防止被 302 拐进内网）。 */
const MAX_REDIRECTS = 5

/**
 * 内网 / 回环 / 链路本地地址判定。
 *
 * 2026-11-06 修：原来只校验协议，`http://127.0.0.1:8199/` 这种能被抓，
 * 等于给本机任意进程开了一个「探测内网服务」的探头。这里按 IP 段拒掉。
 */
export function isPrivateHost(hostname) {
  let host = String(hostname ?? '').trim().toLowerCase()
  if (!host) return true
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true // fe80::/10 链路本地
    if (host.startsWith('::ffff:')) return isPrivateHost(host.slice('::ffff:'.length))
    return false
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 0 || a === 10 || a === 127) return true // 本机 / 私网 A 类
  if (a === 169 && b === 254) return true // 链路本地（含云元数据地址）
  if (a === 172 && b >= 16 && b <= 31) return true // 私网 B 类
  if (a === 192 && b === 168) return true // 私网 C 类
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试段
  if (a >= 224) return true // 组播 / 保留
  return false
}

/**
 * 抓之前先体检这个主机名。
 *
 * 2026-11-12 修两个漏：
 *  ① 「解析出来全是内网」才拦（every）—— 公网域名挂一条内网 A 记录就能绕，
 *     改成「只要有一条落在内网就拒」（some）。多 IP 的公网站点也因此更严格，这是有意的。
 *  ② 解析失败原来直接放行，等于把判断权交给 fetch 的第二次解析 —— DNS 重绑定正是这么绕的。
 *     改成解析不出来就不抓：宁可不学，也别给内网留口子。
 *
 * 返回 { ok, reason }，reason 用来给老大一句能看懂的话。
 */
async function checkTargetHost(hostname) {
  const host = String(hostname ?? '').trim()
  if (!host) return { ok: false, reason: 'empty' }
  if (isPrivateHost(host)) return { ok: false, reason: 'private' }
  // IP 字面量上面已经判过了，不用再查 DNS
  if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: true, reason: '' }
  let addrs
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    return { ok: false, reason: 'unresolved' }
  }
  if (!Array.isArray(addrs) || addrs.length === 0) return { ok: false, reason: 'unresolved' }
  if (addrs.some((item) => isPrivateHost(item?.address))) return { ok: false, reason: 'private' }
  return { ok: true, reason: '' }
}

function hostRejectText(reason, where = '') {
  if (reason === 'unresolved') {
    return `${where}域名解析不出来（或者解析结果不对），这次不抓`
  }
  return `${where}不抓内网或本机地址`
}

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
  // 2026-11-06 修：内网/本机地址一律不抓。2026-11-12 收紧成 some + 解析失败也拒。
  {
    const verdict = await checkTargetHost(target.hostname)
    if (!verdict.ok) return { ok: false, error: hostRejectText(verdict.reason) }
  }
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  const signal = AbortSignal.timeout(timeout)
  try {
    let current = target
    let res = null
    let hops = 0
    while (true) {
      res = await fetch(current.toString(), {
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        // 自己跟跳转：每一跳都得重新体检，不能交给 fetch 闷头跟到底
        redirect: 'manual',
        signal,
      })
      const status = Number(res.status)
      if (status < 300 || status >= 400) break
      if (hops >= MAX_REDIRECTS) return { ok: false, error: '跳转次数太多' }
      hops += 1
      const location = res.headers.get('location')
      if (!location) return { ok: false, error: `HTTP ${status}`, status }
      let next
      try {
        next = new URL(location, current)
      } catch {
        return { ok: false, error: '跳转地址不合法' }
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return { ok: false, error: `不支持的协议 ${next.protocol}` }
      }
      {
        const verdict = await checkTargetHost(next.hostname)
        if (!verdict.ok) return { ok: false, error: hostRejectText(verdict.reason, '跳转到了') }
      }
      current = next
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status }
    const type = String(res.headers.get('content-type') ?? '')
    if (type && !/text|html|json|xml/i.test(type)) {
      return { ok: false, error: `不是文本内容（${type}）` }
    }
    const body = await res.text()
    return {
      ok: true,
      url: current.toString(),
      host: current.hostname.replace(/^www\./, ''),
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
