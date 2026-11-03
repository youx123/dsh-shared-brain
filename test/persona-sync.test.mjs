/**
 * 人设同步（共享大脑 → dsh-persona-dafeiyu）的离线自测。
 *
 * 用独立 DSH_HOME，造一份共享大脑人设库 + 一份养鱼插件人设库，验证镜像规则：
 * 加 / 删 / 保留用户自己的人设 / 指纹没变就不写盘 / 关掉就不写 / 状态字段。
 *
 * 跑法：node tests/persona-sync.test.mjs
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = process.env.SB_LIB || join(HERE, '..', 'lib')
const SANDBOX = mkdtempSync(join(tmpdir(), 'sb-persona-sync-'))
process.env.DSH_HOME = SANDBOX
process.env.DSH_BILI_HOME = SANDBOX // 养鱼插件的人设正文（~/.bili-ai/persona.md）也放进沙箱

const SB_DIR = join(SANDBOX, 'storages', 'dsh-shared-brain')
const PLUGIN_DIR = join(SANDBOX, 'storages', 'dsh-persona-dafeiyu')
mkdirSync(SB_DIR, { recursive: true })
mkdirSync(PLUGIN_DIR, { recursive: true })

const SB_FILE = join(SB_DIR, 'persona.json')
const PLUGIN_FILE = join(PLUGIN_DIR, 'personas.json')

const P = await import('file://' + LIB.replace(/\\/g, '/') + '/persona-sync.js')
const PERSONA = await import('file://' + LIB.replace(/\\/g, '/') + '/persona.js')

let passed = 0
let failed = 0
const failures = []

function group(name) {
  console.log('\n' + name)
}

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log('  ✗ ' + name + ' — ' + (error && error.message ? error.message : String(error)))
  }
}

function ok(value, message) {
  if (!value) throw new Error(message || 'expected truthy')
}

function equal(actual, expected, message) {
  if (actual !== expected) throw new Error((message || 'not equal') + '：实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected))
}

function writeShared(personas, current) {
  writeFileSync(
    SB_FILE,
    JSON.stringify({ version: 1, current, personas, bySession: {}, updatedAt: Date.now() }, null, 2),
    'utf8',
  )
}

function writePlugin(store) {
  writeFileSync(PLUGIN_FILE, JSON.stringify(store, null, 2), 'utf8')
}

function readPlugin() {
  return JSON.parse(readFileSync(PLUGIN_FILE, 'utf8'))
}

function resetPlugin() {
  writePlugin({
    version: 1,
    mode: 'single',
    current: 'dafeiyu',
    disabled: [],
    personas: [{ id: 'mine-1', name: '我自己导的', text: '不要动我', createdAt: '2026-01-01T00:00:00.000Z' }],
    workspaces: [{ cwd: 'D:/work', personaId: 'mine-1' }],
  })
}

function resetSyncState(enabled = true) {
  const file = join(SB_DIR, 'persona-sync.json')
  writeFileSync(file, JSON.stringify({ version: 1, enabled }, null, 2), 'utf8')
}

// ---------------------------------------------------------------- 基础镜像

group('人设镜像')

resetPlugin()
resetSyncState(true)
writeShared(
  [
    { id: 'dafeiyu', name: '大肥鱼', text: '# 人设：大肥鱼（共享大脑版）', bundled: true },
    { id: 'custom-1', name: '自定义一号', text: '# 自定义一号正文' },
  ],
  'custom-1',
)

test('第一次同步把共享大脑人设镜像进养鱼插件', () => {
  const result = P.syncPersonaToPlugin({ force: true })
  equal(result.reason, 'forced')
  equal(result.written, 4) // 2 条自定义 + 3 条内置（内置即使库里缺也补）
  const store = readPlugin()
  const mirrored = store.personas.filter((p) => p.id.startsWith('sb-'))
  equal(mirrored.length, 4)
  ok(mirrored.some((p) => p.id === 'sb-dafeiyu'), '缺 sb-dafeiyu')
  ok(mirrored.some((p) => p.id === 'sb-custom-1'), '缺 sb-custom-1')
})

test('当前人设跟着共享大脑走', () => {
  equal(readPlugin().current, 'sb-custom-1')
  equal(P.personaSyncStatus().pluginCurrent, 'sb-custom-1')
})

test('用户自己在养鱼插件里导的人设不被碰', () => {
  const store = readPlugin()
  ok(store.personas.some((p) => p.id === 'mine-1'), 'mine-1 被动了')
  equal(store.personas.find((p) => p.id === 'mine-1').text, '不要动我')
})

test('工作目录绑定等其它字段保持原样', () => {
  const store = readPlugin()
  equal(store.workspaces.length, 1)
  equal(store.workspaces[0].cwd, 'D:/work')
})

test('镜像条目带上正文与名字', () => {
  const store = readPlugin()
  const dafeiyu = store.personas.find((p) => p.id === 'sb-dafeiyu')
  equal(dafeiyu.name, '大肥鱼')
  ok(dafeiyu.text.includes('共享大脑版'), '正文没同步过来')
  ok(typeof dafeiyu.createdAt === 'string' && dafeiyu.createdAt.length > 0, '缺 createdAt')
})

// ---------------------------------------------------------------- 指纹

group('指纹：没变就不写盘')

test('同样的内容再同步一次是 unchanged', () => {
  const result = P.syncPersonaToPlugin({})
  equal(result.changed, false)
  equal(result.reason, 'unchanged')
})

test('共享大脑改了正文，指纹变 → 重新写', () => {
  writeShared(
    [
      { id: 'dafeiyu', name: '大肥鱼', text: '# 人设：大肥鱼（改过）', bundled: true },
      { id: 'custom-1', name: '自定义一号', text: '# 自定义一号正文' },
    ],
    'custom-1',
  )
  const result = P.syncPersonaToPlugin({})
  equal(result.reason, 'changed')
  ok(readPlugin().personas.find((p) => p.id === 'sb-dafeiyu').text.includes('改过'), '正文没更新')
})

test('共享大脑切人设 → 养鱼插件当前也跟着切', () => {
  writeShared(
    [
      { id: 'dafeiyu', name: '大肥鱼', text: '# 人设：大肥鱼（改过）', bundled: true },
      { id: 'custom-1', name: '自定义一号', text: '# 自定义一号正文' },
    ],
    'dafeiyu',
  )
  P.syncPersonaToPlugin({})
  equal(readPlugin().current, 'sb-dafeiyu')
})

// ---------------------------------------------------------------- 删除

group('删除')

test('共享大脑删掉人设 → 镜像条目一并删掉', () => {
  writeShared([{ id: 'dafeiyu', name: '大肥鱼', text: '# 人设：大肥鱼（改过）', bundled: true }], 'dafeiyu')
  const result = P.syncPersonaToPlugin({})
  equal(result.removed, 1)
  const store = readPlugin()
  ok(!store.personas.some((p) => p.id === 'sb-custom-1'), 'sb-custom-1 没被清掉')
  ok(store.personas.some((p) => p.id === 'mine-1'), 'mine-1 被误删')
})

test('删掉以后当前指向回落到还存在的镜像', () => {
  const store = readPlugin()
  ok(store.current.startsWith('sb-'), '当前不该指向不存在的镜像')
  ok(store.personas.some((p) => p.id === store.current), '当前指向了一个不存在的条目')
})

// ---------------------------------------------------------------- 手动覆盖

group('不抢用户的手动选择')

test('用户在养鱼插件里手动选了别的人设，下一次同步不硬拉回来（内容没变时不写）', () => {
  const store = readPlugin()
  store.current = 'mine-1'
  writePlugin(store)
  // 共享大脑内容没变 → 指纹相同 → 不该写盘
  const result = P.syncPersonaToPlugin({})
  equal(result.changed, false)
  equal(readPlugin().current, 'mine-1')
})

test('共享大脑真的改了，才会重新把当前指过去', () => {
  writeShared([{ id: 'dafeiyu', name: '大肥鱼', text: '# 人设：大肥鱼（又改了一次）', bundled: true }], 'dafeiyu')
  P.syncPersonaToPlugin({})
  equal(readPlugin().current, 'sb-dafeiyu')
})

// ---------------------------------------------------------------- 开关

group('开关')

test('关掉以后不再写盘', () => {
  resetSyncState(true)
  P.applyPersonaSync({ enabled: false })
  const before = readFileSync(PLUGIN_FILE, 'utf8')
  writeShared([{ id: 'dafeiyu', name: '大肥鱼', text: '# 关掉期间改的', bundled: true }], 'dafeiyu')
  const result = P.syncPersonaToPlugin({ force: true })
  equal(result.reason, 'disabled')
  equal(readFileSync(PLUGIN_FILE, 'utf8'), before)
})

test('再打开会立刻推一次', () => {
  const result = P.applyPersonaSync({ enabled: true })
  equal(result.ok, true)
  equal(result.enabled, true)
  ok(readPlugin().personas.find((p) => p.id === 'sb-dafeiyu').text.includes('关掉期间改的'), '打开后没同步')
})

// ---------------------------------------------------------------- 状态

group('状态字段')

test('personaSyncStatus 给出目标插件、文件、镜像条数、两边当前人设', () => {
  const status = P.personaSyncStatus()
  equal(status.target, 'dsh-persona-dafeiyu')
  ok(status.file.endsWith(join('dsh-persona-dafeiyu', 'personas.json')), '文件路径不对：' + status.file)
  equal(status.pluginExists, true)
  equal(status.enabled, true)
  equal(status.sharedCurrent, 'dafeiyu')
  ok(status.mirrored >= 1, '镜像条数不对')
})

test('内置人设即使库里没有条目也会镜像（用插件内的内置正文）', () => {
  writeShared([{ id: 'custom-only', name: '只有自定义', text: '# 只有自定义' }], 'custom-only')
  P.syncPersonaToPlugin({ force: true })
  const store = readPlugin()
  for (const bundled of PERSONA.BUNDLED_PERSONAS) {
    ok(store.personas.some((p) => p.id === 'sb-' + bundled.id), '缺内置镜像 ' + bundled.id)
  }
})

test('镜像 id 规整：带特殊字符也不会跑出目录', () => {
  equal(P.mirrorId('a/b c'), 'sb-a-b-c')
  equal(P.mirrorId('sb-already'), 'sb-already')
  equal(P.mirrorId(''), '')
})

// ---------------------------------------------------------------- 看门狗

group('看门狗')

test('startPersonaSync 会立刻同步一次并返回间隔', () => {
  resetSyncState(true)
  const started = P.startPersonaSync({ intervalMs: 200 })
  equal(started.intervalMs, 200)
  writeShared([{ id: 'dafeiyu', name: '大肥鱼', text: '# 看门狗立刻同步', bundled: true }], 'dafeiyu')
  P.syncPersonaToPlugin({ force: true })
  ok(readPlugin().personas.find((p) => p.id === 'sb-dafeiyu').text.includes('看门狗立刻同步'), '没同步')
  P.stopPersonaSync()
})

// ── dsh-bili-whale（设置页里的「养鱼」）────────────────────────────
group('养鱼插件（dsh-bili-whale）')

function resetAll() {
  resetPlugin()
  resetSyncState(true)
  writeFileSync(join(SANDBOX, 'bili-whale.config.json'), '{}', 'utf8')
  const md = join(SANDBOX, '.bili-ai', 'persona.md')
  mkdirSync(dirname(md), { recursive: true })
  writeFileSync(md, '', 'utf8')
}

function seedShared() {
  writeShared(
    [
      { id: 'dafeiyu', name: '大肥鱼', text: '# 人设：大肥鱼\n你是大肥鱼，自称本鱼。', bundled: true },
      { id: 'custom-1', name: '自定义一号', text: '# 自定义一号\n这是自定义人设正文。' },
    ],
    'dafeiyu',
  )
}

function selectShared(id) {
  const store = JSON.parse(readFileSync(SB_FILE, 'utf8'))
  writeShared(store.personas, id)
}

function readWhaleCfg() {
  const text = readFileSync(join(SANDBOX, 'bili-whale.config.json'), 'utf8')
  if (!text.trim() || text.trim() === '{}') return null
  return JSON.parse(text)
}

test('第一次同步：把当前人设写进养鱼插件的配置和 persona.md', () => {
  resetAll()
  seedShared()
  const result = P.syncPersonaToPlugin({ force: true })
  ok(result.whale && result.whale.changed === true, '没报告养鱼插件已写')
  equal(result.whale.name, '大肥鱼')
  const cfg = readWhaleCfg()
  ok(cfg && cfg.persona, '配置没写出来')
  equal(cfg.persona.name, '大肥鱼')
  equal(cfg.persona.ownerTitle, '主人')
  ok(typeof cfg.persona.selfClaim === 'string' && cfg.persona.selfClaim.length > 0, '自称没写')
  const md = readFileSync(join(SANDBOX, '.bili-ai', 'persona.md'), 'utf8')
  ok(md.trim().length > 0, 'persona.md 是空的')
  ok(md.length <= 20000, '超过养鱼插件的 20000 字上限')
})

test('养鱼插件里别的配置项一律不碰', () => {
  resetAll()
  seedShared()
  writeFileSync(
    join(SANDBOX, 'bili-whale.config.json'),
    JSON.stringify({ quota: { shareDaily: 7 }, notify: { type: 'webhook' }, persona: { name: '旧名', ownerTitle: '老大', selfClaim: '人家' } }, null, 2),
    'utf8',
  )
  P.syncPersonaToPlugin({ force: true })
  const cfg = readWhaleCfg()
  equal(cfg.quota.shareDaily, 7)
  equal(cfg.notify.type, 'webhook')
  equal(cfg.persona.ownerTitle, '老大')
  equal(cfg.persona.name, '大肥鱼')
})

test('共享大脑没变时，养鱼插件也不重复写盘', () => {
  resetAll()
  seedShared()
  P.syncPersonaToPlugin({ force: true })
  const again = P.syncPersonaToPlugin({})
  equal(again.reason, 'unchanged')
  ok(again.whale && again.whale.changed === false, 'unchanged 时不该说养鱼插件变了')
})

test('切共享大脑的人设 → 养鱼插件的角色名和人设正文跟着换', () => {
  resetAll()
  seedShared()
  P.syncPersonaToPlugin({ force: true })
  selectShared('custom-1')
  P.syncPersonaToPlugin({ force: true })
  equal(readWhaleCfg().persona.name, '自定义一号')
  ok(readFileSync(join(SANDBOX, '.bili-ai', 'persona.md'), 'utf8').includes('自定义'), 'persona.md 没换成新人设')
})

test('关掉同步 → 养鱼插件一个字节都不写', () => {
  resetAll()
  seedShared()
  P.applyPersonaSync({ enabled: false })
  const result = P.syncPersonaToPlugin({ force: true })
  equal(result.reason, 'disabled')
  equal(readWhaleCfg(), null)
})

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败')
if (failed > 0) {
  for (const item of failures) console.log('\n失败：' + item.name + '\n' + (item.error && item.error.stack ? item.error.stack : item.error))
  process.exit(1)
}
