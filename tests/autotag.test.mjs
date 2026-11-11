import { extractTags, mergeTags, tagsForEntry } from 'file:///C:/Users/13176/Documents/dsh-shared-brain-patches/lib/autotag.js'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + ' ' + extra) }
}

const poem = extractTags('欲穷千里目，更上一层楼。——王之涣《登鹳雀楼》。要看得更远，就得站得更高。', { sourceRef: '唐宋诗词精选' })
check('诗词：书名', poem.includes('唐宋诗词精选'), poem.join(','))
check('诗词：作者', poem.includes('王之涣'), poem.join(','))
check('诗词：篇名', poem.includes('登鹳雀楼'), poem.join(','))
check('诗词：不超过 6 个', poem.length <= 6, String(poem.length))

const history = extractTags('商（约前 1600-前 1046）有甲骨文，是目前确认的最早成熟汉字体系。', { sourceRef: '中国历史纲要' })
check('历史：带出处', history.includes('中国历史纲要'), history.join(','))
check('历史：不把「约前」这类数字残片当标签', !history.some((t) => /^\d+$/.test(t)), history.join(','))

const work = extractTags('改 store.js 的 writeStore，跑 node --check 全过，再同步 patches')
check('技术词：文件名', work.includes('store.js'), work.join(','))
check('技术词：命令/标识符', work.some((t) => /^writeStore$|^node$|^patches$/i.test(t)), work.join(','))
check('技术词：没有「老大让我把」这类整段', !work.some((t) => t.includes('让我')), work.join(','))

check('空文本不炸', extractTags('').length === 0)
check('纯标点不炸', extractTags('。。。，,').length === 0)
check('停用词不收', !extractTags('这个 那个 因为 所以').includes('这个'))
check('去重', (() => { const t = extractTags('《将进酒》《将进酒》'); return t.filter((x) => x === '将进酒').length === 1 })())
check('超长标签不收', !extractTags('《' + '很'.repeat(60) + '》').length)
check('合并保序去重', mergeTags(['a1', 'b2'], ['b2', 'c3']).join(',') === 'a1,b2,c3')

const entry = { text: '相看两不厌，只有敬亭山。——李白《独坐敬亭山》。', sourceRef: '唐宋诗词精选', tags: ['孤独'] }
const merged = tagsForEntry(entry)
check('原有标签保留', merged.includes('孤独'), merged.join(','))
check('新标签补上', merged.includes('李白') && merged.includes('独坐敬亭山'), merged.join(','))

// 真数据抽样：看会不会抽出垃圾
const samples = [
  '老大让我把桌面助手的自动重启接完整，再跑一遍检查。',
  '记忆条目超过上限时会转存到 memory-archive.jsonl。',
  '「大肥鱼」是历史遗留的外号，别混着叫。',
]
for (const text of samples) console.log('SAMPLE', JSON.stringify(extractTags(text)))

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
