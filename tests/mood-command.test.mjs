/**
 * `/shared-memory mood on|off` 能真的开关心情。
 * 回归背景：以前 `mood` 只走「查看」分支，`mood-on` / `mood-off` 才是开关，
 * 用户照 README 敲 `mood on` 永远打不开心情。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-moodcmd-'))
process.env.DSH_HOME = home

const { registerCommands } = await import('../lib/commands.js')
const { readEmotionStore } = await import('../lib/emotion.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

const sections = []
let command = null
const ctx = {
  logger: () => ({ info() {}, warn() {} }),
  systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 1500, context() {} },
  on() {},
  effect: (fn) => { fn(); return { dispose() {} } },
  commands: { register: (c) => { command = c } },
}
registerCommands(ctx)
check('命令已注册', Boolean(command))

const view = command.handler(['mood'])
check('mood 不带参数仍是查看', view.kind === 'success' && /心情/.test(view.text), JSON.stringify(view).slice(0, 80))

const off = command.handler(['mood', 'off'])
check('mood off 是关闭', off.kind === 'success' && /已关闭/.test(off.text), JSON.stringify(off).slice(0, 80))
check('关掉后配置里 enabled=false', readEmotionStore().config.enabled === false)

const on = command.handler(['mood', 'on'])
check('mood on 是开启', on.kind === 'success' && /已开启/.test(on.text), JSON.stringify(on).slice(0, 80))
check('开起来后配置里 enabled=true', readEmotionStore().config.enabled === true)

const legacy = command.handler(['mood-on'])
check('老写法 mood-on 还能用', legacy.kind === 'success' && /已开启/.test(legacy.text))

const bogus = command.handler(['mood', 'maybe'])
check('不认识的参数回查看而不是报错', bogus.kind === 'success' && /心情/.test(bogus.text))

// Windows 上 sqlite 句柄还没释放，删临时目录会 EPERM；清不掉就算了
try { rmSync(home, { recursive: true, force: true }) } catch {}
console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
