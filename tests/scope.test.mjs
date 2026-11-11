/**
 * 单条记忆的作用域（全局 / 工作区 / 本会话）——2026-11-11
 *
 * 命令行以前只能设 global/workspace（workspace 还得手填路径），
 * 界面上能选的「只在这个会话里用」在命令行没法做。这里守 applyItemScope：
 * 桶条目与扁平库两边一起改，缺路径/缺会话要报错而不是悄悄当 global。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-scope-'))
process.env.DSH_HOME = home

const { writeModules, readModules, putModuleItem } = await import('../lib/modules.js')
const { writeStore, readStore } = await import('../lib/store.js')
const { applyItemScope } = await import('../lib/bridge.js')

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}`) }
  else { fail += 1; console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`) }
}

const now = Date.now()
const text = '周末把阳台的花浇一下'
writeStore({
  version: 1,
  entries: [{
    id: 'mem_scope_1', module: 'cognition', text, weight: 0.8, lifetime: 'permanent',
    expiresAt: 0, ttlMs: 0, pinned: false, source: 'manual', tags: [], scope: 'global',
    scopePath: '', scopeSession: '', createdAt: now, updatedAt: now,
  }],
})

const modules = readModules()
putModuleItem(modules, 'cognition', {
  id: 'mod_scope_1', text, weight: 0.8, lifetime: 'permanent', expiresAt: 0,
  pinned: false, source: 'manual', tags: [], createdAt: now, updatedAt: now,
})
writeModules(modules)

// 1. 限到会话
let res = applyItemScope({ module: 'cognition', id: 'mod_scope_1', scope: 'session', scopeSession: 'session-abc' })
check('会话作用域能设', res.ok === true, res.error ?? res.note)
let item = readModules().cognition.items.find((it) => it.id === 'mod_scope_1')
check('桶里记成 session', item?.scope === 'session' && item?.scopeSession === 'session-abc', JSON.stringify(item?.scope))
let entry = readStore().entries.find((e) => e.id === 'mem_scope_1')
check('扁平库跟着改', entry?.scope === 'session' && entry?.scopeSession === 'session-abc', JSON.stringify(entry?.scope))

// 2. 会话作用域不给会话 → 报错，不悄悄降级
res = applyItemScope({ module: 'cognition', id: 'mod_scope_1', scope: 'session', scopeSession: '' })
check('缺会话时报错', res.ok === false && /会话/.test(res.error ?? ''), res.error)

// 3. 工作区不给路径 → 报错
res = applyItemScope({ module: 'cognition', id: 'mod_scope_1', scope: 'workspace', scopePath: '' })
check('缺路径时报错', res.ok === false && /目录|路径/.test(res.error ?? ''), res.error)

// 4. 工作区给路径 → 生效
res = applyItemScope({ module: 'cognition', id: 'mod_scope_1', scope: 'workspace', scopePath: 'D:\\微信web开发者工具' })
check('工作区作用域能设', res.ok === true, res.error ?? res.note)
item = readModules().cognition.items.find((it) => it.id === 'mod_scope_1')
check('桶里记成 workspace + 路径', item?.scope === 'workspace' && item?.scopePath === 'D:\\微信web开发者工具', JSON.stringify(item))

// 5. 改回 global → 路径与会话清空
res = applyItemScope({ module: 'cognition', id: 'mod_scope_1', scope: 'global' })
check('改回全局', res.ok === true, res.error)
const item2 = readModules().cognition.items.find((it) => it.id === 'mod_scope_1')
check('全局不残留路径与会话', item2?.scope === 'global' && !item2?.scopePath && !item2?.scopeSession, JSON.stringify(item2))

// 6. 不认识的模块 / 不存在的条目
check('未知模块报错', applyItemScope({ module: 'nope', id: 'x', scope: 'global' }).ok === false)
check('不存在的条目报错', applyItemScope({ module: 'cognition', id: 'mod_missing', scope: 'global' }).ok === false)

try { rmSync(home, { recursive: true, force: true }) } catch { /* Windows 句柄未关时删不掉 */ }

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
