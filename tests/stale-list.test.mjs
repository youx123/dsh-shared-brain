/** 体检不只报「N 条陈旧」，还要给出是哪几条。 */
import { memoryCheck } from 'file:///C:/Users/13176/Documents/dsh-shared-brain-patches/lib/health.js'

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++
    console.log('PASS  ' + name)
  } else {
    fail++
    console.log('FAIL  ' + name + '  ' + extra)
  }
}

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const entry = (id, days, extra = {}) => ({
  id,
  module: 'cognition',
  text: `很久没动过的第 ${id} 条 ${'补'.repeat(40)}`,
  updatedAt: now - days * DAY,
  lifetime: 'permanent',
  source: 'auto',
  ...extra,
})

const many = Array.from({ length: 12 }, (_, i) => entry('mem_old_' + i, 100 + i))
many.push(entry('mem_pinned', 200, { pinned: true }))
many.push(entry('mem_fresh', 3))
const result = memoryCheck({ entries: many, modules: {}, now })

check('陈旧计数包含 12 条', result.stale === 12, String(result.stale))
check('明细最多 8 条', result.staleList.length === 8, String(result.staleList.length))
check('明细按条目给出 id', result.staleList[0].id === 'mem_old_0', JSON.stringify(result.staleList[0]))
check('明细带天数', result.staleList[0].days === 100, String(result.staleList[0].days))
check('明细正文截断到 30 字以内', result.staleList[0].text.length <= 30, String(result.staleList[0].text.length))
check('钉住的不进明细', !result.staleList.some((x) => x.id === 'mem_pinned'))
check('最近动过的不进明细', !result.staleList.some((x) => x.id === 'mem_fresh'))

const none = memoryCheck({ entries: [entry('mem_new', 1)], modules: {}, now })
check('没有陈旧时是空数组', Array.isArray(none.staleList) && none.staleList.length === 0)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
