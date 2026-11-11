/**
 * 自动互动的「为什么没说话」诊断。
 *
 * 2026-11-11 加：老大把自动互动打开、作用范围选成「指定会话」却一个都没勾，
 * 结果整晚一声不吭，界面上只有一个「已开启」，看不出是配置把自己锁死了。
 * 这里只做判断、不碰状态，返回一句人话给界面直接显示。
 */

/** 把间隔折算成人话。 */
function humanInterval(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '未知间隔'
  const minutes = Math.round(value / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round((minutes / 60) * 10) / 10
  return `${hours} 小时`
}

/**
 * @returns {{ level: 'ok'|'info'|'warn', key: string, text: string }}
 */
export function proactiveDiagnosis(input = {}, now = Date.now()) {
  const enabled = input?.enabled === true
  if (!enabled) {
    return { level: 'ok', key: 'off', text: '自动互动关着，不会主动说话。' }
  }
  const scope = input?.scope === 'session' ? 'session' : 'all'
  const ids = Array.isArray(input?.sessionIds)
    ? input.sessionIds.filter((id) => typeof id === 'string' && id.trim() !== '')
    : []
  if (scope === 'session' && ids.length === 0) {
    return {
      level: 'warn',
      key: 'no-session',
      text: '开了，但一个会话都没勾：现在谁都不会收到主动消息。要收的话在设置里勾上对应会话。',
    }
  }
  const window = input?.timeWindow ?? {}
  if (window.enabled !== true) {
    return { level: 'info', key: 'no-window', text: `全天都可能发，约每 ${humanInterval(input?.intervalMs)} 一次。` }
  }
  const start = String(window.start ?? '09:00')
  const end = String(window.end ?? '23:00')
  const perRound = Number(input?.maxPerRound)
  const cap = Number.isFinite(perRound) && perRound > 0 ? `，一轮最多 ${perRound} 个会话` : ''
  const timed = !(Number.isFinite(now) && now > 0)
  if (timed) {
    return { level: 'ok', key: 'running', text: `${start}~${end} 之间说话，约每 ${humanInterval(input?.intervalMs)} 一次${cap}。` }
  }
  // now 在窗口外时给一句「现在是静默时段」，但别报错——这是正常配置。
  const hhmm = new Date(now).toTimeString().slice(0, 5)
  const inWindow = start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end
  if (inWindow) {
    return { level: 'ok', key: 'running', text: `${start}~${end} 之间说话，约每 ${humanInterval(input?.intervalMs)} 一次${cap}。` }
  }
  return { level: 'info', key: 'outside-window', text: `现在是静默时段（只在 ${start}~${end} 之间说话），到点才会开口。` }
}
