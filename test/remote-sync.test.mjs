/**
 * 跨机同步（remote-sync.js）离线测试。
 *
 * 用一个假 GitHub Contents API（内存版）模拟远端仓库，
 * 用两个不同的 DSH_HOME 模拟两台机器，验证：
 *   合并 / 删除墓碑 / 冲突重试 / 作用域过滤 / 人设 / 设置 / 状态
 *
 * 跑法：node tests/remote-sync.test.mjs
 */
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
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

  test("detectDeletions：本地消失的 id 记墓碑", () => {
    const tombstones = sync.detectDeletions([entry("keep", "留着的")], ["keep", "gone"], 1234)
    assertEqual(tombstones.gone, 1234, "消失的记墓碑")
    assertEqual(tombstones.keep, undefined, "还在的不记")
  })

  test("pruneTombstones：超过 30 天的墓碑清掉", () => {
    const now = 100 * 24 * 60 * 60 * 1000
    const kept = sync.pruneTombstones({ fresh: now - 1000, stale: now - 31 * 24 * 60 * 60 * 1000 }, now)
    assertEqual(kept.fresh, now - 1000, "新的留着")
    assertEqual(kept.stale, undefined, "旧的清掉")
  })

  test("mergeTombstones：同 id 取更晚的时间", () => {
    const merged = sync.mergeTombstones({ a: 10, b: 20 }, { a: 30 })
    assertEqual(merged.a, 30, "取更晚")
    assertEqual(merged.b, 20, "另一个保留")
  })

  /* ---------------------------------------------------------------- */
  group("人设与设置")

  test("mergePersona：personas 按 id 并集，bySession 不上云", () => {
    const local = {
      version: 1,
      current: "a",
      personas: [{ id: "a", name: "本机", updatedAt: 2000 }],
      bySession: { s1: "a" },
      updatedAt: 2000,
    }
    const remoteP = {
      version: 1,
      current: "b",
      personas: [{ id: "a", name: "旧", updatedAt: 1000 }, { id: "b", name: "远端", updatedAt: 1500 }],
      bySession: { s2: "b" },
      updatedAt: 1000,
    }
    const merged = sync.mergePersona(local, remoteP)
    assertEqual(merged.current, "a", "更新的整份赢")
    assertEqual(merged.personas.length, 2, "并集两条")
    assertEqual(merged.personas.find((p) => p.id === "a").name, "本机", "同 id 取新")
    assertEqual(Object.keys(merged.bySession).length, 0, "会话映射清空")
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

  test("mergeModules：整份按 updatedAt 取新", () => {
    const older = { ...modulesLib.normalizeModules({}), updatedAt: 1000, network: { enabled: false } }
    const newer = { ...modulesLib.normalizeModules({}), updatedAt: 2000, network: { enabled: true } }
    const merged = sync.mergeModules(older, newer)
    assertEqual(merged.network.enabled, true, "取新的那份")
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

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
