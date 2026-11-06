// 校验新 tgz：解包检查文件数与关键标记
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const os = require('os')

const TGZ = 'C:/Users/13176/.dsh/profiles/desktop/vendor/dsh-shared-brain-0.9.7.tgz'
const buf = zlib.gunzipSync(fs.readFileSync(TGZ))
let off = 0
const files = {}
while (off + 512 <= buf.length) {
  const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '')
  const sizeStr = buf.toString('ascii', off + 124, off + 136).replace(/\0.*$/, '').trim()
  if (!name) break
  const size = parseInt(sizeStr, 8) || 0
  const typeflag = buf.toString('ascii', off + 156, off + 157)
  off += 512
  if (typeflag === '0' || typeflag === '') {
    files[name] = buf.slice(off, off + size)
  }
  off += Math.ceil(size / 512) * 512
}
console.log('解出文件数:', Object.keys(files).length)
const libFiles = Object.keys(files).filter((f) => f.startsWith('package/lib/'))
console.log('lib 文件数:', libFiles.length)
const missing = ['package/package.json','package/README.md','package/LICENSE','package/cordis.patch.yml'].filter((f) => !files[f])
console.log('元文件缺失:', missing.length ? missing.join(', ') : '无')

const p = files['package/lib/proactive.js'].toString('utf8')
const marks = {
  'PROACTIVE_INTERVAL_JITTER': p.includes('PROACTIVE_INTERVAL_JITTER'),
  'randomizeInterval': p.includes('export function randomizeInterval'),
  'nonce 提示词': p.includes('本次检查编号'),
  'setTimeout 链': p.includes('timer = setTimeout('),
  'clearTimeout': p.includes('clearTimeout(timer)'),
}
console.log('proactive.js 标记:', JSON.stringify(marks, null, 0))

const idx = files['package/lib/index.js'].toString('utf8')
console.log('index.js import JITTER:', idx.includes('PROACTIVE_INTERVAL_JITTER,'))
console.log('index.js 随机日志:', idx.includes('分钟之间随机'))

const cmd = files['package/lib/commands.js'].toString('utf8')
console.log('commands.js 随机文案:', cmd.includes('分钟之间随机'))

const br = files['package/lib/bridge.js'].toString('utf8')
console.log('bridge.js 随机文案:', br.includes('分钟之间随机'))

const cl = files['package/lib/client.js'].toString('utf8')
console.log('client.js 新文案键:', cl.includes('proactiveIntervalHint'), cl.includes('proactiveNextFire'))
