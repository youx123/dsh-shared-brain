import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-add-knowledge-'))
process.env.DSH_HOME = home

const lib = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const bridge = await import(`file:///${lib}/bridge.js`)
const store = await import(`file:///${lib}/store.js`)

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

// 1. 正常写入：返回 value.added，界面要拿这个数
const first = bridge.mutateModules({ action: 'addKnowledge', title: '测试书', text: '第一条要点\n第二条要点' })
check('写入成功', first.ok === true, JSON.stringify(first))
check('value.added = 2', first.value && first.value.added === 2, JSON.stringify(first.value))
check('value.title 回显', first.value && first.value.title === '测试书')

// 2. 同一批内容再存一次：不该再「成功写入 2 条」
const again = bridge.mutateModules({ action: 'addKnowledge', title: '测试书', text: '第一条要点\n第二条要点' })
check('重复内容被拒', again.ok === false, JSON.stringify(again))
check('重复提示说得清', /重复/.test(again.error || ''), again.error)

// 3. 空白内容
const empty = bridge.mutateModules({ action: 'addKnowledge', title: '测试书', text: '   ' })
check('空内容被拒', empty.ok === false, JSON.stringify(empty))

// 4. 没给书名
const noTitle = bridge.mutateModules({ action: 'addKnowledge', title: '', text: '随便一条' })
check('没书名被拒', noTitle.ok === false)

// 5. 落库形状：两条、sourceRef 是书名、source 是 manual
const snapshot = store.readStore()
const knowledge = snapshot.entries.filter((entry) => entry.module === 'knowledge')
check('扁平库两条', knowledge.length === 2, String(knowledge.length))
check('sourceRef 是书名', knowledge.every((entry) => entry.sourceRef === '测试书'))
check('source 是 manual', knowledge.every((entry) => entry.source === 'manual'))
check('默认永久', knowledge.every((entry) => entry.lifetime === 'permanent'))

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
