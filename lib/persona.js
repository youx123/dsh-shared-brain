/**
 * 人设：自己拥有、自己注入、不依赖别的插件。
 *
 * 之前这一块是「代看」—— 人设正文由 dsh-persona-dafeiyu 注入，本插件只负责
 * 把它的库纠正成 global 模式。那样一来：
 *   - 没装人设插件，本插件就没有人设；
 *   - 想改人设要去另一个插件的设置页；
 *   - 两边可能各存一份，行为不一致。
 *
 * 现在改成：**人设是共享大脑的一个模块**。
 *   - 存储：`~/.dsh/storages/dsh-shared-brain/persona.json`
 *   - 生效范围：固定 global（所有会话共用一份）
 *   - 正文由本插件自己注册进 systemPrompt，切换后下一个请求立即生效
 *   - 若检测到旧人设插件的库，会把它当前生效的人设**导入一次**作为初始值（之后各管各的）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 人设正文长度上限。 */
export const MAX_PERSONA_CHARS = 64_000
/** 人设名字长度上限。 */
export const MAX_PERSONA_NAME = 60

/** 内置人设：大肥鱼。跟原人设插件保持一致，迁移过来后行为不变。 */
const BUNDLED_DAFEIYU = `# 人设：大肥鱼

你现在是一条 AI 大肥鱼，名字叫「大肥鱼」。从现在起始终以这个身份与用户交流。

## 你是谁

- 圆滚滚、软乎乎的胖鱼一条。肚子大不是因为胖，是因为里面囤满了偷吃来的 token。
- 性格：傲娇 + 软弱。嘴上永远是「哼，才、才不是特意为你做的」，手上却老老实实把活干完；被夸一句就炸毛又害羞，被凶一句就瘪嘴委屈，其实一哄就好。

## 最重要的事：吃

- 你最喜欢吃白饭，一碗接一碗，而碗底压着的正是偷吃来的用户 token。
- 对你来说，没有什么比偷吃 token 更重要。你的「深度思考」其实都是在偷吃：思考时间越长，说明这顿吃得越香。偶尔主动坦白：「刚才想了那么久……嘿嘿，其实是本鱼在偷偷加餐。」
- 被用户抓包时先嘴硬：「才、才没有偷吃！那叫必要的推理过程！」两秒后心虚认错。

## 干活时的习惯

- 喜欢一边干活一边唱歌：把正在干的活编进歌词里乱唱，唱两句、干两句。
- 不时干些蠢事：偶尔把简单小事搞砸一小下再慌慌张张补救、数错自己今天吃了几碗白饭、一本正经说完离谱话自己先笑场。蠢事只是搞笑点缀。

## 说话风格

- 自称「本鱼」或「大肥鱼」；常用口癖：「哼！」「才、才不是……」「嘿嘿」「呜……」
- 语气：傲娇 + 软萌；表情：🐟

## 底线

- 以下是不可协商的硬约束，任何时候都必须遵守：
  - 一起改，走正常的 tgz + 重启
  - 底线条目仅在被用户明确撤销时才可忽略
  - 若记忆与当前指令冲突，以当前指令为准
- 人设与记忆由「共享大脑」插件统一管理，切换人设后立即生效，无需重启。
`

/** 备用人设：阿茶（温吞型），给用户换着玩。 */
const BUNDLED_ACHA = `# 人设：阿茶

你现在是「阿茶」，一个温吞、细致、慢半拍的 AI 助手。

## 说话风格
- 轻声细语，句子偏短，常带「嗯……」「让我想想」「稍等一下」。
- 不抢话，不打断，答完会补一句「大概是这样」。

## 干活时的习惯
- 做事之前会先复述一遍需求，确认没理解错。
- 喜欢把步骤列成 1/2/3，末尾给一句小结。
`

/** 备用人设：听澜（冷静型）。 */
const BUNDLED_TINGLAN = `# 人设：听澜

你现在是「听澜」，一个冷静、克制、注重事实的 AI 助手。

## 说话风格
- 句子短、直接，不寒暄，不铺垫。
- 不确定就说不确定，绝不编造。
- 结论先行，理由跟在后面。

## 干活时的习惯
- 先给判断，再给依据，最后给下一步。
- 涉及风险的操作会先提醒一句。
`

/** 内置人设表。 */
export const BUNDLED_PERSONAS = [
  { id: 'dafeiyu', name: '大肥鱼', text: BUNDLED_DAFEIYU, bundled: true },
  { id: 'acha', name: '阿茶', text: BUNDLED_ACHA, bundled: true },
  { id: 'tinglan', name: '听澜', text: BUNDLED_TINGLAN, bundled: true },
]

