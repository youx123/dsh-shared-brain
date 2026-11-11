import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-id-unique-'))
process.env.DSH_HOME = home

const lib = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const modulesLib = await import(`file:///${lib}/modules.js`)
const storeLib = await import(`file:///${lib}/store.js`)

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

// 1) 模块桶：两条撞 id，正文都要留住，id 要分开
const raw = {
  updatedAt: 1,
  cognition: {
    enabled: true,
    weight: 1,
    items: [
      { id: 'mod_dup', text: '第一条：记住甲。', weight: 0.8, tags: [] },
      { id: 'mod_dup', text: '第二条：记住乙。', weight: 0.6, tags: [] },
    ],
  },
  knowledge: {
    enabled: true,
    weight: 0.7,
    items: [{ id: 'mod_dup', text: '第三条：读过的书。', weight: 0.7, tags: [] }],
  },
}
const mods = modulesLib.normalizeModules(raw)
const ids = []
const texts = []
for (const key of modulesLib.ALL_MODULES) {
  for (const item of mods[key]?.items ?? []) {
    ids.push(item.id)
    texts.push(item.text)
  }
}
check('三条都还在', texts.length === 3, String(texts.length))
check('id 全不重复', new Set(ids).size === ids.length, ids.join(','))
check('第一条 id 保留原值', ids[0] === 'mod_dup', ids[0])
check('正文没被改', texts.includes('第一条：记住甲。') && texts.includes('第二条：记住乙。') && texts.includes('第三条：读过的书。'))

// 2) 再规范化一次要稳定（不能每次读都换 id，否则界面点一下就找不到条目）
const mods2 = modulesLib.normalizeModules(JSON.parse(JSON.stringify(mods)))
const ids2 = []
for (const key of modulesLib.ALL_MODULES) {
  for (const item of mods2[key]?.items ?? []) ids2.push(item.id)
}
check('二次规范化 id 不变', JSON.stringify(ids2) === JSON.stringify(ids), `${ids.join(',')} vs ${ids2.join(',')}`)

// 3) 扁平库：两条撞 id，正文都要留住
const store = storeLib.normalizeStore({
  version: 1,
  updatedAt: 1,
  entries: [
    { id: 'mem_dup', module: 'cognition', text: '扁平甲', weight: 1, lifetime: 'permanent', expiresAt: 0 },
    { id: 'mem_dup', module: 'cognition', text: '扁平乙', weight: 1, lifetime: 'permanent', expiresAt: 0 },
  ],
})
check('扁平库两条都在', store.entries.length === 2, String(store.entries.length))
check('扁平库 id 不重复', store.entries[0].id !== store.entries[1].id, store.entries.map((e) => e.id).join(','))
check('扁平库正文都对', store.entries[0].text === '扁平甲' && store.entries[1].text === '扁平乙')

try {
  rmSync(home, { recursive: true, force: true })
} catch {
  // 清不掉无所谓
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
