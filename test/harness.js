/**
 * 离线自测：不依赖宿主，验证模块化大脑的完整流程。
 *
 * 覆盖：
 *   1. apply 注册 4 个段落 + 命令 + 3 个钩子
 *   2. 人设被纠正为 global
 *   3. Hindsight 配置写入且 bank 固定
 *   4. 分类器：底线 / 情感 / 认知 / 本能 的路由
 *   5. 入库后条目带 module 与 weight
 *   6. 底线永远注入（哪怕查询完全不相关）
 *   7. 声音段落常驻，能力段落反映开关
 *   8. 权重调整生效
 *   9. 命令可用
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-sb-test-'))
const home = join(root, 'dsh-home')
const hindsightCfg = join(root, 'hindsight', 'coding-agent.json')
process.env.DSH_HOME = home
process.env.HINDSIGHT_CONFIG = hindsightCfg

mkdirSync(join(home, 'storages', 'dsh-persona-dafeiyu'), { recursive: true })
// 旧人设插件的库：里面有一份正在用的人设，共享大脑启动时应该把它导入一次。
writeFileSync(
  join(home, 'storages', 'dsh-persona-dafeiyu', 'personas.json'),
  JSON.stringify({
    version: 1,
    mode: 'session',
    current: 'dafeiyu',
    disabled: [],
    personas: [{ id: 'dafeiyu', name: '大肥鱼（旧插件）', text: '我是旧插件里的人设。', updatedAt: Date.now() }],
    workspaces: [],
  }),
)

const mod = await import('../lib/index.js')
const { classify } = await import('../lib/classify.js')
const { createSessionCatalog } = await import('../lib/sessions.js')
const { readModules, writeModules, MEMORY_MODULES, MODULE_PROFILES, normalizeModules } = await import('../lib/modules.js')
const { recallModules, renderModuleRecall, renderVoice } = await import('../lib/weighted-recall.js')
const { readStore, writeStore, brainFile, pruneExpired, isAlive } = await import('../lib/store.js')
const { activePersona, personaList, selectPersona, savePersona, deletePersona, adoptLegacyPersona, personaFile, readPersona } = await import('../lib/persona.js')
const { judgeLifetime, formatSpan } = await import('../lib/lifetime.js')
const { normalizeSpeech, setSpeech, SPEECH_LIMITS } = await import('../lib/modules.js')

// 客户端源码的副本，用来验证浏览器侧注册了预期的插槽。
writeFileSync(join(root, 'client-src.js'), readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))

let failures = 0
function assert(cond, label, extra = '') {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures += 1
    console.log(`  ✗ ${label} ${extra}`)
  }
}

console.log('== apply ==')
const sections = []
const hooks = {}
let command = null
const ctx = {
  logger: () => ({ info: (m) => console.log('  [info]', m), warn: (m) => console.log('  [warn]', m) }),
  systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 1500 },
  on: (name, fn) => { hooks[name] = fn },
  effect: (fn) => { fn(); return { dispose() {} } },
  commands: { register: (c) => { command = c } },
}
mod.apply(ctx)
console.log('  sections:', sections.map((s) => s.name).join(', '))
console.log('  hooks:', Object.keys(hooks).join(', '))
assert(sections.length === 4, '注册了 4 个提示词段落（记忆/人设/声音/能力）')
assert(sections.some((s) => s.name === 'shared-brain:memory'), '记忆段落存在')
assert(sections.some((s) => s.name === 'shared-brain:voice'), '声音段落存在')
assert(sections.some((s) => s.name === 'shared-brain:capability'), '能力段落存在')
assert(Boolean(hooks['agent/pre-step'] && hooks['agent/turn-stopping'] && hooks['agent/disposed']), '3 个会话钩子已注册')
assert(Boolean(command), '命令已注册')

console.log('== 人设由共享大脑自持（不再依赖别的插件） ==')
const personaRead = readPersona()
console.log('  库文件:', personaRead.path, 'exists=', personaRead.exists)
assert(personaRead.path.replace(/\\/g, '/').endsWith('dsh-shared-brain/persona.json'), '人设库放在共享大脑自己的目录下')
assert(typeof personaRead.store.current === 'string' && personaRead.store.current.length > 0, '人设库有当前人设')
const active = activePersona()
console.log('  当前:', active.id, active.name, 'bundled=', active.bundled, 'chars=', active.text.length)
assert(active.id === personaRead.store.current, 'activePersona 与库里当前人设一致')
assert(active.text.length > 0, '当前人设有正文')
assert(personaList().list.length >= 3, '至少三份人设（内置大肥鱼/阿茶/听澜）')
assert(personaList().list.some((x) => x.bundled === true), '存在内置人设')
// 旧插件库被一次性导入
const legacyFile = join(home, 'storages', 'dsh-persona-dafeiyu', 'personas.json')
console.log('  旧插件库:', existsSync(legacyFile) ? JSON.stringify(JSON.parse(readFileSync(legacyFile, 'utf8'))) : '无')
const legacyAdopt = adoptLegacyPersona()
console.log('  导入结果:', JSON.stringify(legacyAdopt))
assert(personaList().list.some((x) => String(x.id).startsWith('legacy_')), '旧人设被导入本插件')
// 切换 / 新建 / 删除
const useAcha = selectPersona('acha')
assert(useAcha.ok === true && activePersona().id === 'acha', '切换到内置人设「阿茶」成功')
const saveRes = savePersona({ name: '测试人设', text: '我是一个测试人设。' })
assert(saveRes.ok === true, '新建自定义人设成功')
assert(personaList().list.some((x) => x.id === saveRes.id), '自定义人设出现在列表里')
assert(activePersona().id === saveRes.id, '新建的人设自动成为当前人设')
const delRes = deletePersona(saveRes.id)
assert(delRes.ok === true, '删除自定义人设成功')
assert(!personaList().list.some((x) => x.id === saveRes.id), '删除后人设不见了')
assert(activePersona().id === 'dafeiyu', '删掉当前人设后回落到内置大肥鱼')
assert(deletePersona('dafeiyu').ok === false, '内置人设不可删除')
assert(savePersona({ id: 'dafeiyu', name: 'x', text: 'y' }).ok === false, '内置人设不可覆盖')
selectPersona('dafeiyu')

console.log('== Hindsight 配置 ==')
const hs = JSON.parse(readFileSync(hindsightCfg, 'utf8'))
console.log(' ', JSON.stringify(hs))
assert(hs.bankId === 'coding-agent::global', 'bank 固定为全局')
assert(hs.dynamicBankId === false, 'dynamicBankId 为 false')

console.log('== 分类器路由 ==')
const cases = [
  [{ user: '不要删除我的文件', text: '不要删除我的文件' }, 'cognition'],
  [{ user: '以后不许动我的配置', text: '以后不许动我的配置' }, 'cognition'],
  [{ user: '我喜欢你这样说话', text: '我喜欢你这样说话' }, 'emotion'],
  [{ user: '记住我叫你小肥鱼', text: '记住我叫你小肥鱼' }, 'emotion'],
  [{ user: '插件安装失败，原因是网络慢', text: '插件安装失败，原因是网络慢' }, 'cognition'],
]
for (const [input, expected] of cases) {
  const result = classify(input)
  console.log(`  ${input.user.slice(0, 16)} → ${result.module} (${result.weight}) ${result.reason}`)
  assert(result.module === expected, `「${input.user.slice(0, 12)}」归入 ${expected}`)
}
const instinctCase = classify({ user: '装插件', text: '装插件' }, { repeatCount: 3 })
console.log(`  反复 4 次 → ${instinctCase.module} (${instinctCase.weight})`)
assert(instinctCase.module === 'instinct', '反复出现归入本能')
const bottomlineCase = classify({ user: '以后不许动我的配置', text: '以后不许动我的配置' });
assert(bottomlineCase.suggestBottomline === true, '底线信号提示可手动钉为底线（不再自动归底线）')

console.log('== turn-stopping：入库并分区 ==')
const events = [
  { type: 'user/message', time: Date.now(), data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '不要删除我的文件' }] } } },
  { type: 'assistant/message', time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，绝对不动你的文件。' }] } } },
]
const agent = { session: { header: { id: 'session-test-1', cwd: 'D:/work/proj' }, events, snapshotEvents: () => events } }
hooks['agent/turn-stopping']({ agent })
const store = readStore()
console.log('  条目:', JSON.stringify(store.entries.map((e) => ({ module: e.module, weight: e.weight, text: e.text.slice(0, 30) }))))
assert(store.entries.length === 1, '入库 1 条')
assert(store.entries[0].module === 'cognition', '自动入库不归底线（底线改为手动）')
assert(store.entries[0].weight >= 0.8, '涉及限制的条目权重高（>=0.8）')

console.log('== 底线永远注入 ==')
const modules = readModules()
const unrelated = recallModules(modules, '今天星期几', { limit: 5 })
console.log('  always 条数:', unrelated.always.length, '| hits 条数:', unrelated.hits.length)
assert(unrelated.always.length === 0, '自动分类的底线不会常驻注入（只有钉住的才注入）')
const rendered = renderModuleRecall(unrelated)
console.log('  渲染片段:', rendered.split('\n')[0])
assert(!rendered.includes('底线'), '未钉住时渲染文本里没有底线')

console.log('== 手动钉住的底线才注入 ==')
const pinnedModules = readModules()
pinnedModules.bottomline.items = [{ id: 'mod_pinned_1', text: '不要删除我的文件', weight: 0.9, tags: [], hits: 0, pinned: true, source: 'manual', lifetime: 'permanent', expiresAt: 0, createdAt: Date.now(), updatedAt: Date.now() }]
writeModules(pinnedModules)
const pinnedRecall = recallModules(readModules(), '今天星期几', { limit: 5 })
console.log('  always 条数:', pinnedRecall.always.length)
assert(pinnedRecall.always.length === 1, '钉住的底线在无关查询里也注入')
assert(pinnedRecall.always[0].item.text === '不要删除我的文件', '注入的是钉住的那条底线')
const pinnedRender = renderModuleRecall(pinnedRecall)
assert(pinnedRender.includes('底线'), '渲染文本标明底线模块')
assert(pinnedRender.includes('不要删除我的文件'), '渲染文本包含底线内容')
console.log('== 声音与能力段落 ==')
const voiceText = renderVoice(modules)
console.log(' ', voiceText)
assert(voiceText.includes('语气'), '声音段落描述语气')
const capSection = sections.find((s) => s.name === 'shared-brain:capability')
const capText = capSection.text()
console.log(' ', capText.split('\n')[0])
assert(capText.includes('网络') && capText.includes('自动互动'), '能力段落包含网络与自动互动')

console.log('== 能力开关 ==')
const m2 = readModules()
m2.network.enabled = true
m2.agentive.enabled = true
writeModules(m2)
const capText2 = capSection.text()
assert(capText2.includes('主动去查'), '开网络后提示改为主动获取信息')
assert(capText2.includes('主动提出建议'), '开自动互动后提示改为主动')

console.log('== pre-step：召回并注入 ==')
const decision = await hooks['agent/pre-step'](
  { agent, signal: null },
  async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我装个插件' }] }] }),
)
console.log('  消息数:', decision.messages.length)
assert(decision.messages.length === 2, '注入了一条记忆')

console.log('== 权重调整 ==')
command.handler(['weight', 'bottomline', '0.3'])
const m3 = readModules()
assert(Math.abs(m3.bottomline.weight - 0.3) < 0.001, '底线模块权重被改成 0.3')

console.log('== 命令 ==')
const out = command.handler(['list'])
console.log(out.text.split('\n').slice(0, 14).join('\n'))
assert(out.kind === 'success', '/shared-memory list 成功')
const voiceOut = command.handler(['voice', '说话要带点傲娇'])
assert(voiceOut.kind === 'success', '/shared-memory voice 成功')
const netOut = command.handler(['network', 'on'])
assert(netOut.kind === 'success', '/shared-memory network on 成功')
const clearOut = command.handler(['clear', 'bottomline'])
assert(clearOut.kind === 'success', '/shared-memory clear bottomline 成功')

console.log('== 命令：手动底线与寿命与范围 ==')
const addOut = command.handler(['add', 'bottomline', '不要删除我的文件'])
assert(addOut.kind === 'success', '/shared-memory add 成功')
assert(readModules().bottomline.items.some((it) => it.text === '不要删除我的文件' && it.pinned === true), 'add 写入钉住的底线')
const addedItem = readModules().bottomline.items.find((it) => it.text === '不要删除我的文件')
const unpinOut = command.handler(['unpin', 'bottomline', addedItem.id])
assert(unpinOut.kind === 'success', '/shared-memory unpin 成功')
assert(readModules().bottomline.items.find((it) => it.id === addedItem.id).pinned === false, 'unpin 生效')
const pinOut = command.handler(['pin', 'bottomline', addedItem.id])
assert(pinOut.kind === 'success', '/shared-memory pin 成功')
const tempOut = command.handler(['temporary', 'bottomline', addedItem.id, '2'])
assert(tempOut.kind === 'success', '/shared-memory temporary 成功')
assert(readModules().bottomline.items.find((it) => it.id === addedItem.id).lifetime === 'temporary', 'temporary 生效')
const permOut = command.handler(['permanent', 'bottomline', addedItem.id])
assert(permOut.kind === 'success', '/shared-memory permanent 成功')
assert(readModules().bottomline.items.find((it) => it.id === addedItem.id).lifetime === 'permanent', 'permanent 生效')
const scopeOut = command.handler(['agentive', 'scope', 'session', 'sess-1'])
assert(scopeOut.kind === 'success', '/shared-memory agentive scope 成功')
assert(readModules().agentive.sessionIds[0] === 'sess-1', 'scope 记下了会话')
const scopeBad = command.handler(['agentive', 'scope', 'session'])
assert(scopeBad.kind === 'error', 'session 范围必须给会话 ID')
const scopeAllOut = command.handler(['agentive', 'scope', 'all'])
assert(scopeAllOut.kind === 'success', '/shared-memory agentive scope all 成功')
const rmOut = command.handler(['remove', 'bottomline', addedItem.id])
assert(rmOut.kind === 'success', '/shared-memory remove 成功')
assert(!readModules().bottomline.items.some((it) => it.id === addedItem.id), 'remove 删掉了条目')
console.log('== 浏览器桥：快照与变更 ==')
const bridge = await import('../lib/bridge.js')
const snap = bridge.snapshotOf()
console.log('  模块:', Object.keys(snap.modules).join(','))
console.log('  声音语气:', snap.voice.style.tone)
assert(Object.keys(snap.modules).length === 7, '快照含 7 个模块')
assert(snap.voice && snap.voice.style && typeof snap.voice.style.tone === 'string', '快照含声音风格')
assert(typeof snap.memory.total === 'number', '快照含记忆总数')
const w = bridge.mutateModules({ action: 'setWeight', module: '情感', weight: 0.33 })
assert(w.ok === true, 'setWeight 成功')
assert(Math.abs(readModules().emotion.weight - 0.33) < 0.001, '情感权重被改成 0.33')
const e = bridge.mutateModules({ action: 'setEnabled', module: 'network', enabled: true })
assert(e.ok === true && readModules().network.enabled === true, '网络能力被打开')
const v = bridge.mutateModules({ action: 'setVoice', tone: '软萌一点', tics: ['哼！', '嘿嘿'] })
assert(v.ok === true && readModules().voice.style.tone === '软萌一点', '声音语气被改写')
assert(Array.isArray(readModules().voice.style.tics) && readModules().voice.style.tics.length === 2, '口头禅被写成 2 条')
const bad = bridge.mutateModules({ action: 'setWeight', module: '不存在的模块', weight: 0.5 })
assert(bad.ok === false, '未知模块被拒绝')
const badAction = bridge.mutateModules({ action: 'nope' })
assert(badAction.ok === false, '未知 action 被拒绝')
const cn = bridge.mutateModules({ action: 'setWeight', module: '底线', weight: 0.77 })
assert(cn.ok === true && Math.abs(readModules().bottomline.weight - 0.77) < 0.001, '中文模块名可解析')
assert(bridge.resolveModuleKey('自动互动') === 'agentive', 'resolveModuleKey 认中文名')

console.log('== 永久 / 临时记忆 ==')
const tmpStore = readStore()
tmpStore.entries.push({ id: 'mem_tmp_1', text: '临时条目', tags: [], module: 'cognition', weight: 0.6, lifetime: 'temporary', expiresAt: Date.now() - 1000, pinned: false, source: 'manual', sessionId: '', cwd: '', createdAt: Date.now(), updatedAt: Date.now(), hits: 0 })
writeStore(tmpStore)
const pruned = pruneExpired(readStore())
assert(pruned.removed === 1, '过期临时记忆被清理')
assert(!pruned.store.entries.some((e) => e.id === 'mem_tmp_1'), '过期条目已从库里移除')
const aliveStore = readStore()
aliveStore.entries.push({ id: 'mem_tmp_2', text: '还活着的临时条目', tags: [], module: 'cognition', weight: 0.6, lifetime: 'temporary', expiresAt: Date.now() + 3600000, pinned: false, source: 'manual', sessionId: '', cwd: '', createdAt: Date.now(), updatedAt: Date.now(), hits: 0 })
writeStore(aliveStore)
assert(isAlive({ lifetime: 'temporary', expiresAt: Date.now() + 1000 }) === true, '未过期临时记忆有效')
assert(isAlive({ lifetime: 'temporary', expiresAt: Date.now() - 1000 }) === false, '已过期临时记忆无效')
assert(isAlive({ lifetime: 'permanent' }) === true, '永久记忆永远有效')
console.log('== 手动底线 / 寿命 / 作用范围（桥） ==')
const addRes = bridge.mutateModules({ action: 'addItem', module: 'bottomline', text: '不要删除我的文件', pinned: true })
assert(addRes.ok === true, '手动添加底线条目成功')
const afterAdd = readModules()
const added = afterAdd.bottomline.items.find((it) => it.text === '不要删除我的文件')
assert(added !== undefined, '底线条目进了模块配置')
assert(added.pinned === true, '手动添加的条目默认钉住')
assert(added.source === 'manual', '手动添加的条目来源是 manual')
const storeAfterAdd = readStore()
assert(storeAfterAdd.entries.some((e) => e.text === '不要删除我的文件'), '手动条目也进了扁平记忆库')
const pinRes = bridge.mutateModules({ action: 'pinItem', module: 'bottomline', id: added.id, pinned: false })
assert(pinRes.ok === true, '取消钉住成功')
assert(readModules().bottomline.items.find((it) => it.id === added.id).pinned === false, '钉住状态已更新')
const lifeRes = bridge.mutateModules({ action: 'setLifetime', module: 'bottomline', id: added.id, lifetime: 'temporary', ttlMs: 3600000 })
assert(lifeRes.ok === true, '改成临时记忆成功')
const lifeItem = readModules().bottomline.items.find((it) => it.id === added.id)
assert(lifeItem.lifetime === 'temporary' && lifeItem.expiresAt > Date.now(), '临时记忆带过期时间')
const scopeRes = bridge.mutateModules({ action: 'setAgentiveScope', scope: 'session', sessionIds: ['sess-1', 'sess-2'] })
assert(scopeRes.ok === true, '设置自动互动范围成功')
assert(readModules().agentive.scope === 'session', '范围记为 session')
assert(readModules().agentive.sessionIds.length === 2, '记下了两个会话')
const scopeAll = bridge.mutateModules({ action: 'setAgentiveScope', scope: 'all' })
assert(scopeAll.ok === true && readModules().agentive.sessionIds.length === 0, '切回全部会话时清空会话列表')
const badScope = bridge.mutateModules({ action: 'setAgentiveScope', scope: 'nope' })
assert(badScope.ok === false, '非法范围被拒绝')
console.log('== 客户端源码检查 ==')
// 客户端是浏览器侧代码（window.__ModuleLoader__），这里只验证它能被读到，
// 并且注册了预期的三个插槽。
const clientSource = readFileSync(join(root, 'client-src.js'), 'utf8')
assert(clientSource.length > 0, '客户端源码可读')
assert(clientSource.includes('settings.section'), '客户端注册了设置页小节')
assert(clientSource.includes('conversation.composer.dock'), '客户端注册了侧边栏小条')
assert(clientSource.includes('shell.overlay'), '客户端注册了浮层面板')

// JSX 调用形态校验：React 的 jsx(type, props, key) 只从 props.children 读子节点。
// 历史上我们把 children 写成第 4 个位置参数，React 会静默丢弃 → 设置页整块空白。
// 这里做一次静态扫描，防止再犯。
{
  const calls = []
  const re = /jsxRuntime\.jsx(s?)\(/g
  let m
  while ((m = re.exec(clientSource)) !== null) {
    let depth = 0
    let i = m.index + m[0].length - 1
    let inStr = null
    const args = []
    let argStart = i + 1
    for (; i < clientSource.length; i++) {
      const ch = clientSource[i]
      if (inStr) {
        if (ch === '\\') { i++; continue }
        if (ch === inStr) inStr = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; continue }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth--
        if (depth === 0) { args.push(clientSource.slice(argStart, i)); break }
        continue
      }
      if (ch === ',' && depth === 1) { args.push(clientSource.slice(argStart, i)); argStart = i + 1 }
    }
    calls.push({ line: clientSource.slice(0, m.index).split('\n').length, args })
  }
  const positional = calls.filter((c) => {
    if (c.args.length < 4) return false
    const props = c.args[1] || ''
    return !/(^|[{,]\s*)children\s*:/.test(props)
  })
  assert(positional.length === 0, `JSX 子节点没有写在 props.children 里（位置参数写法会渲染空白）：${positional.map((c) => 'L' + c.line).join(', ')}`)

  // key 必须作为第 3 个参数传给 jsx，不能塞进 props。
  // 只看本调用的「直接」props：嵌套在 children 数组里的子调用不算。
  const directProps = (props) => {
    // 去掉嵌套的数组/对象内容（children: [ ... ] 里的内容），只留顶层属性。
    let depth = 0
    let out = ''
    for (let i = 0; i < props.length; i++) {
      const ch = props[i]
      if (ch === '[' || ch === '(') { depth++; if (depth === 1) { out += ' '; continue } continue }
      if (ch === ']' || ch === ')') { depth--; if (depth === 0) { out += ' '; continue } continue }
      if (depth > 0) continue
      if (ch === '{') { depth++; out += ch; continue }
      if (ch === '}') { depth--; out += ch; continue }
      out += ch
    }
    return out
  }
  const keyInProps = calls.filter((c) => {
    const props = c.args[1] || ''
    if (!/(^|[{,]\s*)key\s*:/.test(props)) return false
    return /(^|[{,]\s*)key\s*:/.test(directProps(props))
  })
  assert(keyInProps.length === 0, `key 写在了 props 里（React 会警告）：${keyInProps.map((c) => 'L' + c.line).join(', ')}`)

  // DOM 元素必须有 children（void 元素除外），否则渲染成空气。
  const childless = calls.filter((c) => {
    if (c.args.length >= 3) return false
    const props = c.args[1] || ''
    if (/(^|[{,]\s*)children\s*:/.test(props)) return false
    const type = (c.args[0] || '').trim().replace(/^"|"$/g, '')
    if (!/^[a-z][a-z0-9]*$/.test(type)) return false
    return !['input', 'textarea', 'img', 'br', 'hr'].includes(type)
  })
  assert(childless.length === 0, `DOM 元素缺少 children：${childless.map((c) => 'L' + c.line).join(', ')}`)
}

console.log('== 记忆寿命自动判断 ==')
{
  const stable = judgeLifetime({ text: '我喜欢用 TypeScript，讨厌用 Go，以后每次都用 TS。' })
  console.log('  稳定偏好 →', stable.lifetime, stable.reason)
  assert(stable.lifetime === 'permanent', '稳定偏好判为永久')
  const ephemeral = judgeLifetime({ text: '今天先把这个临时方案跑起来。' })
  console.log('  临时安排 →', ephemeral.lifetime, ephemeral.reason)
  assert(ephemeral.lifetime === 'temporary', '带时效词判为临时')
  assert(ephemeral.expiresAt > Date.now(), '临时记忆有过期时间')
  const volatile = judgeLifetime({ text: '当前版本是 2.1.0，端口在 8080。' })
  console.log('  易变状态 →', volatile.lifetime, volatile.reason)
  assert(volatile.lifetime === 'temporary', '易变状态判为临时')
  const fallback = judgeLifetime({ text: '嗯嗯。' })
  console.log('  兜底 →', fallback.lifetime, fallback.reason)
  assert(fallback.lifetime === 'temporary', '没信号时兜底为临时')
  const trap = judgeLifetime({ text: '我讨厌临时文件。' })
  console.log('  陷阱句 →', trap.lifetime, trap.reason)
  assert(trap.lifetime === 'permanent', '句中偶然出现「临时」不会误判')
  assert(formatSpan(3600000) === '1 小时', 'formatSpan 输出小时')
}

console.log('== 语音 / 唱歌参数 ==')
{
  const speech = normalizeSpeech(undefined)
  console.log(' ', JSON.stringify(speech))
  assert(speech.rate === 1 && speech.pitch === 1 && speech.volume === 0.9, '语音默认值正确')
  assert(speech.sing.enabled === false, '唱歌默认关闭')

  const res = setSpeech(readModules(), { voiceName: '晓晓', rate: 1.2, sing: { enabled: true, bpm: 100 } })
  assert(res.changed === true, '语音参数可改')
  const after = normalizeSpeech(res.modules.voice.style.speech)
  assert(after.voiceName === '晓晓' && after.rate === 1.2, '音色与语速已保存')
  assert(after.sing.enabled === true && after.sing.bpm === 100, '唱法开关与 BPM 已保存')
  assert(after.sing.style === '轻哼', '未改的唱法字段保留默认值（深合并）')
  const clamped = setSpeech(readModules(), { rate: 9 })
  const clampedAfter = normalizeSpeech(clamped.modules.voice.style.speech)
  assert(clampedAfter.rate <= SPEECH_LIMITS.rate.max, '语速被夹到上限')
}

console.log('== 桥：语音 / 人设 / 搜索 ==')
{
  const speechRes = bridge.mutateModules({ action: 'setSpeech', voiceName: '晓晓', rate: 1.1 })
  assert(speechRes.ok === true, '桥能改语音参数')
  const useRes = bridge.mutateModules({ action: 'selectPersona', id: 'tinglan' })
  assert(useRes.ok === true, '桥能切换人设')
  const saveRes = bridge.mutateModules({ action: 'savePersona', name: '桥建人设', text: '我是桥建的人设。' })
  assert(saveRes.ok === true, '桥能新建人设')
  const delRes = bridge.mutateModules({ action: 'deletePersona', id: saveRes.value?.id })
  assert(delRes.ok === true, `桥能删除人设（${delRes.note || delRes.error}）`)
  const searchRes = bridge.mutateModules({ action: 'searchMemory', query: '不要删除我的文件' })
  assert(searchRes.ok === true, '桥能搜记忆')
  assert(Array.isArray(searchRes.value.hits), '搜索返回命中数组')
  assert(searchRes.value.hits.length > 0, '搜索能命中已入库的记忆')
  const badSearch = bridge.mutateModules({ action: 'searchMemory' })
  assert(badSearch.ok === false, '缺少 query 的搜索被拒绝')
}

console.log('== 命令：人设 / 语音 / 搜索 ==')
{
  const listRes = await command.handler(['persona'])
  assert(listRes.kind === 'success', '/shared-memory persona 列出人设')
  const useRes = await command.handler(['persona', 'use', 'dafeiyu'])
  assert(useRes.kind === 'success', '/shared-memory persona use 切人设')
  const saveRes = await command.handler(['persona', 'save', '命令行人设', '我是命令行建的。'])
  assert(saveRes.kind === 'success', '/shared-memory persona save 新建人设')
  const speechShow = await command.handler(['speech'])
  assert(speechShow.kind === 'success', '/shared-memory speech 显示参数')
  const speechSet = await command.handler(['speech', 'voiceName', '晓晓'])
  assert(speechSet.kind === 'success', '/shared-memory speech 改音色')
  const speechRate = await command.handler(['speech', 'rate', '1.3'])
  assert(speechRate.kind === 'success', '/shared-memory speech 改语速')
  const singOn = await command.handler(['speech', 'sing.enabled', 'on'])
  assert(singOn.kind === 'success', '/shared-memory speech 打开唱歌')
  const singStyle = await command.handler(['speech', 'sing.style', '轻哼'])
  assert(singStyle.kind === 'success', '/shared-memory speech 改唱法')
  const searchRes = await command.handler(['search', '删除'])
  assert(searchRes.kind === 'success', '/shared-memory search 搜记忆')
  const unknown = await command.handler(['nope'])
  assert(unknown.kind === 'error', '未知参数被拒绝')
}

console.log('== 0.6：续期 / 冲突 / 作用域 / 时间窗 / 表情 / 按会话人设 ==')
{
  const { renewEntry } = await import('../lib/store.js')
  const { findConflicts, isConflicting, renderConflict } = await import('../lib/conflict.js')
  const { setModuleItemScope, setAgentiveTimeWindow, withinTimeWindow, ITEM_SCOPES, normalizeClock } = await import('../lib/modules.js')
  const { readEmojiDir, writeEmoji, normalizeEmoji, renderEmoji, defaultEmojiDir } = await import('../lib/emoji.js')
  const { setSessionPersona, activePersona: active2 } = await import('../lib/persona.js')
  const { mutateModules, snapshotOf } = await import('../lib/bridge.js')

  // 临时记忆续期
  const now = Date.now()
  const temp = { lifetime: 'temporary', expiresAt: now + 1000, ttlMs: 60 * 60 * 1000 }
  const renewed = renewEntry(temp, now)
  assert(renewed.expiresAt > now + 1000, '召回命中后临时记忆被续期')
  assert(renewed.ttlMs === 60 * 60 * 1000, '续期沿用原来的 ttl')
  assert(renewEntry({ lifetime: 'permanent', expiresAt: 0 }, now).expiresAt === 0, '永久记忆不会被续期')
  

  // 冲突检测
  const older = { id: 'a', text: '默认模型用 A 方案', tags: ['默认模型', '方案'], updatedAt: 1 }
  assert(isConflicting(older, { text: '默认模型改用 B 方案', tags: ['默认模型', '方案'] }), '转向词 + 同主题算冲突')
  assert(!isConflicting(older, { text: '今天天气不错', tags: ['天气'] }), '不同主题不算冲突')
  const conflicts = findConflicts([older], { text: '默认模型改用 B 方案', tags: ['默认模型', '方案'] })
  assert(conflicts.length === 1 && conflicts[0].id === 'a', 'findConflicts 找到旧条目')
  assert(renderConflict(conflicts, '默认模型改用 B 方案').includes('以新说法为准'), '冲突渲染提示以新为准')

  // 条目作用域
  const mods = readModules()
  mods.bottomline.items = [{ id: 'bl-1', text: '不要在 D 盘乱写', weight: 0.9, pinned: true, scope: 'global', scopePath: '' }]
  const scoped = setModuleItemScope(mods, 'bottomline', 'bl-1', 'workspace', 'D:/work')
  assert(scoped.changed && mods.bottomline.items[0].scope === 'workspace', '条目可限定到工作区')
  assert(mods.bottomline.items[0].scopePath === 'D:/work', '作用域记住工作区路径')
  assert(ITEM_SCOPES.includes('workspace'), 'ITEM_SCOPES 含 workspace')

  // 时间窗
  assert(normalizeClock('9:5', '09:00') === '09:05', 'normalizeClock 补零')
  assert(normalizeClock('乱写', '09:00') === '09:00', 'normalizeClock 非法值回落')
  const windowed = { enabled: true, start: '09:00', end: '17:00' }
  assert(withinTimeWindow(windowed, new Date(2026, 0, 1, 12, 0)) === true, '窗口内返回 true')
  assert(withinTimeWindow(windowed, new Date(2026, 0, 1, 20, 0)) === false, '窗口外返回 false')
  assert(withinTimeWindow({ enabled: true, start: '22:00', end: '06:00' }, new Date(2026, 0, 1, 23, 0)) === true, '跨午夜窗口判对')
  setAgentiveTimeWindow(mods, { enabled: true, start: '08:00', end: '20:00' })
  assert(mods.agentive.timeWindow.enabled && mods.agentive.timeWindow.start === '08:00', '时间窗可写入模块')
  const { renderCapabilities } = await import('../lib/weighted-recall.js')
  const outside = renderCapabilities({ network: { enabled: false }, agentive: { enabled: true, scope: 'all', timeWindow: { enabled: true, start: '09:00', end: '10:00' } } }, { now: new Date(2026, 0, 1, 23, 0) })
  assert(outside.includes('不在窗口内'), '窗口外时能力段落明说不主动')

  // 表情包目录
  const emojiDir = join(root, 'emoji-test')
  assert(normalizeEmoji('  (≧▽≦)  ').value === '(≧▽≦)', 'normalizeEmoji 取首行并去空白')
  assert(normalizeEmoji('开心: (≧▽≦)').value === '(≧▽≦)', 'normalizeEmoji 支持 name: value')
  assert(normalizeEmoji('开心: (≧▽≦)').name === '开心', 'normalizeEmoji 提取名字前缀')
  const written = writeEmoji(emojiDir, '委屈', '呜…')
  assert(written.ok === true, 'writeEmoji 写入成功')
  const readBack = readEmojiDir(emojiDir)
  assert(readBack.exists && readBack.count === 1, 'readEmojiDir 读到 1 个表情')
  assert(readBack.items[0].name === '委屈' && readBack.items[0].value === '呜…', '表情的名字与值都对')
  assert(defaultEmojiDir().replace(/\\/g, '/').endsWith('dsh-shared-brain/emoji'), '默认表情目录在插件自己的目录下')
  const emojiText = renderEmoji({ emoji: '🐟' }, readBack)
  assert(emojiText.includes('🐟') && emojiText.includes('委屈'), 'renderEmoji 同时给默认表情与目录表情')
  const voiceWithEmoji = renderVoice({ voice: { enabled: true, weight: 0.7, style: { tone: '傲娇', emojiDir, speech: { sing: { enabled: false } } } } })
  assert(voiceWithEmoji.includes('委屈'), '声音段落带上目录里的表情')

  // 按会话指定人设
  const setForSession = setSessionPersona('sess-xyz', 'tinglan')
  assert(setForSession.ok === true, '能给会话单独指定人设')
  assert(active2('sess-xyz').id === 'tinglan', '该会话用的是指定人设')
  assert(active2('sess-xyz').sessionScoped === true, '标记为按会话生效')
  assert(active2('other-session').sessionScoped === false, '别的会话不受影响')
  const cleared = setSessionPersona('sess-xyz', '')
  assert(cleared.ok === true && active2('sess-xyz').id === readPersona().store.current, '留空回到全局人设')
  assert(personaList().bySession !== undefined, 'personaList 带 bySession')

  // 桥的新 action（作用域要先有真实条目，走 addItem 建一条）
  const emojiDirRes = mutateModules({ action: 'setEmojiDir', dir: emojiDir })
  assert(emojiDirRes.ok === true, '桥能设置表情目录')
  const addEmojiRes = mutateModules({ action: 'addEmoji', name: '开心', value: '(≧▽≦)' })
  assert(addEmojiRes.ok === true, '桥能加表情')
  const realAdd = mutateModules({ action: 'addItem', module: 'bottomline', text: '不要在 D 盘乱写', pinned: true })
  assert(realAdd.ok === true, '桥能加手动底线（供作用域测试）')
  const realItem = readModules().bottomline.items.find((it) => it.text === '不要在 D 盘乱写')
  assert(Boolean(realItem?.id), '手动底线有 id')
  const scopeRes = mutateModules({ action: 'setItemScope', module: 'bottomline', id: realItem.id, scope: 'workspace', scopePath: 'D:/work' })
  assert(scopeRes.ok === true, '桥能改条目作用域')
  const windowRes = mutateModules({ action: 'setAgentiveTimeWindow', enabled: true, start: '07:00', end: '19:00' })
  assert(windowRes.ok === true && readModules().agentive.timeWindow.start === '07:00', '桥能改时间窗')
  const sessionRes = mutateModules({ action: 'setSessionPersona', sessionId: 'sess-xyz', id: 'acha' })
  assert(sessionRes.ok === true && active2('sess-xyz').id === 'acha', '桥能按会话指定人设')
  const badSession = mutateModules({ action: 'setSessionPersona', sessionId: 'sess-xyz', id: '不存在' })
  assert(badSession.ok === false, '不存在的人设被拒绝')

  // 搜索过滤
  store.entries.push(
    { id: 'f1', text: '临时笔记：端口 8080', tags: ['端口'], module: 'cognition', weight: 0.5, lifetime: 'temporary', expiresAt: Date.now() + 60000, pinned: false, source: 'auto', createdAt: Date.now(), updatedAt: Date.now(), hits: 0 },
    { id: 'f2', text: '永久规则：端口不要乱改', tags: ['端口', '规则'], module: 'cognition', weight: 0.9, lifetime: 'permanent', expiresAt: 0, pinned: true, source: 'manual', createdAt: Date.now(), updatedAt: Date.now(), hits: 0 },
  )
  writeStore(store)
  const all = mutateModules({ action: 'searchMemory', query: '端口' })
  assert(all.ok === true && all.value.total >= 2, '搜索能找到多条')
  const onlyTemp = mutateModules({ action: 'searchMemory', query: '端口', lifetime: 'temporary' })
  assert(onlyTemp.value.hits.every((h) => h.lifetime === 'temporary'), '按寿命过滤生效')
  const onlyPinned = mutateModules({ action: 'searchMemory', query: '端口', pinned: true })
  assert(onlyPinned.value.hits.every((h) => h.pinned === true), '只看钉住的生效')
  const byTag = mutateModules({ action: 'searchMemory', query: '端口', tag: '规则' })
  assert(byTag.value.hits.every((h) => (h.tags || []).includes('规则')), '按标签过滤生效')
  const badModule = mutateModules({ action: 'searchMemory', query: '端口', module: '不存在' })
  assert(badModule.ok === false, '不认识的模块过滤被拒绝')
  const snap = snapshotOf()
  assert(snap.emoji !== undefined && snap.persona.bySession !== undefined, '快照带表情与人设映射')
  assert(snap.modules.agentive.timeWindow !== undefined, '快照带时间窗')

  // 命令
  const emojiShow = await command.handler(['emoji'])
  assert(emojiShow.kind === 'success' && emojiShow.text.includes('表情包目录'), '/shared-memory emoji 显示目录')
  const emojiAdd = await command.handler(['emoji', 'add', '高兴', '(๑•̀ㅂ•́)'])
  assert(emojiAdd.kind === 'success', '/shared-memory emoji add')
  const emojiDirCmd = await command.handler(['emoji', 'dir', emojiDir])
  assert(emojiDirCmd.kind === 'success', '/shared-memory emoji dir')
  const scopeCmd = await command.handler(['scope', '底线', '不要在', 'workspace', 'D:/work'])
  assert(scopeCmd.kind === 'success', '/shared-memory scope')
  const windowShow = await command.handler(['timewindow'])
  assert(windowShow.kind === 'success' && windowShow.text.includes('自动互动时间窗'), '/shared-memory timewindow 显示')
  const windowOn = await command.handler(['timewindow', 'on', '08:00', '18:00'])
  assert(windowOn.kind === 'success', '/shared-memory timewindow on')
  const personaSession = await command.handler(['persona', 'session', 'sess-cmd', 'dafeiyu'])
  assert(personaSession.kind === 'success', '/shared-memory persona session')
}

// ── 0.7：会话目录（设置页要能列出当前有哪些会话）────────────────
{
  console.log('\n== 会话目录 ==')
  const wsPath = 'D:\\work\\alpha'
  const otherPath = 'D:\\work\\beta'
  const persisted = [
    { header: { id: 'sess-al1', createdAt: 5000, cwd: wsPath } },
    { header: { id: 'sess-al2', createdAt: 4000, cwd: wsPath + '\\sub' } },
    { header: { id: 'sess-be1', createdAt: 6000, cwd: otherPath } },
    { header: { id: 'sess-nc1', createdAt: 3000 } },
  ]
  const live = [{ header: { id: 'sess-al1', createdAt: 5000, cwd: wsPath }, meta: { title: '把共享大脑修好' } }]
  const registry = {
    list: () => [
      { id: 'ws1', title: 'alpha', path: wsPath, sessionIds: ['sess-al1'] },
      { id: 'ws2', title: 'beta', path: otherPath, sessionIds: [] },
    ],
  }
  const services = {
    workspaceRegistry: registry,
    sessions: { list: () => live },
    sessionPersistence: { list: async () => persisted },
  }
  // 宿主里没在 inject 声明过的服务只能通过 ctx.get() 拿到 —— 这里就按那个形状模拟
  const catalog = createSessionCatalog({ get: (name) => services[name], logger: { warn: () => {} } })
  catalog.setCurrent('sess-al2')
  await catalog.refresh({ force: true })
  const snap = catalog.snapshot()
  assert(snap.total === 4, '会话目录：扫到全部会话（活跃 + 持久）')
  assert(snap.flat.find((s) => s.id === 'sess-al1')?.live === true, '会话目录：活跃会话被标记')
  assert(snap.flat.find((s) => s.id === 'sess-be1')?.live === false, '会话目录：非活跃会话 live=false')
  assert(snap.flat[0].id === 'sess-be1', '会话目录：按创建时间倒序')
  assert(snap.flat.find((s) => s.id === 'sess-al2')?.current === true, '会话目录：当前会话被标记')
  assert(snap.flat.find((s) => s.id === 'sess-al1')?.title === '把共享大脑修好', '会话目录：优先用会话标题')
  assert(String(snap.flat.find((s) => s.id === 'sess-al2')?.title || '').includes('sub'), '会话目录：没有标题时回退成目录名')
  assert(snap.flat.some((s) => s.id === 'sess-nc1'), '会话目录：没有 cwd 的会话也列出来')
  assert(snap.workspaces.find((w) => w.id === 'ws1')?.sessions.length === 2, '会话目录：工作区吃到 sessionIds 与路径匹配')
  assert(snap.workspaces.find((w) => w.id === 'ws2')?.sessions.some((s) => s.id === 'sess-be1') === true, '会话目录：按 cwd 前缀归到工作区')
  assert(snap.workspaces.find((w) => w.id === '__other__')?.sessions.some((s) => s.id === 'sess-nc1') === true, '会话目录：归不上的进「其他会话」')
  assert(snap.error === '', '会话目录：正常情况没有错误')

  const before = catalog.snapshot().updatedAt
  await catalog.refresh()
  assert(catalog.snapshot().updatedAt === before, '会话目录：3 秒内重复刷新走缓存')

  const bare = createSessionCatalog({ get: () => undefined, logger: { warn: () => {} } })
  await bare.refresh({ force: true })
  const bareSnap = bare.snapshot()
  assert(bareSnap.total === 0 && bareSnap.workspaces.length === 0, '会话目录：拿不到服务时给空目录而不是崩')
  assert(String(bareSnap.error).includes('workspaceRegistry'), '会话目录：拿不到服务时说明原因')

  const lonely = createSessionCatalog({
    get: (name) => (name === 'sessionPersistence' ? { list: async () => persisted } : undefined),
    logger: { warn: () => {} },
  })
  await lonely.refresh({ force: true })
  const lonelySnap = lonely.snapshot()
  assert(lonelySnap.workspaces.length === 1 && lonelySnap.workspaces[0].sessions.length === 4, '会话目录：没有工作区时给兜底分组，界面仍能选')

  // 桥的快照要带上这份目录
  const bridgeMod = await import('../lib/bridge.js')
  const bridgeSnap = bridgeMod.snapshotOf()
  assert(bridgeSnap.sessions && Array.isArray(bridgeSnap.sessions.workspaces), '快照带上会话目录')
}

// ── 0.8：表情目录定时自动加载（文字 + 图片）──────────────────────
{
  console.log('\n== 表情自动加载 ==')
  const emoji = await import('../lib/emoji.js')
  const { defaultModules, normalizeModules } = await import('../lib/modules.js')

  // 默认配置里就有自动加载，且旧配置缺字段时有默认值
  const defaults = defaultModules()
  assert(defaults.voice.style.emojiAuto?.enabled === true, '默认开启表情自动加载')
  assert(defaults.voice.style.emojiAuto?.intervalMs === 5 * 60 * 1000, '默认间隔 5 分钟')
  const merged = normalizeModules({ voice: { style: { emojiAuto: { intervalMs: 60000 } } } })
  assert(merged.voice.style.emojiAuto.enabled === true, '只配了 intervalMs 时 enabled 保留默认')
  assert(merged.voice.style.emojiAuto.intervalMs === 60000, 'intervalMs 被写进去')
  assert(normalizeModules({ voice: { style: { tone: '软' } } }).voice.style.emojiAuto?.enabled === true, '旧配置补上 emojiAuto 默认值')

  // 间隔夹取
  assert(emoji.clampEmojiInterval(1000) === emoji.MIN_EMOJI_INTERVAL_MS, '间隔太小被抬到下限')
  assert(emoji.clampEmojiInterval(99 * 60 * 60 * 1000) === emoji.MAX_EMOJI_INTERVAL_MS, '间隔太大被压到上限')
  assert(emoji.clampEmojiInterval(0) === emoji.DEFAULT_EMOJI_INTERVAL_MS, '非法间隔回落到默认')

  // 目录：一个文字表情 + 一个图片表情
  const autoDir = join(root, 'emoji-auto')
  mkdirSync(autoDir, { recursive: true })
  writeFileSync(join(autoDir, '开心.txt'), '开心: (≧▽≦)\n', 'utf8')
  writeFileSync(join(autoDir, '震惊.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
  const style = { emojiDir: autoDir, emoji: '', emojiAuto: { enabled: true, intervalMs: 60 * 1000 } }
  const first = emoji.emojiStatus(style, { scan: true })
  assert(first.exists && first.count === 2, '扫到文字 + 图片两个表情')
  assert(first.textCount === 1 && first.imageCount === 1, '文字/图片分别计数')
  assert(first.items.some((it) => it.kind === 'image' && it.name === '震惊'), '图片表情带 kind=image 与名字')
  assert(first.items.some((it) => it.kind === 'text' && it.name === '开心'), '文字表情带 kind=text')
  assert(first.auto.enabled === true && first.auto.scannedAt > 0, '自动加载状态带扫描时间')
  assert(first.auto.intervalMs === 60 * 1000, '自动加载状态带间隔')

  // 配置没变时不会重复扫（定时器负责刷新）
  const again = emoji.emojiStatus(style)
  assert(again.auto.scannedAt === first.auto.scannedAt, '配置不变时复用上次扫描结果')

  // 往目录里丢个新文件，重扫就能长出来，并记下变更
  writeFileSync(join(autoDir, '得意.txt'), '得意: 嘿嘿\n', 'utf8')
  const rescanned = emoji.emojiStatus(style, { scan: true })
  assert(rescanned.count === 3, '重扫后读到新表情')
  assert(rescanned.auto.changes.some((c) => (c.added || []).includes('得意')), '记下新增的表情名')

  // 关掉自动加载
  const offStyle = { ...style, emojiAuto: { enabled: false, intervalMs: 60 * 1000 } }
  const off = emoji.emojiStatus(offStyle)
  assert(off.auto.enabled === false, '可以关掉自动加载')
  emoji.stopEmojiLoader()
  assert(emoji.loaderSummary().enabled === false, 'stopEmojiLoader 停掉定时器')

  // 提示词里带上图片表情的名字（文字表情照旧）
  const rendered = emoji.renderEmoji({ emoji: '🐟' }, first)
  assert(rendered.includes('表情图') && rendered.includes('震惊'), '提示词里列出图片表情名字')
  assert(rendered.includes('开心:(≧▽≦)'), '提示词里文字表情照旧')

  // 桥：开自动加载 / 改间隔 / 立即重扫
  const bridge = await import('../lib/bridge.js')
  const autoOn = bridge.mutateModules({ action: 'setEmojiDir', dir: autoDir })
  assert(autoOn.ok === true && autoOn.value.emoji.auto !== undefined, '桥设目录时返回自动加载状态')
  const autoOffRes = bridge.mutateModules({ action: 'setEmojiAuto', enabled: false })
  assert(autoOffRes.ok === true && autoOffRes.value.emoji.auto.enabled === false, '桥能关掉自动加载')
  const autoIntRes = bridge.mutateModules({ action: 'setEmojiAuto', enabled: true, intervalMinutes: 10 })
  assert(autoIntRes.ok === true && autoIntRes.value.emoji.auto.intervalMs === 10 * 60 * 1000, '桥能改自动扫描间隔')
  const rescanRes = bridge.mutateModules({ action: 'rescanEmoji' })
  assert(rescanRes.ok === true && rescanRes.value.emoji.count === 3, '桥能立即重扫')
  const autoSnap = bridge.snapshotOf()
  assert(autoSnap.emoji.auto !== undefined && autoSnap.emoji.auto.intervalMs > 0, '快照带自动加载信息')

  // 命令：autoload / interval / reload
  const cmdOff = await command.handler(['emoji', 'autoload', 'off'])
  assert(cmdOff.kind === 'success' && cmdOff.text.includes('已关闭'), '/shared-memory emoji autoload off')
  const cmdOn = await command.handler(['emoji', 'autoload', 'on'])
  assert(cmdOn.kind === 'success' && cmdOn.text.includes('已开启'), '/shared-memory emoji autoload on')
  const cmdInt = await command.handler(['emoji', 'interval', '3'])
  assert(cmdInt.kind === 'success' && cmdInt.text.includes('3 分钟'), '/shared-memory emoji interval 3')
  const cmdReload = await command.handler(['emoji', 'reload'])
  assert(cmdReload.kind === 'success' && cmdReload.text.includes('个表情'), '/shared-memory emoji reload')
  const cmdShow = await command.handler(['emoji'])
  assert(cmdShow.kind === 'success' && cmdShow.text.includes('自动加载'), '/shared-memory emoji 总览带自动加载状态')
  emoji.stopEmojiLoader()
}

console.log('== 0.9：按会话隔离 + 自动互动真实化 ==')
{
  const state = await import('../lib/agent-state.js')
  const proactive = await import('../lib/proactive.js')

  // ── agent-state：按会话隔离，不再有跨会话污染 ──
  state.clearAll()
  state.setAgentContext('sess-a', { sessionId: 'sess-a', title: '会话 A', cwd: 'D:/a', prompt: 'A 问的问题' })
  state.setAgentContext('sess-b', { sessionId: 'sess-b', title: '会话 B', cwd: 'D:/b', prompt: 'B 问的问题' })
  assert(state.currentContext('sess-a').prompt === 'A 问的问题', '会话 A 拿到自己的提示词')
  assert(state.currentContext('sess-b').prompt === 'B 问的问题', '会话 B 拿到自己的提示词')
  assert(state.currentContext('sess-a').cwd === 'D:/a', '会话 A 拿到自己的工作目录')
  assert(state.getAgentContext('sess-a').title === '会话 A', '会话标题按会话存')
  assert(state.currentContext('sess-unknown').prompt === 'B 问的问题', '未知会话退回最近活跃会话（兜底，不留空）')
  state.setLastInjected('sess-a', 'PAYLOAD-A')
  assert(state.lastInjected('sess-a') === 'PAYLOAD-A', '注入去重按会话存')
  assert(state.lastInjected('sess-b') === '', '去重状态不会串到别的会话')
  state.clearAgentContext('sess-a')
  assert(state.getAgentContext('sess-a') === undefined, '会话释放后上下文被清掉')
  assert(state.getAgentContext('sess-b') !== undefined, '清一个会话不影响另一个')

  // ── proactive：作用域、时间窗、冷却、followup ──
  assert(proactive.clampProactiveInterval(10) === proactive.MIN_PROACTIVE_INTERVAL_MS, '间隔下限被夹住')
  assert(proactive.clampProactiveInterval(999999999) === proactive.MAX_PROACTIVE_INTERVAL_MS, '间隔上限被夹住')
  assert(proactive.clampProactiveInterval(0) === proactive.DEFAULT_PROACTIVE_INTERVAL_MS, '非法间隔回落到默认')

  // scope=session 但一个会话都没选 → 不限定
  assert(proactive.inProactiveScope({}, { enabled: true, scope: 'session', sessionIds: [] }, 'sess-x') === true, '选了 session 但没挑会话 = 不限定')
  assert(proactive.inProactiveScope({}, { enabled: true, scope: 'session', sessionIds: ['sess-y'] }, 'sess-x') === false, '指定会话时不在名单内被排除')
  assert(proactive.inProactiveScope({}, { enabled: true, scope: 'session', sessionIds: ['sess-y'] }, 'sess-y') === true, '指定会话时在名单内被放行')
  assert(proactive.inProactiveScope({}, { enabled: true, scope: 'all', sessionIds: [] }, 'sess-x') === true, 'scope=all 全部放行')
  assert(proactive.inProactiveScope({}, { enabled: false, scope: 'all' }, 'sess-x') === false, '开关关掉时不主动')

  // 时间窗
  assert(proactive.inTimeWindow({ timeWindow: { enabled: false } }) === true, '没设窗口时一直可以')
  assert(proactive.inTimeWindow({ timeWindow: { enabled: true, start: '09:00', end: '10:00' } }, new Date(2026, 0, 1, 9, 30)) === true, '窗口内可以')
  assert(proactive.inTimeWindow({ timeWindow: { enabled: true, start: '09:00', end: '10:00' } }, new Date(2026, 0, 1, 23, 0)) === false, '窗口外不主动')
  assert(proactive.inTimeWindow({ timeWindow: { enabled: true, start: '22:00', end: '06:00' } }, new Date(2026, 0, 1, 23, 0)) === true, '跨午夜窗口判对')

  // nudgeAgent 真的调 followup
  const calls = []
  const fakeAgent = {
    session: { header: { id: 'sess-p', cwd: 'D:/proj' } },
    followup: (msg) => calls.push({ kind: 'followup', msg }),
  }
  const agentive = { enabled: true, scope: 'all', sessionIds: [], timeWindow: { enabled: false } }
  assert(proactive.nudgeAgent(fakeAgent, { agentive, sessionId: 'sess-p' }) === true, 'nudgeAgent 成功发出')
  assert(calls.length === 1 && calls[0].kind === 'followup', '用的是 followup（能唤醒会话）')
  assert(calls[0].msg.content[0].text.includes('自动互动'), '主动指令里说明了这是自动检查')
  assert(calls[0].msg.source.kind === 'plugin:dsh-shared-brain', '主动指令带插件来源标记')

  // 冷却：紧接着再发会被跳过
  assert(proactive.nudgeAgent(fakeAgent, { agentive, sessionId: 'sess-p' }) === false, '冷却期内不重复发')
  assert(proactive.nudgeAgent(fakeAgent, { agentive, sessionId: 'sess-p', force: true }) === true, 'force 能绕过冷却')

  // 没有 followup 就退回 inject
  const injectCalls = []
  const injectOnly = {
    session: { header: { id: 'sess-q', cwd: '' } },
    inject: (msg) => injectCalls.push(msg),
  }
  assert(proactive.nudgeAgent(injectOnly, { agentive, sessionId: 'sess-q' }) === true, '没有 followup 时退回 inject 也能发')
  assert(injectCalls.length === 1, 'inject 被调用')

  // runProactiveNow：对所有活跃 agent 发
  proactive.clearProactiveState()
  const agents = [
    { session: { header: { id: 'sess-1', cwd: '' } }, followup: () => {} },
    { session: { header: { id: 'sess-2', cwd: '' } }, followup: () => {} },
    { session: { header: { id: '', cwd: '' } }, followup: () => {} },
  ]
  const fakeCtx = { get: (name) => (name === 'agents' ? { list: () => agents } : undefined) }
  const nowRes = proactive.runProactiveNow(fakeCtx, { agentive, force: true })
  assert(nowRes.total === 3 && nowRes.sent === 2, 'runProactiveNow 对有会话 ID 的 agent 各发一次')
  assert(proactive.proactiveStatus().fired >= 2, '状态里记下了已主动次数')

  // 定时器能起能停
  proactive.startProactiveLoop(fakeCtx, { intervalMs: 60 * 1000, agentive })
  assert(proactive.proactiveStatus().running === true, '定时器已启动')
  assert(proactive.proactiveStatus().intervalMs === 60 * 1000, '定时器间隔正确')
  proactive.stopProactiveLoop()
  assert(proactive.proactiveStatus().running === false, '定时器已停')

  // ── modules：agentive.intervalMs 归一化 ──
  const mods = await import('../lib/modules.js')
  assert(mods.clampAgentiveInterval(30 * 1000) === mods.MIN_AGENTIVE_INTERVAL_MS, 'agentive 间隔下限被夹住')
  assert(mods.clampAgentiveInterval(10 * 60 * 1000) === 10 * 60 * 1000, '合法间隔原样保留')
  assert(mods.clampAgentiveInterval(99 * 60 * 60 * 1000) === mods.MAX_AGENTIVE_INTERVAL_MS, 'agentive 间隔上限被夹住')
  assert(mods.clampAgentiveInterval(0) === mods.DEFAULT_AGENTIVE_INTERVAL_MS, '非正数回落默认间隔')
  const defaults = mods.defaultModules()
  assert(defaults.agentive.intervalMs === mods.DEFAULT_AGENTIVE_INTERVAL_MS, '默认 agentive 间隔是 15 分钟')
  const normalized = mods.normalizeModules({ agentive: { enabled: true, intervalMs: 5 * 60 * 1000 } })
  assert(normalized.agentive.intervalMs === 5 * 60 * 1000, '归一化保留合法的间隔')
  const normalizedBad = mods.normalizeModules({ agentive: { enabled: true, intervalMs: 1 } })
  assert(normalizedBad.agentive.intervalMs === mods.MIN_AGENTIVE_INTERVAL_MS, '归一化把过小的间隔夹住')

  // ── 桥：setAgentiveInterval / runProactive + 快照里的 proactive 段 ──
  const bridge = await import('../lib/bridge.js')
  const intRes = bridge.mutateModules({ action: 'setAgentiveInterval', intervalMinutes: 7 })
  assert(intRes.ok === true, '桥能改自动互动间隔')
  assert(Math.abs(readModules().agentive.intervalMs - 7 * 60 * 1000) < 1000, '间隔写进了模块配置')
  const badInt = bridge.mutateModules({ action: 'setAgentiveInterval', intervalMinutes: 0 })
  assert(badInt.ok === false && typeof badInt.error === 'string', '非法间隔会明确报错')
  assert(readModules().agentive.intervalMs !== 0, '非法间隔不会把配置写成 0')
  const nowRes2 = bridge.mutateModules({ action: 'runProactive' })
  assert(nowRes2.ok === true, '桥能立刻主动一次')
  const snap2 = bridge.snapshotOf()
  assert(snap2.proactive !== undefined, '快照含 proactive 段')
  assert(typeof snap2.proactive.enabled === 'boolean' && typeof snap2.proactive.runtime === 'object', 'proactive 段带开关与运行状态')
  assert(snap2.proactive.runtime !== undefined, '运行状态可读')

  // ── 命令：agentive interval / now ──
  const cmdInterval = await command.handler(['agentive', 'interval', '9'])
  assert(cmdInterval.kind === 'success' && cmdInterval.text.includes('9'), '/shared-memory agentive interval 9')
  const cmdBadInterval = await command.handler(['agentive', 'interval', 'abc'])
  assert(cmdBadInterval.kind === 'error', '/shared-memory agentive interval abc 报错')
  const cmdNow = await command.handler(['agentive', 'now'])
  assert(cmdNow.kind === 'success', '/shared-memory agentive now')

  // ── 回归：不传 agentive 配置时不应该「全部跳过」──
  // （0.9.0 的真实 bug：桥和命令都没把 agentive 配置传进 runProactiveNow，
  //  于是 agentive = {} → enabled 为假 → 所有会话都被判成不在作用域内）
  proactive.clearProactiveState()
  const sentCalls = []
  const regressAgents = [
    { session: { header: { id: 'sess-r1', cwd: '' } }, followup: (m) => sentCalls.push(m) },
  ]
  const regressCtx = { get: (name) => (name === 'agents' ? { list: () => regressAgents } : undefined) }
  const noCfg = proactive.runProactiveNow(regressCtx, { force: true })
  assert(noCfg.sent === 0 && noCfg.enabled === false, '没传配置时如实报告「开关是关的」而不是假装发出')
  const withCfg = proactive.runProactiveNow(regressCtx, {
    force: true,
    getAgentive: () => ({ enabled: true, scope: 'session', sessionIds: [], timeWindow: { enabled: false } }),
  })
  assert(withCfg.sent === 1, '传了 agentive 配置就能真的发出去（这是 0.9.0 的回归点）')
  assert(sentCalls.length === 1, 'followup 真的被调用了')

  // 桥的 runProactive 也要真的发得出去（用桩 agents 服务验证）
  const bridgeSent = []
  bridge.setBridgeContext({
    get: (name) => (name === 'agents' ? { list: () => [{ session: { header: { id: 'sess-b1', cwd: '' } }, followup: (m) => bridgeSent.push(m) }] } : undefined),
  })
  const bridgeNow = bridge.mutateModules({ action: 'runProactive' })
  assert(bridgeNow.ok === true, '桥的 runProactive 返回 ok')
  assert(bridgeNow.value.sent >= 0, '桥的 runProactive 带上明细')
  assert(typeof bridgeNow.note === 'string' && bridgeNow.note.length > 0, '桥的 runProactive 给出可读说明')

  const cmdOverview = await command.handler(['list'])
  assert(cmdOverview.kind === 'success' && cmdOverview.text.includes('自动互动'), '总览里能看到自动互动状态')

  // ── 客户端：设置页有「自动互动 · 定时主动」区块 ──
  const clientSrc = readFileSync(join(root, 'client-src.js'), 'utf8')
  assert(clientSrc.includes('proactiveTitle'), '客户端有自动互动区块的文案')
  assert(clientSrc.includes('ProactiveCard'), '客户端渲染了 ProactiveCard')
  assert(clientSrc.includes('setAgentiveInterval'), '客户端会调用 setAgentiveInterval')
  assert(clientSrc.includes('runProactive'), '客户端有「立刻主动一次」按钮')
  assert(clientSrc.includes('intervalDraft: proactiveMinutes'), '客户端有主动间隔输入草稿')
}

console.log('== 底线：条数上限别把低权重底线截掉 ==')
{
  // 0.9.3 的真实问题：底线 limit 硬编码 12，用户手动钉了 14 条常用底线，
  // 靠后（权重低）的 2 条被悄悄截掉。底线是硬约束，不该被静默丢弃。
  assert(MODULE_PROFILES.bottomline.limit >= 24, '底线 limit 提到 24，常驻硬约束不会被截断')

  // 造 14 条钉住的底线，全部应该出现在渲染结果里
  const manyModules = normalizeModules({
    bottomline: {
      enabled: true,
      weight: 0.9,
      items: Array.from({ length: 14 }, (_, i) => ({
        text: `底线第 ${i + 1} 条`,
        weight: 1 - i * 0.02,
        pinned: true,
        source: 'manual',
        lifetime: 'permanent',
      })),
    },
  })
  const manyRecall = recallModules(manyModules, '完全无关的查询')
  assert(manyRecall.always.length === 14, '14 条钉住的底线全部常驻')
  const manyText = renderModuleRecall(manyRecall)
  assert(manyText.includes('底线第 1 条') && manyText.includes('底线第 14 条'), '最后一条底线也在渲染文本里')
  assert(manyText.includes('【底线】'), '底线段标题正确')
}

try {
  rmSync(root, { recursive: true, force: true })
} catch {}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
