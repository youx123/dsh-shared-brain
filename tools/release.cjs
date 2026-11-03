#!/usr/bin/env node
/**
 * 一键发版：改版本号 → 同步 → 全量测试 → 打包 tgz → 提交打标签 → （可选）推送并建 Release。
 *
 * 默认**只是彩排**：把每一步要做什么打出来，一个字节都不写、一个请求都不发。
 * 真发版必须显式加 --push。这是故意的 —— 发版是对外不可逆的操作，
 * 不能因为手滑跑了一次脚本就把东西推出去。
 *
 * 用法：
 *   node tools/release.cjs                    # 彩排（读当前版本，列出步骤）
 *   node tools/release.cjs --version 0.10.0   # 彩排 + 显示会改成 0.10.0
 *   node tools/release.cjs --version 0.10.0 --push
 *   node tools/release.cjs --push             # 用当前版本号真发（已发过会报错）
 *
 * 其它参数：
 *   --repo youx123/dsh-shared-brain   仓库（默认这个）
 *   --skip-tests                      跳过测试（不建议）
 *   --no-commit                       只打包，不提交（调试用）
 *
 * 依赖：git（取 credential 里的 token）、node。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const HOME = os.homedir()
const ARGS = process.argv.slice(2)

function arg(name, fallback = '') {
  const i = ARGS.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = ARGS[i + 1]
  if (!next || next.startsWith('--')) return true
  return next
}
const flag = (name) => ARGS.includes(`--${name}`)

const DRY = !flag('push')
const VERSION = String(arg('version', '') || '')
const REPO = String(arg('repo', 'youx123/dsh-shared-brain'))
const SKIP_TESTS = flag('skip-tests')
const NO_COMMIT = flag('no-commit')

const INSTALL = process.env.SB_INSTALL || path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-shared-brain')
const PATCHES = process.env.SB_PATCHES || path.resolve(__dirname, '..')
const WORK = process.env.SB_REPO || 'D:/tmp/dsh-shared-brain'
const VENDOR = process.env.SB_VENDOR || path.join(HOME, '.dsh', 'profiles', 'desktop', 'vendor')

const steps = []
function step(title, fn) {
  steps.push({ title, fn })
}

function log(msg) {
  console.log(msg)
}
function head(msg) {
  console.log(`\n── ${msg} ──`)
}

function run(cmd, args, opts = {}) {
  if (DRY && !opts.allowInDry) {
    log(`    [彩排] ${cmd} ${args.join(' ')}`)
    return ''
  }
  log(`    $ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/** 从 git credential 里取 token（不落盘、不打印）。 */
function githubToken() {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    })
    const line = out.split(/\r?\n/).find((l) => l.startsWith('password='))
    return line ? line.slice('password='.length).trim() : ''
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* 步骤                                                                */
/* ------------------------------------------------------------------ */

step('检查环境', () => {
  for (const [label, dir] of [
    ['安装目录', INSTALL],
    ['补丁源', PATCHES],
    ['仓库', WORK],
  ]) {
    if (!fs.existsSync(dir)) throw new Error(`找不到${label}：${dir}`)
    log(`    ✓ ${label} ${dir}`)
  }
  if (!fs.existsSync(VENDOR)) log(`    · vendor 目录还没有，打包时会建：${VENDOR}`)
})

step('确定版本号', () => {
  const pkgFile = path.join(INSTALL, 'package.json')
  const pkg = readJson(pkgFile)
  const from = pkg.version
  const to = VERSION || from
  if (!/^\d+\.\d+\.\d+$/.test(to)) throw new Error(`版本号格式不对：${to}`)
  if (VERSION && to !== from) {
    log(`    版本号：${from} → ${to}`)
    if (!DRY) {
      for (const file of [pkgFile, path.join(WORK, 'package.json')]) {
        if (!fs.existsSync(file)) continue
        const data = readJson(file)
        data.version = to
        writeJson(file, data)
      }
    }
  } else {
    log(`    版本号：${to}`)
  }
  process.env.REL_VERSION = to
})

step('同步代码到补丁源 / 仓库', () => {
  run(process.execPath, [path.join(PATCHES, 'tools', 'dev.cjs'), 'sync'], { allowInDry: true })
})

step('全量测试', () => {
  if (SKIP_TESTS) {
    log('    · 按参数跳过')
    return
  }
  // 测试必须真跑（彩排也要跑）—— 测试是只读的，不产生副作用
  execFileSync(process.execPath, [path.join(PATCHES, 'tools', 'dev.cjs'), 'test'], {
    stdio: 'inherit',
    encoding: 'utf8',
  })
})

step('打 tgz', () => {
  const version = process.env.REL_VERSION
  if (DRY) {
    log(`    [彩排] 会生成 ${path.join(VENDOR, `dsh-shared-brain-${version}.tgz`)}`)
    return
  }
  fs.mkdirSync(VENDOR, { recursive: true })
  const out = execFileSync(process.execPath, [path.join(PATCHES, 'tools', 'mktgz-versioned.cjs')], { encoding: 'utf8' })
  log(out.split('\n').map((l) => `    ${l}`).join('\n'))
  const tgz = path.join(VENDOR, `dsh-shared-brain-${version}.tgz`)
  if (!fs.existsSync(tgz)) throw new Error(`没有打包出 ${tgz}`)
  process.env.REL_TGZ = tgz
  log(`    ✓ ${tgz}（${fs.statSync(tgz).size} 字节）`)
})

