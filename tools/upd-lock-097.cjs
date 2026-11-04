// 更新 pnpm-lock.yaml 里 0.9.7 tgz 的 integrity（本次「心情驱动自动互动」改动后的新值）
const fs = require('fs')
const p = 'C:/Users/13176/.dsh/profiles/desktop/pnpm-lock.yaml'
const OLD = 'sha512-W65gAfxSb9X3ScXbXj8cERw1UHV0d8gF5nwf3hkzP2/vEjO1uqh7DwhxQkT7qe2rPnrvRBal2kpk95kMH9AEsQ=='
const NEW = 'sha512-vFvIWgvlujIcDTw15eEmJ7L2tR2WR7Pp8fahGMqFOnlx/lsGhJFcSDQSWZ3awWVTTX3zlYChz3B+nazXk26sGA=='

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