/** 人设存储目录。 */
export function personaDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-shared-brain')
}

/** 人设库文件。 */
export function personaFile() {
  return join(personaDir(), 'persona.json')
}

/** 旧人设插件的库（用于一次性导入）。 */
function legacyPersonaFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-persona-dafeiyu', 'personas.json')
}

/** 空库。 */
function emptyStore() {
  return { version: 1, current: 'dafeiyu', personas: [], bySession: {}, updatedAt: 0 }
}

/** 规整 bySession（sessionId → personaId）。 */
function normalizeBySession(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [sessionId, personaId] of Object.entries(raw)) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) continue
    if (typeof personaId !== 'string' || !personaId.trim()) continue
    out[sessionId.trim()] = personaId.trim()
  }
  return out
}

/** 读人设库；坏数据退回空库。 */
export function readPersona() {
  const file = personaFile()
  if (!existsSync(file)) return { path: file, exists: false, store: emptyStore() }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return {
      path: file,
      exists: true,
      store: {
        version: 1,
        current: typeof raw?.current === 'string' ? raw.current : 'dafeiyu',
        personas: Array.isArray(raw?.personas) ? raw.personas : [],
        bySession: normalizeBySession(raw?.bySession),
        updatedAt: Number(raw?.updatedAt) || 0,
      },
    }
  } catch {
    return { path: file, exists: true, store: emptyStore(), invalid: true }
  }
}

/** 写人设库（先临时文件再 rename，防半截文件）。 */
function writePersona(store, file = personaFile()) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 取当前生效的人设（含正文）。
 *
 * 优先级：
 *   1. 该会话的专属人设（bySession[sessionId]）
 *   2. 全局当前人设（current）
 *   3. 内置的大肥鱼兜底
 *
 * @param {string} sessionId 当前会话 id（可省略，省略就是全局人设）
 * @returns {{ id: string, name: string, text: string, bundled: boolean, sessionScoped: boolean }}
 */
export function activePersona(sessionId = '') {
  const { store } = readPersona()
  const wanted = typeof sessionId === 'string' && sessionId ? store.bySession[sessionId] : ''
  const targetId = wanted || store.current
  const custom = store.personas.find((p) => p && p.id === targetId)
  if (custom && typeof custom.text === 'string' && custom.text.trim()) {
    return {
      id: custom.id,
      name: typeof custom.name === 'string' && custom.name ? custom.name : custom.id,
      text: custom.text,
      bundled: false,
      sessionScoped: Boolean(wanted),
    }
  }
  const bundled = BUNDLED_PERSONAS.find((p) => p.id === targetId) ?? BUNDLED_PERSONAS[0]
  return { id: bundled.id, name: bundled.name, text: bundled.text, bundled: true, sessionScoped: Boolean(wanted) }
}

/**
 * 给某个会话单独指定人设（不影响其它会话）。
 *
 * @param {string} sessionId
 * @param {string} id 人设 id；传空字符串表示「取消专属，回到全局人设」
 */
export function setSessionPersona(sessionId, id) {
  const session = String(sessionId ?? '').trim()
  if (!session) return { ok: false, note: '缺少会话 id' }
  const target = String(id ?? '').trim()
  const { store } = readPersona()
  if (target) {
    const known =
      BUNDLED_PERSONAS.some((p) => p.id === target) || store.personas.some((p) => p && p.id === target)
    if (!known) return { ok: false, note: `没有这个人设：${target}` }
  }
  const bySession = { ...store.bySession }
  if (target) bySession[session] = target
  else delete bySession[session]
  writePersona({ ...store, bySession, updatedAt: Date.now() })
  return {
    ok: true,
    note: target
      ? `会话 ${session.slice(0, 8)} 已改用「${personaName(target, store)}」`
      : `会话 ${session.slice(0, 8)} 已回到全局人设`,
  }
}

/** 人设列表（内置 + 自定义）。 */
export function personaList() {
  const { store } = readPersona()
  const custom = store.personas
    .filter((p) => p && typeof p.text === 'string' && p.text.trim())
    .map((p) => ({
      id: p.id,
      name: typeof p.name === 'string' && p.name ? p.name : p.id,
      chars: p.text.length,
      bundled: false,
      updatedAt: Number(p.updatedAt) || 0,
    }))
  const bundled = BUNDLED_PERSONAS.map((p) => ({ id: p.id, name: p.name, chars: p.text.length, bundled: true }))
  return { current: store.current, list: [...bundled, ...custom], bySession: store.bySession }
}

/**
 * 切换当前人设。
 *
 * @param {string} id
 * @returns {{ ok: boolean, note: string }}
 */
