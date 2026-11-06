const fs = require('fs')
const path = require('path')
const SRC = 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const DST = 'C:/Users/13176/Documents/dsh-shared-brain-patches/lib'
const files = ['proactive.js', 'index.js', 'commands.js', 'bridge.js', 'client.js']
for (const f of files) {
  const s = path.join(SRC, f)
  const d = path.join(DST, f)
  // 先把当前补丁源另存一份（保留上一版）
  if (fs.existsSync(d)) {
    const bak = d + '.bak-20261030-rand'
    fs.copyFileSync(d, bak)
  }
  fs.copyFileSync(s, d)
  const a = fs.readFileSync(s)
  const b = fs.readFileSync(d)
  console.log((a.equals(b) ? 'SAME ' : 'DIFF ') + f + '  ' + a.length + ' bytes')
}
