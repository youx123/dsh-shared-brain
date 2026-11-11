/**
 * 跨机同步往返不该抹掉本机归属。
 *
 * 背景：mergeEntries 以前在合并结果上直接 delete cwd / sessionId / scopeSession，
 * 而合并结果是要写回本地的 —— 每同步一次，本机的目录归属就淡一层。
 * （会话级条目本身不同步：syncableEntry 见 scope === 'session' 直接 false，
 *  所以这里只断言工作区级。）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-rmerge-'))
process.env.DSH_HOME = home

const lib = new URL('../lib/', import.meta.url).pathname
const { mergeEntries, pushableEntries, syncableEntry } = await import(`${lib}remote-sync.js`)

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

const base = {
  module: 'cognition',
  tags: [],
  weight: 0.5,
  lifetime: 'permanent',
  expiresAt: 0,
  pinned: false,
  source: 'auto',
  createdAt: 1000,
}

const local = [
  {
    ...base,
    id: 'w1',
    text: '本机旧的内容',
    scope: 'workspace',
    scopePath: 'D:\\wx',
    scopeSession: '',
    cwd: 'D:\\wx',
    updatedAt: 1000,
  },
  {
    ...base,
    id: 's1',
    text: '只在某个会话里用',
    scope: 'session',
    scopePath: '',
    scopeSession: 'session-abc',
    sessionId: 'session-abc',
    cwd: 'D:\\wx',
    updatedAt: 1000,
  },
]

const remote = [
  {
    ...base,
    id: 'w1',
    text: '远端更新后的内容',
    scope: 'workspace',
    scopePath: 'D:\\wx',
    source: 'sync',
    updatedAt: 5000,
  },
  {
    ...base,
    id: 'r1',
    text: '只有远端有',
    scope: 'global',
    source: 'sync',
    updatedAt: 1500,
  },
]

check('会话级条目不进同步', syncableEntry(local[1]) === false)
check('工作区条目进同步', syncableEntry(local[0]) === true)

const merged = mergeEntries(local, remote, {})
const byId = new Map(merged.entries.map((e) => [e.id, e]))
const w1 = byId.get('w1')

check('远端新内容赢了', w1.text === '远端更新后的内容', w1.text)
check('工作区作用域留住', w1.scope === 'workspace', w1.scope)
check('scopePath 留住', w1.scopePath === 'D:\\wx', w1.scopePath)
check('cwd 补回来了（远端不带）', w1.cwd === 'D:\\wx', String(w1.cwd))
check('会话级条目不在结果里', !byId.has('s1'))
check('远端独有的也在', byId.has('r1'))

const push = pushableEntries(merged.entries)
check('推送形状去掉 cwd', push.every((e) => !('cwd' in e)))
check('推送形状去掉 sessionId', push.every((e) => !('sessionId' in e)))
check('推送形状去掉 scopeSession', push.every((e) => !('scopeSession' in e)))
check('推送形状条数不变', push.length === merged.entries.length, `${push.length} vs ${merged.entries.length}`)
check('原对象没被推形状改坏', byId.get('w1').cwd === 'D:\\wx')
check('推形状不动 scopePath', push.find((e) => e.id === 'w1').scopePath === 'D:\\wx')

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