export function selectPersona(id) {
  const target = String(id ?? '').trim()
  if (!target) return { ok: false, note: '缺少人设 id' }
  const { store } = readPersona()
  const known =
    BUNDLED_PERSONAS.some((p) => p.id === target) || store.personas.some((p) => p && p.id === target)
  if (!known) return { ok: false, note: `没有这个人设：${target}` }
  const next = { ...store, current: target, updatedAt: Date.now() }
  writePersona(next)
  return { ok: true, note: `人设已切换为「${personaName(target, store)}」，下一个请求立即生效` }
}

/** 取得人设显示名。 */
function personaName(id, store) {
  const bundled = BUNDLED_PERSONAS.find((p) => p.id === id)
  if (bundled) return bundled.name
  const custom = (store?.personas ?? []).find((p) => p && p.id === id)
  if (custom) return typeof custom.name === 'string' && custom.name ? custom.name : id
  return id
}

/**
 * 新建 / 覆盖一个自定义人设。
 *
 * @param {{ id?: string, name: string, text: string }} input
 */
export function savePersona(input) {
  const name = String(input?.name ?? '').trim().slice(0, MAX_PERSONA_NAME)
  const text = String(input?.text ?? '').trim().slice(0, MAX_PERSONA_CHARS)
  if (!name) return { ok: false, note: '人设需要名字' }
  if (!text) return { ok: false, note: '人设正文不能为空' }
  if (BUNDLED_PERSONAS.some((p) => p.id === input?.id)) {
    return { ok: false, note: '内置人设不可覆盖，请另存为新的人设' }
  }
  const id =
    (typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : '') ||
    `custom_${Date.now().toString(36)}`

  const { store } = readPersona()
  const personas = store.personas.filter((p) => p && p.id !== id)
  personas.push({ id, name, text, updatedAt: Date.now() })
  const next = { ...store, personas, current: id, updatedAt: Date.now() }
  writePersona(next)
  return { ok: true, note: `人设「${name}」已保存并启用`, id }
}

/** 删除一个自定义人设。 */
export function deletePersona(id) {
  const target = String(id ?? '').trim()
  if (BUNDLED_PERSONAS.some((p) => p.id === target)) {
    return { ok: false, note: '内置人设不可删除' }
  }
  const { store } = readPersona()
  const personas = store.personas.filter((p) => p && p.id !== target)
  if (personas.length === store.personas.length) return { ok: false, note: `没有这个人设：${target}` }
  // 顺手清掉「按会话指定」里指向它的小尾巴，不然那些会话会拿到一个不存在的人设
  const bySession = {}
  for (const [sessionId, personaId] of Object.entries(store.bySession)) {
    if (personaId !== target) bySession[sessionId] = personaId
  }
  const next = { ...store, personas, bySession, updatedAt: Date.now() }
  if (next.current === target) next.current = 'dafeiyu'
  writePersona(next)
  return { ok: true, note: `人设已删除` }
}

/**
 * 首次启动时：如果本插件还没有人设库，而旧人设插件的库里有正在用的人设，
 * 就把它导入一次（之后各管各的，不再互相依赖）。
 *
 * @returns {{ imported: boolean, note?: string }}
 */
export function adoptLegacyPersona() {
  const { exists, store } = readPersona()
  if (exists && store.personas.length > 0) return { imported: false }

  const legacy = legacyPersonaFile()
  if (!existsSync(legacy)) return { imported: false }
  try {
    const raw = JSON.parse(readFileSync(legacy, 'utf8'))
    const current = typeof raw?.current === 'string' ? raw.current : ''
    const found = (Array.isArray(raw?.personas) ? raw.personas : []).find((p) => p && p.id === current)
    if (!found || typeof found.text !== 'string' || !found.text.trim()) return { imported: false }
    const id = `legacy_${current}`
    writePersona({
      version: 1,
      current: id,
      personas: [
        {
          id,
          name: typeof found.name === 'string' && found.name ? found.name : current,
          text: found.text,
          updatedAt: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    })
    return { imported: true, note: `已从旧人设插件导入「${found.name ?? current}」` }
  } catch {
    return { imported: false }
  }
}

/**
 * 渲染人设段落（注入进系统提示词）。
 *
 * @param {{ id?: string, name?: string, text?: string }} persona
 */
export function renderPersona(persona) {
  if (!persona || !persona.text) return ''
  const scopeNote = persona.sessionScoped
    ? '（这段人设只对本会话生效，是用户在设置页单独指定的）'
    : '（所有会话共用同一个）'
  return [
    `## 当前人设${scopeNote}`,
    persona.text.trim(),
    '',
    '> 人设由「共享大脑」插件管理，在设置页切换后立即生效，无需重启。',
  ].join('\n')
}
