/**
 * 跨机同步（remote-sync.js）离线测试。
 *
 * 用一个假 GitHub Contents API（内存版）模拟远端仓库，
 * 用两个不同的 DSH_HOME 模拟两台机器，验证：
 *   合并 / 删除墓碑 / 冲突重试 / 作用域过滤 / 人设 / 设置 / 状态
 *
 * 跑法：node tests/remote-sync.test.mjs
 */
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync as rf, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = process.env.SB_LIB || join(HERE, "..", "lib")

let passed = 0
let failed = 0
let groupName = ""

function group(name) {
  groupName = name
  console.log(`\n${name}`)
}

function test(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === "function") throw new Error("异步用例请用 awaitTest")
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function awaitTest(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertOk(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

/* ------------------------------------------------------------------ */
/* 假 GitHub Contents API                                              */
/* ------------------------------------------------------------------ */

const remote = new Map() // path → {data, sha}
let shaSeq = 0
let conflictOnce = 0

function shaOf() {
  shaSeq += 1
  return `sha${shaSeq}`.padEnd(40, "0")
}

function parseRepoPath(url) {
  // https://api.github.com/repos/owner/name/contents/brain/memory.json?ref=main
  const match = /\/repos\/[^/]+\/[^/]+\/contents\/(.+?)(\?|$)/.exec(url)
  if (!match) return null
  return decodeURIComponent(match[1])
}

globalThis.fetch = async (url, options = {}) => {
  const method = options.method || "GET"
  const path = parseRepoPath(String(url))
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
  if (!path) return json(400, { message: "bad url" })

  if (method === "GET") {
    const hit = remote.get(path)
    if (!hit) return json(404, { message: "Not Found" })
    return json(200, {
      sha: hit.sha,
      content: Buffer.from(JSON.stringify(hit.data, null, 2), "utf8").toString("base64"),
    })
  }

  if (method === "PUT") {
    const body = JSON.parse(options.body || "{}")
    const hit = remote.get(path)
    if (conflictOnce > 0) {
      conflictOnce -= 1
      return json(409, { message: "sha does not match" })
    }
    if (hit && body.sha !== hit.sha) return json(409, { message: "sha does not match" })
    if (!hit && body.sha) return json(422, { message: "sha supplied but file missing" })
    const data = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"))
    const sha = shaOf()
    remote.set(path, { data, sha })
    return json(200, { content: { sha } })
  }

  return json(405, { message: "method not allowed" })
}

/* ------------------------------------------------------------------ */
/* 沙箱                                                               */
/* ------------------------------------------------------------------ */

const ROOT = mkdtempSync(join(tmpdir(), "sb-remote-"))
const HOME_A = join(ROOT, "a")
const HOME_B = join(ROOT, "b")
for (const home of [HOME_A, HOME_B]) mkdirSync(home, { recursive: true })

const TOKEN = "ghp_" + "test".repeat(10)

const store = await import(pathToFileURL(join(LIB, "store.js")).href)
const modulesLib = await import(pathToFileURL(join(LIB, "modules.js")).href)
const persona = await import(pathToFileURL(join(LIB, "persona.js")).href)
const sync = await import(pathToFileURL(join(LIB, "remote-sync.js")).href)

function useHome(home) {
  process.env.DSH_HOME = home
  process.env.DSH_SHARED_BRAIN_TOKEN = TOKEN
}

function entry(id, text, extra = {}) {
  const at = extra.updatedAt ?? Date.now()
  return {
    id,
    text,
    module: "cognition",
    weight: 0.6,
    lifetime: "permanent",
    source: "manual",
    scope: "global",
    createdAt: extra.createdAt ?? at,
    updatedAt: at,
    ...extra,
  }
}

try {
  /* ---------------------------------------------------------------- */
  group("配置：仓库地址与参数规整")

  test("normalizeRepo 认 https / ssh / owner-name 三种写法", () => {
    assertEqual(sync.normalizeRepo("https://github.com/youx/brain.git"), "youx/brain", "https 形式")
    assertEqual(sync.normalizeRepo("git@github.com:youx/brain.git"), "youx/brain", "ssh 形式")
    assertEqual(sync.normalizeRepo(" youx/brain "), "youx/brain", "裸写法")
    assertEqual(sync.normalizeRepo(""), "", "空串")
    assertEqual(sync.normalizeRepo("not a repo"), "", "不合法")
  })

  test("normalizeSyncConfig 夹紧间隔、默认分支、布尔转真值", () => {
    const cfg = sync.normalizeSyncConfig({ enabled: "yes", repo: "o/r", intervalMs: 1, branch: "" })
    assertEqual(cfg.enabled, true, "enabled 转布尔")
    assertEqual(cfg.repo, "o/r", "repo")
    assertEqual(cfg.branch, "main", "分支兜底")
    assertEqual(cfg.intervalMs, sync.MIN_REMOTE_INTERVAL_MS, "间隔夹到最小值")
    const big = sync.normalizeSyncConfig({ intervalMs: 10 ** 12 })
    assertEqual(big.intervalMs, sync.MAX_REMOTE_INTERVAL_MS, "间隔夹到最大值")
  })

  /* ---------------------------------------------------------------- */
  group("合并规则：条目 / 墓碑 / 作用域")

  test("syncableEntry 只收全局条目", () => {
    assertEqual(sync.syncableEntry(entry("a", "全局的")), true, "全局收")
    assertEqual(sync.syncableEntry(entry("b", "会话的", { scope: "session" })), false, "会话级不收")
    assertEqual(sync.syncableEntry(entry("c", "  ")), false, "空文本不收")
    assertEqual(sync.syncableEntry({ id: "" }), false, "无 id 不收")
    const expired = entry("d", "过期的", { lifetime: "temporary", expiresAt: Date.now() - 1000 })
    assertEqual(sync.syncableEntry(expired), false, "过期的不收")
  })

  test("mergeEntries：新增、按 updatedAt 取新、墓碑删除", () => {
    const old = entry("x", "旧版本", { updatedAt: 1000 })
    const fresh = entry("x", "新版本", { updatedAt: 2000 })
    const onlyRemote = entry("y", "远端的", { updatedAt: 1500 })
    const merged = sync.mergeEntries([old], [fresh, onlyRemote], {})
    assertEqual(merged.entries.length, 2, "两条")
    const x = merged.entries.find((item) => item.id === "x")
    assertEqual(x.text, "新版本", "远端的更新，取远端")
    assertEqual(merged.updated, 0, "远端更新时本地不覆盖，updated 计 0")
    assertEqual(merged.added, 0, "两边都有同一个 id，不算新增")

    const localExtra = sync.mergeEntries([old, entry("z", "只有本地有", { updatedAt: 1200 })], [onlyRemote], {})
    assertEqual(localExtra.added, 2, "本地独有的都算新增")
    assertEqual(localExtra.entries.length, 3, "合并后三条")

    const localWins = sync.mergeEntries([fresh], [old], {})
    assertEqual(localWins.entries[0].text, "新版本", "本地更新时取本地")
    assertEqual(localWins.updated, 1, "本地覆盖远端时 updated 计 1")

    const killed = sync.mergeEntries([old], [fresh], { x: 3000 })
    assertEqual(killed.entries.length, 0, "墓碑晚于更新 → 删除")
    assertEqual(killed.deleted, 1, "删除计数")

    const survived = sync.mergeEntries([old], [fresh], { x: 500 })
    assertEqual(survived.entries.length, 1, "墓碑早于更新 → 保留")
  })

  test("detectDeletions：本地消失的 id 记墓碑（带种类）", () => {
    const tombstones = sync.detectDeletions([entry("keep", "留着的")], ["keep", "gone"], 1234)
    assertEqual(sync.tombstoneAt(tombstones, "gone"), 1234, "消失的记墓碑")
    assertEqual(sync.tombstoneKind(tombstones, "gone"), "entry", "默认是记忆条目的墓碑")
    assertEqual(sync.tombstoneAt(tombstones, "keep"), 0, "还在的不记")
  })

  test("detectDeletions：模块条目的墓碑带 kind='module'", () => {
    const tombstones = sync.detectDeletions([], ["bl_1"], 4321, "module")
    assertEqual(sync.tombstoneKind(tombstones, "bl_1"), "module", "是模块条目的墓碑")
    assertEqual(sync.tombstoneAt(tombstones, "bl_1"), 4321, "时间也记上")
  })

  test("pruneTombstones：超过 30 天的墓碑清掉", () => {
    const now = 100 * 24 * 60 * 60 * 1000
    const kept = sync.pruneTombstones({ fresh: now - 1000, stale: now - 31 * 24 * 60 * 60 * 1000 }, now)
    assertEqual(sync.tombstoneAt(kept, "fresh"), now - 1000, "新的留着")
    assertEqual(sync.tombstoneAt(kept, "stale"), 0, "旧的清掉")
  })

  test("mergeTombstones：同 id 取更晚的时间（兼容旧格式）", () => {
    const merged = sync.mergeTombstones({ a: 10, b: 20 }, { a: 30 })
    assertEqual(sync.tombstoneAt(merged, "a"), 30, "取更晚")
    assertEqual(sync.tombstoneAt(merged, "b"), 20, "另一个保留")
  })

  /* ---------------------------------------------------------------- */
  group("人设与设置")

  test("mergePersona：personas 按 id 并集，会话映射不进合并结果", () => {
    const local = {
      version: 1,
      current: "a",
      currentAt: 2000,
      personas: [{ id: "a", name: "本机", updatedAt: 2000 }],
      bySession: { s1: "a" },
      updatedAt: 2000,
    }
    const remoteP = {
      version: 1,
      current: "b",
      currentAt: 1000,
      personas: [{ id: "a", name: "旧", updatedAt: 1000 }, { id: "b", name: "远端", updatedAt: 1500 }],
      bySession: { s2: "b" },
      updatedAt: 1000,
    }
    const merged = sync.mergePersona(local, remoteP)
    assertEqual(merged.current, "a", "人设时间戳更新的赢")
    assertEqual(merged.personas.length, 2, "并集两条")
    assertEqual(merged.personas.find((p) => p.id === "a").name, "本机", "同 id 取新")
    // 2026-11-04（P1-6 审计）：合并结果**不带** bySession。
    // 「会话 → 人设」的绑定是本机的事（别的机器上没有这些会话），
    // 以前它跟着合并结果写进远端 persona.json → 本机布局泄露到云上，
    // 远端回来时又会把本机绑定覆盖掉。
    // 本机的绑定由 syncOnce 落地时单独从本地补回来（见下面那条测试）。
    assertEqual(merged.bySession, undefined, "合并结果不带会话映射")
  })

  test("mergePersona：会话映射不进合并结果，但本机那份仍然有效", () => {
    // 合并结果是要推给远端的形状 —— 里面不该有 bySession。
    // 本机的 bySession 存在 persona.json 里，syncOnce 落地时补回去，
    // 所以「合并结果没有」不等于「本机丢了」。
    const local = {
      version: 1,
      current: "a",
      currentAt: 1000,
      personas: [{ id: "a", name: "甲", updatedAt: 1000 }],
      bySession: { s1: "a", s2: "a" },
      updatedAt: 1000,
    }
    const merged = sync.mergePersona(local, {}, {})
    assertEqual(merged.bySession, undefined, "推给远端的不带会话映射")
    assertEqual(Object.keys(local.bySession).length, 2, "本地那份原样没动")
  })

  test("mergePersona：current 只听自己的 currentAt，不抢整份时间戳", () => {
    // 本机：改了一个**别的**人设，整份 updatedAt 顶新了，但 current 没动过
    const local = {
      version: 1,
      current: "a",
      currentAt: 1000,
      personas: [{ id: "a", name: "甲", updatedAt: 1000 }, { id: "c", name: "本机新加的", updatedAt: 9000 }],
      bySession: {},
      updatedAt: 9000,
    }
    // 远端：整份旧，但 current 是刚刚才切换的
    const remoteP = {
      version: 1,
      current: "b",
      currentAt: 8000,
      personas: [{ id: "b", name: "乙", updatedAt: 3000 }],
      bySession: {},
      updatedAt: 3000,
    }
    const merged = sync.mergePersona(local, remoteP)
    assertEqual(merged.current, "b", "current 该听 currentAt（远端 8000 > 本机 1000）")
    assertEqual(merged.currentAt, 8000, "currentAt 取较大的")
    assertEqual(merged.personas.length, 3, "三个人设都在")
  })

  test("mergePersona：删掉的人设不会因为远端还在而复活", () => {
    const local = { version: 1, current: "a", currentAt: 1000, personas: [{ id: "a", name: "甲", updatedAt: 1000 }], bySession: {}, updatedAt: 1000 }
    const remoteP = {
      version: 1,
      current: "a",
      currentAt: 1000,
      personas: [{ id: "a", name: "甲", updatedAt: 1000 }, { id: "gone", name: "删掉的", updatedAt: 500 }],
      bySession: {},
      updatedAt: 1000,
    }
    const tombstones = { gone: { at: 2000, kind: "persona" } }
    const merged = sync.mergePersona(local, remoteP, tombstones)
    assertEqual(merged.personas.length, 1, "删掉的不能复活")
    assertEqual(merged.personas.some((p) => p.id === "gone"), false, "墓碑说了算")
  })

  test("mergePersona：坏条目（没 id / 没 name）丢掉并计数", () => {
    const local = { version: 1, current: "a", currentAt: 1, personas: [{ id: "a", name: "甲", updatedAt: 1 }], bySession: {}, updatedAt: 1 }
    const remoteP = {
      version: 1,
      current: "a",
      currentAt: 1,
      personas: [{ id: "", name: "没 id" }, { id: "x", name: "" }, { id: "b", name: "乙", updatedAt: 2 }],
      bySession: {},
      updatedAt: 1,
    }
    const merged = sync.mergePersona(local, remoteP)
    assertEqual(merged.personas.length, 2, "只收 a 和 b")
    assertEqual(merged.mergeStats.dropped, 2, "两条坏条目被丢")
  })

  test("mergePersona：current 指向被删掉的人设 → 退回内置兜底", () => {
    const local = { version: 1, current: "gone", currentAt: 5000, personas: [], bySession: {}, updatedAt: 5000 }
    const remoteP = { version: 1, current: "a", currentAt: 1, personas: [{ id: "a", name: "甲", updatedAt: 1 }], bySession: {}, updatedAt: 1 }
    const merged = sync.mergePersona(local, remoteP, { gone: { at: 9000, kind: "persona" } })
    assertEqual(merged.current, "dafeiyu", "别留一个死 id")
  })

  test("sanitizeModules：剥掉会话级条目与会话白名单", () => {
    const modules = modulesLib.normalizeModules({})
    modules.cognition.items = [
      { id: "1", text: "全局的", scope: "global", weight: 0.5 },
      { id: "2", text: "会话的", scope: "session", weight: 0.5 },
    ]
    modules.agentive.sessionIds = ["session-abc"]
    const clean = sync.sanitizeModules(modules)
    assertEqual(clean.cognition.items.length, 1, "会话级条目被剥掉")
    assertEqual(clean.agentive.sessionIds.length, 0, "会话白名单清空")
  })

  test("mergeModules：没有条目的模块（network）整块取较新", () => {
    const older = { ...modulesLib.normalizeModules({}), updatedAt: 1000, network: { enabled: false } }
    const newer = { ...modulesLib.normalizeModules({}), updatedAt: 2000, network: { enabled: true } }
    const merged = sync.mergeModules(older, newer)
    assertEqual(merged.network.enabled, true, "取新的那份")
  })

  test("mergeModules：按条目合并 —— 一边改底线、一边改别的设置，底线不被覆盖", () => {
    // 这是 0.10.0 修的头号问题：以前是「整份较新者胜」，
    // 别人动一下任何一项设置，老大那条底线就被整份盖掉。
    const base = modulesLib.normalizeModules({})
    base.bottomline.items = [
      { id: "bl_1", text: "未经同意不删改数据", weight: 0.9, pinned: true, scope: "global", updatedAt: 1000 },
    ]
    base.cognition.items = []
    const local = JSON.parse(JSON.stringify(base))
    local.updatedAt = 2000
    // 本机改了「认知」的权重（模块级），没碰底线
    local.cognition.weight = 0.9
    local.cognition.updatedAt = 2000

    const remote = JSON.parse(JSON.stringify(base))
    remote.updatedAt = 3000
    // 远端改了「网络」开关（模块级），也没碰底线，但整份 updatedAt 更大
    remote.network.enabled = true
    remote.network.updatedAt = 3000

    const merged = sync.mergeModules(local, remote)
    assertEqual(merged.cognition.weight, 0.9, "本机改的认知权重保住了")
    assertEqual(merged.network.enabled, true, "远端改的网络开关也合上了")
    const bl = merged.bottomline.items.find((item) => item.id === "bl_1")
    assert(bl, "底线条目没被弄丢")
    assertEqual(bl.text, "未经同意不删改数据", "底线原文没被覆盖")
    assertEqual(bl.pinned, true, "钉住状态还在")
  })

  test("mergeModuleItems：同 id 取 updatedAt 新的；墓碑能删条目", () => {
    const local = [{ id: "x", text: "本机新版", updatedAt: 2000 }]
    const remote = [{ id: "x", text: "远端旧版", updatedAt: 1000 }, { id: "y", text: "远端独有", updatedAt: 1000 }]
    const merged = sync.mergeModuleItems(local, remote, {})
    assertEqual(merged.items.length, 2, "两条都在")
    assertEqual(merged.items.find((i) => i.id === "x").text, "本机新版", "同 id 取新")

    const killed = sync.mergeModuleItems([], remote, { y: { at: 3000, kind: "module" } })
    assertEqual(killed.items.length, 1, "墓碑删掉一条")
    assertEqual(killed.deleted, 1, "删除计数")
  })

  test("collectModuleItemIds：把所有模块里的条目 id 收齐", () => {
    const mods = modulesLib.normalizeModules({})
    mods.bottomline.items = [{ id: "bl_1", text: "底线" }]
    mods.cognition.items = [{ id: "c_1", text: "认知" }, { id: "c_2", text: "认知2" }]
    const ids = sync.collectModuleItemIds(mods)
    assertEqual(ids.has("bl_1"), true, "底线条目收进来了")
    assertEqual(ids.has("c_2"), true, "认知条目收进来了")
    assertEqual(ids.size, 3, "一共三个")
  })

  /* ---------------------------------------------------------------- */
  group("两台机器端到端（假 GitHub）")

  await awaitTest("A 机首次同步：建远端文件、只推全局条目", async () => {
    useHome(HOME_A)
    const now = Date.now()
    store.writeStore({
      version: 1,
      updatedAt: now,
      entries: [
        entry("m1", "老大喜欢用中文", { createdAt: now - 3000, updatedAt: now - 3000 }),
        entry("m2", "这台机器的会话记忆", { scope: "session", createdAt: now - 2000, updatedAt: now - 2000 }),
        entry("m3", "第二条全局记忆", { createdAt: now - 1000, updatedAt: now - 1000 }),
      ],
    })
    sync.writeSyncConfig({ enabled: true, repo: "youx/brain-data", branch: "main", token: TOKEN, lastSeenIds: [] })

    const result = await sync.runRemoteSync()
    assert(result.ok, `同步应成功：${result.error ?? ""}`)
    assertEqual(remote.size >= 1, true, "远端至少建了记忆文件")
    const pushed = remote.get("brain/memory.json").data
    assertEqual(pushed.entries.length, 2, "只推两条全局条目")
    assertEqual(pushed.entries.some((item) => item.scope === "session"), false, "会话条目没上云")
    assertEqual(typeof pushed.deviceId, "string", "带了设备编号")
    assertEqual(pushed.tombstones && Object.keys(pushed.tombstones).length, 0, "没有墓碑")
  })

  await awaitTest("B 机首次同步：把远端条目拉回来（会话条目不出本机）", async () => {
    useHome(HOME_B)
    sync.writeSyncConfig({ enabled: true, repo: "youx/brain-data", branch: "main", token: TOKEN, lastSeenIds: [] })
    const result = await sync.runRemoteSync()
    assert(result.ok, `同步应成功：${result.error ?? ""}`)
    const local = store.readStore()
    assertEqual(local.entries.length, 2, "B 机拿到两条全局记忆")
    assertEqual(local.entries.some((item) => item.text.includes("会话")), false, "会话记忆没过界")
  })

  await awaitTest("B 机删掉一条 → A 机跟着消失（墓碑生效）", async () => {
    useHome(HOME_B)
    const local = store.readStore()
    store.writeStore({ ...local, entries: local.entries.filter((item) => item.id !== "m1"), updatedAt: Date.now() })
    const del = await sync.runRemoteSync()
    assert(del.ok, `B 删除后同步应成功：${del.error ?? ""}`)
    assertEqual(del.summary.deleted, 1, "B 侧统计到 1 条删除")
    assertEqual(remote.get("brain/memory.json").data.entries.length, 1, "远端只剩 1 条")

    useHome(HOME_A)
    const back = await sync.runRemoteSync()
    assert(back.ok, `A 回拉应成功：${back.error ?? ""}`)
    const storeA = store.readStore()
    assertEqual(storeA.entries.length, 1, "A 机也只剩 1 条")
    assertEqual(storeA.entries[0].id, "m3", "留下的是没被删的那条")
  })

  await awaitTest("A 机改一条 → B 机拿到新文本", async () => {
    useHome(HOME_A)
    const local = store.readStore()
    const updated = local.entries.map((item) => (item.id === "m3" ? { ...item, text: "改过的全局记忆", updatedAt: Date.now() + 1000 } : item))
    store.writeStore({ ...local, entries: updated, updatedAt: Date.now() })
    const push = await sync.runRemoteSync()
    assert(push.ok, `A 推送应成功：${push.error ?? ""}`)

    useHome(HOME_B)
    const pull = await sync.runRemoteSync()
    assert(pull.ok, `B 拉取应成功：${pull.error ?? ""}`)
    assertEqual(store.readStore().entries[0].text, "改过的全局记忆", "B 拿到新文本")
  })

  await awaitTest("远端被抢先写 → 409 后自动重试合上", async () => {
    useHome(HOME_A)
    conflictOnce = 1
    const now = Date.now()
    const local = store.readStore()
    store.writeStore({
      ...local,
      entries: [...local.entries, entry("m4", "重试时新增的一条", { createdAt: now, updatedAt: now })],
      updatedAt: now,
    })
    const result = await sync.runRemoteSync()
    assert(result.ok, `冲突重试后应成功：${result.error ?? ""}`)
    assertEqual(result.summary.attempt, 2, "第二次尝试才成功")
    assertEqual(remote.get("brain/memory.json").data.entries.length, 2, "远端两条都在")
  })

  /* ---------------------------------------------------------------- */
  group("状态与定时器")

  test("remoteSyncStatus 反映配置与运行状态", () => {
    useHome(HOME_A)
    const status = sync.remoteSyncStatus()
    assertEqual(status.enabled, true, "开着")
    assertEqual(status.repo, "youx/brain-data", "仓库")
    assertEqual(status.hasToken, true, "有 token")
    assertEqual(typeof status.deviceId, "string", "有设备编号")
    assertEqual(status.trackedEntries >= 1, true, "记住上次看到的条目")
    assertEqual(typeof status.runtime.running, "boolean", "运行状态")
  })

  await awaitTest("applyRemoteSync 能改配置并夹紧间隔", async () => {
    useHome(HOME_A)
    const result = sync.applyRemoteSync({ intervalMinutes: 0.001 })
    const status = sync.remoteSyncStatus()
    assertEqual(status.intervalMs, sync.MIN_REMOTE_INTERVAL_MS, "间隔被夹到最小")
    assert(typeof result.note === "string" && result.note.length > 0, "返回了提示文案")

    const tenMinutes = sync.applyRemoteSync({ intervalMinutes: 10 })
    assertEqual(tenMinutes.config.intervalMs, 600000, "按分钟填能落成毫秒")
  })

  await awaitTest("显式传进来的 token 会被用上（不必先存进配置）", async () => {
    const home = join(ROOT, "token-arg")
    mkdirSync(home, { recursive: true })
    useHome(home)
    process.env.DSH_SHARED_BRAIN_TOKEN = ""
    sync.writeSyncConfig({ enabled: true, repo: "youx/brain", token: "" })
    const store0 = store.readStore()
    store0.entries = [entry("t1", "只有显式 token 才能推上去")]
    store.writeStore(store0)
    const result = await sync.runRemoteSync({ token: TOKEN })
    assertEqual(result.ok, true, `显式 token 应该能用：${result.error || ""}`)
    assert(remote.has("brain/memory.json"), "远端写进去了")
  })

  await awaitTest("推上去的 memory.json 带上了本机编号", async () => {
    const home = join(ROOT, "device-id")
    mkdirSync(home, { recursive: true })
    useHome(home)
    remote.clear()
    sync.writeSyncConfig({ enabled: true, repo: "youx/brain", token: TOKEN })
    const store1 = store.readStore()
    store1.entries = [entry("d1", "看看 deviceId 有没有写上")]
    store.writeStore(store1)
    const result = await sync.runRemoteSync()
    assertEqual(result.ok, true, `同步应该成功：${result.error || ""}`)
    const pushed = remote.get("brain/memory.json")
    assert(pushed && typeof pushed.data.deviceId === "string" && pushed.data.deviceId.length > 0, `deviceId 不该是空的：${JSON.stringify(pushed?.data.deviceId)}`)
  })

  /* ---------------------------------------------------------------- */
  group("令牌：不落在明文配置里（P0-2）")

  await awaitTest("token 不写进 sync.json，只落在独立的 token 文件", async () => {
    const home = join(ROOT, "token-store")
    mkdirSync(home, { recursive: true })
    useHome(home)
    sync.writeSyncConfig({ enabled: true, repo: "youx/brain", token: TOKEN })
    const syncJson = rf(join(home, "storages", "dsh-shared-brain", "sync.json"), "utf8")
    assert(syncJson.includes(TOKEN) === false, `sync.json 里不该出现明文 token：${syncJson.slice(0, 200)}`)
    assert(syncJson.includes("\"token\"") === false, "sync.json 连 token 字段都不该有")
    const tokenFile = join(home, "storages", "dsh-shared-brain", "sync-token.json")
    assert(existsSync(tokenFile), "token 文件应该存在")
    assert(rf(tokenFile, "utf8").includes(TOKEN), "token 在独立文件里")
    // 但功能没坏：还是能读到 token
    assertEqual(sync.remoteSyncStatus().hasToken, true, "状态里认得出有 token")
  })

  await awaitTest("老配置里的明文 token 会被自动搬进独立文件并擦掉", async () => {
    const home = join(ROOT, "token-legacy")
    mkdirSync(home, { recursive: true })
    useHome(home)
    const dir = join(home, "storages", "dsh-shared-brain")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "sync.json"), JSON.stringify({
      version: 1, enabled: true, repo: "youx/brain", branch: "main", intervalMs: 600000, token: TOKEN,
    }, null, 2), "utf8")
    const status = sync.remoteSyncStatus()
    assertEqual(status.hasToken, true, "老配置里的 token 认得出来")
    const after = rf(join(dir, "sync.json"), "utf8")
    assert(after.includes(TOKEN) === false, `老 token 没被擦掉：${after}`)
    assert(existsSync(join(dir, "sync-token.json")), "搬到了独立文件")
  })

  await awaitTest("清空 token 会把独立文件删掉", async () => {
    const home = join(ROOT, "token-clear")
    mkdirSync(home, { recursive: true })
    useHome(home)
    sync.writeSyncConfig({ enabled: true, repo: "youx/brain", token: TOKEN })
    const tokenFile = join(home, "storages", "dsh-shared-brain", "sync-token.json")
    assert(existsSync(tokenFile), "先写进去")
    // 环境变量里那个先撤掉，不然它会顶替掉文件里的 token
    process.env.DSH_SHARED_BRAIN_TOKEN = ""
    sync.writeSyncConfig({ token: "" })
    assert(existsSync(tokenFile) === false, "清空后文件没了")
    assertEqual(sync.remoteSyncStatus().hasToken, false, "状态里也没 token 了")
  })

  await awaitTest("没填仓库时给清楚的错误，而不是崩", async () => {
    const home = join(ROOT, "empty")
    mkdirSync(home, { recursive: true })
    useHome(home)
    sync.writeSyncConfig({ enabled: false, repo: "", token: TOKEN })
    const result = await sync.runRemoteSync()
    assertEqual(result.ok, false, "应该失败")
    assert(result.error.includes("仓库"), `错误里说明仓库没填：${result.error}`)
  })
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ */
/* P1-3 跨机同步边界说明（2026-11-03）                                  */
/* ------------------------------------------------------------------ */

group("跨机同步边界")

test("syncBoundary 讲清楚哪些会上云、哪些只留本机", () => {
  const b = sync.syncBoundary()
  assertOk(Array.isArray(b.shared) && b.shared.length > 0, '要列出上云的东西')
  assertOk(Array.isArray(b.localOnly) && b.localOnly.length > 0, '要列出不上云的东西')
  const sharedLabels = b.shared.map((x) => x.label).join('|')
  const localLabels = b.localOnly.map((x) => x.label).join('|')
  assertOk(sharedLabels.includes('全局记忆条目'), '全局记忆该上云')
  assertOk(sharedLabels.includes('人设'), '人设该上云')
  assertOk(sharedLabels.includes('模块设置'), '模块设置该上云')
  assertOk(localLabels.includes('会话内的记忆'), '会话内记忆不该上云')
  assertOk(localLabels.includes('访问令牌'), '令牌绝不该上云')
  assertOk(localLabels.includes('心情状态'), '心情状态不该上云')
  assertOk(typeof b.note === 'string' && b.note.length > 0, '要说明删除会同步')
})

test("remoteSyncStatus 里带着边界清单", () => {
  const st = sync.remoteSyncStatus()
  assertOk(st.boundary, '状态里要有 boundary')
  assertOk(Array.isArray(st.boundary.shared), 'boundary.shared 要是数组')
  assertOk(Array.isArray(st.boundary.localOnly), 'boundary.localOnly 要是数组')
})

test("设置页把边界清单画出来", () => {
  const src = readFileSync(join(LIB, 'client.js'), 'utf8')
  assertOk(src.includes('remoteSyncBoundaryToggle'), '缺边界开关')
  assertOk(src.includes('remoteSyncShared'), '缺「会同步」文案')
  assertOk(src.includes('remoteSyncLocal'), '缺「只留本机」文案')
  assertOk(src.includes('remote-sync-boundary-box'), '缺边界区块')
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
