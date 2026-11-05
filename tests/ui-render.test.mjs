/**
 * 设置页 UI 渲染冒烟测试（2026-11-03 新增）
 *
 * 为什么需要它：client.js 里的卡片组件曾有几处「引用了不存在的变量」
 * （semanticOn / emoji / t）—— node --check 只查语法、harness 的 JSX 静态检查
 * 只查 props 写法，都抓不到，只有真的把组件函数跑一遍才会抛 ReferenceError。
 * 这个文件用一个极简 React 假实现把组件渲染成文本，任何 [渲染出错:...] 都算失败。
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, "..", "lib")

let passed = 0
let failed = 0
const fails = []
function test(name, fn) {
  try {
    fn()
    passed++
    console.log("  ✓", name)
  } catch (error) {
    failed++
    fails.push(`${name}: ${error && error.message ? error.message : error}`)
    console.log("  ✗", name, "—", error && error.message ? error.message : error)
  }
}
function group(name) {
  console.log(`\n${name}`)
}
function ok(value, label = "") {
  if (!value) throw new Error(`${label} 期望为真，实际 ${JSON.stringify(value)}`)
}

// ---------- 极简 React：只够把组件函数真的跑起来 ----------
const FRAGMENT = Symbol("Fragment")
const react = {
  Fragment: FRAGMENT,
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useReducer: (fn, init) => [init, () => {}],
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value === undefined ? null : value }),
  useContext: () => ({}),
  useImperativeHandle: () => {},
  memo: (component) => component,
  forwardRef: (component) => component,
  createContext: () => ({ Provider: FRAGMENT, Consumer: FRAGMENT }),
  Children: { map: (c, f) => (Array.isArray(c) ? c.map(f) : c == null ? [] : [f(c)]) },
  isValidElement: (node) => Boolean(node && typeof node === "object" && "type" in node),
  cloneElement: (node, props) => ({ ...node, props: { ...node.props, ...(props || {}) } }),
}
const jsxRuntime = {
  jsx: (type, props, key) => ({ type, props: props || {}, key }),
  jsxs: (type, props, key) => ({ type, props: props || {}, key }),
  Fragment: FRAGMENT,
}

function loadClient() {
  const source = readFileSync(join(LIB, "client.js"), "utf8")
  const marker = "return module.exports;"
  if (!source.includes(marker)) throw new Error("client.js 里找不到 return module.exports")
  // 只改内存里的源码，把内部卡片组件暴露出来（不落盘）
  const patched = source.replace(
    marker,
    "exports.__cards = {"
      + " emojiCard: typeof EmojiCard === \"function\" ? EmojiCard : null,"
      + " proactiveCard: typeof ProactiveCard === \"function\" ? ProactiveCard : null,"
      + " moodCard: typeof MoodCard === \"function\" ? MoodCard : null,"
      + " remoteSyncCard: typeof RemoteSyncCard === \"function\" ? RemoteSyncCard : null,"
      + " personaCard: typeof PersonaCard === \"function\" ? PersonaCard : null,"
      + " capabilityCard: typeof CapabilityCard === \"function\" ? CapabilityCard : null,"
      + " memoryGraphCard: typeof MemoryGraphCard === \"function\" ? MemoryGraphCard : null,"
      + " brainPanel: typeof BrainPanel === \"function\" ? BrainPanel : null"
      + " }; " + marker,
  )
  let exported = null
  const fakeWindow = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        exported = factory((name) => (name === "react" ? react : jsxRuntime))
      },
    },
  }
  new Function("window", patched)(fakeWindow)
  if (!exported) throw new Error("client.js 没有导出模块")
  ok(exported.__cards, "内部组件暴露失败")
  return exported.__cards
}

function renderText(node, depth = 0) {
  if (node === null || node === undefined || node === false || node === true) return ""
  if (depth > 80) return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map((item) => renderText(item, depth + 1)).join(" ")
  if (typeof node === "function") return renderText(node({}), depth + 1)
  const { type, props } = node
  if (type === FRAGMENT) return renderText(props && props.children, depth + 1)
  if (typeof type === "function") {
    try {
      return renderText(type(props), depth + 1)
    } catch (error) {
      return `[渲染出错:${error && error.message ? error.message : error}]`
    }
  }
  if (typeof type === "string") return renderText(props && props.children, depth + 1)
  return ""
}

function collectInputValues(node, depth = 0, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (depth > 80) return out
  if (typeof node === "string" || typeof node === "number") return out
  if (Array.isArray(node)) {
    for (const item of node) collectInputValues(item, depth + 1, out)
    return out
  }
  if (typeof node === "function") return collectInputValues(node({}), depth + 1, out)
  const { type, props } = node
  if (type === FRAGMENT) return collectInputValues(props && props.children, depth + 1, out)
  if (typeof type === "function") {
    try {
      return collectInputValues(type(props), depth + 1, out)
    } catch {
      return out
    }
  }
  if (typeof type === "string") {
    if ((type === "input" || type === "textarea" || type === "select") && props && props.value !== undefined) {
      out.push(String(props.value))
    }
    return collectInputValues(props && props.children, depth + 1, out)
  }
  return out
}

const t = (key) => String(key)
const cards = loadClient()

function noRenderError(text) {
  const hit = text.match(/\[渲染出错:[^\]]*\]/)
  if (hit) throw new Error("渲染抛错：" + hit[0])
}

const emojiStatus = {
  dir: "C:/fake/emoji",
  exists: true,
  count: 2,
  textCount: 1,
  imageCount: 1,
  items: [{ name: "开心", value: ":)", kind: "text" }],
  auto: { enabled: true, intervalMs: 300000, scannedAt: Date.now(), changes: [] },
  packsDir: "C:/Users/x/.dsh/emoji-packs",
  packs: [{ id: "dafeiyu", name: "大肥鱼", version: "1.0.0", keys: ["happy", "sad"] }],
  builtin: {
    dir: "C:/fake/assets/emoji",
    exists: true,
    count: 100,
    bytes: 3586546,
    mapped: 40,
    missing: [],
    pack: { id: "dafeiyu", name: "大肥鱼表情包", version: "1.0.0", license: "CC BY-NC-SA 4.0", source: "https://github.com/diwer/ai-biaoqingbao" },
  },
}

group("表情卡片：语义表情 + 表情包（阶段 B）")
test("EmojiCard 渲染不抛错", () => {
  const text = renderText(cards.emojiCard({ t, busy: false, emoji: emojiStatus, semantic: { enabled: true, mode: "auto" } }))
  noRenderError(text)
})
test("EmojiCard 有开关与三档", () => {
  const text = renderText(cards.emojiCard({ t, busy: false, emoji: emojiStatus, semantic: { enabled: true, mode: "auto" } }))
  for (const key of ["emojiSemantic", "emojiSemanticOff", "emojiSemanticAuto", "emojiSemanticFrequent", "emojiSemanticHint"]) {
    ok(text.includes(key), `缺少 ${key}`)
  }
})
test("EmojiCard 列出表情包与包目录", () => {
  const text = renderText(cards.emojiCard({ t, busy: false, emoji: emojiStatus, semantic: { enabled: true, mode: "auto" } }))
  noRenderError(text)
  ok(text.includes("大肥鱼 1.0.0"), "没渲染出包名版本")
  ok(text.includes("C:/Users/x/.dsh/emoji-packs"), "没渲染出包目录")
})
test("EmojiCard 没装包时给提示而不是空白", () => {
  const text = renderText(cards.emojiCard({ t, busy: false, emoji: { ...emojiStatus, packs: [] }, semantic: { enabled: false, mode: "off" } }))
  noRenderError(text)
  ok(text.includes("emojiPacksNone"), "缺 emojiPacksNone 提示")
})
test("EmojiCard 缺 semantic 参数时用默认值不崩", () => {
  const text = renderText(cards.emojiCard({ t, busy: false, emoji: emojiStatus }))
  noRenderError(text)
  ok(text.includes("emojiSemantic"), "缺 semantic 时没渲染开关")
})

group("表情卡片：内置包与外部包（0.9.8）")
test("EmojiCard 显示内置包概况", () => {
  const text = renderText(cards.emojiCard({ t, busy: false, emoji: emojiStatus, semantic: { enabled: true, mode: "auto" } }))
  noRenderError(text)
  ok(text.includes("emojiBuiltin"), "缺内置包那行")
  ok(text.includes("100"), "没显示张数")
  ok(text.includes("40"), "没显示语义 key 数量")
})
test("没装外部包时只给「不用装」，不甩包目录", () => {
  const text = renderText(cards.emojiCard({ t, busy: false, emoji: { ...emojiStatus, packs: [] }, semantic: { enabled: true, mode: "auto" } }))
  noRenderError(text)
  ok(text.includes("emojiPacksNone"), "缺「没有」提示")
  ok(!text.includes("emojiPacksDir"), "没装包却显示了外部包目录")
})
test("真装了外部包才显示包目录", () => {
  const text = renderText(cards.emojiCard({ t, busy: false, emoji: emojiStatus, semantic: { enabled: true, mode: "auto" } }))
  ok(text.includes("emojiPacksDir"), "装了包却没显示包目录")
})

group("自动互动卡片：心情驱动（0.9.7 新增）")
test("ProactiveCard 渲染不抛错", () => {
  const text = renderText(cards.proactiveCard({
    t,
    busy: false,
    proactive: { enabled: true, intervalMs: 960000, runtime: {}, mood: {} },
    draft: {},
    moodDriveDraft: {},
  }))
  noRenderError(text)
})
test("ProactiveCard 有心情驱动全部字段", () => {
  const text = renderText(cards.proactiveCard({
    t,
    busy: false,
    proactive: {
      enabled: true,
      intervalMs: 960000,
      runtime: { jitter: 0.5 },
      mood: { enabled: true, lowMood: 45, highMood: 78, maxPerDay: 3, quietPeriodMs: 1800000, allowConcern: true, allowShare: true },
    },
    draft: {},
    moodDriveDraft: {},
  }))
  noRenderError(text)
  for (const key of ["moodDriveTitle", "moodDriveLow", "moodDriveHigh", "moodDriveMaxPerDay", "moodDriveQuiet", "moodDriveConcern", "moodDriveShare"]) {
    ok(text.includes(key), `缺少 ${key}`)
  }
})

group("情感卡片：维度 / 理由 / 轨迹（P1-12）")
test("MoodCard 渲染不抛错（空数据）", () => {
  const text = renderText(cards.moodCard({ t, busy: false, emotion: { config: {}, sessions: [], total: 0 }, onRun: () => {} }))
  noRenderError(text)
})
test("MoodCard 显示维度 / 理由 / 轨迹", () => {
  const text = renderText(cards.moodCard({
    t,
    busy: false,
    emotion: {
      config: { enabled: true, moodBase: 70, decayHalfHours: 12, injectMode: "event" },
      total: 1,
      sessions: [{
        sessionId: "session-abc",
        mood: 33,
        band: "heartache",
        dims: { heartache: 55, worry: 30, happy: 4 },
        reason: "老大说最近很累",
        confidence: 82,
        minor: false,
        judgements: 1,
        revision: 9,
        timeline: [{ at: 1762000000000, mood: 33, delta: -4, reason: "累了" }],
      }],
    },
    onRun: () => {},
  }))
  noRenderError(text)
  ok(text.includes("moodDims"), "缺维度标签")
  ok(text.includes("心疼 55"), "维度没渲染出心疼 55")
  ok(text.includes("moodReason"), "缺理由标签")
  ok(text.includes("82%"), "可信度没渲染")
  ok(text.includes("moodTimeline"), "缺轨迹标签")
  ok(text.includes("33(-4)"), "轨迹没渲染")
})
test("MoodCard 维度都很低时不硬凑（阈值 20）", () => {
  const text = renderText(cards.moodCard({
    t,
    busy: false,
    emotion: {
      config: {},
      total: 1,
      sessions: [{ sessionId: "s", mood: 70, band: "happy", dims: { happy: 7, calm: 6 }, reason: "", confidence: 0, timeline: [] }],
    },
    onRun: () => {},
  }))
  noRenderError(text)
  ok(!text.includes("moodDims"), "维度都低于阈值时不该显示")
})

group("跨机同步卡片（0.9.9 新增）")

const syncStatus = {
  enabled: true,
  repo: "youx/brain-data",
  branch: "main",
  intervalMs: 600000,
  hasToken: true,
  deviceId: "host-ab12cd",
  lastSyncAt: Date.now() - 60_000,
  trackedEntries: 18,
  tombstones: 2,
  lastError: "",
  runtime: { running: true, busy: false, runs: 3, lastSummary: ["合并后 18 条", "新增 2"] },
}

test("RemoteSyncCard 渲染不抛错", () => {
  const text = renderText(cards.remoteSyncCard({ t, busy: false, remoteSync: syncStatus, draft: {} }))
  noRenderError(text)
})

test("RemoteSyncCard 有仓库 / 令牌 / 分支 / 间隔四组输入", () => {
  const text = renderText(cards.remoteSyncCard({ t, busy: false, remoteSync: syncStatus, draft: {} }))
  ok(text.includes("remoteSyncRepo"), "缺仓库")
  ok(text.includes("remoteSyncToken"), "缺令牌")
  ok(text.includes("remoteSyncBranch"), "缺分支")
  ok(text.includes("remoteSyncInterval"), "缺间隔")
  const values = collectInputValues(cards.remoteSyncCard({ t, busy: false, remoteSync: syncStatus, draft: {} }))
  ok(values.includes("youx/brain-data"), "没回填仓库名")
  ok(values.includes("main"), "没回填分支")
  ok(values.includes("10"), "间隔没按分钟换算（600000ms 应为 10）")
})

test("RemoteSyncCard 的保存 / 立即同步按钮有文案（空白按钮会点不到）", () => {
  const zh = { remoteSyncSave: "保存并同步", remoteSyncNow: "立即同步", remoteSyncOn: "已开启", remoteSyncOff: "已关闭" }
  const tZh = (key) => (zh[key] !== undefined ? zh[key] : key)
  const text = renderText(cards.remoteSyncCard({ t: tZh, busy: false, remoteSync: syncStatus, draft: {} }))
  noRenderError(text)
  ok(text.includes("保存并同步"), "保存按钮没有文案")
  ok(text.includes("立即同步"), "立即同步按钮没有文案")
  ok(text.includes("已开启"), "开关按钮没有文案")
})

test("RemoteSyncCard 显示上次同步与条目数", () => {
  const text = renderText(cards.remoteSyncCard({ t, busy: false, remoteSync: syncStatus, draft: {} }))
  ok(text.includes("remoteSyncStatus"), "缺上次同步")
  ok(text.includes("18"), "没显示跟踪条数")
  ok(text.includes("2"), "没显示删除记录数")
  ok(text.includes("host-ab12cd"), "没显示本机编号")
})

test("RemoteSyncCard 没同步过时说「还没同步过」，不显示 1970", () => {
  const text = renderText(cards.remoteSyncCard({ t, busy: false, remoteSync: { ...syncStatus, lastSyncAt: 0 }, draft: {} }))
  noRenderError(text)
  ok(text.includes("remoteSyncNever"), "缺「还没同步过」")
  ok(!text.includes("1970"), "把 0 当时间渲染成了 1970")
})

test("RemoteSyncCard 有错误就把错误显示出来", () => {
  const text = renderText(cards.remoteSyncCard({ t, busy: false, remoteSync: { ...syncStatus, lastError: "仓库不存在或没权限" }, draft: {} }))
  ok(text.includes("仓库不存在或没权限"), "错误没显示")
})

test("RemoteSyncCard 编辑中的草稿优先于已保存值", () => {
  const values = collectInputValues(cards.remoteSyncCard({ t, busy: false, remoteSync: syncStatus, draft: { repo: "new/one", minutes: "15" } }))
  ok(values.includes("new/one"), "草稿仓库没生效")
  ok(values.includes("15"), "草稿间隔没生效")
  ok(!values.includes("youx/brain-data"), "草稿没盖掉已保存值")
})

group("整体")
test("client.js 内部组件都还在", () => {
  ok(cards.emojiCard, "EmojiCard 不见了")
  ok(cards.proactiveCard, "ProactiveCard 不见了")
  ok(cards.moodCard, "MoodCard 不见了")
  ok(cards.brainPanel, "BrainPanel 不见了")
})

test("PersonaCard 有养鱼插件同步那一行（开关 + 立即同步 + 说明）", () => {
  const zh = { personaSyncTitle: "养鱼插件同步", personaSyncOn: "已同步", personaSyncOff: "未同步", personaSyncNow: "立即同步", personaSyncHint: "已镜像 {n} 条，当前指向 {current}" }
  const tZh = (key) => (zh[key] !== undefined ? zh[key] : key)
  const text = renderText(cards.personaCard({
    t: tZh,
    busy: false,
    persona: { list: [], current: "dafeiyu" },
    personaSync: { enabled: true, mirrored: 4, pluginCurrent: "sb-dafeiyu" },
  }))
  noRenderError(text)
  ok(text.includes("养鱼插件同步"), "缺标题")
  ok(text.includes("已同步"), "开关文案没出")
  ok(text.includes("立即同步"), "立即同步按钮没文案")
  ok(text.includes("4"), "镜像条数没填")
  ok(text.includes("sb-dafeiyu"), "当前指向没填")
})

test("PersonaCard 同步关掉时开关显示未同步", () => {
  const zh = { personaSyncOn: "已同步", personaSyncOff: "未同步" }
  const tZh = (key) => (zh[key] !== undefined ? zh[key] : key)
  const text = renderText(cards.personaCard({ t: tZh, busy: false, persona: { list: [] }, personaSync: { enabled: false, mirrored: 0 } }))
  noRenderError(text)
  ok(text.includes("未同步"), "关掉时开关文案不对")
})

group("人设卡片 · 养鱼插件（dsh-bili-whale）")
test("PersonaCard 显示养鱼插件的角色名 / 称呼 / 保存按钮", () => {
  const zh = {
    personaSyncTitle: "养鱼插件同步",
    personaSyncOn: "已同步",
    personaSyncOff: "未同步",
    personaSyncNow: "立即同步",
    personaSyncSave: "保存并同步",
    personaSyncWhaleName: "养鱼角色名",
    personaSyncWhaleOwner: "她怎么称呼你",
    personaSyncWhaleNameEmpty: "（来自共享大脑人设名）",
    personaSyncWhaleOwnerHint: "例如「主人」",
    personaSyncHint: "dsh-bili-whale 的角色名 {name} · 自称 {self} · 人设 {bytes} 字",
  }
  const tZh = (key) => (zh[key] !== undefined ? zh[key] : key)
  const text = renderText(
    cards.personaCard({
      t: tZh,
      busy: false,
      persona: { list: [], current: "dafeiyu" },
      personaSync: { enabled: true, mirrored: 3, pluginCurrent: "sb-dafeiyu", whale: { name: "大肥鱼", ownerTitle: "主人", selfClaim: "本鱼", personaBytes: 183 } },
    }),
  )
  ok(text.includes("养鱼角色名"), "没有养鱼角色名这一栏")
  ok(text.includes("大肥鱼"), "角色名没显示出来")
  ok(text.includes("她怎么称呼你"), "没有称呼这一栏")
  ok(text.includes("保存并同步"), "没有保存并同步按钮")
  ok(text.includes("本鱼") && text.includes("183"), "状态行没显示自称 / 字数")
  ok(!text.includes("{name}") && !text.includes("{bytes}"), "占位符没被替换")
})


/* ------------------------------------------------------------------ */
/* 开关文案：按钮上必须能直接读出「开」还是「关」                        */
/* ------------------------------------------------------------------ */

