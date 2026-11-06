// 重新实现 tar header 的 checksum（正确算法：字段本身按空格计为 8 字节）
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// 用法: node mktgz2.cjs  —— 从「已安装目录」打包成 vendor 里的 tgz
// 注意: 打包前必须先把补丁同步进 node_modules，否则打出来的包会退回官方版
const LIBDIR = 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain'
const OUT = 'C:/Users/13176/.dsh/profiles/desktop/vendor/dsh-shared-brain-0.9.7.tgz'

function tarHeader(name, size, mode, type, mtime) {
  const buf = Buffer.alloc(512, 0)
  buf.write(name.slice(0, 100), 0, 'utf8')
  // mode: 7 位八进制 + NUL
  buf.write((mode || '0000644') + '\0', 100, 'ascii')
  // uid/gid: 8 位八进制 + NUL
  buf.write('0000000\0', 108, 'ascii')
  buf.write('0000000\0', 116, 'ascii')
  // size: 11 位八进制 + NUL
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  // mtime: 11 位八进制 + NUL
  buf.write((mtime || 0).toString(8).padStart(11, '0') + '\0', 136, 'ascii')
  // checksum 字段先填 8 个空格
  buf.write('        ', 148, 'ascii')
  // typeflag
  buf.write(type === 'dir' ? '5' : '0', 156, 'ascii')
  // magic "ustar\0" + version "00"
  buf.write('ustar\0', 257, 'ascii')
  buf.write('00', 263, 'ascii')
  // uname/gname
  buf.write('root\0', 265, 'ascii')
  buf.write('root\0', 297, 'ascii')

  // 计算 checksum：所有字节之和（checksum 字段按 8 个空格算）
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  const chk = sum.toString(8).padStart(6, '0') + '\0 '
  buf.write(chk, 148, 'ascii')
  return buf
}

function addFile(blocks, arcname, content, mode, mtime) {
  blocks.push(tarHeader(arcname, content.length, mode, 'file', mtime))
  blocks.push(content)
  const pad = (512 - (content.length % 512)) % 512
  if (pad) blocks.push(Buffer.alloc(pad))
}
function addDir(blocks, arcname, mtime) {
  blocks.push(tarHeader(arcname, 0, '0000755', 'dir', mtime))
}

const blocks = []
const entries = []
const libDir = path.join(LIBDIR, 'lib')
const libFiles = fs.readdirSync(libDir).filter((f) => f.endsWith('.js')).sort()
for (const f of libFiles) entries.push({ arc: 'package/lib/' + f, real: path.join(libDir, f) })
for (const f of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']) {
  const p = path.join(LIBDIR, f)
  if (fs.existsSync(p)) entries.push({ arc: 'package/' + f, real: p })
}

const MTIME = Math.floor(Date.now() / 1000)
addDir(blocks, 'package/', MTIME)
addDir(blocks, 'package/lib/', MTIME)
for (const e of entries) {
  const st = fs.statSync(e.real)
  addFile(blocks, e.arc, fs.readFileSync(e.real), '0000644', Math.floor(st.mtimeMs / 1000))
}
blocks.push(Buffer.alloc(1024))

const tar = Buffer.concat(blocks)
const gz = zlib.gzipSync(tar, { level: 9 })
fs.writeFileSync(OUT, gz)
console.log('wrote', OUT, gz.length, 'bytes,', entries.length, 'files')

const crypto = require('crypto')
console.log('integrity: sha512-' + crypto.createHash('sha512').update(gz).digest('base64'))
