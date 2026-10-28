/**
 * 记忆时效判定：自动判断一条记忆该「永久保留」还是「临时放着，过期就扔」。
 *
 * 为什么需要自动判断：
 *   手动切太累，而且大部分人记不清自己到底设过哪些临时记忆。
 *   更要命的是 —— 有些东西**天生就有保质期**，比如「今天下午三点开会」、
 *   「这个月的额度还剩 200」；过了一周还留在库里召回，只会误导。
 *
 * 判定思路（按优先级，先命中先定）：
 *   1. 显式时效信号 —— 内容里带着具体时间/期限（「今天」「本周」「临时」「先」）
 *   2. 状态易变信号 —— 内容是随时会变的运行时状态（「当前版本是…」「现在在跑…���）
 *   3. 稳定信号     —— 偏好、称呼、约定、长期项目背景 → 永久
 *   4. 兜底         —— 其余按「半永久」处理（中等 TTL），比永久短但不会第二天就消失
 *
 * TTL 阶梯（毫秒）：
 *   12 小时 —— 「今天/今晚」这类当天过期的事
 *   3 天    —— 「本周/这几天」这类短期事
 *   7 天    —— 「临时/先/暂��」这类过渡状态
 *   14 天   —— 兜底的半永久
 *   永久    —— 稳定偏好、约定、长期背景
 */

/** 显式时效信号：自带时间窗口。 */
const EPHEMERAL_PATTERNS = [
  // 当天 / 本周
  { re: /今天|今日|今晚|今早|今晚|当天|本日|今天之内|before end of day/i, hours: 12, reason: '内容限定在当天' },
  { re: /明天|明日|明早|明晚|tomorrow/i, hours: 36, reason: '内容指向明天' },
  { re: /本周|这周|本星期|this week/i, hours: 24 * 3, reason: '内容限定在本周' },
  { re: /这几天|最近几天|接下来几天|这几天内|next few days/i, hours: 24 * 3, reason: '内容是近几天的安排' },
  { re: /本月|这个月|month/i, hours: 24 * 10, reason: '内容限定在本月' },
  { re: /今年|年度|year/i, hours: 24 * 60, reason: '内容限定在本年度' },
  // 过渡性措辞
  { re: /临时|暂时|先(?:这样|用|记着|放着)|暂缓|稍后|回头|待定|todo|to-do|占位/i, hours: 24 * 7, reason: '内容是过渡性安排' },
  { re: /待会|等会|马上|立刻|right now|asap/i, hours: 12, reason: '内容是即时安排' },
  // 相对时长
  { re: /(\d+)\s*(?:小时|个小时|hours?)\s*(?:后|内|以内)/i, perUnit: 3600_000, reason: '内容带有小时级期限' },
  { re: /(\d+)\s*(?:天|days?)\s*(?:后|内|以内)/i, perUnit: 86_400_000, reason: '内容带有天级期限' },
  { re: /(\d+)\s*(?:周|weeks?)\s*(?:后|内|以内)/i, perUnit: 604_800_000, reason: '内容带有周级期限' },
]

/**
 * 状态易变信号：内容描述的是「当前状态」，过一阵就不成立了。
 * 这些做成永久记忆是负资产 —— 召回到过期的状态比不召回更糟。
 */
const VOLATILE_PATTERNS = [
  { re: /当前(?:的)?(?:版本|状态|配置|分支|进程|端口|路径|目录|数量|余额|额度|进度)|现在(?:的)?(?:版本|状态|配置|分支|进程|端口)/i, reason: '描述的是当前运行状态' },
  { re: /(?:正在|刚(?:才|刚)|已经)(?:运行|启动|安装|部署|打开|关闭)|此刻|此时|当下/i, reason: '描述的是此刻的状态' },
  { re: /(?:剩余|还剩|可用|余额|额度|配额|端口|行号|行数|条数)/, reason: '内容是会变的计数或余额' },
  { re: /ip 地址|ip地址|localhost:\d+|:\d{4,5}\b|http:\/\/localhost/i, reason: '内容是临时地址或端口' },
  { re: /这次|本次|刚才|刚刚|上一轮|这一轮/i, reason: '内容只针对最近一次操作' },
]

/** 稳定信号：这些天生该永久留着。 */
const STABLE_PATTERNS = [
  { re: /我(?:喜欢|讨厌|偏好|习惯)|请(?:叫我|称呼)|(?:以后)?叫我|称呼/i, reason: '是长期偏好或称呼' },
  { re: /以后(?:都|请|要)?|每次(?:都|请)?|从今(?:以后|后)|今后|长期|一直/i, reason: '是长期约定' },
  { re: /我的(?:生日|邮箱|手机号|地址|工作|项目|团队|设备|宠物|名字)/i, reason: '是稳定的个人信息' },
  { re: /不要|必须|禁止|一律|务必|统一|规则|约定|规范|底线/i, reason: '是规则或约定' },
  { re: /配置|路径|目录|端口号|用户名|仓库|项目名|版本要求|依赖/i, reason: '是稳定的配置事实' },
  { re: /架构|设计|原理|方案|流程|规范|文档/i, reason: '是长期有效的知识' },
]

/** 兜底的半永久时长：14 天。 */
const FALLBACK_HOURS = 24 * 14

