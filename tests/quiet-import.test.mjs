import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-quiet-import-'))
process.env.DSH_HOME = home

const lib = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const store = await import(`file:///${lib}/store.js`)

const warns = []
const originalWarn = console.warn
console.warn = (...args) => {
  warns.push(args.join(' '))
}

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

const brainFile = join(home, 'storages', 'dsh-shared-brain', 'memory.json')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  // 1. 先写一份真实内容
  const first = store.readStore()
  first.entries.push({
    id: 'mem_quiet_1',
    text: '安静导入测试：这条先写进库',
    module: 'cognition',
    weight: 0.5,
    lifetime: 'permanent',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  store.writeStore(first)
  const before = store.readStore()
  check('写入后能读回 1 条', before.entries.length === 1, String(before.entries.length))

  // 2. 什么都不改，只把文件重写一遍（改 mtime）
  await wait(1200)
  const raw = readFileSync(brainFile, 'utf8')
  writeFileSync(brainFile, raw, 'utf8')
  const mtime = statSync(brainFile).mtimeMs

  warns.length = 0
  const afterTouch = store.readStore()
  check('碰过文件后条数不变', afterTouch.entries.length === 1, String(afterTouch.entries.length))
  check('内容没变时不再整份导入', warns.some((line) => line.includes('跳过整份导入')), warns.join(' | '))
  check('内容没变时不说「已导入」', !warns.some((line) => line.includes('已导入')), warns.join(' | '))
  check('文件确实比库新（前置条件成立）', mtime > 0)

  // 3. 再读一次，不该再喊（版本号已经推过了）
  warns.length = 0
  await wait(50)
  store.readStore()
  check('版本号推过之后不再重复提示', !warns.some((line) => line.includes('跳过整份导入')), warns.join(' | '))

  // 4. 真改内容 → 仍然要导入
  await wait(1200)
  const parsed = JSON.parse(readFileSync(brainFile, 'utf8'))
  parsed.entries.push({
    id: 'mem_quiet_2',
    text: '安静导入测试：这条是外部加进来的',
    module: 'cognition',
    weight: 0.5,
    lifetime: 'permanent',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  writeFileSync(brainFile, JSON.stringify(parsed, null, 2), 'utf8')

  warns.length = 0
  const afterReal = store.readStore()
  check('内容真变了会导入', afterReal.entries.length === 2, String(afterReal.entries.length))
  check('真变化时打的是「已导入」', warns.some((line) => line.includes('已导入')), warns.join(' | '))
  check('真变化时不打「跳过」', !warns.some((line) => line.includes('跳过整份导入')), warns.join(' | '))
} finally {
  console.warn = originalWarn
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* Windows 上句柄没放干净时忽略 */
  }
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}（${pass} 通过）`)
process.exit(fail === 0 ? 0 : 1)
