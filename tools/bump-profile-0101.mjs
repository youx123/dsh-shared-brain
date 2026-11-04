#!/usr/bin/env node
/**
 * 把 profile 里的插件引用从 0.10.0 换到 0.10.1。
 *
 * 只替换与 dsh-shared-brain 相关的那几行 —— 别碰别的包的 integrity
 * （0.10.0 那次踩过：@antfu/install-pkg 的哈希长得像，误改会坏）。
 * 不跑 pnpm install（联网重装风险大，node_modules 里已经是新代码）。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const OLD = '0.10.0'
const NEW = '0.10.1'
const OLD_TGZ = `vendor/dsh-shared-brain-${OLD}.tgz`
const NEW_TGZ = `vendor/dsh-shared-brain-${NEW}.tgz`
const OLD_INTEGRITY = 'sha512-DNsFG8tqNaEKVxxvNT/0nae3aGUmhH50wRFFIjiIfz29TenP7E0zGWKApoMiHa1ryqqD30SZHVQxX5f8GDq1BQ=='
const NEW_INTEGRITY = 'sha512-bq3MOe46vzMzOIUdd+Tqnw1JFROKw5XA/nYDNuzy0064L9yt7nykgLTbuT9JNO1JtJCwDeejXDhCDnjLi8xglA=='

const DIR = 'C:/Users/13176/.dsh/profiles/desktop'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

for (const name of ['package.json', 'pnpm-lock.yaml']) {
  copyFileSync(`${DIR}/${name}`, `${DIR}/${name}.bak-0101-${stamp}`)
}

// ① package.json
{
  const p = `${DIR}/package.json`
  const src = readFileSync(p, 'utf8')
  const from = `"dsh-shared-brain": "file:${OLD_TGZ}"`
  const to = `"dsh-shared-brain": "file:${NEW_TGZ}"`
  const hits = src.split(from).length - 1
  if (hits === 1) {
    writeFileSync(p, src.replace(from, to), 'utf8')
    console.log('[ok] package.json')
  } else if (src.includes(to)) {
    console.log('[skip] package.json 已经是 0.10.1')
  } else {
    throw new Error('package.json 锚点异常：' + hits)
  }
}

// ② pnpm-lock.yaml —— 只改 dsh-shared-brain 那一行块
{
  const p = `${DIR}/pnpm-lock.yaml`
  const lines = readFileSync(p, 'utf8').split('\n')
  let changed = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    // specifier / version / 依赖键 / 包键 —— 都带 file:vendor/dsh-shared-brain-<ver>.tgz
    if (line.includes(`dsh-shared-brain`) && line.includes(OLD_TGZ)) {
      lines[i] = line.split(OLD_TGZ).join(NEW_TGZ)
      changed += 1
      continue
    }
    // resolution 行的 integrity + tarball（tarball 已在上面那条覆盖不到时兜底）
    if (line.includes('dsh-shared-brain@file:') || line.includes(`${OLD_TGZ}`)) {
      lines[i] = line.split(OLD_TGZ).join(NEW_TGZ)
      changed += 1
    }
  }

  // 单独处理 integrity：它出现在 dsh-shared-brain 的 resolution 行，
  // 而包键在**上一行**（`dsh-shared-brain@file:vendor/...:`），所以按「上一行是包键」来认
  let intChanged = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(OLD_INTEGRITY)) continue
    const prev = lines[i - 1] ?? ''
    if (!prev.includes('dsh-shared-brain@file:')) {
      throw new Error(`第 ${i + 1} 行的旧哈希不属于 dsh-shared-brain，中止：${prev.trim()}`)
    }
    lines[i] = lines[i].replace(OLD_INTEGRITY, NEW_INTEGRITY)
    intChanged += 1
  }

  const out = lines.join('\n')
  if (changed === 0) throw new Error('lockfile 里没找到要改的行')
  if (intChanged === 0) throw new Error('lockfile 里没找到 integrity 行')
  writeFileSync(p, out, 'utf8')
  console.log(`[ok] pnpm-lock.yaml：${changed} 处文件名 + ${intChanged} 处 integrity`)
}

// ③ 复查：旧版本残留必须是 0，别的包的 integrity 必须没动
{
  const lock = readFileSync(`${DIR}/pnpm-lock.yaml`, 'utf8')
  const leftOld = lock.split(OLD_TGZ).length - 1
  const leftOldInt = lock.split(OLD_INTEGRITY).length - 1
  const antfuOk = lock.includes('sha512-sdg9NxU3')
  console.log(`\n复查：旧文件名残留 ${leftOld} 处，旧哈希残留 ${leftOldInt} 处`)
  console.log(`      @antfu/install-pkg 哈希还在：${antfuOk ? '是 ✅' : '没了（要查）'}`)
  if (leftOld !== 0 || leftOldInt !== 0) throw new Error('还有旧版本残留')
}