const cards2 = loadClient()
const tZh = (key) => ({
  capTitle: "能力开关",
  capSummary: "已开启",
  enabled: "已开启",
  disabled: "已关闭",
  enabledLabel: "点此关闭",
  disabledLabel: "点此开启",
  network: "网络",
  networkNote: "允许取外部信息",
  agentive: "自动互动",
  agentiveNote: "没事找你说两句",
}[key] ?? key)

function capCard(modules) {
  return cards2.capabilityCard({ t: tZh, busy: false, modules, onToggle: () => {} })
}

function buttonsOf(node) {
  const out = []
  const walk = (n) => {
    if (!n || typeof n !== "object") return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === "button") out.push(n.props)
    if (n.props && n.props.children !== undefined) {
      const kids = n.props.children
      if (Array.isArray(kids)) kids.forEach(walk)
      else walk(kids)
    }
  }
  walk(node)
  return out
}

group("开关文案（必须有明显的开 / 关信息）")

test("开启态按钮写着「● 已开启」，关闭态写着「○ 已关闭」", () => {
  const text = renderText(capCard({ network: { enabled: true }, agentive: { enabled: false } }))
  ok(text.includes("● 已开启"), "开启态按钮上有实心圆 + 已开启")
  ok(text.includes("○ 已关闭"), "关闭态按钮上有空心圆 + 已关闭")
})

