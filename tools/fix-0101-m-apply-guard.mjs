#!/usr/bin/env node
/**
 * P2-2（收窄版）：apply 初始化阶段的写盘失败不该把整个插件打死。
 *
 * 本来审计报的是「apply 函数体没有顶层 try/catch」。去核了实际代码：
 * `readPersona` / `readModules` / `readHindsightConfig` 内部都各自 try 过，
 * 所以「读坏了」不会炸。**真正的暴露点是初始化时的那几次写盘** ——
 * 磁盘满、目录只读、杀软锁文件，都会让 writeModulesSynced / writeStoreSynced
 * 抛出去，整个插件 apply 失败，设置页变空白。
 *
 * 这几处写盘在初始化阶段只是「把默认值落一下盘」，失败完全不影响运行
 * （内存里那份已经对了，下次有改动会再写）。所以给它们加兜底：
 * 记一笔 warning，继续跑。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'index.js')
let src = readFileSync(p, 'utf8')

const FROM = `  // 初始化模块配置（第一次会写入默认的声音风格与能力开关）
  const modules = readModules()
  writeModulesSynced(modules)`

const TO = `  // 初始化模块配置（第一次会写入默认的声音风格与能力开关）
  const modules = readModules()
  // 2026-11-04（P2-2）：这只是一次「把默认值落盘」，磁盘满 / 目录只读 / 杀软锁文件
  // 都不该让整个插件 apply 失败（那会让设置页直接空白）。内存里那份已经是对的，
  // 下次真改动时还会再写一次，所以这里记一笔就继续。
  try {
    writeModulesSynced(modules)
  } catch (error) {
    logger?.warn?.(\`模块配置初始化写盘失败（不影响运行）：\${error?.message ?? error}\`)
  }`

const n = src.split(FROM).length - 1
if (n !== 1) throw new Error(`锚点出现 ${n} 次`)
src = src.replace(FROM, TO)

writeFileSync(p, src, 'utf8')
console.log('[ok] index.js：初始化写盘加了兜底')
