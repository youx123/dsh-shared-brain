/** 记忆注入的预算守门：超了就按行截，末尾说明少了多少行。 */
import { fitToBudget, describeBudget, INJECT_BUDGET_CHARS } from 'file:///C:/Users/13176/Documents/dsh-shared-brain-patches/lib/inject-budget.js'

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

// 1. 短文本原样
const short = fitToBudget('【认知】\n- 一条很短的话')
check('短文本不改', short.text === '【认知】\n- 一条很短的话' && short.trimmed === false)
check('短文本 dropped 为 0', short.droppedLines === 0)

// 2. 超预算按行截
const lines = []
for (let i = 0; i < 200; i++) lines.push(`- 第 ${i} 条记忆，内容长度大概二十个字左右`)
const long = lines.join('\n')
const cut = fitToBudget(long, { budget: 500 })
check('超预算会截断', cut.trimmed === true)
check('截断后不超预算', cut.text.length <= 500, String(cut.text.length))
check('保留开头', cut.text.startsWith('- 第 0 条记忆'))
check('末尾有说明', /后面还有 \d+ 行没放进来/.test(cut.text), cut.text.slice(-40))
check('丢的行数与说明一致', cut.text.includes(`还有 ${cut.droppedLines} 行`), String(cut.droppedLines))

// 3. 不切半个字符：一行的字数是整数，拼接后不应出现半个代理对
const emojiLine = '🐟'.repeat(400)
const emojiCut = fitToBudget(emojiLine, { budget: 300 })
check('超长单行不报错', typeof emojiCut.text === 'string' && emojiCut.text.length > 0)
check('超长单行硬切后也不超预算', emojiCut.text.length <= 300, String(emojiCut.text.length))

// 4. 边界
check('空文本回空', fitToBudget('').text === '')
check('null 回空', fitToBudget(null).text === '')
check('预算 0 只留说明', fitToBudget('abc\ndef', { budget: 0 }).text.startsWith('…（记忆太长'), fitToBudget('abc\ndef', { budget: 0 }).text)
check('默认预算是 4000', INJECT_BUDGET_CHARS === 4000)

// 5. 一行不多不少正好在预算内
const exact = 'x'.repeat(4000)
check('刚好等于预算不改', fitToBudget(exact, { budget: 4000 }).trimmed === false)

// 6. describeBudget
check('未截断的描述', describeBudget(short) === '注入未截断')
check('截断的描述', describeBudget(cut).startsWith('注入已截断：少了 '))

// 7. 保持行结构（不把多行糊成一行）
check('多行仍多行', cut.text.split('\n').length >= 2)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