test("不再出现「启用 / 停用」这种状态动作两可的词", () => {
  const text = renderText(capCard({ network: { enabled: true }, agentive: { enabled: false } }))
  ok(!text.includes("启用"), "不该出现「启用」")
  ok(!text.includes("停用"), "不该出现「停用」")
})

test("卡片标题旁有汇总「已开启 N / M」", () => {
  const text = renderText(capCard({ network: { enabled: true }, agentive: { enabled: false } }))
  ok(text.includes("已开启 1 / 2"), "汇总应为 已开启 1 / 2，实际：" + text.slice(0, 80))
})

test("按钮 title 写的是动作（点此关闭 / 点此开启），不重复状态", () => {
  const buttons = buttonsOf(capCard({ network: { enabled: true }, agentive: { enabled: false } }))
  ok(buttons.length === 2, "两张能力卡片各一个按钮，实际 " + buttons.length)
  ok(buttons[0].title === "点此关闭", "开启态 title 应为「点此关闭」，实际 " + buttons[0].title)
  ok(buttons[1].title === "点此开启", "关闭态 title 应为「点此开启」，实际 " + buttons[1].title)
})

test("按钮带 aria-pressed，读屏也能知道开关状态", () => {
  const buttons = buttonsOf(capCard({ network: { enabled: true }, agentive: { enabled: false } }))
  ok(buttons[0]["aria-pressed"] === "true", "开启态 aria-pressed 应为 true")
  ok(buttons[1]["aria-pressed"] === "false", "关闭态 aria-pressed 应为 false")
})

