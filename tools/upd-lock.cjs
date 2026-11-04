// 更新 pnpm-lock.yaml 里 0.9.7 tgz 的 integrity
const fs = require('fs')
const p = 'C:/Users/13176/.dsh/profiles/desktop/pnpm-lock.yaml'
const OLD = 'sha512-DC5XH4PBP6gMvrxMIXPrxeFwR/Qwx+C57zM+boHi6A9Za+dEoodIGAL7AmC+D9ASl0ZMDy45g6XRA2oUsnffbg=='
const NEW = 'sha512-vf2YWVw27b8LiSs7A+vTY3H6RD7uHmq9r0q2ZaLS12Z9nYU5i0z2CDFEa173UyimVavKbCehLbql9V/dwd3vbg=='

let s = fs.readFileSync(p, 'utf8')
const parts = s.split(OLD)
console.log('old integrity occurrences:', parts.length - 1)
if (parts.length - 1 === 0) {
  console.log('没找到旧 integrity，退出')
  process.exit(1)
}
s = parts.join(NEW)
fs.writeFileSync(p, s)
console.log('new integrity occurrences:', s.split(NEW).length - 1)
