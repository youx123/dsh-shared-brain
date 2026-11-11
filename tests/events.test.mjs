/**
 * 事件环（lib/events.js）—— 2026-11-11
 *
 * 它就是给桌宠和排障看的「刚才发生了什么」，所以只守三件事：
 * 顺序（新的在前）、上限（200 条丢掉最旧的）、不炸（任何输入都不抛）。
 */
import { recordEvent, recentEvents, clearEvents, eventCount } from '../lib/events.js'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}`) }
  else { fail += 1; console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

clearEvents()
check('初始为空', recentEvents().length === 0)

recordEvent('turn', 'cognition：记下一条测试')
recordEvent('proactive', '问问进度怎么样了', { sessionId: 'session-1' })
let list = recentEvents(10)
check('记两条就有两条', list.length === 2)
check('新的在前', list[0].kind === 'proactive' && list[1].kind === 'turn', JSON.stringify(list.map((e) => e.kind)))
check('带 extra', list[0].extra?.sessionId === 'session-1')
check('带时间戳', typeof list[0].at === 'number' && list[0].at > 0)

// 空白与超长都收得住
recordEvent('turn', '  多   余   空   白  ')
list = recentEvents(1)
check('空白折叠成单个空格', list[0].text === '多 余 空 白', JSON.stringify(list[0].text))
recordEvent('turn', 'x'.repeat(500))
list = recentEvents(1)
check('长文本截到 200', list[0].text.length === 200, String(list[0].text.length))

// 非法输入不抛
let threw = false
try {
  recordEvent()
  recordEvent(null, null)
  recordEvent('k', 'ok', 'not-an-object')
  recentEvents('abc')
  recentEvents(-5)
} catch (error) {
  threw = true
  console.log('  抛了：' + error.message)
}
check('非法输入不抛', !threw)

// 上限：塞 260 条只留最后 200
clearEvents()
for (let i = 0; i < 260; i += 1) recordEvent('turn', `第 ${i} 条`)
check('上限 200', eventCount() === 200, String(eventCount()))
list = recentEvents(200)
check('留的是最新的', list[0].text === '第 259 条' && list[199].text === '第 60 条', list[0].text)

// limit 的边界
check('limit 默认 20', recentEvents().length === 20)
check('limit 超上限被夹住', recentEvents(999).length === 200)
check('limit 为 0 回默认 20', recentEvents(0).length === 20)

clearEvents()
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
