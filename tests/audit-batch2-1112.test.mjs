// 2026-11-12 第二批：宽限期按会话算 + 写接口「无 Origin 即拒」。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-batch2-'))
process.env.DSH_HOME = home

const { appendChat, recentChats } = await import('../lib/db.js')
const { noteUserTurn, recentlyActive, ACTIVE_GRACE_MS } = await import('../lib/proactive.js')
const { isSameSiteRequest } = await import('../lib/bridge.js')

const results = []
const check = (name, ok, extra = '') => results.push({ name, ok: Boolean(ok), extra })

// ── 一、宽限期按会话算 ─────────────────────────────────────────────
// 老大在 A 会话里说话，B 会话不该跟着被按住。
const now = Date.now()
const GRACE = 5 * 60 * 1000

appendChat('user', 'cognition', 'A 会话刚说的话', now - 60 * 1000, 'sess-A')
appendChat('user', 'cognition', 'B 会话很久以前说的话', now - 3 * 60 * 60 * 1000, 'sess-B')

check(
  'A 会话刚说过 → A 算活跃',
  recentlyActive(GRACE, now, 'sess-A') === true,
  String(recentlyActive(GRACE, now, 'sess-A')),
)
check(
  'A 会话刚说过 → B 不算活跃（这正是要修的那条）',
  recentlyActive(GRACE, now, 'sess-B') === false,
  String(recentlyActive(GRACE, now, 'sess-B')),
)
check(
  '完全不传会话 → 仍是全局判定（谁在说话都算忙）',
  recentlyActive(GRACE, now) === true,
  String(recentlyActive(GRACE, now)),
)
check(
  '没聊过的会话不算活跃',
  recentlyActive(GRACE, now, 'sess-C') === false,
  String(recentlyActive(GRACE, now, 'sess-C')),
)

// 只有内存里那一笔、库还没写的情况
noteUserTurn(now, 'sess-D')
check('内存里 D 刚说话 → D 算活跃', recentlyActive(GRACE, now, 'sess-D') === true)
check('内存里 D 刚说话 → A 不受影响？A 库里有记录，仍活跃', recentlyActive(GRACE, now, 'sess-A') === true)
check('内存里 D 刚说话 → C 仍不算活跃', recentlyActive(GRACE, now, 'sess-C') === false)

// 日期分界：昨天的 A 不该让今天算活跃
check(
  '很久以前的会话不因别处说话而变活跃',
  recentlyActive(GRACE, now, 'sess-B') === false,
)

// chat_log 里真带上了 session_id
const rows = recentChats(10, 'sess-A')
check(
  'recentChats 按会话过滤只回该会话的',
  rows.length === 1 && rows[0].session_id === 'sess-A',
  JSON.stringify(rows),
)

// 没写 session_id 的老记录（升级前留下的、或者拿不到会话的）归不到任何会话，
// 只能当「不知道是谁说的」—— 这种要算所有人的，宁可先不插嘴。
appendChat('user', 'cognition', '不知道是哪个会话说的', now - 30 * 1000)
check(
  '没有归属的老记录 → 任何会话都算忙（宁可少说）',
  recentlyActive(GRACE, now, 'sess-Z') === true,
  String(recentlyActive(GRACE, now, 'sess-Z')),
)

// ── 二、写接口「无 Origin 即拒」 ───────────────────────────────────
const req = (headers = {}) => ({ headers })

check('两个头都没有 → 拒（本机脚本冒充不了自己人）', isSameSiteRequest(req({})) === false)
check('空对象头 → 拒', isSameSiteRequest(req()) === false)
check('sec-fetch-site: same-origin → 放行', isSameSiteRequest(req({ 'sec-fetch-site': 'same-origin' })) === true)
check('sec-fetch-site: none → 放行（地址栏直接打开）', isSameSiteRequest(req({ 'sec-fetch-site': 'none' })) === true)
check('sec-fetch-site: cross-site → 拒', isSameSiteRequest(req({ 'sec-fetch-site': 'cross-site' })) === false)
check(
  'Origin 是回环 → 放行（没带 sec-fetch-site 的老浏览器）',
  isSameSiteRequest(req({ origin: 'http://127.0.0.1:50618' })) === true,
)
check('Origin 是 localhost → 放行', isSameSiteRequest(req({ origin: 'http://localhost:50618' })) === true)
check('Origin 是外站 → 拒', isSameSiteRequest(req({ origin: 'http://evil.example' })) === false)
check('Origin: null → 拒（沙箱 iframe 会发这个）', isSameSiteRequest(req({ origin: 'null' })) === false)
check('Origin 空串 → 拒', isSameSiteRequest(req({ origin: '' })) === false)
check(
  'sec-fetch-site 说 same-origin 但 Origin 是外站 → 以 sec-fetch-site 为准放行（浏览器自己发的，可信）',
  isSameSiteRequest(req({ 'sec-fetch-site': 'same-origin', origin: 'http://evil.example' })) === true,
)

// ── 汇总 ─────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? `  → ${r.extra}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) process.exitCode = 1
