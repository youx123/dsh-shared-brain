import { proactiveDiagnosis } from 'file:///C:/Users/13176/Documents/dsh-shared-brain-patches/lib/proactive-diagnosis.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log('PASS  ' + name)
  } else {
    fail++
    console.log('FAIL  ' + name + '  ' + extra)
  }
}

const base = { enabled: true, scope: 'all', sessionIds: [], intervalMs: 900000, maxPerRound: 1, timeWindow: { enabled: false } }
const at = (hhmm) => new Date(`2026-11-11T${hhmm}:00+08:00`).getTime()

// 1. 关着
check('关着就说关着', proactiveDiagnosis({ ...base, enabled: false }).key === 'off')

// 2. 指定会话但一个没勾 → warn
const locked = proactiveDiagnosis({ ...base, scope: 'session', sessionIds: [] })
check('没勾会话报 warn', locked.level === 'warn' && locked.key === 'no-session', locked.key)
check('warn 文案说清「谁都不会收到」', locked.text.includes('谁都不会收到'), locked.text)

// 3. 空串/空白不算勾
const blank = proactiveDiagnosis({ ...base, scope: 'session', sessionIds: ['', '  '] })
check('空白 id 不算勾', blank.key === 'no-session', blank.key)

// 4. 勾了就正常（没设时间窗时是 info「全天」，不该再报 warn）
const bound = proactiveDiagnosis({ ...base, scope: 'session', sessionIds: ['session-abc'] })
check('勾了会话就不告警', bound.level !== 'warn' && bound.key === 'no-window', bound.key)

// 4b. 勾了 + 设了时间窗 + 窗内 → 正常 running
const boundRunning = proactiveDiagnosis(
  { ...base, scope: 'session', sessionIds: ['session-abc'], timeWindow: { enabled: true, start: '09:00', end: '23:00' } },
  at('14:30'),
)
check('勾了且窗内 → running', boundRunning.key === 'running' && boundRunning.level === 'ok', boundRunning.key)

// 5. 没设时间窗 → info 全天
check('没时间窗说「全天都可能发」', proactiveDiagnosis(base).text.includes('全天都可能发'))

// 6. 设了时间窗、现在在窗内 → ok
const inWindow = proactiveDiagnosis({ ...base, timeWindow: { enabled: true, start: '09:00', end: '23:00' } }, at('14:30'))
check('窗内正常', inWindow.key === 'running' && inWindow.level === 'ok', inWindow.key)

// 7. 窗外 → info（不是错）
const outside = proactiveDiagnosis({ ...base, timeWindow: { enabled: true, start: '09:00', end: '23:00' } }, at('03:10'))
check('窗外提示静默时段', outside.key === 'outside-window' && outside.level === 'info', outside.key)

// 8. 跨午夜窗口（23:00~07:00）凌晨算窗内
const night = proactiveDiagnosis({ ...base, timeWindow: { enabled: true, start: '23:00', end: '07:00' } }, at('03:10'))
check('跨午夜窗口算窗内', night.key === 'running', night.key)

// 9. 间隔人话
check('间隔折算成分钟', proactiveDiagnosis(base).text.includes('15 分钟'), proactiveDiagnosis(base).text)
check('间隔大时折算成小时', proactiveDiagnosis({ ...base, intervalMs: 3 * 3600 * 1000 }).text.includes('3 小时'))

// 10. 一轮个数写进去
check('带上每轮个数', proactiveDiagnosis({ ...base, maxPerRound: 2, timeWindow: { enabled: true, start: '09:00', end: '23:00' } }, at('12:00')).text.includes('一轮最多 2 个会话'))

// 11. 脏输入不炸
check('空对象不炸', proactiveDiagnosis().key === 'off')
check('乱间隔不炸', typeof proactiveDiagnosis({ ...base, intervalMs: 'x' }).text === 'string')

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
