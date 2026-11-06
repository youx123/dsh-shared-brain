/**
 * 内置表情包（大肥鱼 GIF）测试
 *
 * 覆盖：素材完整性 / 名字解析（含越界）/ URL 与 markdown / 提示词片段 / 静态路由行为。
 * 路由那几条用假的 req/res 直接调 handler，不需要真起 HTTP 服务。
 */
import { existsSync, readFileSync, statSync, mkdtempSync, mkdirSync, rmSync, writeFileSync as wfs } from "node:fs"
import { tmpdir } from "node:os"
import { deflateSync } from "node:zlib"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Writable } from "node:stream"

const HERE = dirname(fileURLToPath(import.meta.url))
// 本地开发时补丁源可能还没同步素材，允许用 SB_LIB 指到安装目录
const LIB = process.env.SB_LIB || join(HERE, "..", "lib")

const B = await import("file:///" + join(LIB, "emoji-builtin.js").replace(/\\/g, "/"))
const E = await import("file:///" + join(LIB, "emoji.js").replace(/\\/g, "/"))

let passed = 0
let failed = 0
const fails = []
async function test(name, fn) {
  try {
    await fn()
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
function eq(actual, expected, label = "") {
  if (actual !== expected) throw new Error(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

const DIR = B.builtinAssetDir()

group("素材完整性")
await test("40 个语义 key 都有映射", () => {
  const keys = Object.keys(B.BUILTIN_KEY_FILES)
  eq(keys.length, 40, "key 数量")
  for (const key of keys) {
    ok(/^\d{3}\.gif$/.test(B.BUILTIN_KEY_FILES[key]), `${key} 的文件名不规范`)
  }
})
await test("40 个 key 的中文名都有", () => {
  const labels = Object.keys(B.BUILTIN_KEY_LABELS)
  eq(labels.length, 40, "label 数量")
  for (const key of Object.keys(B.BUILTIN_KEY_FILES)) ok(B.BUILTIN_KEY_LABELS[key], `${key} 缺中文名`)
})
await test("映射的文件都在磁盘上，且是真 GIF", () => {
  for (const [key, file] of Object.entries(B.BUILTIN_KEY_FILES)) {
    const full = join(DIR, file)
    ok(existsSync(full), `${key} → ${file} 不存在`)
    const head = readFileSync(full).subarray(0, 6).toString("latin1")
    ok(head === "GIF89a" || head === "GIF87a", `${key} → ${file} 不是 GIF（magic=${head}）`)
  }
})
await test("素材目录带齐 100 张 + 许可文件", () => {
  const status = B.builtinStatus(DIR)
  ok(status.exists, "素材目录不存在")
  eq(status.count, 100, "GIF 数量")
  eq(status.mapped, 40, "已映射数量")
  eq(status.missing.length, 0, "缺失映射文件：" + status.missing.join(","))
  ok(status.bytes > 3 * 1024 * 1024, "素材体积看着不对：" + status.bytes)
  ok(existsSync(join(DIR, "NOTICE.txt")), "缺 NOTICE.txt（CC BY-NC-SA 4.0 署名要求）")
  ok(existsSync(join(DIR, "catalog.json")), "缺 catalog.json")
})
await test("许可元信息正确", () => {
  eq(B.BUILTIN_PACK.license, "CC BY-NC-SA 4.0", "许可协议")
  ok(B.BUILTIN_PACK.source.includes("ai-biaoqingbao"), "来源链接")
})

group("名字解析（安全）")
await test("语义 key 能解析到文件", () => {
  const full = B.resolveBuiltinAsset("hug")
  ok(full && full.endsWith("010.gif"), "hug 应解析到 010.gif，实际 " + full)
})
await test("三位编号也能解析", () => {
  ok(B.resolveBuiltinAsset("100"), "编号 100 解析失败")
  ok(B.resolveBuiltinAsset("1"), "编号 1 应等价 001")
})
await test("带 .gif 后缀也能解析", () => {
  ok(B.resolveBuiltinAsset("happy.gif"), "带后缀解析失败")
})
await test("越界与未知名字一律拒绝", () => {
  for (const bad of ["../package.json", "..%2F..%2Fetc", "nope", "", null, "a/b", "999"]) {
    const got = B.resolveBuiltinAsset(bad)
    if (bad === "999") {
      ok(got === null, "999 不存在却解析出来了")
      continue
    }
    ok(got === null, `${JSON.stringify(bad)} 不该解析出来，实际 ${got}`)
  }
})

group("URL 与 markdown")
await test("URL 拼装正确", () => {
  eq(B.builtinEmojiUrl(59635, "hug"), "http://127.0.0.1:59635/api/dsh-shared-brain/emoji/hug.gif")
})
await test("markdown 用中文名当 alt", () => {
  const md = B.builtinEmojiMarkdown(59635, "hug")
  ok(md.startsWith("![抱抱]("), "alt 不是中文名：" + md)
  ok(md.includes("/emoji/hug.gif"), "URL 不对：" + md)
})

group("提示词片段")
await test("off 模式不给表情", () => {
  eq(B.renderBuiltinEmojiHint({ mode: "off", limit: 3, keys: ["hug"] }, 59635), "")
})
await test("没有端口就不给（拿不到端口别瞎编）", () => {
  eq(B.renderBuiltinEmojiHint({ mode: "auto", limit: 3, keys: ["hug"] }, 0), "")
  eq(B.renderBuiltinEmojiHint({ mode: "auto", limit: 3, keys: ["hug"] }, undefined), "")
})
await test("按 limit 截断，且都是现成 markdown", () => {
  const hint = B.renderBuiltinEmojiHint({ mode: "auto", limit: 2, keys: ["hug", "sigh", "cheer"] }, 59635)
  ok(hint.includes("![抱抱](http://127.0.0.1:59635/api/dsh-shared-brain/emoji/hug.gif)"), "缺抱抱 markdown")
  ok(hint.includes("![好累]("), "缺好累 markdown")
  ok(!hint.includes("加油"), "超过 limit 的 key 不该出现")
  ok(hint.includes("一轮最多 2 个"), "没说明上限")
})
await test("空 keys 直接空串", () => {
  eq(B.renderBuiltinEmojiHint({ mode: "auto", limit: 3, keys: [] }, 59635), "")
})

group("静态路由行为")
function fakeRequest({ method = "GET", url = "/", remote = "127.0.0.1" } = {}) {
  return { method, url, socket: { remoteAddress: remote } }
}
function fakeResponse() {
  const state = { status: 0, headers: null, chunks: [], ended: false }
  const stream = new Writable({
    write(chunk, _enc, cb) {
      state.chunks.push(chunk)
      cb()
    },
  })
  const response = Object.assign(stream, {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
      return response
    },
    end(body) {
      state.ended = true
      if (body !== undefined) state.chunks.push(Buffer.from(String(body)))
      return Writable.prototype.end.call(stream)
    },
  })
  return { response, state }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

group("路由：正常取图")
await test("GET 命中：200 + image/gif + content-length", async () => {
  const { response, state } = fakeResponse()
  const handled = B.handleBuiltinEmojiRequest(fakeRequest({ url: "/api/dsh-shared-brain/emoji/hug.gif" }), response)
  await settle()
  ok(handled, "handler 应该返回 true")
  eq(state.status, 200, "状态码")
  eq(state.headers["content-type"], "image/gif", "content-type")
  const expectSize = statSync(B.resolveBuiltinAsset("hug")).size
  eq(Number(state.headers["content-length"]), expectSize, "content-length")
  ok(state.chunks.length > 0, "没有写任何字节")
  eq(state.chunks[0].subarray(0, 6).toString("latin1"), "GIF89a", "首字节")
})
await test("HEAD 命中：200 但不发 body", async () => {
  const { response, state } = fakeResponse()
  B.handleBuiltinEmojiRequest(fakeRequest({ method: "HEAD", url: "/api/dsh-shared-brain/emoji/010.gif" }), response)
  await settle()
  eq(state.status, 200, "状态码")
  eq(state.chunks.length, 0, "HEAD 不该有 body")
  ok(state.ended, "没有结束响应")
})

group("路由：该拒绝的都拒绝")
await test("未知名字 → 404", async () => {
  const { response, state } = fakeResponse()
  B.handleBuiltinEmojiRequest(fakeRequest({ url: "/api/dsh-shared-brain/emoji/nope.gif" }), response)
  await settle()
  eq(state.status, 404, "状态码")
})
await test("非 .gif → 404", async () => {
  const { response, state } = fakeResponse()
  B.handleBuiltinEmojiRequest(fakeRequest({ url: "/api/dsh-shared-brain/emoji/hug.png" }), response)
  await settle()
  eq(state.status, 404, "状态码")
})
await test("越界路径 → 404", async () => {
  const { response, state } = fakeResponse()
  B.handleBuiltinEmojiRequest(fakeRequest({ url: "/api/dsh-shared-brain/emoji/..%2F..%2Fpackage.json" }), response)
  await settle()
  eq(state.status, 404, "状态码")
})
await test("前缀外的路径 → 404", async () => {
  const { response, state } = fakeResponse()
  B.handleBuiltinEmojiRequest(fakeRequest({ url: "/api/other/hug.gif" }), response)
  await settle()
  eq(state.status, 404, "状态码")
})
await test("非 GET/HEAD → 405", async () => {
  const { response, state } = fakeResponse()
  B.handleBuiltinEmojiRequest(fakeRequest({ method: "POST", url: "/api/dsh-shared-brain/emoji/hug.gif" }), response)
  await settle()
  eq(state.status, 405, "状态码")
})
await test("非本机回环 → 403", async () => {
  const { response, state } = fakeResponse()
  B.handleBuiltinEmojiRequest(fakeRequest({ remote: "10.0.0.7", url: "/api/dsh-shared-brain/emoji/hug.gif" }), response)
  await settle()
  eq(state.status, 403, "状态码")
})

group("与插件接线")
await test("index.js 注册了 prefix 路由", () => {
  const src = readFileSync(join(LIB, "index.js"), "utf8")
  ok(src.includes("kind: 'prefix'"), "没找到 prefix 路由")
  ok(src.includes("BUILTIN_EMOJI_ROUTE"), "没引用路由前缀常量")
  ok(src.includes("handleBuiltinEmojiRequest"), "没接 handler")
})
await test("心情上下文里会拼内置表情 markdown", () => {
  const src = readFileSync(join(LIB, "index.js"), "utf8")
  ok(src.includes("renderBuiltinEmojiHint(proposal, port)"), "没调用 renderBuiltinEmojiHint")
  ok(src.includes("ctx?.get?.('webServer')?.port"), "没从宿主取端口")
})

group("设置页与状态显示")
await test("client.js 表情卡片会显示内置包", () => {
  const s = readFileSync(join(LIB, "client.js"), "utf8")
  ok(s.includes("emojiBuiltin"), "缺 emojiBuiltin 文案")
  ok(s.includes("emoji-builtin"), "缺内置包那行 JSX")
  ok(s.includes("emoji.builtin"), "没读状态里的 builtin")
})
await test("emoji.js 状态里带 builtin", () => {
  const s = readFileSync(join(LIB, "emoji.js"), "utf8")
  ok(s.includes("builtinStatus"), "emoji.js 没接 builtinStatus")
})

/* ------------------------------------------------------------------ */
/* P1-4 表情包校验（2026-11-03）                                        */
/* ------------------------------------------------------------------ */

group("表情包校验")

// 造一个最小合法 PNG（真彩色 8bit + deflate + CRC32）
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n += 1) {
    c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function makePng(width = 8, height = 8) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const PACK_ROOT = mkdtempSync(join(tmpdir(), "sb-pack-"))
function makePack(id, { keySet = "dsh-emoji-core@1", keys = ["happy", "hug"], bad = null } = {}) {
  const dir = join(PACK_ROOT, id)
  mkdirSync(join(dir, "images"), { recursive: true })
  wfs(join(dir, "pack.json"), JSON.stringify({ schemaVersion: 1, keySet, id, name: id, version: "1.0.0" }))
  for (const key of keys) {
    if (bad === "notpng" && key === keys[0]) {
      wfs(join(dir, "images", `${key}.png`), "这不是 PNG")
      continue
    }
    if (bad === "huge" && key === keys[0]) {
      wfs(join(dir, "images", `${key}.png`), makePng(2048, 2048))
      continue
    }
    wfs(join(dir, "images", `${key}.png`), makePng())
  }
  return dir
}

await test("合格的包能通过校验", () => {
  const dir = makePack("good-pack")
  const manifest = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"))
  const checked = E.validateEmojiPack(dir, manifest, ["happy", "hug"])
  ok(checked.ok, "好包应该通过：" + JSON.stringify(checked.problems))
  eq(checked.keys.length, 2, "两个 key")
  eq(checked.problems.length, 0, "没毛病")
})

await test("keySet 不对 → 不合格并说清原因", () => {
  const dir = makePack("wrong-keyset", { keySet: "other@9" })
  const manifest = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"))
  const checked = E.validateEmojiPack(dir, manifest, ["happy"])
  ok(!checked.ok, "keySet 不对就不该通过")
  ok(checked.problems.some((p) => p.includes("keySet")), "要说明 keySet 不对：" + JSON.stringify(checked.problems))
})

await test("图不是 PNG → 不合格", () => {
  const dir = makePack("bad-png", { bad: "notpng" })
  const manifest = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"))
  const checked = E.validateEmojiPack(dir, manifest, ["happy", "hug"])
  ok(!checked.ok, "坏图不该通过")
  ok(checked.problems.some((p) => p.includes("PNG")), "要说明不是 PNG：" + JSON.stringify(checked.problems))
})

await test("图太大 → 不合格", () => {
  const dir = makePack("huge-png", { bad: "huge" })
  const manifest = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"))
  const checked = E.validateEmojiPack(dir, manifest, ["happy", "hug"])
  ok(!checked.ok, "超大图不该通过")
  ok(checked.problems.some((p) => p.includes("尺寸")), "要说明尺寸太大：" + JSON.stringify(checked.problems))
})

await test("scanEmojiPacks 把坏包踢进 rejected，好包照收", () => {
  makePack("aa-good")
  makePack("bb-bad", { bad: "notpng" })
  const info = E.scanEmojiPacks(PACK_ROOT)
  const ids = info.packs.map((p) => p.id)
  ok(ids.includes("aa-good"), "好包要留下")
  ok(!ids.includes("bb-bad"), "坏包不该被引用")
  ok(Array.isArray(info.rejected), "rejected 要是数组")
  ok(info.rejected.some((r) => r.id === "bb-bad"), "坏包要记进 rejected")
  ok(info.rejected.find((r) => r.id === "bb-bad").problems.length > 0, "要带毛病说明")
})

await test("状态里带 packsRejected，设置页能显示", () => {
  const src = readFileSync(join(LIB, "emoji.js"), "utf8")
  ok(src.includes("packsRejected"), "emojiStatus 少 packsRejected")
  const cli = readFileSync(join(LIB, "client.js"), "utf8")
  ok(cli.includes("emojiPacksRejected"), "设置页少不合格包的文案")
  ok(cli.includes("emoji-rejected-box"), "设置页少不合格包的区块")
})

try {
  const { closeDb } = await import('../lib/db.js')
  closeDb()
} catch {
  /* 没有 db.js 就跳过 */
}
try {
  rmSync(PACK_ROOT, { recursive: true, force: true })
} catch {
  /* Windows 上 WAL 可能还被持有，清理失败不影响测试结论 */
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  console.log("\n失败明细：")
  for (const line of fails) console.log(" -", line)
}
process.exit(failed > 0 ? 1 : 0)
