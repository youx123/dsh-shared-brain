/**
 * Hindsight 的 bank 去分裂。
 *
 * Hindsight 默认按工作区目录名派生 bank（coding-agent::{gitProject}），
 * 两个工作区就是两个记忆库。本插件把 bank 固定成一个全局值，
 * 这样即使以后配上了 Hindsight 的 API key，记忆也不会再按工作区分开。
 *
 * 同时：没有 apiToken 时 Hindsight 会反复报 401，本插件会显式把它关掉，
 * 免得日志里一直刷错误。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 全局共享的 bank 名。 */
export const GLOBAL_BANK_ID = 'coding-agent::global'

/** Hindsight 的配置文件路径（与插件内部 CONFIG_PATH 一致）。 */
export function hindsightConfigFile() {
  return process.env.HINDSIGHT_CONFIG || join(homedir(), '.hindsight', 'coding-agent.json')
}

/** 读 Hindsight 配置。 */
export function readHindsightConfig() {
  const file = hindsightConfigFile()
  if (!existsSync(file)) return { path: file, exists: false, raw: {}, config: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { path: file, exists: true, raw, config: raw && typeof raw === 'object' ? raw : {} }
  } catch {
    return { path: file, exists: true, raw: {}, config: {}, invalid: true }
  }
}

/**
 * 让 Hindsight 指向单一全局 bank。
 *
 * @param {{ bankId?: string, enable?: boolean }} options
 *   bankId  全局 bank 名，默认 coding-agent::global
 *   enable  false 时把 Hindsight 整个关掉（disabled: true），用于没有凭据时止住 401 刷屏
 */
export function ensureGlobalBank(options = {}) {
  const bankId = typeof options.bankId === 'string' && options.bankId ? options.bankId : GLOBAL_BANK_ID
  const enable = options.enable !== false
  const { path, raw } = readHindsightConfig()
  const notes = []

  const next = { ...(raw && typeof raw === 'object' ? raw : {}) }

  // bank 固定与启停是两件事：即使暂时没有凭据、暂时停用 Hindsight，
  // 也要先把 bank 写死，这样以后配上 key 也不会再按工作区分裂。
  if (next.bankId !== bankId) {
    notes.push(`bank 由 ${next.bankId ?? '(按工作区派生)'} 固定为 ${bankId}（所有会话共用同一个记忆库）`)
    next.bankId = bankId
  }
  // dynamicBankId: false 才能让 bankId 真正生效（否则配置里的 bankId 被忽略）
  if (next.dynamicBankId !== false) {
    notes.push('dynamicBankId 设为 false，使固定 bank 生效')
    next.dynamicBankId = false
  }

  if (!enable) {
    if (next.disabled !== true) {
      notes.push('Hindsight 已停用（缺少 API 凭据，避免每轮刷 401）')
      next.disabled = true
    }
  } else if (next.disabled === true) {
    notes.push('Hindsight 已重新启用')
    next.disabled = false
  }

  const changed = notes.length > 0
  if (changed) writeHindsightConfig(next, path)
  return { changed, path, notes, bankId, config: next }
}

/** 写 Hindsight 配置（先临时文件再 rename）。 */
function writeHindsightConfig(payload, path) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, path)
}

/**
 * Hindsight 当前是否具备可用凭据。
 * 没有 token 时它是云端 401 / 本地 daemon 起不来，只能靠本插件的本地记忆兜底。
 */
export function hindsightCredentialState() {
  const { config } = readHindsightConfig()
  const token = config.apiToken || process.env.HINDSIGHT_API_TOKEN || ''
  const serverMode = config.serverMode || process.env.HINDSIGHT_SERVER_MODE || 'cloud'
  const disabled = config.disabled === true
  if (disabled) return { usable: false, reason: '已在配置中禁用', serverMode, hasToken: Boolean(token) }
  if (!token) {
    return {
      usable: false,
      reason: serverMode === 'daemon'
        ? 'daemon 模式需要 uv / Rust / LLM key，本机都不具备'
        : '未配置 apiToken，云端调用会返回 401',
      serverMode,
      hasToken: false,
    }
  }
  return { usable: true, reason: '已配置凭据', serverMode, hasToken: true }
}
