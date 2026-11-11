import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MARKER,
  isExportable,
  renderRule,
  exportRules,
  renderExportSummary,
} from '../lib/cursor-export.js'

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

const dir = join(tmpdir(), 'sb-cursor-export-' + process.pid)
try {
  rmSync(dir, { recursive: true, force: true })
} catch {}
mkdirSync(dir, { recursive: true })

const bottom = { id: 'mod_1', module: 'bottomline', text: '不许删除用户数据。任何删除操作先问。', pinned: true }
const pinned = { id: 'mem_2', module: 'cognition', text: '发布前先跑全套测试，别跳。', pinned: true }
const plain = { id: 'mem_3', module: 'cognition', text: '这是一条普通工作记忆，不该进规则库。' }
const archived = { id: 'mem_4', module: 'bottomline', text: '归档的底线不该导出。', archived: true }
const short = { id: 'mem_5', module: 'bottomline', text: '短' }

// 1. 该不该导出
check('底线可导出', isExportable(bottom))
check('钉住可导出', isExportable(pinned))
check('普通记忆不导出', !isExportable(plain))
check('归档不导出', !isExportable(archived))
check('太短不导出', !isExportable(short))
check('null 不炸', isExportable(null) === false)

// 2. 渲染
const rule = renderRule(bottom)
check('带标记', rule.startsWith(MARKER))
check('有 frontmatter', rule.includes('---') && rule.includes('description:'))
check('底线 alwaysApply 为 true', rule.includes('alwaysApply: true'))
check('钉住的 alwaysApply 为 false', renderRule(pinned).includes('alwaysApply: false'))
check('正文在文件里', rule.includes('不许删除用户数据'))

// 3. 首次导出
const r1 = exportRules([bottom, pinned, plain], { dir })
check('写了两份', r1.written.length === 2, String(r1.written.length))
check('普通记忆没写', !r1.written.some((f) => f.includes('mem_3')))
check('文件真实存在', r1.written.every((f) => existsSync(f)))
check('内容带标记', r1.written.every((f) => readFileSync(f, 'utf8').startsWith(MARKER)))

// 4. 再导一次：未变
const r2 = exportRules([bottom, pinned, plain], { dir })
check('第二次全未变', r2.written.length === 0 && r2.updated.length === 0 && r2.unchanged.length === 2)

// 5. 内容变了才更新
const changed = { ...bottom, text: '不许删除用户数据。任何删除操作先问，并且先备份。' }
const r3 = exportRules([changed, pinned], { dir })
check('改过的更新一份', r3.updated.length === 1, String(r3.updated.length))

// 6. 用户手写同名文件不覆盖
const userFile = join(dir, 'dsh-mem_2.mdc')
writeFileSync(userFile, '# 我自己写的规则\n', 'utf8')
const r4 = exportRules([pinned], { dir })
check('手写文件被跳过', r4.skipped.length === 1 && r4.skipped[0].reason.includes('不是共享大脑写的'))
check('手写内容没被改', readFileSync(userFile, 'utf8').includes('我自己写的规则'))

// 7. prune 只清自己写的孤儿
const orphan = join(dir, 'dsh-gone.mdc')
writeFileSync(orphan, MARKER + '\n---\ndescription: "x"\nalwaysApply: false\n---\n\n旧条目\n', 'utf8')
const r5 = exportRules([bottom], { dir, prune: true })
check('孤儿被清掉', r5.removed.some((f) => f.endsWith('dsh-gone.mdc')), JSON.stringify(r5.removed))
check('孤儿文件确实没了', !existsSync(orphan))
check('手写文件仍在', existsSync(userFile))
check('目录里只剩该留的', readdirSync(dir).filter((n) => n.endsWith('.mdc')).sort().join(',') === 'dsh-mem_2.mdc,dsh-mod_1.mdc', readdirSync(dir).join(','))

// 8. dryRun 不落盘
const dryDir = join(dir, 'dry')
const r6 = exportRules([bottom, pinned], { dir: dryDir, dryRun: true })
check('dry 报告写了 2 份', r6.written.length === 2)
check('dry 没建目录/没文件', !existsSync(dryDir) || readdirSync(dryDir).length === 0)

// 9. 没给目录
const r7 = exportRules([bottom], { dir: '   ' })
check('没目录时跳过并说明', r7.skipped.length === 1 && renderExportSummary(r7).includes('没给目录'))

// 10. 摘要
const sum = renderExportSummary(r5)
check('摘要含目录与计数', sum.includes(dir) && sum.includes('新写') && sum.includes('未变'))
check('摘要含跳过原因', renderExportSummary(r4).includes('不是共享大脑写的'))

try {
  rmSync(dir, { recursive: true, force: true })
} catch {}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
