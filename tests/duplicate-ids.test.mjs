import { memoryCheck, renderCheckLine } from 'file:///C:/Users/13176/Documents/dsh-shared-brain-patches/lib/health.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log('PASS  ' + name)
  } else {
    fail += 1
    console.log('FAIL  ' + name + '  ' + extra)
  }
}

const now = Date.now()
const mk = (id, text, module = 'cognition') => ({
  id,
  module,
  text,
  weight: 0.7,
  lifetime: 'permanent',
  expiresAt: 0,
  pinned: false,
  source: 'auto',
  createdAt: now - 1000,
  updatedAt: now - 1000,
  tags: [],
})

const entries = [
  mk('mem_dup_a', '这条正文重复了三遍，应该被归成一组。'),
  mk('mem_dup_b', '这条正文重复了三遍，应该被归成一组。'),
  mk('mem_dup_c', '这条正文重复了三遍，应该被归成一组。'),
  mk('mem_only', '这条是独一份，别算进重复。'),
]

const result = memoryCheck({ entries, modules: {}, now })

check('重复组数为 1', result.duplicates.length === 1, JSON.stringify(result.duplicates))
const group = result.duplicates[0] ?? {}
check('这一组是 3 条', group.count === 3, String(group.count))
check('带上三个 id', Array.isArray(group.ids) && group.ids.length === 3, JSON.stringify(group.ids))
check(
  'id 是真实那三条',
  ['mem_dup_a', 'mem_dup_b', 'mem_dup_c'].every((id) => group.ids.includes(id)),
  JSON.stringify(group.ids),
)
check('独一份没被算进去', !group.ids.includes('mem_only'), JSON.stringify(group.ids))
check('文本保留了前 60 字', String(group.text).startsWith('这条正文重复了三遍'), String(group.text))

const line = renderCheckLine(result)
check('体检行说 1 组重复', line.includes('重复 1 组'), line)

// 单条不该产生重复组
const single = memoryCheck({ entries: [mk('mem_solo', '只有我一条。')], modules: {}, now })
check('单条不报重复', single.duplicates.length === 0, JSON.stringify(single.duplicates))

// 不同模块同正文不算重复（沿用旧口径）
const cross = memoryCheck({
  entries: [mk('mem_x', '跨模块同正文。', 'cognition'), mk('mem_y', '跨模块同正文。', 'knowledge')],
  modules: {},
  now,
})
check('不同模块同正文不算重复', cross.duplicates.length === 0, JSON.stringify(cross.duplicates))

// id 超过 6 条时只留前 6 个，免得一行拉太长
const many = Array.from({ length: 9 }, (_, i) => mk('mem_many_' + i, '九条一模一样的正文。'))
const manyResult = memoryCheck({ entries: many, modules: {}, now })
const manyGroup = manyResult.duplicates[0] ?? {}
check('九条只留前 6 个 id', (manyGroup.ids ?? []).length === 6, JSON.stringify(manyGroup.ids))
check('总数还是 9', manyGroup.count === 9, String(manyGroup.count))

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
