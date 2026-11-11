// retagStore：界面按钮与命令行共用的一致性测试。
import { retagStore, tagsForEntry, extractTags } from '../lib/autotag.js'

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok: Boolean(ok), extra })
}

const poem = {
  id: 'k1',
  module: 'knowledge',
  text: '欲穷千里目，更上一层楼。——王之涣《登鹳雀楼》。要看得更远，就得站得更高。',
  tags: [],
  sourceRef: '唐宋诗词精选',
  updatedAt: 1000,
}
const history = {
  id: 'k2',
  module: 'knowledge',
  text: '商（约前 1600-前 1046）有甲骨文，是目前确认的最早成熟汉字体系。',
  tags: [],
  updatedAt: 2000,
}
const chat = { id: 'c1', module: 'cognition', text: '今天把三个文件都改完了，顺手跑了一下测试。', tags: [], updatedAt: 3000 }
const tagged = {
  id: 'k3',
  module: 'knowledge',
  text: '老子出关，留下《道德经》五千言。',
  tags: ['道德经', '老子'],
  updatedAt: 4000,
}

// 1. 默认只碰知识类，工作记忆不动
{
  const store = { entries: [structuredClone(poem), structuredClone(history), structuredClone(chat), structuredClone(tagged)] }
  const result = retagStore(store, {})
  check('只扫知识类：scanned 为 3', result.scanned === 3, `scanned=${result.scanned}`)
  check('工作记忆未被改', JSON.stringify(store.entries[2].tags) === '[]', JSON.stringify(store.entries[2].tags))
}

// 2. dryRun 不落盘但报数
{
  const store = { entries: [structuredClone(poem), structuredClone(history)] }
  const result = retagStore(store, { dryRun: true })
  check('dryRun 报出能改的条数', result.changed === 2, `changed=${result.changed}`)
  check('dryRun 不改内存里的 tags', JSON.stringify(store.entries[0].tags) === '[]', JSON.stringify(store.entries[0].tags))
  check('dryRun 标记为 true', result.dryRun === true)
}

// 3. 真补：诗拿到书名/作者/篇名，且 updatedAt 原样
{
  const store = { entries: [structuredClone(poem), structuredClone(history), structuredClone(tagged)] }
  const before = store.entries.map((e) => e.updatedAt)
  const result = retagStore(store, {})
  // 已带标签那条也会被补（正文里还有「老子出关」这类有据可依的短语），
  // 所以是 3 不是 2 —— 只补不删，是 mergeTags 的口径。
  check('三条都能补（只补不删）', result.changed === 3, `changed=${result.changed}`)
  const tags = store.entries[0].tags
  check('诗词补出王之涣', tags.includes('王之涣'), JSON.stringify(tags))
  check('诗词补出登鹳雀楼', tags.includes('登鹳雀楼'), JSON.stringify(tags))
  check('诗词补出书名', tags.includes('唐宋诗词精选'), JSON.stringify(tags))
  check('updatedAt 全都没动', JSON.stringify(store.entries.map((e) => e.updatedAt)) === JSON.stringify(before), JSON.stringify(store.entries.map((e) => e.updatedAt)))
  const kept = store.entries[2].tags
  check('原有标签一个不丢', kept.includes('道德经') && kept.includes('老子'), JSON.stringify(kept))
  check('原有标签排在最前', kept[0] === '道德经' && kept[1] === '老子', JSON.stringify(kept))
}

// 4. 幂等：再跑一遍什么都不改
{
  const store = { entries: [structuredClone(poem), structuredClone(history)] }
  retagStore(store, {})
  const again = retagStore(store, {})
  check('第二次 changed 为 0', again.changed === 0, `changed=${again.changed}`)
}

// 5. all 才碰工作记忆
{
  const store = { entries: [structuredClone(chat)] }
  const narrow = retagStore(store, {})
  check('默认口径工作记忆 scanned 为 0', narrow.scanned === 0, `scanned=${narrow.scanned}`)
  const wide = retagStore(store, { all: true })
  check('all 口径会扫工作记忆', wide.scanned === 1, `scanned=${wide.scanned}`)
}

// 6. 与 tagsForEntry 同源
{
  check('tagsForEntry 与 extractTags 一致', JSON.stringify(tagsForEntry(poem)) === JSON.stringify(extractTags(poem.text, { sourceRef: poem.sourceRef })))
}

// 7. 坏输入不炸
{
  check('null store 不炸', retagStore(null, {}).changed === 0)
  check('空 entries 不炸', retagStore({ entries: [] }, {}).changed === 0)
  const messy = { entries: [null, undefined, 'x', { module: 'knowledge' }] }
  check('混合脏数据不炸', retagStore(messy, {}).scanned === 1, 'scanned')
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  ' + r.extra}`)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : 'FAILED'} ${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
