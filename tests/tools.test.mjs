/**
 * 工具链自测：一条命令同步+跑测（tools/dev.cjs）和一键发版（tools/release.cjs）。
 *
 * 这两个脚本本身最容易「看起来像在工作」——发版脚本要是默认就真推，
 * 手滑一次就把东西发出去了。所以这里重点测三件事：
 *   1. 语法没坏（node --check）
 *   2. 发版默认是彩排：不写盘、不推、不改版本号
 *   3. 彩排的输出里必须明确写出「彩排」和「要加 --push」
 *
 * 跑法：node tests/tools.test.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const NODE = process.execPath

let passed = 0
let failed = 0
const failures = []

function group(name) {
  console.log('\n' + name)
}

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (err) {
    failed += 1
    failures.push({ name, error: err })
    console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err))
  }
}

function ok(value, msg) {
  if (!value) throw new Error(msg || '期望为真')
}

function equal(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

function check(file) {
  const res = spawnSync(NODE, ['--check', join(ROOT, 'tools', file)], { encoding: 'utf8' })
  return { status: res.status, err: `${res.stdout || ''}${res.stderr || ''}` }
}

function runRelease(args) {
  const res = spawnSync(NODE, [join(ROOT, 'tools', 'release.cjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}` }
}

group('tools：脚本存在且语法正确')

test('tools/dev.cjs 存在且能过 node --check', () => {
  ok(existsSync(join(ROOT, 'tools', 'dev.cjs')), '没有 tools/dev.cjs')
  const res = check('dev.cjs')
  equal(res.status, 0, 'dev.cjs 语法错：' + res.err)
})

test('tools/release.cjs 存在且能过 node --check', () => {
  ok(existsSync(join(ROOT, 'tools', 'release.cjs')), '没有 tools/release.cjs')
  const res = check('release.cjs')
  equal(res.status, 0, 'release.cjs 语法错：' + res.err)
})

test('tools/mktgz-versioned.cjs 存在且能过 node --check', () => {
  ok(existsSync(join(ROOT, 'tools', 'mktgz-versioned.cjs')), '没有 tools/mktgz-versioned.cjs')
  const res = check('mktgz-versioned.cjs')
  equal(res.status, 0, 'mktgz 语法错：' + res.err)
})

group('tools：发版脚本默认只彩排')

test('不加 --push 跑一遍：退出码 0，输出里有「彩排」和「--push」', () => {
  const { status, out } = runRelease(['--skip-tests'])
  equal(status, 0, '彩排该成功退出：' + out.slice(-400))
  ok(out.includes('彩排'), '输出里该明确写着彩排')
  ok(out.includes('--push'), '该提示真发要加 --push')
})

test('彩排不改版本号、不动 package.json 的修改时间', () => {
  const pkgFile = join(ROOT, 'package.json')
  const before = readFileSync(pkgFile, 'utf8')
  const mtimeBefore = statSync(pkgFile).mtimeMs
  runRelease(['--skip-tests', '--version', '0.10.0'])
  const after = readFileSync(pkgFile, 'utf8')
  equal(after, before, '彩排不该改 package.json 内容')
  equal(statSync(pkgFile).mtimeMs, mtimeBefore, '彩排不该碰文件')
})

test('彩排输出里列出六步（版本 / 同步 / 测试 / 打包 / 提交 / 推送 / Release）', () => {
  const { out } = runRelease(['--skip-tests'])
  for (const step of ['确定版本号', '同步代码', '打 tgz', '提交 + 打标签', '推送到 GitHub', '建 Release']) {
    ok(out.includes(step), `彩排输出里缺「${step}」这一步`)
  }
})

test('没加 --push 时，彩排不会去取 token（离线安全）', () => {
  const { out } = runRelease(['--skip-tests'])
  ok(!out.includes('取不到 GitHub token'), '彩排不该走到需要 token 那一步')
})

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败')
if (failed > 0) {
  for (const item of failures) {
    console.log('\n失败：' + item.name)
    console.log(item.error && item.error.stack ? item.error.stack : item.error)
  }
  process.exit(1)
}