test("两个都开时汇总显示 2 / 2", () => {
  const text = renderText(capCard({ network: { enabled: true }, agentive: { enabled: true } }))
  ok(text.includes("已开启 2 / 2"), "汇总应为 已开启 2 / 2")
})

group("记忆图谱卡片（2026-11-05）")

function graphCard() {
  return cards2.memoryGraphCard({ t: tZh, busy: false })
}

test("MemoryGraphCard 渲染不抛错", () => {
  const text = renderText(graphCard())
  ok(!text.includes("[渲染出错:"), "渲染出错：" + text.slice(0, 200))
})

test("图谱卡片说清楚蓝点/橙点是什么", () => {
  const text = renderText(graphCard())
  ok(text.includes("蓝点是记忆"), "要说明蓝点代表记忆")
  ok(text.includes("橙点是实体"), "要说明橙点代表实体")
})

test("图谱卡片明确说归档不删文本", () => {
  const text = renderText(graphCard())
  ok(text.includes("归档只打标记"), "要说明归档只打标记")
  ok(text.includes("文本不会被删"), "要说明文本不会被删")
})

test("图谱卡片有刷新与重建两个按钮", () => {
  const buttons = buttonsOf(graphCard())
  const labels = buttons.map((b) => b.children)
  ok(labels.includes("刷新"), "要有刷新按钮，实际 " + JSON.stringify(labels))
  ok(labels.includes("重建图谱"), "要有重建按钮，实际 " + JSON.stringify(labels))
})

