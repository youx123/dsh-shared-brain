#!/usr/bin/env node
/** 把「本地形状」那段抽成可测的导出函数，并加回归测试 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'remote-sync.js')
let src = readFileSync(p, 'utf8')

// 1) 插入导出函数（放在 mergeModules 之后）
const ANCHOR = `  const sanitized = sanitizeModules(out)
  sanitized.mergeStats = stats
  return sanitized
}`
if (src.split(ANCHOR).length - 1 !== 1) throw new Error('mergeModules 结尾锚点不唯一')

const FN = `${ANCHOR}

/**
 * 把「推送形状」的合并结果还原成「本地形状」。
 *
 * mergeModules 的返回体里 agentive.sessionIds 一定是空的（那是推给远端的形状，
 * 本机会话 id 不该上云）。但这份结果也要写回本地 —— 以前直接写，等于每同步
 * 一次就把用户的「限定自动互动到指定会话」清一次，表现就是**勾了又自己取消**。
 *
 * 所以本地落地前走一遍这里：scope / sessionIds 一律以本机原值为准。
 * mergeStats 是本机诊断字段，也在这里剥掉（不能落盘、更不能推上云）。
 */
export function restoreLocalAgentive(merged, local) {
  const { mergeStats, ...shape } = merged ?? {}
  const localAgentive = local?.agentive ?? {}
  const scope = localAgentive.scope === 'session' ? 'session' : 'all'
  const sessionIds = Array.isArray(localAgentive.sessionIds)
    ? localAgentive.sessionIds.filter((id) => typeof id === 'string' && id.trim())
    : []
  return {
    ...shape,
    agentive: { ...(shape.agentive ?? {}), scope, sessionIds },
  }
}`

src = src.replace(ANCHOR, FN)

// 2) syncOnce 里那段手写逻辑改成调函数
const FROM = `    const modulesMerged = mergeModules(localModules, remoteModules.data ?? {}, tombstones)
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
    }`
if (src.split(FROM).length - 1 !== 1) throw new Error('syncOnce 锚点不唯一')

src = src.replace(FROM, `    const modulesMerged = mergeModules(localModules, remoteModules.data ?? {}, tombstones)
    // 推送形状：sessionIds 已清、没有 mergeStats
    const { mergeStats: modulesMergeStats, ...modulesPushShape } = modulesMerged
    // 本地形状：把本机的 scope / sessionIds 还原回来（否则勾选的会话会被清掉）
    const modulesNext = restoreLocalAgentive(modulesPushShape, localModules)`)

writeFileSync(p, src, 'utf8')
console.log('[ok] remote-sync.js：抽成 restoreLocalAgentive 并接入 syncOnce')
