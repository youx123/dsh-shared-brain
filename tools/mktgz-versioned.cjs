// 按 package.json 的版本号打包：vendor/dsh-shared-brain-<version>.tgz
// 用法: node mktgz-versioned.cjs
// 注意: 打包前必须先把补丁同步进 node_modules，否则打出来的是旧代码
// 2026-11-03：加收 assets/（内置表情包 GIF，100 张约 3.4MB）
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')

// 默认按本机安装目录打包；换机器 / 从仓库直接打包时用环境变量覆盖：
//   SB_SRC=仓库根目录 SB_VENDOR=输出目录 node tools/mktgz-versioned.cjs
const os = require('os')
const LIBDIR =
  process.env.SB_SRC ||
  (process.env.SB_INSTALL || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-shared-brain'))
const VENDOR =
  process.env.SB_VENDOR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'vendor')

if (!fs.existsSync(path.join(LIBDIR, 'package.json'))) {
  console.error('找不到 package.json：', LIBDIR)
  process.exit(1)
}
if (!fs.existsSync(VENDOR)) fs.mkdirSync(VENDOR, { recursive: true })
const pkg = JSON.parse(fs.readFileSync(path.join(LIBDIR, 'package.json'), 'utf8'))
const OUT = path.join(VENDOR, `dsh-shared-brain-${pkg.version}.tgz`)

function tarHeader(name, size, mode, type, mtime) {
  const buf = Buffer.alloc(512, 0)
  buf.write(name.slice(0, 100), 0, 'utf8')
  buf.write((mode || '0000644') + '\0', 100, 'ascii')
  buf.write('0000000\0', 108, 'ascii')
  buf.write('0000000\0', 116, 'ascii')
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  buf.write((mtime || 0).toString(8).padStart(11, '0') + '\0', 136, 'ascii')
  buf.write('        ', 148, 'ascii')
  buf.write(type === 'dir' ? '5' : '0', 156, 'ascii')
  buf.write('ustar\0', 257, 'ascii')
  buf.write('00', 263, 'ascii')
  buf.write('root\0', 265, 'ascii')
  buf.write('root\0', 297, 'ascii')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return buf
}

const dirs = []
const entries = []

const libDir = path.join(LIBDIR, 'lib')
for (const f of fs.readdirSync(libDir).filter((x) => x.endsWith('.js')).sort()) {
  entries.push({ arc: 'package/lib/' + f, real: path.join(libDir, f) })
}
for (const f of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']) {
  const p = path.join(LIBDIR, f)
  if (fs.existsSync(p)) entries.push({ arc: 'package/' + f, real: p })
}

// assets/ 递归收（内置表情包就住在这儿）
function walk(rel) {
  const abs = path.join(LIBDIR, rel)
  if (!fs.existsSync(abs)) return
  const stat = fs.statSync(abs)
  if (stat.isDirectory()) {
    dirs.push('package/' + rel + '/')
    for (const name of fs.readdirSync(abs).sort()) walk(rel + '/' + name)
    return
  }
  entries.push({ arc: 'package/' + rel, real: abs })
}
walk('assets')

const MTIME = Math.floor(Date.now() / 1000)
const blocks = []
blocks.push(tarHeader('package/', 0, '0000755', 'dir', MTIME))
blocks.push(tarHeader('package/lib/', 0, '0000755', 'dir', MTIME))
for (const d of dirs) blocks.push(tarHeader(d, 0, '0000755', 'dir', MTIME))

let totalBytes = 0
for (const e of entries) {
  const content = fs.readFileSync(e.real)
  totalBytes += content.length
  const mtime = Math.floor(fs.statSync(e.real).mtimeMs / 1000)
  blocks.push(tarHeader(e.arc, content.length, '0000644', 'file', mtime))
  blocks.push(content)
  const pad = (512 - (content.length % 512)) % 512
  if (pad) blocks.push(Buffer.alloc(pad))
}
blocks.push(Buffer.alloc(1024))

const gz = zlib.gzipSync(Buffer.concat(blocks), { level: 9 })
fs.writeFileSync(OUT, gz)
const integrity = 'sha512-' + crypto.createHash('sha512').update(gz).digest('base64')
console.log('wrote', OUT, gz.length, 'bytes,', entries.length, 'files,', dirs.length, 'dirs')
console.log('未压缩内容:', (totalBytes / 1048576).toFixed(2), 'MB')
console.log('integrity:', integrity)
