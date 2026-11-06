// 重新打 dsh-shared-brain-0.9.7.tgz：把当前安装目录（已含随机间隔修复）的 lib + 元文件打包
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const LIBDIR = 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain'
const OUT = 'C:/Users/13176/.dsh/profiles/desktop/vendor/dsh-shared-brain-0.9.7.tgz'

function tarHeader(name, size, mode, type) {
  const buf = Buffer.alloc(512)
  buf.write(name.slice(0, 100), 0, 'utf8')
  buf.write((mode || '0000644').padStart(7, '0') + '\0', 100, 'ascii')
  buf.write('0000000\0', 108, 'ascii')
  buf.write('0000000\0', 116, 'ascii')
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  buf.write('00000000000\0', 136, 'ascii')
  buf.write(type === 'dir' ? '5' : '0', 156, 'ascii')
  // checksum: 前 8 字节留空
  let sum = 0
  for (const b of buf) sum += b
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return buf
}

function addFile(blocks, arcname, content, mode) {
  blocks.push(tarHeader(arcname, content.length, mode, 'file'))
  blocks.push(content)
  const pad = (512 - (content.length % 512)) % 512
  if (pad) blocks.push(Buffer.alloc(pad))
}
function addDir(blocks, arcname) {
  blocks.push(tarHeader(arcname, 0, '0000755', 'dir'))
}

const blocks = []
const entries = []
// package/ 目录下：package.json, README.md, LICENSE, cordis.patch.yml, lib/*.js
const libDir = path.join(LIBDIR, 'lib')
const libFiles = fs.readdirSync(libDir).filter((f) => f.endsWith('.js')).sort()
for (const f of libFiles) {
  entries.push({ arc: 'package/lib/' + f, real: path.join(libDir, f) })
}
for (const f of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']) {
  const p = path.join(LIBDIR, f)
  if (fs.existsSync(p)) entries.push({ arc: 'package/' + f, real: p })
}

addDir(blocks, 'package/')
addDir(blocks, 'package/lib/')
for (const e of entries) {
  addFile(blocks, e.arc, fs.readFileSync(e.real), '0000644')
}
// 结尾两块 0
blocks.push(Buffer.alloc(1024))

const tar = Buffer.concat(blocks)
const gz = zlib.gzipSync(tar, { level: 9 })

fs.writeFileSync(OUT, gz)
console.log('wrote', OUT, gz.length, 'bytes,', entries.length, 'files')

// 同时算 integrity（sha512 base64）
const crypto = require('crypto')
const integrity = 'sha512-' + crypto.createHash('sha512').update(gz).digest('base64')
console.log('integrity:', integrity)
