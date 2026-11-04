#!/usr/bin/env node
/**
 * 一条命令：把安装目录的代码同步到补丁源/仓库，然后跑全部回归测试。
 *
 * 为什么要有这个脚本：
 *   以前每次改完都得先 `node synclib.mjs` 同步三处，再挨个 node tests/*.test.mjs，
 *   忘了同步就会出现「我明明改了，测试还是老结果」这种最浪费时间的假象。
 *
 * 用法：
 *   node tools/dev.cjs           # 同步 + 跑全部测试（默认）
 *   node tools/dev.cjs sync      # 只同步
 *   node tools/dev.cjs test      # 只跑测试
 *   node tools/dev.cjs test emotion remote-sync   # 只跑指定几个
 *
 * 路径可用环境变量覆盖：
 *   SB_INSTALL  安装目录（默认 ~/.dsh/profiles/desktop/node_modules/dsh-shared-brain）
 *   SB_PATCHES  补丁源目录（默认本脚本上一级）
 *   SB_REPO     仓库目录（默认 D:/tmp/dsh-shared-brain；不存在就跳过那一步）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const HOME = os.homedir()

const INSTALL =
  process.env.SB_INSTALL || path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-shared-brain')
const PATCHES = process.env.SB_PATCHES || path.resolve(__dirname, '..')
const REPO = process.env.SB_REPO || 'D:/tmp/dsh-shared-brain'

/** 全部回归测试的顺序（harness 最后跑，它最慢）。 */
const SUITES = [
  'emotion',
  'audit-fixes',
  'audit-0101',
  'proactive-mood',
  'remote-sync',
  'persona-sync',
  'ui-render',
  'emoji-builtin',
  'perf',
  'tools',
]

function log(msg) {
  console.log(msg)
}

function mustDir(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`找不到${label}：${dir}（可用环境变量指定）`)
  }
  return dir
}

function syncLib() {
  const src = mustDir(path.join(INSTALL, 'lib'), '安装目录的 lib')
  const dsts = [path.join(PATCHES, 'lib')]
  if (fs.existsSync(REPO)) dsts.push(path.join(REPO, 'lib'))

  const files = fs.readdirSync(src).filter((f) => f.endsWith('.js'))
  for (const file of files) {
    const from = path.join(src, file)
    if (!fs.statSync(from).isFile()) continue
    for (const dst of dsts) {
      fs.mkdirSync(dst, { recursive: true })
      fs.copyFileSync(from, path.join(dst, file))
    }
  }
  log(`同步 lib：${files.length} 个文件 → ${dsts.length} 处`)
}

function syncTests() {
  const src = path.join(PATCHES, 'tests')
  if (!fs.existsSync(src)) {
    log('没有 tests 目录，跳过测试同步')
    return
  }
  const dst = path.join(REPO, 'test')
  if (!fs.existsSync(REPO)) {
    log('没有仓库目录，跳过测试同步')
    return
  }
  const files = fs.readdirSync(src).filter((f) => f.endsWith('.mjs'))
  fs.mkdirSync(dst, { recursive: true })
  for (const file of files) fs.copyFileSync(path.join(src, file), path.join(dst, file))
  log(`同步测试：${files.length} 个文件 → 仓库 test/`)
}

/** 工具脚本也同步一份进仓库，README 里写的 \`node tools/dev.cjs\` 才跑得起来。 */
function syncTools() {
  const src = path.join(PATCHES, 'tools')
  if (!fs.existsSync(src) || !fs.existsSync(REPO)) return
  const dst = path.join(REPO, 'tools')
  fs.mkdirSync(dst, { recursive: true })
  // 只同步「正经工具」——历史上那些一次性的 mktgz2 / upd-lock-097 / verify-* 留在补丁源就行
  const files = ['dev.cjs', 'release.cjs', 'mktgz-versioned.cjs'].filter((f) => fs.existsSync(path.join(src, f)))
  for (const file of files) fs.copyFileSync(path.join(src, file), path.join(dst, file))
  // 仓库里多出来的旧脚本清掉，别让人以为还在用
  for (const file of fs.readdirSync(dst)) {
    if (file.endsWith('.cjs') && !files.includes(file)) fs.rmSync(path.join(dst, file))
  }
  log(`同步工具：${files.length} 个脚本 → 仓库 tools/`)
}