test("图谱卡片画布不是空元素", () => {
  const node = graphCard()
  const canvases = []
  const walk = (n) => {
    if (!n || typeof n !== "object") return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === "canvas") canvases.push(n)
    if (n.props && n.props.children !== undefined) {
      const kids = n.props.children
      if (Array.isArray(kids)) kids.forEach(walk)
      else walk(kids)
    }
  }
  walk(node)
  ok(canvases.length === 1, "应该正好一个 canvas，实际 " + canvases.length)
  ok(canvases[0].props.style.height === "340px", "画布要有高度")
})

test("没有候选时也给说明，不是一片空白", () => {
  const text = renderText(graphCard())
  ok(text.includes("归档候选"), "要有归档候选这一节")
  ok(text.includes("可恢复"), "要说明能恢复")
})

group("记忆图谱卡片（2026-11-05）")

function graphCard() {
  return cards2.memoryGraphCard({ t: tZh, busy: false })
}

test("MemoryGraphCard 渲染不抛错", () => {
  const text = renderText(graphCard())
  ok(!text.includes("[渲染出错:"), "渲染出错：" + text.slice(0, 200))
})

test("图谱卡片说清楚蓝点/橙点是什么", () => {
  const text = renderText(graphCard())
  ok(text.includes("蓝点是记忆"), "要说明蓝点代表记忆")
  ok(text.includes("橙点是实体"), "要说明橙点代表实体")
})

