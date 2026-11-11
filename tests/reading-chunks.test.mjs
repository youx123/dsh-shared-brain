import { chunkText, coverageSummary, CHUNK_CHARS, MAX_CHUNKS } from '../lib/reading-chunks.js'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log('  ✓ ' + name)
  } else {
    fail += 1
    console.log('  ✗ ' + name + (extra ? '  ' + extra : ''))
  }
}

// 1. 短文本不分块
const short = '这是一段很短的话。'
const c1 = chunkText(short)
check('短文本只有一块', c1.length === 1 && c1[0].text === short)
check('短文本 chars 正确', c1[0].chars === short.length)

// 2. 空输入
check('空文本返回空数组', chunkText('   ').length === 0 && chunkText(null).length === 0)

// 3. 长文本按上限切
const long = Array.from({ length: 160 }, (_, i) => `第${i + 1}段：这是用来测试分块的正文，里面有一些不重要的话，凑够长度。`).join('\n\n')
const c2 = chunkText(long, { maxChunks: 10 })
check('长文本切成多块', c2.length > 3, String(c2.length))
check('没有块超过上限（允许标点溢出 1~2 字）', c2.every((c) => c.chars <= CHUNK_CHARS + 2), c2.map((c) => c.chars).join(','))
check('默认最多 3 块', chunkText(long).length === MAX_CHUNKS, String(chunkText(long).length))

// 4. 块序与 offset 连续
check('index 连续', c2.every((c, i) => c.index === i))
check('offset 单调递增', c2.every((c, i) => i === 0 || c.offset >= c2[i - 1].offset + c2[i - 1].chars))
check('拼起来覆盖前段', c2.map((c) => c.text).join('\n').includes('第1段'))

// 5. 单句超长时硬切
const noBreak = '甲'.repeat(3000)
const c3 = chunkText(noBreak, { size: 1000, maxChunks: 5 })
check('无标点也能切', c3.length === 3 && c3.every((c) => c.chars <= 1000))

// 6. 段落拼接：两个短段应合成一块
const two = '第一段。\n\n第二段。'
check('两个短段合成一块', chunkText(two).length === 1)

// 7. 覆盖统计
const cov = coverageSummary(c2, long.length)
check('覆盖统计有块数', cov.chunks === c2.length)
check('覆盖统计字数', cov.chars === c2.reduce((s, c) => s + c.chars, 0))
check('未读完时 truncated 为真', cov.truncated === true)
const covFull = coverageSummary(c1, short.length)
check('读完了 truncated 为假', covFull.truncated === false && covFull.ratio === 1)

// 8. 非法参数不炸
check('非法 maxChunks 回默认', chunkText(long, { maxChunks: -3 }).length === MAX_CHUNKS)
check('非法 size 回默认', chunkText('短句', { size: 0 }).length === 1)

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
