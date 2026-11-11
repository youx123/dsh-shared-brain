/** 模块桶合并去重：按 id 或正文前 40 字挡重复，且不再平方复杂度。 */
import { mergeBucketItems, textPrefix, PREFIX_LEN } from 'file:///C:/Users/13176/Documents/dsh-shared-brain-patches/lib/bucket-merge.js'

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

const base = [
  { id: 'a', text: '第一条：今天把共享大脑的注入预算做完了，顺手补了几个测试' },
  { id: 'b', text: '第二条：桌宠的愁脸只在刚出错的时候演，十分钟后就不演了' },
]

// 1. 全新条目照收
const r1 = mergeBucketItems(base, [{ id: 'c', text: '第三条：一件完全不相干的事' }])
check('新条目加进来', r1.items.length === 3 && r1.added === 1)
check('原条目没被改', r1.items[0].id === 'a' && r1.items[1].id === 'b')

// 2. 同 id 挡掉
const r2 = mergeBucketItems(base, [{ id: 'a', text: '同 id 但正文不一样，也得挡' }])
check('同 id 挡掉', r2.items.length === 2 && r2.added === 0 && r2.skipped === 1)

// 3. 正文前 40 字相同挡掉（老数据里 id 不同、正文一样的情况）
const longBase = '第一条：今天把共享大脑的注入预算做完了，顺手补了几个测试，这行特意写长一点超过四十个字，好验证前缀判等'
const base2 = [{ id: 'a', text: longBase }]
const dupText = { id: 'z', text: longBase }
const r3 = mergeBucketItems(base2, [dupText])
check('完全一样挡掉', r3.items.length === 1 && r3.added === 0)

// 4. 前 40 字相同、后面不同也挡（历史数据里同一段话被截断过的那种）
const r4 = mergeBucketItems(base2, [{ id: 'y', text: longBase.slice(0, 40) + '从这里开始不一样了' }])
check('前 40 字相同就挡（即使后面不同）', r4.items.length === 1 && r4.added === 0, String(r4.items.length))

// 5. accept 过滤（比如过期删掉的正文）
const r5 = mergeBucketItems(base, [{ id: 'd', text: '过期了的那条' }], { accept: () => false })
check('accept 返回 false 就跳过', r5.items.length === 2 && r5.skipped === 1)

// 6. 同一批里自己重复
const r6 = mergeBucketItems([], [{ id: 'x', text: '同一条' }, { id: 'x2', text: '同一条' }])
check('同一批里重复也挡', r6.items.length === 1 && r6.added === 1)

// 7. 空输入
check('空桶接空候选', mergeBucketItems([], []).items.length === 0)
check('undefined 不炸', mergeBucketItems(undefined, undefined).items.length === 0)

// 8. 不改原数组
const original = base.slice()
mergeBucketItems(base, [{ id: 'q', text: '再来一条' }])
check('不改原数组', base.length === original.length)

// 9. 前缀工具
check('前缀去空白', textPrefix('   前后有空格   ') === '前后有空格')
check('前缀长度 40', textPrefix('x'.repeat(100)).length === 40)
check('PREFIX_LEN 是 40', PREFIX_LEN === 40)
check('空文本前缀为空', textPrefix(undefined) === '')

// 10. 量级：一千条对一千条，不该慢
const many = []
for (let i = 0; i < 1000; i++) many.push({ id: `old-${i}`, text: `旧条目第 ${i} 号，内容长约三十个字，用来做规模测试` })
const incoming = []
for (let i = 0; i < 1000; i++) incoming.push({ id: `new-${i}`, text: `新条目第 ${i} 号，内容同样长约三十个字，用来做规模测试` })
const t0 = Date.now()
const big = mergeBucketItems(many, incoming)
const cost = Date.now() - t0
check('一千加一千都进来了', big.items.length === 2000 && big.added === 1000, String(big.items.length))
check('规模测试不慢（<300ms）', cost < 300, `${cost}ms`)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