test("图谱卡片明确说归档不删文本", () => {
  const text = renderText(graphCard())
  ok(text.includes("归档只打标记"), "要说明归档只打标记")
  ok(text.includes("文本不会被删"), "要说明文本不会被删")
})

test("图谱卡片有刷新与重建两个按钮", () => {
  const buttons = buttonsOf(graphCard())
  const labels = buttons.map((b) => b.children)
  ok(labels.includes("刷新"), "要有刷新按钮，实际 " + JSON.stringify(labels))
  ok(labels.includes("重建图谱"), "要有重建按钮，实际 " + JSON.stringify(labels))
})

test("图谱卡片画布不是空元素", () => {
  const node = graphCard()
  const canvases = []
  const walk = (n) => {
    if (!n || typeof n !== "object") return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === "canvas") canvases.push(n)
    if (n.props && n.props.children !== undefined) {
      const kids = n.props.children
      if (Array.isArray(kids)) kids.forEach(walk)
      else walk(kids)
    }
  }
  walk(node)
  ok(canvases.length === 1, "应该正好一个 canvas，实际 " + canvases.length)
  ok(canvases[0].props.style.height === "340px", "画布要有高度")
})

test("没有候选时也给说明，不是一片空白", () => {
  const text = renderText(graphCard())
  ok(text.includes("归档候选"), "要有归档候选这一节")
  ok(text.includes("可恢复"), "要说明能恢复")
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  console.log("\n失败明细：")
  for (const line of fails) console.log(" -", line)
}
process.exit(failed > 0 ? 1 : 0)