/**
 * 判定一条记忆的时效。
 *
 * @param {{ text?: string, user?: string, assistant?: string, tags?: string[] }} summary
 * @param {{ now?: number }} context
 * @returns {{ lifetime: 'permanent'|'temporary', expiresAt: number, ttlMs: number, reason: string }}
 */
export function judgeLifetime(summary, context = {}) {
  const now = context.now ?? Date.now()
  const text = `${summary?.user ?? ''} ${summary?.text ?? ''} ${summary?.assistant ?? ''} ${(summary?.tags ?? []).join(' ')}`

  // 判定分三步，先看有没有「明确的长期约定」，再看有没有「明确的时间窗」，
  // 最后才落到稳定偏好 / 易变状态 / 兜底。
  //
  // 关键区分（踩过的坑）：
  //   「我讨厌临时文件」      → 永久（「临时」说的是文件类型，不是保质期）
  //   「今天先跑这个临时方案」→ 临时（时间窗 + 过渡措辞）
  //   「以后每周三都开会」    → 永久（长期约定压过时间窗）
  const longTerm = /以后|每次|从今|今后|长期|一直|从来|每次都|以后都|永久/.test(text)
  // 强时效 = 明确限定时间窗的规则（今天/明天/本周/这几天/本月/今年）。
  // 「临时/暂时/先/暂缓」这类模糊过渡词不算强时效。
  const strongRules = EPHEMERAL_PATTERNS.slice(0, 6)
  const strongMatch = strongRules.find((rule) => rule.re.test(text))
  // 过渡措辞（模糊）
  const fuzzyMatch = EPHEMERAL_PATTERNS.find(
    (rule) => !strongRules.includes(rule) && rule.re.test(text),
  )

  // 0a. 长期约定优先：明确的「以后/每次/从今以后」压过一切时间窗。
  if (longTerm) {
    for (const rule of STABLE_PATTERNS) {
      if (!rule.re.test(text)) continue
      return { lifetime: 'permanent', expiresAt: 0, ttlMs: 0, reason: `${rule.reason}，适合长期保留` }
    }
  }

  // 0b. 明确的时间窗（今天/本周/…）且不是长期约定 → 临时。
  if (strongMatch && !longTerm) {
    return temporaryFrom(strongMatch, text, now)
  }

  // 0c. 稳定信号：偏好、称呼、约定、规则、配置事实、长期知识 → 永久。
  //     「我讨厌临时文件」走到这里，因为 strongMatch 为空、fuzzyMatch 命中但不是时间窗。
  for (const rule of STABLE_PATTERNS) {
    if (!rule.re.test(text)) continue
    return { lifetime: 'permanent', expiresAt: 0, ttlMs: 0, reason: `${rule.reason}，适合长期保留` }
  }

  // 1. 过渡措辞（临时/先/暂缓/待定/稍后/待会）→ 临时，7 天或更短。
  if (fuzzyMatch) {
    return temporaryFrom(fuzzyMatch, text, now)
  }

  // 2. 相对时长（「3 天后」「2 小时以内」）→ 临时。
  for (const rule of EPHEMERAL_PATTERNS) {
    if (!rule.perUnit) continue
    if (!rule.re.test(text)) continue
    const match = text.match(rule.re)
    const amount = Number(match?.[1] ?? 1)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const ttlMs = amount * rule.perUnit
    return {
      lifetime: 'temporary',
      expiresAt: now + ttlMs,
      ttlMs,
      reason: `${rule.reason}，约 ${formatSpan(ttlMs)}后过期`,
    }
  }

  // 3. 状态易变信号：当前版本、正在运行、剩余额度、端口… → 短期。
  for (const rule of VOLATILE_PATTERNS) {
    if (rule.re.test(text)) {
      const ttlMs = FALLBACK_HOURS * 3_600_000
      return {
        lifetime: 'temporary',
        expiresAt: now + ttlMs,
        ttlMs,
        reason: `${rule.reason}，按短期记忆处理`,
      }
    }
  }

  // 4. 兜底：半永久。
  const ttlMs = FALLBACK_HOURS * 3_600_000
  return {
    lifetime: 'temporary',
    expiresAt: now + ttlMs,
    ttlMs,
    reason: '未识别出长期价值，先按短期记忆保留，到期后可在设置页改回永久',
  }
}

/** 由一条时效规则算出临时记忆的到期时间。 */
function temporaryFrom(rule, text, now) {
  let ttlMs
  if (rule.perUnit) {
    const match = text.match(rule.re)
    const amount = Number(match?.[1] ?? 1)
    if (!Number.isFinite(amount) || amount <= 0) ttlMs = FALLBACK_HOURS * 3_600_000
    else ttlMs = amount * rule.perUnit
  } else {
    ttlMs = rule.hours * 3_600_000
  }
  return {
    lifetime: 'temporary',
    expiresAt: now + ttlMs,
    ttlMs,
    reason: `${rule.reason}，约 ${formatSpan(ttlMs)}后过期`,
  }
}

/** 把毫秒说成人话。 */
export function formatSpan(ms) {
  const value = Number(ms) || 0
  if (value <= 0) return '永久'
  const hours = value / 3_600_000
  if (hours < 1) return `${Math.max(1, Math.round(value / 60_000))} 分钟`
  if (hours < 24) return `${Math.round(hours)} 小时`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天`
  return `${Math.round(days / 30)} 个月`
}
