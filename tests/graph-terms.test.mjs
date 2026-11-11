/**
 * 图谱不该把「继续」「装好」「做完」这类口头语当实体。
 * 实测真库里度数最高的几个节点就是它们（继续 54、装好 32、做完 29），
 * 结果图扩展召回把毫不相干的记忆连成一片。
 */
import { contentTerms, isLowValueTerm, buildGraph } from '../lib/memory-graph.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

const chatter = ['继续', '装好', '做完', '弄好', '搞定', '跑通', '看看', '顺手', '马上', '知道了']
for (const term of chatter) check(`「${term}」不算线索`, isLowValueTerm(term) === true)

const terms = contentTerms('继续把补丁装好，做完我看看，顺手把 SQLite 那边的 WAL 也收一下')
check('口头语被滤掉', !['继续', '装好', '做完', '看看', '顺手'].some((t) => terms.has(t)), [...terms].join(','))
check('真正的名词留得住', terms.has('补丁') && terms.has('SQLite'.toLowerCase()) === false, [...terms].join(','))
check('跨词碎片与代词被滤掉', !terms.has('完我') && !terms.has('我看') && !terms.has('我看看'), [...terms].join(','))

// 造两条记忆：除了口头语没有任何共同内容，不应该被共现边连起来
const entries = [
  { id: 'm1', text: '继续 装好 做完 看看 顺手', module: 'cognition' },
  { id: 'm2', text: '继续 装好 做完 看看 顺手', module: 'cognition' },
]
const g = buildGraph(entries)
const labels = (g.nodes ?? []).map((n) => n.label)
check('纯口头语的两条记忆不起实体节点', !labels.includes('继续') && !labels.includes('装好'), labels.slice(0, 8).join(','))

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
