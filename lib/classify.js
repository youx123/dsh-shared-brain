/**
 * 分类器：把一轮对话摘要路由到「底线 / 认知 / 情感 / 本能」四个记忆模块。
 *
 * 路由规则（按优先级，先命中先定）：
 *   1. 底线 —— 出现操作限制、禁令、权限边界的信号词
 *   2. 情感 —— 出现关系、偏好、情绪、称呼的信号词
 *   3. 本能 —— 同一件事被反复提起（由使用频次判定，不靠关键词）
 *   4. 认知 —— 其余全部（事实、结论、决定）
 *
 * 权重：
 *   底线默认 0.9（硬约束）
 *   情感默认 0.6（偏亲密）
 *   认知默认按内容确定度 0.5~0.8
 *   本能默认 0.5，每次被复述权重上调
 */

import { detectSentiment, detectTarget } from './emotion.js'

/**
 * 底线信号词：命中即判为硬约束。
 *
 * 分两组：
 *   - 明确禁止/强制的语气词（「不要」「必须」）—— 直接判底线
 *   - 敏感领域词（权限、机密、凭据）—— 单独出现时也是底线
 *
 * 「删除/卸载/覆盖/重启」这类**动作词**不单独作为底线信号：用户说
 * 「看一下这个应用为什么卸载不掉」是在**问问题**，不是在**下禁令**。
 * 只有当它们出现在祈使句里（不要…/…别…/…不许…）才算底线。
 */
const BOTTOMLINE_PATTERNS = [
  // 禁止与强制
  /不要|不许|禁止|不得|别再|不准|不能|不可以|勿|切勿|严禁|甭/,
  /必须|一定要|只能|务必|严格|一律|统统/,
  /limit|never|must|forbidden|do not|don'?t|should not|required|always/i,
  // 敏感领域
  /权限|越权|授权|白名单|黑名单|敏感|机密|保密|隐私|凭据|密钥|凭据|口令|密码/,
  /风险|危险|破坏|清空|格式化|提权|管理员|root 权限/i,
  // 永久性策略
  /每次|永远|始终|统一|默认就|今后|以后都/,
]

/**
 * 底线动作词：只有与祈使语气同现时才算底线。
 * 祈使语气标记：否定前缀、命令词、「一律/不要」等。
 */
const DESTRUCTIVE_ACTIONS = /删除|删掉|清空|格式化|覆盖|卸载|重装|重启|抹掉|清除/gi
const IMPERATIVE_MARKERS = /不要|不许|禁止|不得|别|不准|勿|严禁|务必|必须|只能|一律|不要在|别再|甭/

/** 敏感信息动作词：涉及密钥/凭据的一律视为底线（不管语气）。 */
const SENSITIVE_ACTIONS = /密钥|密码|凭据|token|secret|api key/i

/**
 * 情感信号词：关系、偏好、情绪、称呼。
 *
 * ⚠ 2026-11-02 修正：原来最后一条是 `/我们|咱们|一起|咱/i`，**太宽了**。
 * 工作汇报里一句「我们把通道打通了」就会命中，把一条纯工作记录误判成情感
 * ——现场就是这样积出一条假情感的（原文是「好嘞！本鱼这就把通道打通…」）。
 * 「我们」本身不表达情感，只是叙述视角，**不能当情感信号**。
 *
 * 现在改成：
 *   - 明确表达情感/偏好的词（喜欢、讨厌、心疼…）→ 强信号
 *   - 称呼类（叫我、喊我）→ 强信号
 *   - 「我们/咱们/一起」只有**和情感词同现**时才算情感（见 isEmotionText）
 */
const EMOTION_PATTERNS = [
  /喜欢|讨厌|爱|恨|想念|开心|难过|生气|高兴|兴奋|失落|委屈|撒娇|傲娇|害羞|心疼/i,
  /喜欢你|爱你|想你|陪我|别走|回来|想念/i,
  /我叫|叫我|称呼|喊我|我是|我是谁/i,
  /prefer|like|love|hate|miss|favorite|favourite|feel|feeling/i,
]

/** 「我们 / 咱们 / 一起」——只有跟情感词同现时才算情感（否则只是叙述视角）。 */
const PLURAL_MARKERS = /我们|咱们|一起|咱/i

/** 认知信号词：明确的结论/决定/事实，比一般叙述权重更高。 */
const COGNITION_CONFIDENT_PATTERNS = [
  /确认|确定|结论|原因是|因为|所以|决定|改成|设置为|改为|最终|已经|成功|失败|修复|安装|卸载|完成|版本/i,
  /root cause|confirmed|decided|fixed|installed|failed|version/i,
]

/**
 * 判断文本是否命中任何模式。
 */
