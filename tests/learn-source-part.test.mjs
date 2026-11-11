/** 长文分块后，出处带「第几段」；一段就整篇，不标。 */
import { sourceRefForPart } from 'file:///C:/Users/13176/Documents/dsh-shared-brain-patches/lib/reading-chunks.js'

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

check('分三段时标第 1 段', sourceRefForPart('长文《某页》', 0, 3) === '长文《某页》（第1段）', sourceRefForPart('长文《某页》', 0, 3))
check('第二段标第 2 段', sourceRefForPart('长文', 1, 3) === '长文（第2段）')
check('一段不标', sourceRefForPart('整篇', 0, 1) === '整篇')
check('零段不标', sourceRefForPart('整篇', 0, 0) === '整篇')
check('没出处就空', sourceRefForPart('', 0, 3) === '')
check('全是空白也当没有', sourceRefForPart('   ', 2, 3) === '')
check('前后空白去掉', sourceRefForPart('  某页  ', 0, 2) === '某页（第1段）')
check('段号非法按第一段', sourceRefForPart('某页', undefined, 3) === '某页（第1段）')
check('段号是字符串也认', sourceRefForPart('某页', '2', 4) === '某页（第3段）')

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
