#!/usr/bin/env node
/**
 * 版本 0.10.1 → 0.10.2（安装目录 / 补丁源 / 仓库 三处 package.json）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const targets = [
  'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/package.json',
  'C:/Users/13176/Documents/dsh-shared-brain-patches/package.json',
  'D:/tmp/dsh-shared-brain/package.json',
]

for (const p of targets) {
  const raw = readFileSync(p, 'utf8')
  const json = JSON.parse(raw)
  if (json.version !== '0.10.1' && json.version !== '0.10.2') {
    throw new Error(`${p} 当前版本是 ${json.version}，不是预期的 0.10.1`)
  }
  if (json.version === '0.10.2') {
    console.log(`[skip] ${p} 已是 0.10.2`)
    continue
  }
  // 只替换第一处 "version": "0.10.1"，且必须带行首缩进（避免撞依赖里的版本）
  const from = `"version": "0.10.1"`
  const n = raw.split(from).length - 1
  if (n < 1) throw new Error(`${p} 找不到 version 字段`)
  const idx = raw.indexOf(from)
  // 确认这是文件里第一个（顶层 version 在 name 之后）
  const next = raw.slice(0, idx) + `"version": "0.10.2"` + raw.slice(idx + from.length)
  writeFileSync(p, next, 'utf8')
  console.log(`[ok] ${p} → 0.10.2`)
}
