/**
 * `/shared-memory recall <文本>` —— 召回预览。
 * 起因：「这条为什么没被召回」以前只能靠猜；把预览接到命令行上，
 * 顺手也给「召回结果长什么样」留一份可断言的形状。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-recallcmd-'))
process.env.DSH_HOME = home

const { registerCommands, setRecallRunner } = await import('../lib/commands.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

let command = null
const ctx = {
  logger: () => ({ info() {}, warn() {} }),
  systemPrompt: { section() {}, getSectionOrder: () => 1500, context() {} },
  on() {},
  effect: (fn) => { fn(); return { dispose() {} } },
  commands: { register: (c) => { command = c } },
}
registerCommands(ctx)
check('命令已注册', Boolean(command))

const empty = command.handler(['recall'])
check('不带文本时给用法', empty.kind === 'error' && /用法/.test(empty.text), String(empty.text).slice(0, 80))

setRecallRunner(() => {
  throw new Error('不该走到这里')
})
const noTextAgain = command.handler(['recall', '   '])
check('只有空白也算没给文本', noTextAgain.kind === 'error' && /用法/.test(noTextAgain.text))

setRecallRunner(null)
const unavailable = command.handler(['recall', '周报'])
check('没注入实现时明确说不可用', unavailable.kind === 'error' && /不可用/.test(unavailable.text), String(unavailable.text).slice(0, 80))

let received = ''
setRecallRunner((text) => {
  received = text
  return {
    rendered: '【记忆】…',
    hits: [
      { id: 'mem_1', module: 'cognition', text: '每周五整理一次周报，写完先自己读一遍。', score: 3.21 },
      { id: 'mem_2', module: 'knowledge', text: '《论语》里讲「学而时习之」。', score: 1.05 },
    ],
    supersededDropped: 2,
  }
})
const ok = command.handler(['recall', '周五', '要发', '周报'])
check('多词会被拼成一句', received === '周五 要发 周报', received)
check('列出条数与模块标签', ok.kind === 'success' && /召回 2 条/.test(ok.text), String(ok.text).slice(0, 120))
check('命中条目带模块中文名', /\[认知\]/.test(ok.text) && /\[知识\]/.test(ok.text), String(ok.text))
check('分数保留两位', /3\.21/.test(ok.text), String(ok.text))
check('提到压掉几条旧说法', /压掉了 2 条/.test(ok.text), String(ok.text))
check('注明只看不写', /只看不写/.test(ok.text))

setRecallRunner(() => ({ rendered: '', hits: [], supersededDropped: 0 }))
const none = command.handler(['recall', '完全无关的词'])
check('没有命中时说清楚', /一条都没命中/.test(none.text), String(none.text))

setRecallRunner(() => ({ rendered: '', hits: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, module: 'cognition', text: `第 ${i} 条`, score: 1 })) }))
const many = command.handler(['recall', '很多'])
check('最多列 8 条', (many.text.match(/第 \d+ 条/g) ?? []).length === 8, String(many.text).slice(0, 200))

setRecallRunner(() => undefined)
const broken = command.handler(['recall', '实现返回了空'])
check('实现返回空也不炸', broken.kind === 'success' && /召回 0 条/.test(broken.text), String(broken.text))

try {
  rmSync(home, { recursive: true, force: true })
} catch {
  /* Windows 上句柄可能还开着 */
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}（${pass} 项通过，${fail} 项失败）`)
process.exit(fail === 0 ? 0 : 1)
