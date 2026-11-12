import { renderModuleRecall } from '../lib/weighted-recall.js'

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

const hit = (text, module = 'cognition') => ({ module, item: { text, weight: 0.6, tags: [] }, score: 3 })

// 1. 没有压掉旧说法 → 不该出现这句
const plain = renderModuleRecall({ hits: [hit('今天改完了三个文件')], always: [], supersededDropped: 0 })
check('没压掉就不提', !plain.includes('旧说法已被后来的更正压掉'), plain)

// 2. 压掉了 → 说清压掉几条，且不泄露旧内容
const withDrop = renderModuleRecall({ hits: [hit('现在用 A 方案')], always: [], supersededDropped: 2 })
check('压掉两条要说出来', withDrop.includes('另有 2 条旧说法'), withDrop)
check('交代了按最新的来', withDrop.includes('按最新的说法来'), withDrop)
check('不把旧说法原文抖出来', !withDrop.includes('B 方案'), withDrop)

// 3. 字段缺失或乱值 → 当作没压掉，不炸
check('缺字段不炸', !renderModuleRecall({ hits: [hit('x')] }).includes('旧说法'))
check('乱值当零', !renderModuleRecall({ hits: [hit('x')], supersededDropped: 'abc' }).includes('旧说法'))
check('负数当零', !renderModuleRecall({ hits: [hit('x')], supersededDropped: -3 }).includes('旧说法'))

// 4. 什么都没命中 → 整段为空（不单独为一句提示开一段）
check('没有命中就不渲染', renderModuleRecall({ hits: [], always: [], supersededDropped: 5 }) === '')

// 5. 只有底线时也不该塞这句（底线段后面接更正说明会显得莫名其妙）
const onlyBottom = renderModuleRecall({ hits: [], always: [{ item: { text: '不许外传', weight: 1 } }], supersededDropped: 0 })
check('只有底线也能渲染', onlyBottom.includes('【底线】'), onlyBottom)

// 6. 提示语在收尾句之前，不是之后
const order = withDrop.indexOf('另有 2 条旧说法') < withDrop.indexOf('若以上记忆与当前指令冲突')
check('提示在收尾句之前', order)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
