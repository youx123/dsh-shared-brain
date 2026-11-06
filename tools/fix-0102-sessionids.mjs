#!/usr/bin/env node
/**
 * 修「自动互动勾选的会话总是自己取消」。
 *
 * 根因：`mergeModules` 返回前无条件 `sanitizeModules(out)`（推给远端要清掉
 * 本机会话 id，这是对的），但 `syncOnce` 把这个**推送形状**直接
 * `writeModulesSynced` 写回本地 —— 于是每同步一次，`agentive.sessionIds`
 * 就被清空一次。用户勾完会话，下一次 10 分钟同步就取消。
 *
 * 人设那边早就踩过同一个坑（mergePersona 去掉 bySession → 落地时补回来），
 * 模块这边漏了。
 *
 * 改法：
 *   1. mergeModules 的结果只当「推送形状」，另拼一份「本地形状」——
 *      scope / sessionIds 一律取本机原值；
 *   2. 推送前剥掉 mergeStats（跟人设同样的道理：诊断字段一变就等于有改动，
 *      会变成无脑空推）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'remote-sync.js')
let src = readFileSync(p, 'utf8')

const FROM = `    const modulesNext = mergeModules(localModules, remoteModules.data ?? {}, tombstones)

    const pushMemory = JSON.stringify(memoryRemoteNext) !== JSON.stringify(remoteMemory.data ?? {})
    const pushPersona = JSON.stringify(personaNext) !== JSON.stringify(remotePersona.data ?? {})
    const pushModules = JSON.stringify(modulesNext) !== JSON.stringify(remoteModules.data ?? {})`

if (src.split(FROM).length - 1 !== 1) throw new Error('锚点不唯一')

const TO = `    // 2026-11-04（0.10.2）：mergeModules 的返回是**推送形状**（sessionIds 已清空）。
    // 以前把这个形状直接写回本地，等于每同步一次就把「限定自动互动到指定会话」
    // 清一次 —— 用户看到的就是「勾了又自己取消」。
    // 现在拆成两份：远端那份不带本机会话 id，本地那份原样留住。
    const modulesMerged = mergeModules(localModules, remoteModules.data ?? {}, tombstones)
    // 诊断字段不能进远端（否则统计一变就多一个 commit，同步变成无脑空推）
    const { mergeStats: modulesMergeStats, ...modulesPushShape } = modulesMerged
    const localAgentive = localModules?.agentive ?? {}
    const modulesNext = {
      ...modulesPushShape,
      agentive: {
        ...(modulesPushShape.agentive ?? {}),
        scope: localAgentive.scope === 'session' ? 'session' : 'all',
        sessionIds: Array.isArray(localAgentive.sessionIds)
          ? localAgentive.sessionIds.filter((id) => typeof id === 'string' && id.trim())
          : [],
      },
    }

    const pushMemory = JSON.stringify(memoryRemoteNext) !== JSON.stringify(remoteMemory.data ?? {})
    const pushPersona = JSON.stringify(personaNext) !== JSON.stringify(remotePersona.data ?? {})
    // 推的是 modulesPushShape（干净形状，没有 mergeStats）
    const pushModules = JSON.stringify(modulesPushShape) !== JSON.stringify(remoteModules.data ?? {})`

src = src.replace(FROM, TO)

// 远端写入用推送形状
const FROM_PUSH = 'const res = await writeRemoteFile(config, REMOTE_MODULES, modulesNext, remoteModules.sha,'
if (src.split(FROM_PUSH).length - 1 !== 1) throw new Error('写远端锚点不唯一')
src = src.replace(FROM_PUSH, 'const res = await writeRemoteFile(config, REMOTE_MODULES, modulesPushShape, remoteModules.sha,')

writeFileSync(p, src, 'utf8')
console.log('[ok] remote-sync.js：模块「推送形状 / 本地形状」拆开')
