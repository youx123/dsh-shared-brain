
import { renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * 原子写：先写临时文件，再 rename 覆盖。
 *
 * 2026-11-11 修：Windows 上 rename 到「已被别的进程打开」的目标会抛 EPERM
 * （实测：harness 去写 ~/.cursor 的协调文件，而真插件正开着它）。以前这里
 * 一抛就把整轮流程打断。现在先重试几次，实在不行退回直接覆盖写 ——
 * 宁可极少数情况下不是原子的，也别让写盘失败把调用方带崩。
 *
 * @param {string} file 目标文件
 * @param {string} text 内容
 * @param {{ retries?: number, onFallback?: (error: Error) => void }} [options]
 * @returns {{ atomic: boolean }}
 */
export function writeFileAtomicSync(file, text, { retries = 3, onFallback } = {}) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  let lastError = null
  for (let attempt = 0; attempt < Math.max(1, retries); attempt += 1) {
    try {
      renameSync(tmp, file)
      return { atomic: true }
    } catch (error) {
      lastError = error
      // EPERM/EBUSY/EACCES：目标被占用，等一小会儿再试（Windows 上常见）
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) break
      const until = Date.now() + 5 * (attempt + 1)
      while (Date.now() < until) {
        // 同步忙等几毫秒；这里在插件的写盘路径上，不能 await
      }
    }
  }
  try {
    rmSync(tmp, { force: true })
  } catch {
    // 删不掉临时文件不影响结果
  }
  writeFileSync(file, text, 'utf8')
  if (typeof onFallback === 'function') onFallback(lastError ?? new Error('rename failed'))
  return { atomic: false }
}
