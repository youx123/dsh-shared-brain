/**
 * 记忆冲突检测：找出「后说的话推翻了前一句话」的情况。
 *
 * 为什么需要：
 *   「用 A 方案」入库之后，隔天又说「改用 B 方案」—— 两条都在库里，
 *   召回时哪个都可能被抽出来，模型就懵了。真正有用的不是记住两条，
 *   而是知道**当前该听哪一条**。
 *
 * 怎么判冲突（不靠大模型，纯规则）：
 *   1. 主题重合 —— 标签重合或正文前若干字相同（跟 classify.js 的 topicOverlap 同思路）
 *   2. 方向相反 —— 命中「改用 / 换成 / 不再用 / 其实 / 改成」这类**转向词**，
 *      而且新条目出现得更晚
 *
 * 命中后不是删掉旧记忆（旧记忆仍有历史价值），而是给新记忆打上
 * `supersedes: <旧条目 id>` 标记，召回时优先用新的。
 */
import { topicOverlap } from './classify.js'

/** 转向词：出现即表示「这条推翻了之前的说法」。 */
const REVERSAL_PATTERNS = [
  /改用|换成|不用了|不再用|改成|换成了|改成用|已经换|现在用|其实是|实际上|纠正|更正|搞错了|说错了|作废|废弃|取消掉|撤销/,
  /instead of|rather than|actually|correction|scratch that|no longer/i,
]

/**
 * 判断一条新记忆是否与旧记忆冲突。
 *
 * @param {object} older 旧条目
 * @param {object} newer 新条目
 * @returns {boolean}
 */
export function isConflicting(older, newer) {
  if (!older || !newer) return false
  if (older.id === newer.id) return false
  // 主题必须是同一个，否则不叫冲突
  if (!topicOverlap(older, newer)) return false
  // 新条目必须带「转向」语义
  const text = `${newer.text ?? ''}`
  if (!REVERSAL_PATTERNS.some((pattern) => pattern.test(text))) return false
  // 旧条目不能已经是「被取代过」的？不 —— 链条要能一路传下去
  return true
}

/**
 * 在一批旧条目里找出与新条目冲突的那些。
 *
 * @param {Array} entries 旧条目
 * @param {object} candidate 新条目
 * @returns {Array} 冲突的旧条目
 */
export function findConflicts(entries, candidate) {
  const out = []
  for (const entry of entries ?? []) {
    if (isConflicting(entry, candidate)) out.push(entry)
  }
  return out
}

/**
 * 在候选里找「最新的那个」（取代链条的终点）。
 */
export function latestOf(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  return list.reduce((best, item) => ((item?.updatedAt ?? 0) > (best?.updatedAt ?? 0) ? item : best), list[0])
}

/**
 * 渲染冲突提示（注入提示词时提醒模型以新为准）。
 *
 * @param {Array} conflicts 冲突的旧条目
 * @param {object} current 当前生效的新条目
 */
export function renderConflict(conflicts, current) {
  const list = Array.isArray(conflicts) ? conflicts : []
  if (list.length === 0) return ''
  const olds = list.map((item) => `「${String(item.text ?? '').slice(0, 40)}…」`).join('、')
  return `【注意】以下旧说法已被更正，以新说法为准：${olds} → 现在是「${String(current?.text ?? '').slice(0, 60)}…」`
}