/** 文档也同步一份进仓库（补丁源里改完别只在本地生效）。 */
function syncDocs() {
  if (!fs.existsSync(REPO)) return
  for (const rel of ['FIXES.md', 'README.md', 'docs/FIXES-archive.md']) {
    const from = path.join(PATCHES, rel)
    if (!fs.existsSync(from)) continue
    const to = path.join(REPO, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    log(`同步文档：${rel} → 仓库`)
  }
}

function syncAssets() {
  // assets/ 不常改，但改了不同步会出现「本地有图、仓库没图」的包
  const src = path.join(INSTALL, 'assets')
  if (!fs.existsSync(src) || !fs.existsSync(REPO)) return
  const dst = path.join(REPO, 'assets')
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true })
  log('同步 assets/ → 仓库')
}

/**
 * 跑一个测试文件，返回 { name, ok, passed, failed, ms, output }。
 * 测试脚本自己的「N 通过 / M 失败」是主要判据，退出码只兜底。
 */
function runSuite(name) {
  const file = path.join(PATCHES, 'tests', `${name}.test.mjs`)
  if (!fs.existsSync(file)) return { name, ok: false, missing: true }
  const t0 = Date.now()
  const res = spawnSync(process.execPath, [file], {
    cwd: PATCHES,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${res.stdout || ''}${res.stderr || ''}`
  const ms = Date.now() - t0
  const m = output.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/)
  const passed = m ? Number(m[1]) : 0
  const failed = m ? Number(m[2]) : res.status === 0 ? 0 : 1
  return { name, ok: failed === 0 && res.status === 0, passed, failed, ms, output }
}

function runHarness() {
  const file = path.join(PATCHES, 'tests', 'harness.js')
  const alt = path.join(REPO, 'test', 'harness.js')
  const target = fs.existsSync(file) ? file : fs.existsSync(alt) ? alt : ''
  if (!target) return { name: 'harness', ok: true, skipped: true, passed: 0, failed: 0, ms: 0, output: '' }
  const t0 = Date.now()
  const res = spawnSync(process.execPath, [target], {
    cwd: path.dirname(target),
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    name: 'harness',
    ok: res.status === 0,
    passed: res.status === 0 ? 1 : 0,
    failed: res.status === 0 ? 0 : 1,
    ms: Date.now() - t0,
    output: `${res.stdout || ''}${res.stderr || ''}`,
  }
}

function showFailures(result) {
  const lines = result.output.split(/\r?\n/)
  const idx = lines.findIndex((line) => /失败明细|失败：|AssertionError|Error:/.test(line))
  if (idx >= 0) {
    log(`\n── ${result.name} 失败片段 ──`)
    for (const line of lines.slice(idx, idx + 12)) log(`  ${line}`)
  }
}

function runTests(only = []) {
  const suites = only.length ? only : SUITES
  log(`\n跑测试：${suites.join(' / ')}${only.length ? '' : ' + harness'}\n`)

  const results = []
  for (const name of suites) {
    const started = Date.now()
    const result = runSuite(name)
    results.push(result)
    if (result.missing) {
      log(`  ${'✗'.padEnd(2)} ${name.padEnd(16)} 找不到测试文件`)
      continue
    }
    const mark = result.ok ? '✓' : '✗'
    log(`  ${mark.padEnd(2)} ${name.padEnd(16)} ${String(result.passed).padStart(3)} 通过  ${String(result.failed).padStart(2)} 失败  ${String(result.ms).padStart(5)}ms`)
    if (!result.ok) showFailures(result)
    void started
  }
  if (!only.length) {
    const h = runHarness()
    results.push(h)
    if (h.skipped) log(`  ·  harness          跳过（没找到）`)
    else log(`  ${(h.ok ? '✓' : '✗').padEnd(2)} harness          ${h.ok ? '全绿' : '有失败'}  ${String(h.ms).padStart(5)}ms`)
    if (!h.ok) showFailures(h)
  }

  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0)
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0)
  const bad = results.filter((r) => !r.ok)
  log(`\n合计：${totalPassed} 通过 / ${totalFailed} 失败（${results.length} 个批次）`)
  if (bad.length) {
    log(`挂了：${bad.map((r) => r.name).join('、')}`)
    process.exitCode = 1
  } else {
    log('全绿 ✅')
  }
  return { totalPassed, totalFailed, bad: bad.map((r) => r.name) }
}

function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'all'
  const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv

  if (cmd === 'sync' || cmd === 'all') {
    syncLib()
    syncTests()
    syncAssets()
    syncTools()
    syncDocs()
  }
  if (cmd === 'test' || cmd === 'all') {
    runTests(cmd === 'test' ? rest : [])
  }
  if (!['sync', 'test', 'all'].includes(cmd)) {
    log(`不认识的命令：${cmd}\n用法：node tools/dev.cjs [sync|test|all] [测试名...]`)
    process.exitCode = 2
  }
}

try {
  main()
} catch (err) {
  log(`\n出错了：${err && err.message ? err.message : err}`)
  process.exitCode = 1
}
