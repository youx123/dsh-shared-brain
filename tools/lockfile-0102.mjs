#!/usr/bin/env node
/**
 * profile 的 package.json + pnpm-lock.yaml 指向 0.10.2 的 tgz（幂等版）。
 *
 * 两个坑：
 *  1. lockfile 里的 integrity 写在 resolution 行，包键在**上一行** —— 按当前行匹配会落空；
 *  2. 先替换文件名再找 integrity，上一行已经不是 0.10.1 了，一样落空。
 *     → 先把 integrity 一遍，再改文件名。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FROM = 'dsh-shared-brain-0.10.1.tgz'
const TO = 'dsh-shared-brain-0.10.2.tgz'
const NEW_INTEGRITY = 'sha512-PQLMNl+3M43sNKCzvX+kjpPfny0Cno2N1tAhRAkudrLHtLa65ptiieE0WzYzLwAvCBvlVT+i6LMNV3ErRK536g=='

// ① package.json（幂等）
{
  const p = 'C:/Users/13176/.dsh/profiles/desktop/package.json'
  let s = readFileSync(p, 'utf8')
  if (s.includes(FROM)) {
    s = s.split(FROM).join(TO)
    writeFileSync(p, s, 'utf8')
    console.log('[ok] package.json → 0.10.2')
  } else if (s.includes(TO)) {
    console.log('[skip] package.json 已是 0.10.2')
  } else {
    throw new Error('package.json 里既没有 0.10.1 也没有 0.10.2 的 tgz')
  }
}

// ② pnpm-lock.yaml
{
  const p = 'C:/Users/13176/.dsh/profiles/desktop/pnpm-lock.yaml'
  let lines = readFileSync(p, 'utf8').split('\n')

  // 先 integrity：包键未改动前认
  let integHits = 0
  let already = 0
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]
    if (!prev.includes('dsh-shared-brain@file:vendor/')) continue
    if (!lines[i].includes('resolution: {integrity:')) continue
    if (lines[i].includes(NEW_INTEGRITY)) { already++; continue }
    lines[i] = lines[i].replace(/integrity: sha512-[A-Za-z0-9+/=]+/, `integrity: ${NEW_INTEGRITY}`)
    integHits++
  }

  // 再替换文件名
  let fileHits = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(FROM)) {
      lines[i] = lines[i].split(FROM).join(TO)
      fileHits++
    }
  }

  if (integHits + already !== 1) throw new Error(`integrity：替换 ${integHits}、已新 ${already}，预期合计 1`)
  if (fileHits + (lines.filter((l) => l.includes(TO)).length > 0 && fileHits === 0 ? 0 : 0) < 0) throw new Error('unreachable')
  if (fileHits !== 5 && !(fileHits === 0)) throw new Error(`文件名替换 ${fileHits} 处，预期 5 处`)

  writeFileSync(p, lines.join('\n'), 'utf8')
  console.log(`[ok] pnpm-lock.yaml：integrity ${integHits} 处、文件名 ${fileHits} 处`)
}

// ③ 复查
{
  const p = 'C:/Users/13176/.dsh/profiles/desktop/pnpm-lock.yaml'
  const s = readFileSync(p, 'utf8')
  const oldLeft = (s.match(/dsh-shared-brain-0\.10\.1\.tgz/g) || []).length
  const newCount = (s.match(/dsh-shared-brain-0\.10\.2\.tgz/g) || []).length
  const antfu = s.includes('sha512-sdg9NxU3')
  console.log(`复查：0.10.1 残留 ${oldLeft} 处、0.10.2 出现 ${newCount} 处、@antfu 哈希完好 ${antfu}`)
  if (oldLeft !== 0) throw new Error('还有旧文件名残留')
  if (newCount !== 5) throw new Error(`0.10.2 应出现 5 处，实际 ${newCount}`)
}
