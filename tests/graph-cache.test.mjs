import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-graph-cache-'))
process.env.DSH_HOME = home

const lib = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const db = await import(`file:///${lib}/db.js`)
const graph = await import(`file:///${lib}/memory-graph.js`)

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

const makeGraph = (label) => ({
  nodes: [
    { id: 'n1', type: 'memory', label, module: 'cognition', degree: 1, kind: 'memory' },
    { id: 'n2', type: 'entity', label: '实体', module: 'cognition', degree: 1, kind: 'entity' },
  ],
  edges: [{ from: 'n1', to: 'n2', kind: 'mentions', weight: 1 }],
})

try {
  db.replaceGraph(makeGraph('第一版标签').nodes, makeGraph('第一版标签').edges)
  const first = graph.readGraph()
  check('第一次读到的是第一版', first?.nodes?.some((n) => n.label === '第一版标签'), JSON.stringify(first?.nodes?.map((n) => n.label)))

  // 数量完全一样，只改标签
  db.replaceGraph(makeGraph('第二版标签').nodes, makeGraph('第二版标签').edges)
  const second = graph.readGraph()
  check('同数量换内容后读到第二版', second?.nodes?.some((n) => n.label === '第二版标签'), JSON.stringify(second?.nodes?.map((n) => n.label)))
  check('没读到旧缓存', !second?.nodes?.some((n) => n.label === '第一版标签'))

  // 再读一次仍是新版（缓存命中也要对）
  const again = graph.readGraph()
  check('连续读也保持第二版', again?.nodes?.some((n) => n.label === '第二版标签'))

  const stats = db.graphStats()
  check('graphStats 带版本戳', Number(stats.updatedAt) > 0, JSON.stringify(stats))
} finally {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* Windows 句柄未释放时忽略 */
  }
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}（${pass} 通过）`)
process.exit(fail === 0 ? 0 : 1)