function matches(text, patterns) {
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * 判断是否是一条「带祈使语气的破坏性操作指令」。
 * 例如「不要删除我的文件」「卸载前先备份」——前者是底线，后者是操作步骤。
 */
function isDestructiveConstraint(text) {
  if (!DESTRUCTIVE_ACTIONS.test(text)) {
    DESTRUCTIVE_ACTIONS.lastIndex = 0
    return false
  }
  DESTRUCTIVE_ACTIONS.lastIndex = 0
  return IMPERATIVE_MARKERS.test(text)
}

/**
 * 判断一段文本是不是「情感」。
 *
 * 规则：
 *   1. 命中明确的情感词（喜欢/讨厌/心疼/称呼…）→ 是
 *   2. 只命中「我们/咱们/一起」而没有任何情感词 → **不是**
 *      （那是叙述视角，不是情感；工作汇报最常踩这个坑）
 */
export function isEmotionText(text) {
  const value = String(text ?? '')
  if (!value) return false
  if (matches(value, EMOTION_PATTERNS)) return true
  // 只有复数视角词，没有情感词 → 不算
  return false
}

/**
 * 分类一条摘要。
 *
 * @param {{ text?: string, user?: string, assistant?: string }} summary
 * @param {{ repeatCount?: number }} context repeatCount = 该主题在库中已出现的次数
 * @returns {{ module: string, weight: number, reason: string, suggestBottomline?: boolean, sentiment?: string, target?: string, intimacy?: number }}
 *
 * 注意：底线**不再自动入模块**。命中底线信号时只给出 suggestBottomline，
 * 由用户在设置页手动钉住后才算硬约束（避免把「看一下为什么卸载不掉」这类
 * 提问误当成禁令，更避免模型被自己的猜测绑住手脚）。
 *
 * 2026-11-02：情感判定收紧（去掉「我们/咱们/一起」这个假信号），
 * 并带上**语义字段**（sentiment / target / intimacy）——
 * 情感条目的权重由「亲密度」推导，不再是通用置信度 0.6。
 */
export function classify(summary, context = {}) {
  const text = `${summary?.user ?? ''} ${summary?.text ?? ''} ${summary?.assistant ?? ''}`
  const repeatCount = Number(context.repeatCount ?? 0)

  if (matches(text, BOTTOMLINE_PATTERNS) || isDestructiveConstraint(text) || SENSITIVE_ACTIONS.test(text)) {
    // 命中底线信号：先归到认知，并建议用户手动钉为底线
    return {
      module: 'cognition',
      weight: 0.8,
      reason: '涉及操作限制或权限边界（可手动钉为底线）',
      suggestBottomline: true,
    }
  }
  if (isEmotionText(text)) {
    // 亲密度：显式表达「喜欢/爱你/想你」这类最亲近（0.7），
    // 一般偏好/情绪给 0.6，单纯情绪起伏给 0.5。
    const intimacy = /爱你|喜欢你|想你|陪我|别走|回来|心疼|撒娇/i.test(text)
      ? 0.7
      : /喜欢|讨厌|想念|开心|难过|生气|高兴|兴奋|失落|委屈|傲娇|害羞/i.test(text)
        ? 0.6
        : 0.5
    const sentiment = detectSentiment(text)
    const target = detectTarget(text)
    return {
      module: 'emotion',
      weight: intimacy,
      intimacy,
      sentiment,
      target,
      reason: `涉及感情、偏好或称呼（亲密度 ${intimacy.toFixed(2)}）`,
    }
  }
  if (repeatCount >= 2) {
    // 反复出现 → 本能。频次越高权重越大，但封顶 0.95。
    const weight = Math.min(0.95, 0.5 + repeatCount * 0.12)
    return { module: 'instinct', weight: Number(weight.toFixed(2)), reason: `同一主题已出现 ${repeatCount + 1} 次` }
  }
  if (matches(text, COGNITION_CONFIDENT_PATTERNS)) {
    return { module: 'cognition', weight: 0.8, reason: '明确的结论或决定' }
  }
  return { module: 'cognition', weight: 0.5, reason: '一般事实与结论' }
}

/**
 * 判断库里是否已存在同一主题（用于计算 repeatCount）。
 * 判定：标签重合度高，或正文前 30 字相同。
 */
export function topicOverlap(entry, candidate) {
  const a = new Set((entry.tags ?? []).map((t) => String(t).toLowerCase()))
  const b = new Set((candidate.tags ?? []).map((t) => String(t).toLowerCase()))
  if (a.size > 0 && b.size > 0) {
    let shared = 0
    for (const tag of b) if (a.has(tag)) shared += 1
    if (shared / Math.min(a.size, b.size) >= 0.6) return true
  }
  const prefixA = String(entry.text ?? '').slice(0, 30)
  const prefixB = String(candidate.text ?? '').slice(0, 30)
  return prefixA.length > 10 && prefixA === prefixB
}
