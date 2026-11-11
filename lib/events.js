/**
 * 进程内的「刚发生了什么」事件环 —— 给桌宠和排障用。
 *
 * 只放最近 200 条，不落盘：这是「刚才那一刻」的窗口，不是审计日志。
 * 落盘的事归 memory.json / chat_log，别在这里重复。
 */

const MAX_EVENTS = 200;

/** @type {Array<{at:number,kind:string,text:string,extra?:object}>} */
const ring = [];

/**
 * 记一条事件。text 会被截到 200 字，避免长正文把环撑爆。
 * @param {string} kind 事件类型：turn / proactive / archive / sync / error
 * @param {string} text 一句话说明
 * @param {object} [extra] 附加字段（会原样带出去，别塞隐私）
 */
export function recordEvent(kind, text, extra) {
  const item = {
    at: Date.now(),
    kind: String(kind || 'misc').slice(0, 24),
    text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
  if (extra && typeof extra === 'object') item.extra = extra;
  ring.push(item);
  if (ring.length > MAX_EVENTS) ring.splice(0, ring.length - MAX_EVENTS);
  return item;
}

/**
 * 最近的事件，默认 20 条，新的在前。
 * @param {number} limit
 */
export function recentEvents(limit = 20) {
  const n = Number(limit);
  const size = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_EVENTS) : 20;
  return ring.slice(-size).reverse();
}

/** 清空（测试与插件卸载用）。 */
export function clearEvents() {
  ring.length = 0;
}

/** 当前条数，排障用。 */
export function eventCount() {
  return ring.length;
}