step('提交 + 打标签', () => {
  if (NO_COMMIT) {
    log('    · 按参数跳过')
    return
  }
  const version = process.env.REL_VERSION
  const status = run('git', ['status', '--porcelain'], { cwd: WORK, allowInDry: true })
  if (!status && DRY) log('    [彩排] 工作区干净')
  run('git', ['add', '-A'], { cwd: WORK })
  run('git', ['commit', '-m', `release: v${version}`], { cwd: WORK })
  // 仓库里有历史 tgz，把这次的一起放进版本提交
  if (!DRY && process.env.REL_TGZ) {
    fs.copyFileSync(process.env.REL_TGZ, path.join(WORK, path.basename(process.env.REL_TGZ)))
    run('git', ['add', path.basename(process.env.REL_TGZ)], { cwd: WORK })
    run('git', ['commit', '-m', `release: v${version} tgz`], { cwd: WORK })
  }
  run('git', ['tag', '-a', `v${version}`, '-m', `v${version}`], { cwd: WORK })
})

step('推送到 GitHub', () => {
  if (DRY) {
    log(`    [彩排] git push origin main && git push origin v${process.env.REL_VERSION}`)
    log('    [彩排] 真推要加 --push（这一步是对外不可逆的）')
    return
  }
  run('git', ['push', 'origin', 'HEAD:main'], { cwd: WORK })
  run('git', ['push', 'origin', `v${process.env.REL_VERSION}`], { cwd: WORK })
})

step('建 Release + 传附件', () => {
  const version = process.env.REL_VERSION
  if (DRY) {
    log(`    [彩排] 会给 ${REPO} 建 Release v${version} 并上传 ${path.basename(process.env.REL_TGZ || `dsh-shared-brain-${version}.tgz`)}`)
    return
  }
  const token = githubToken()
  if (!token) throw new Error('取不到 GitHub token（git credential fill 为空），先确认本机凭据还在')

  const body = `## dsh-shared-brain v${version}\n\n见 FIXES.md 的对应小节。\n`
  const create = fetchJson(`https://api.github.com/repos/${REPO}/releases`, token, 'POST', {
    tag_name: `v${version}`,
    name: `v${version}`,
    body,
    draft: false,
    prerelease: false,
  })
  log(`    ✓ Release: ${create.html_url}`)

  // 附件必须带 content-length，否则 GitHub 会挂住不返回（踩过）
  const tgz = process.env.REL_TGZ
  const name = path.basename(tgz)
  const bytes = fs.readFileSync(tgz)
  const res = fetchRaw(
    `https://uploads.github.com/repos/${REPO}/releases/${create.id}/assets?name=${encodeURIComponent(name)}`,
    token,
    'POST',
    bytes,
    { 'content-type': 'application/gzip', 'content-length': String(bytes.length) },
  )
  if (res.status >= 300) throw new Error(`传附件失败：HTTP ${res.status} ${res.text.slice(0, 200)}`)
  log(`    ✓ 附件 ${name}（${bytes.length} 字节）`)
})

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

function fetchRaw(url, token, method, body, extraHeaders = {}) {
  // 用同步方式发请求：脚本是一次性流程，用 Atomics 等同步 HTTP 太绕，
  // 这里直接走 node 的 http 模块 + child helper 太麻烦 —— 改用 spawnSync 起
  // 一个一次性的 node -e。简单、可读、出错能看到状态码。
  const payload = body && Buffer.isBuffer(body) ? body.toString('base64') : ''
  const json = body && !Buffer.isBuffer(body) ? JSON.stringify(body) : ''
  const code = `
const https = require('https')
const url = ${JSON.stringify(url)}
const headers = Object.assign({ authorization: 'Bearer ' + ${JSON.stringify(token)}, 'user-agent': 'dsh-shared-brain-release', accept: 'application/vnd.github+json' }, ${JSON.stringify(extraHeaders)})
const body = ${JSON.stringify(json)} ? Buffer.from(${JSON.stringify(json)}) : (${JSON.stringify(payload)} ? Buffer.from(${JSON.stringify(payload)}, 'base64') : null)
const req = https.request(url, { method: ${JSON.stringify(method)}, headers }, (res) => {
  const chunks = []
  res.on('data', (c) => chunks.push(c))
  res.on('end', () => {
    process.stdout.write(JSON.stringify({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
  })
})
req.on('error', (e) => { process.stdout.write(JSON.stringify({ status: 0, text: String(e && e.message) })); })
if (body) req.write(body)
req.end()
`
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(out)
}

function fetchJson(url, token, method, body) {
  const res = fetchRaw(url, token, method, body)
  if (res.status >= 300) throw new Error(`GitHub ${method} ${url} → HTTP ${res.status}: ${res.text.slice(0, 300)}`)
  return JSON.parse(res.text)
}

/* ------------------------------------------------------------------ */
/* 跑                                                                  */
/* ------------------------------------------------------------------ */

function main() {
  log(`dsh-shared-brain 发版${DRY ? '（彩排，不写不推）' : '（真发版）'}`)
  for (const item of steps) {
    head(item.title)
    item.fn()
  }
  head('完成')
  if (DRY) {
    log('  以上都是彩排。确认没问题后加 --push 真发。')
  } else {
    log(`  v${process.env.REL_VERSION} 已发布：https://github.com/${REPO}/releases`)
  }
}

try {
  main()
} catch (err) {
  log(`\n发版中止：${err && err.message ? err.message : err}`)
  process.exitCode = 1
}
