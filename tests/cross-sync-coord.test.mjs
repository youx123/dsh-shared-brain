import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-cross-'))
const coordDir = join(home, 'coord')
process.env.DSH_HOME = home
process.env.DSH_SHARED_BRAIN_CURSOR_BRAIN = coordDir

const lib = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const cross = await import(`file:///${lib}/cross-sync.js`)

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

const coordFile = join(coordDir, 'sync-coordinator.json')

// 1) 没文件时是默认值
const d0 = cross.readCoord()
check('没有协调文件时是默认值', d0.generation === 0 && d0.writer === null)

// 2) 开始写 → 文件可解析、writer=dsh、没有 tmp 残留
const lock = cross.beginWriteDsh()
check('拿到写锁', lock.ok === true)
const raw = JSON.parse(readFileSync(coordFile, 'utf8'))
check('协调文件写成功且可解析', raw.writer === 'dsh' && raw.version === 1)
const leftovers = readdirSync(coordDir).filter((n) => n.includes('.tmp-'))
check('没有 tmp 残留', leftovers.length === 0, leftovers.join(','))

// 3) 结束写 → generation 加一
cross.finishWriteDsh()
const c1 = cross.readCoord()
check('结束时 generation 加一', c1.generation === 1, String(c1.generation))
check('结束时清掉 writer', c1.writer === null)

// 4) 文件被写坏 → readCoord 回默认值，不抛
writeFileSync(coordFile, '{"version":1,"generation":', 'utf8')
let broken = null
try {
  broken = cross.readCoord()
} catch (error) {
  broken = { threw: String(error.message) }
}
check('坏文件不抛异常', !broken?.threw, JSON.stringify(broken))
check('坏文件回默认值', broken.generation === 0 && broken.writer === null)

// 5) 坏文件之后还能写回去（原子写会整体替换，不会拼接）
const lock2 = cross.beginWriteDsh()
check('坏文件后仍能拿锁', lock2.ok === true)
const reparsed = JSON.parse(readFileSync(coordFile, 'utf8'))
check('坏文件被整体覆盖成合法 JSON', reparsed.writer === 'dsh')

// 6) Cursor 正在写时 DSH 让路
cross.finishWriteDsh({ bump: false })
writeFileSync(coordFile, JSON.stringify({ version: 1, generation: 5, writer: 'cursor', writerAt: Date.now() }), 'utf8')
const blocked = cross.beginWriteDsh()
check('别人正在写时让路', blocked.ok === false)
check('让路时不改协调文件', cross.readCoord().writer === 'cursor')

// 7) 超时后可接管
writeFileSync(coordFile, JSON.stringify({ version: 1, generation: 5, writer: 'cursor', writerAt: Date.now() - 9000 }), 'utf8')
const takeover = cross.beginWriteDsh()
check('超过 8 秒接管锁', takeover.ok === true, JSON.stringify(takeover))

try {
  rmSync(home, { recursive: true, force: true })
} catch {
  // 临时目录清不掉无所谓
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
