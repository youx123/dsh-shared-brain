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

group("整体")
test("client.js 内部组件都还在", () => {
  ok(cards.emojiCard, "EmojiCard 不见了")
  ok(cards.proactiveCard, "ProactiveCard 不见了")
  ok(cards.moodCard, "MoodCard 不见了")
  ok(cards.brainPanel, "BrainPanel 不见了")
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  console.log("\n失败明细：")
  for (const line of fails) console.log(" -", line)
}
process.exit(failed > 0 ? 1 : 0)
