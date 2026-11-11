import { recall, scoreEntry, tokenize } from '../lib/recall.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}  ${extra}`)
  }
}

const now = Date.UTC(2026, 10, 11)
const terms = [...new Set(tokenize('李白 将进酒 豪放'))]

// 1) 短条目不打折：400 字以内长度因子必须是 1，分数与「不加长度项」时一致
const shortA = { id: 'a', text: '李白《将进酒》最豪放。', tags: [], updatedAt: now }
const shortB = { id: 'b', text: '李白《将进酒》最豪放。'.repeat(1), tags: [], updatedAt: now }
check('同样内容分数稳定', scoreEntry(shortA, terms, now) === scoreEntry(shortB, terms, now))

// 2) 长条目：命中词一样多，分数要更低（长度归一在起作用）
const filler = '今天又翻了几页旧书，顺手记了几笔，都是些零碎的感想，跟正题关系不大的闲话。'
const longText = ('李白 将进酒 豪放。' + filler).repeat(40)
check('长文本确实超过 1500 字', longText.length > 1500, String(longText.length))
const longEntry = { id: 'long', text: longText, tags: [], updatedAt: now }
const shortScore = scoreEntry({ id: 's', text: '李白 将进酒 豪放。', tags: [], updatedAt: now }, terms, now)
const longScore = scoreEntry(longEntry, terms, now)
check('长条目分数更低', longScore < shortScore - 1, `short=${shortScore.toFixed(2)} long=${longScore.toFixed(2)}`)

// 3) 排序：短而准的排前面（recall 返回 {entry, score}）
const hits = recall([longEntry, { id: 's', text: '李白 将进酒 豪放。', tags: [], updatedAt: now }], '李白 将进酒 豪放', { limit: 5, now })
check('短而准的排第一', hits.length > 0 && hits[0].entry.id === 's', JSON.stringify(hits.map((h) => h.entry.id)))

// 4) 批量路径与逐条打分一致（长度因子两处都要有，别只改一边）
const same = scoreEntry({ id: 's', text: '李白 将进酒 豪放。', tags: [], updatedAt: now }, terms, now)
check('批量结果与逐条一致', hits.length > 0 && Math.abs(hits[0].score - same) < 1e-9, `${hits[0] && hits[0].score} vs ${same}`)

// 5) 零命中仍是 0
check('零命中是 0 分', scoreEntry({ id: 'x', text: '完全无关的内容', tags: [], updatedAt: now }, terms, now) === 0)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
