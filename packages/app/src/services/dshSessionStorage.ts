import {
  DSH_REMOTE_ORIGIN, decodeDshBase64, dshId, dshRecord, parseDshDeviceTokens,
  type DshDeviceTokens, type DshIdentity,
} from '@ompiui/protocol/dsh-remote'

export interface DshSessionRecord {
  identity: DshIdentity
  tokens: DshDeviceTokens
  mode: 'account' | 'paired'
}

const SESSION_KEY = `ompiui.dsh-remote.session:${DSH_REMOTE_ORIGIN}`
// 旧版配对记录属于同一个固定服务，独立保留键名以免依赖控制端 store。
const LEGACY_PAIRED_KEY = 'ompiui.dsh-remote.paired'

function parseSession(value: unknown): DshSessionRecord {
  const saved = dshRecord(value)
  const stored = dshRecord(saved?.identity)
  if (!saved || (saved.mode !== 'account' && saved.mode !== 'paired') || !stored
    || typeof stored.identityKey !== 'string' || typeof stored.privateKey !== 'string'
    || decodeDshBase64(stored.identityKey, 32).length !== 32
    || decodeDshBase64(stored.privateKey, 32).length !== 32) {
    throw new Error('Invalid DS Harness Remote saved session')
  }
  const identity = {
    deviceId: dshId(stored.deviceId), identityKey: stored.identityKey, privateKey: stored.privateKey,
  }
  const tokens = parseDshDeviceTokens(saved.tokens)
  // access token 可以在恢复后刷新，refresh token 过期则已无法继续授权。
  if (tokens.refreshTokenExpiresAt <= Date.now()) throw new Error('Expired DS Harness Remote saved session')
  return { identity, tokens, mode: saved.mode }
}

function parseStoredSession(raw: string, legacy: boolean): DshSessionRecord {
  const saved = dshRecord(JSON.parse(raw))
  if (!saved) throw new Error('Invalid DS Harness Remote saved session')
  if (legacy) {
    if (saved.mode !== undefined && saved.mode !== 'paired') throw new Error('Invalid DS Harness Remote pairing mode')
    return parseSession({ identity: saved.identity, tokens: saved.tokens, mode: 'paired' })
  }
  if (saved.origin !== DSH_REMOTE_ORIGIN) throw new Error('Invalid DS Harness Remote session origin')
  return parseSession(saved)
}

/** 恢复有效凭据并迁移旧配对记录；存储访问、迁移或清理失败时向调用方抛错。 */
export function loadDshSession(): DshSessionRecord | null {
  const storage = localStorage
  const current = storage.getItem(SESSION_KEY)
  const legacy = current === null
  const raw = current ?? storage.getItem(LEGACY_PAIRED_KEY)
  if (raw === null) return null

  let record: DshSessionRecord
  try {
    record = parseStoredSession(raw, legacy)
  } catch {
    // 统一记录失效时同时清理旧配对记录，避免回退到另一种授权。
    clearDshSession()
    return null
  }
  // 迁移写入放在格式校验的 catch 外，写失败时保留旧授权并报告错误。
  if (legacy) saveDshSession(record)
  return record
}

/** 首次授权和每次 token 刷新均保存完整记录；写入失败不得视为持久化成功。 */
export function saveDshSession(record: DshSessionRecord): void {
  const saved = parseSession(record)
  const storage = localStorage
  storage.setItem(SESSION_KEY, JSON.stringify({ origin: DSH_REMOTE_ORIGIN, ...saved }))
  // 新记录写入成功后才移除旧记录，额度不足或存储被禁用时仍能重试恢复。
  storage.removeItem(LEGACY_PAIRED_KEY)
}

/** 注销、取消配对或凭据失效时清理；删除失败时向调用方抛错。 */
export function clearDshSession(): void {
  const storage = localStorage
  // 先删旧键，防止删除失败后下一次启动复活旧配对。
  storage.removeItem(LEGACY_PAIRED_KEY)
  storage.removeItem(SESSION_KEY)
}

/** 只读判断是否存在可恢复的凭据；迁移、清理及错误反馈由 loadDshSession 负责。 */
export function hasSavedDshSession(): boolean {
  try {
    const storage = localStorage
    const current = storage.getItem(SESSION_KEY)
    const raw = current ?? storage.getItem(LEGACY_PAIRED_KEY)
    if (raw === null) return false
    parseStoredSession(raw, current === null)
    return true
  } catch {
    return false
  }
}
