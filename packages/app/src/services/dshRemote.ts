import {
  DSH_PAIRING_ROOT, DSH_RELAY_CAPABILITY, DSH_REMOTE_ORIGIN,
  DSH_WEB_LEASE_ENDED, DshNoise, createDshIdentity, decodeDshBase64, dshControlFailure, dshFrame, dshId, dshPairingFingerprint, dshPairingProof,
  dshRecord, isDshExpiry, isDshToken, isDshWebLeaseEnd,
  parseDshBrowserGrant, parseDshDeviceTokens, parseDshFrame, parseDshPairingScan, parseDshPairingSession, parseDshPairingStatus,
  requireDshOmpiuiWeb, selectDshHosts,
  type DshBrowserGrant, type DshDeviceTokens, type DshHostListItem, type DshIdentity, type DshPairingSession,
  type DshPairingState, type DshWebLeaseEnd,
} from '@ompiui/protocol/dsh-remote'
import { recordDshDiagnostic } from './dshConnectionDiagnostics'
import { DshControlWire } from './dshControlWire'
import { clearDshSession, loadDshSession, saveDshSession, type DshSessionRecord } from './dshSessionStorage'
import { getDesktopPlatform, getHttpFetch, isTauriMobile } from '../utils/tauri'

export interface DshLoginProvider { id: string; label: string; start: string }
export { selectDshHosts, type DshHostListItem }
export interface DshConnectionEnd { leaseEnd?: DshWebLeaseEnd; error?: unknown }
export interface DshAppConnection { grant: DshBrowserGrant; closed: Promise<DshConnectionEnd>; close(): Promise<void> }

const TOKEN_SKEW = 60_000

export class DshApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number, message = `DS Harness Remote (${status})`) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function isDshControllerAuthFailure(error: unknown): error is DshApiError & { code: 'DSH_AUTH_INVALID' | 'DSH_DEVICE_REVOKED' } {
  return error instanceof DshApiError && ['DSH_AUTH_INVALID', 'DSH_DEVICE_REVOKED'].includes(error.code)
}

export function shouldRefreshDshHello(error: DshApiError, alreadyRetried: boolean): boolean {
  // 只有明确的认证拒绝才消耗刷新令牌；未知关闭码保留原始诊断。
  return !alreadyRetried && error.code === 'DSH_AUTH_INVALID'
}

function controllerAuthError(code: 'AUTH_INVALID' | 'DEVICE_REVOKED'): DshApiError {
  return new DshApiError(`DSH_${code}`, 401, 'Sign in to DS Harness Remote again')
}

function diagnosticCode(error: unknown): string | undefined {
  if (error instanceof DshApiError) return error.code
  if (error instanceof DOMException && error.name === 'AbortError') return 'REQUEST_ABORTED'
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'TIMEOUT'
  if (error instanceof TypeError) return 'TypeError'
  return error instanceof Error ? 'Error' : undefined
}

function rethrowHostLookup(error: unknown): never {
  if (error instanceof DshApiError) {
    if (!isDshControllerAuthFailure(error) && (error.status === 403 || error.code === 'DEVICE_REVOKED')) {
      throw new DshApiError('HOST_UNAUTHORIZED', error.status, 'DS Harness Remote did not authorize the selected host')
    }
    if (error.status === 404) throw new DshApiError('HOST_OFFLINE', error.status, 'The DS Harness Remote host is offline')
  }
  throw error
}

function relayErrorCode(value: unknown): string {
  const code = typeof value === 'string' ? value.toUpperCase() : ''
  if (code.includes('BUSY') || code.includes('ALREADY_CONNECTED')) return 'HOST_BUSY'
  if (code.includes('OFFLINE') || code.includes('NOT_FOUND')) return 'HOST_OFFLINE'
  if (code.includes('AUTH') || code.includes('UNAUTHORIZED') || code.includes('FORBIDDEN') || code.includes('REVOKED')) return 'HOST_UNAUTHORIZED'
  if (code.includes('PROTOCOL') || code.includes('CAPABILIT')) return 'PROTOCOL'
  return ''
}

function wireFailure(wire: DshControlWire, fallback: string, frameCode?: unknown): DshApiError {
  const failure = dshControlFailure(frameCode, wire.closeInfo)
  if (failure === 'AUTH_INVALID' || failure === 'DEVICE_REVOKED') return controllerAuthError(failure)
  if (failure === 'ALREADY_CONNECTED') return new DshApiError('HOST_BUSY', 409)
  return new DshApiError(fallback, 0)
}

async function dshRequest(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const url = new URL(path, DSH_REMOTE_ORIGIN)
  if (url.origin !== DSH_REMOTE_ORIGIN || !url.pathname.startsWith('/api/v1/')) throw new Error('Invalid DSH API path')
  const fetch = await getHttpFetch()
  const headers = new Headers(init.headers)
  if (init.body) headers.set('content-type', 'application/json')
  const deadline = AbortSignal.timeout(12_000)
  const options = { ...init, headers, signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    redirect: 'error' as const, maxRedirections: 0 }
  const response = await fetch(url.href, options)
  if (response.status === 204) return undefined
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const code = dshRecord(dshRecord(body)?.error)?.code
    throw new DshApiError(typeof code === 'string' ? code : '', response.status)
  }
  return body
}

export async function listDshLoginProviders(signal: AbortSignal): Promise<DshLoginProvider[]> {
  const value = dshRecord(await dshRequest('/api/v1/auth/oauth/providers', {}, signal))
  if (!Array.isArray(value?.items)) throw new Error('Invalid DS Harness Remote provider list')
  return value.items.flatMap((entry: unknown) => {
    const item = dshRecord(entry)
    return typeof item?.id === 'string' && /^[a-z0-9-]{1,40}$/.test(item.id)
      && typeof item.displayName === 'string' && item.displayName.trim() && typeof item.qrStartUrl === 'string'
      && /^\/api\/v1\/auth\/oauth\/qr\/start(?:\?provider=[a-z0-9-]+)?$/.test(item.qrStartUrl)
      ? [{ id: item.id, label: item.displayName, start: item.qrStartUrl }] : []
  })
}

export async function beginDshLogin(provider: DshLoginProvider, signal: AbortSignal): Promise<{ id: string; url: string; expiresAt: number }> {
  if (!/^\/api\/v1\/auth\/oauth\/qr\/start(?:\?provider=[a-z0-9-]+)?$/.test(provider.start)) throw new Error('Invalid DSH login path')
  const value = dshRecord(await dshRequest(provider.start, { method: 'POST', body: '{}' }, signal))
  if (typeof value?.qrId !== 'string' || !/^[a-z0-9_-]{8,100}$/i.test(value.qrId) || typeof value.scanUrl !== 'string'
    || !isDshExpiry(value.expiresIn) || (value.provider !== undefined && value.provider !== provider.id)) throw new Error('Invalid DSH login session')
  const url = new URL(value.scanUrl)
  if (url.origin !== DSH_REMOTE_ORIGIN || url.username || url.password || /\p{Cc}/u.test(value.scanUrl)) throw new Error('Invalid DSH login URL')
  return { id: value.qrId, url: url.href, expiresAt: Date.now() + Math.min(value.expiresIn, 600) * 1000 }
}

export async function pollDshLogin(id: string, signal: AbortSignal, options?: { onComplete?: () => void }): Promise<'pending' | 'expired' | DshAppSession> {
  if (!/^[a-z0-9_-]{8,100}$/i.test(id)) throw new Error('Invalid DSH login ID')
  const value = dshRecord(await dshRequest(`/api/v1/auth/oauth/qr/${encodeURIComponent(id)}`, {}, signal))
  if (value?.status === 'pending' || value?.status === 'expired') return value.status
  if (value?.status !== 'complete' || !isDshToken(value.token)) throw new Error('Invalid DSH login response')
  options?.onComplete?.()
  const identity = createDshIdentity()
  const platform = devicePlatform()
  const result = await dshRequest('/api/v1/devices/register', {
    method: 'POST', headers: { authorization: `Bearer ${value.token}` },
    body: JSON.stringify({ v: 1, device: {
      deviceId: identity.deviceId, name: `OMPiUI (${platform})`, role: 'client', platform,
      identityKey: identity.identityKey, clientVersion: __APP_VERSION__,
    } }),
  }, signal)
  const tokens = parseDshDeviceTokens(result)
  signal.throwIfAborted()
  const store = sessionStore(identity, 'account')
  store(tokens)
  return new DshAppSession(identity, tokens, store, 'account')
}

function devicePlatform(): string {
  return isTauriMobile() ? (/Android/i.test(navigator.userAgent) ? 'android' : 'ios') : getDesktopPlatform()
}

// ============================================
// 扫码配对：手机扫电脑上的二维码，显示 8 位验证码，等人在电脑上输入。
// 配对拿到的是这台手机自己的设备授权，不经过账号登录，所以要存下来，否则每次重开 App 都得回电脑前重新配对。
// ============================================

function sessionStore(identity: DshIdentity, mode: DshSessionRecord['mode']): (tokens: DshDeviceTokens | null) => void {
  return tokens => {
    try {
      if (tokens) saveDshSession({ identity, tokens, mode })
      else clearDshSession()
    } catch { throw new DshApiError('DSH_STORAGE_FAILED', 0) }
  }
}

/** 恢复本机账号或配对授权；两者共享存储，但保留独立登录方式。 */
export function restoreDshPairedSession(): DshAppSession | null {
  let saved: DshSessionRecord | null
  try { saved = loadDshSession() } catch { throw new DshApiError('DSH_STORAGE_FAILED', 0) }
  return saved ? new DshAppSession(saved.identity, saved.tokens, sessionStore(saved.identity, saved.mode), saved.mode) : null
}

/**
 * 手机扫到的二维码属于哪台电脑。这一步只读取，不登记任何东西，也不消耗二维码。
 * 已经配对过的手机再配一台电脑时带上 existing：沿用同一个设备身份，新电脑才会和原来的电脑归到一起。
 */
export async function resolveDshPairing(text: string, signal: AbortSignal,
  existing?: { identity: DshIdentity; session: DshAppSession }): Promise<DshPhonePairing> {
  let scan: ReturnType<typeof parseDshPairingScan>
  try { scan = parseDshPairingScan(text) } catch { throw new DshApiError('PAIRING_SCAN_INVALID', 0) }
  let session: DshPairingSession
  if ('session' in scan) session = scan.session
  else {
    const value = await dshRequest('/api/v1/device-pairing/resolve', { method: 'POST', body: JSON.stringify({ ticket: scan.ticket }) }, signal)
    try { session = parseDshPairingSession(value, scan.ticket) } catch { throw new DshApiError('PAIRING_SCAN_INVALID', 0) }
  }
  if (session.expiresAt <= Date.now()) throw new DshApiError('PAIRING_NOT_FOUND', 404)
  return new DshPhonePairing(session, existing)
}

export class DshPhonePairing {
  readonly session: DshPairingSession
  private readonly identity: DshIdentity
  private readonly existing?: DshAppSession
  private claimBody?: string
  private ended = false

  constructor(session: DshPairingSession, existing?: { identity: DshIdentity; session: DshAppSession }) {
    this.session = session
    this.identity = existing?.identity ?? createDshIdentity()
    this.existing = existing?.session
  }

  get computer(): { name: string; fingerprint: string } {
    return { name: this.session.host.name.slice(0, 64), fingerprint: dshPairingFingerprint(this.session.host.identityKey) }
  }

  /** 用户确认是这台电脑之后才调用：领取要在电脑上输入的 8 位验证码。 */
  async claim(signal: AbortSignal): Promise<string> {
    // 请求原文只生成一次：回复丢了就原样重发，拿回的还是同一个验证码。
    this.claimBody ??= JSON.stringify({
      scanSecret: this.session.scanSecret,
      device: {
        deviceId: this.identity.deviceId, name: `OMPiUI (${devicePlatform()})`, role: 'client', platform: devicePlatform(),
        identityKey: this.identity.identityKey, clientVersion: __APP_VERSION__,
      },
    })
    const value = dshRecord(await this.post('claim', this.claimBody, signal))
    if (value?.state !== 'claimed' || typeof value.verificationCode !== 'string' || !/^\d{8}$/.test(value.verificationCode)) {
      throw new Error('Invalid DSH pairing claim')
    }
    return value.verificationCode
  }

  /** 电脑那边输入验证码之后，这里会拿到这台手机自己的会话。 */
  async poll(signal: AbortSignal): Promise<{ state: DshPairingState; failureReason: string | null; paired?: DshAppSession }> {
    const value = await this.post('mobile/status', '{}', signal)
    let status: ReturnType<typeof parseDshPairingStatus>
    // 回复里的电脑或手机对不上，就不是我们确认过的那次配对了：直接作废。
    try { status = parseDshPairingStatus(value, this.session, 'mobile', this.identity) } catch { throw new DshApiError('PAIRING_MISMATCH', 0) }
    this.ended = status.state !== 'claimed' && status.state !== 'approved'
    if (status.state !== 'completed' || !status.tokens) return { state: status.state, failureReason: status.failureReason }
    signal.throwIfAborted()
    // 再配一台电脑时手机的身份和授权都没变，原来的会话接着用。
    if (this.existing) return { state: status.state, failureReason: null, paired: this.existing }
    const store = sessionStore(this.identity, 'paired')
    store(status.tokens)
    return { state: status.state, failureReason: null, paired: new DshAppSession(this.identity, status.tokens, store, 'paired') }
  }

  /** 尽力告诉电脑这次配对不继续了。 */
  async cancel(): Promise<void> {
    if (!this.claimBody || this.ended) return
    this.ended = true
    await this.post('mobile/cancel', '{}', AbortSignal.timeout(5_000)).catch(() => undefined)
  }

  private post(action: string, raw: string, signal: AbortSignal): Promise<unknown> {
    const path = `${DSH_PAIRING_ROOT}/${this.session.sessionId}/${action}`
    return dshRequest(path, {
      method: 'POST', body: raw,
      headers: { 'x-dsh-pairing-proof': dshPairingProof(this.identity.privateKey, this.session.serverPublicKey, this.session.sessionId, 'mobile', path, raw) },
    }, signal)
  }
}

export class DshAppSession {
  private refreshing?: Promise<DshDeviceTokens>
  private readonly pinnedPeers = new Map<string, string>()
  private readonly lifetime = new AbortController()
  private readonly identity: DshIdentity
  private tokens: DshDeviceTokens
  private unsavedTokens = false
  /** 手机重开后继续使用同一个设备；刷新时保存整对授权。 */
  private readonly store?: (tokens: DshDeviceTokens | null) => void
  private readonly mode: DshSessionRecord['mode']

  constructor(identity: DshIdentity, tokens: DshDeviceTokens, store?: (tokens: DshDeviceTokens | null) => void,
    mode: DshSessionRecord['mode'] = 'account') {
    this.identity = identity
    this.tokens = tokens
    this.store = store
    this.mode = mode
  }

  /** 是不是扫码配对来的：没有账号可退出，只能取消配对。 */
  get paired(): boolean { return this.mode === 'paired' }

  /** 已经配对过的手机再扫一台电脑。 */
  pairAnother(text: string, signal: AbortSignal): Promise<DshPhonePairing> {
    return resolveDshPairing(text, signal, { identity: this.identity, session: this })
  }

  async listHosts(signal: AbortSignal, localHostId?: string | null): Promise<DshHostListItem[]> {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    const hosts = new Map<string, DshHostListItem>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) })
      const result = dshRecord(await this.request(`/api/v1/devices?${query}`, {}, signal))
      if (!Array.isArray(result?.items)) throw new Error('Invalid DSH host list')
      const page = selectDshHosts(result.items, this.identity.deviceId, localHostId)
      // 目录用于发现设备，在线状态使用 presence；每页查完再翻页，最多八路请求。
      let index = 0
      await Promise.all(Array.from({ length: Math.min(8, page.length) }, async () => {
        while (index < page.length) {
          signal.throwIfAborted()
          const host = page[index++]
          let online: boolean | undefined
          try {
            const presence = dshRecord(await this.request(`/api/v1/devices/${encodeURIComponent(host.id)}/presence`, {}, signal))
            if (presence?.deviceId !== host.id || typeof presence.online !== 'boolean') throw new Error('Invalid DSH presence')
            online = presence.online
          } catch (error) {
            signal.throwIfAborted()
            if (isDshControllerAuthFailure(error)) throw error
            // 单台状态查询失败保留“未知”，不能误报离线或使用旧列表快照。
          }
          host.online = online
        }
      }))
      signal.throwIfAborted()
      for (const host of page) hosts.set(host.id, host)
      if (result.nextCursor == null) break
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor) || cursors.size >= 200) throw new Error('Invalid DSH host list cursor')
      cursor = result.nextCursor
      cursors.add(cursor)
    } while (cursor)
    return [...hosts.values()]
  }

  async connect(hostId: string, caller: AbortSignal, attemptId: string = crypto.randomUUID()): Promise<DshAppConnection> {
    dshId(hostId)
    const signal = AbortSignal.any([this.lifetime.signal, caller])
    const handshake = AbortSignal.any([signal, AbortSignal.timeout(40_000)])
    const lookupStarted = Date.now()
    recordDshDiagnostic('connect.device_lookup.start', { attemptId })
    let value: Record<string, unknown> | undefined
    try {
      value = dshRecord(await this.request(`/api/v1/devices/${encodeURIComponent(hostId)}`, {}, handshake))
      recordDshDiagnostic('connect.device_lookup.success', { attemptId, durationMs: Date.now() - lookupStarted })
    } catch (error) {
      recordDshDiagnostic('connect.device_lookup.failure', {
        attemptId, durationMs: Date.now() - lookupStarted,
        status: error instanceof DshApiError ? error.status : undefined,
        code: diagnosticCode(error),
      })
      rethrowHostLookup(error)
    }
    if (value?.role !== 'host' || value.deviceId !== hostId || typeof value.identityKey !== 'string'
      || decodeDshBase64(value.identityKey, 32).length !== 32 || typeof value.membershipId !== 'string' || !value.membershipId) {
      throw new DshApiError('HOST_UNAUTHORIZED', 403, 'DS Harness Remote did not authorize the selected host')
    }
    const pinned = this.pinnedPeers.get(hostId)
    if (pinned && pinned !== value.identityKey) throw new DshApiError('HOST_UNAUTHORIZED', 403, 'The DS Harness Remote host identity changed')
    this.pinnedPeers.set(hostId, value.identityKey)
    const { wire, tokens, refreshed } = await this.openControl(signal, handshake, attemptId)
    let channel: DshNoise | undefined
    let stage: 'handshake' | 'lease' = 'handshake'
    const closeWire = () => { channel?.destroy(); channel = undefined; wire.close() }
    try {
      wire.send('connect.request', { hostDeviceId: hostId, preferredTransports: ['relay'] })
      recordDshDiagnostic('connect.request.sent', { attemptId })
      const accepted = await wire.next(handshake)
      if (accepted.type === 'error') {
        const code = relayErrorCode(accepted.payload.code) || 'DSH_UNREACHABLE'
        recordDshDiagnostic('connect.request.rejected', { attemptId, code })
        throw accepted.payload.connectionId === undefined
          ? wireFailure(wire, code, accepted.payload.code)
          : new DshApiError(code, 409)
      }
      if (accepted.type !== 'connect.accepted') throw new DshApiError('PROTOCOL', 0, 'DS Harness Remote declined this device connection')
      recordDshDiagnostic('connect.request.accepted', { attemptId })
      const connectionId = dshId(accepted.payload.connectionId)
      const target = { connectionId, targetDeviceId: hostId }
      channel = new DshNoise(this.identity, value.identityKey, connectionId, hostId, this.identity.deviceId)
      wire.send('transport.selected', { ...target, transport: 'relay' })
      wire.send('secure.handshake', { ...target, step: 1, data: channel.write() })
      let frame = await wire.next(handshake)
      while (frame.type === 'transport.selected') frame = await wire.next(handshake)
      if (frame.type === 'error' && frame.payload.connectionId === undefined) throw wireFailure(wire, 'PROTOCOL', frame.payload.code)
      if (frame.type !== 'secure.handshake' || frame.payload.connectionId !== connectionId
        || frame.payload.targetDeviceId !== this.identity.deviceId || frame.payload.step !== 2) {
        throw new DshApiError('PROTOCOL', 0, 'The DS Harness Remote host failed the secure handshake')
      }
      channel.read(frame.payload.data)
      recordDshDiagnostic('connect.handshake.complete', { attemptId })
      stage = 'lease'
      const channelReady = channel
      const rpc = async (method: string, fallback: 'PROTOCOL' | 'LEASE_FAILED') => {
        const request = dshFrame('rpc.request', { method, params: {} })
        wire.send('relay', { ...target, ...channelReady.send(request) })
        while (true) {
          const next = await wire.next(handshake)
          if (next.type === 'error' && (next.payload.connectionId === undefined || next.payload.connectionId === connectionId)) {
            throw next.payload.connectionId === undefined ? wireFailure(wire, fallback, next.payload.code)
              : new DshApiError(relayErrorCode(next.payload.code) || fallback, 0)
          }
          if (next.type !== 'relay' || next.payload.connectionId !== connectionId || next.payload.targetDeviceId !== this.identity.deviceId) continue
          const response = parseDshFrame(channelReady.receive(next.payload.counter, next.payload.ciphertext))
          if (response.payload.requestId !== request.id) continue
          if (response.type === 'rpc.response') return { id: request.id, result: response.payload.result }
          if (response.type === 'rpc.error') {
            const code = String(response.payload.code ?? '')
            throw new DshApiError(code === 'RATE_LIMITED' ? 'HOST_BUSY' : fallback, 0, 'The DS Harness Remote host could not open a web tunnel')
          }
          throw new DshApiError(fallback, 0, 'The DS Harness Remote host could not open a web tunnel')
        }
      }
      recordDshDiagnostic('connect.rpc.describe.start', { attemptId })
      try {
        requireDshOmpiuiWeb((await rpc('harness.transport.describe', 'PROTOCOL')).result)
        recordDshDiagnostic('connect.rpc.describe.success', { attemptId })
      } catch (error) {
        recordDshDiagnostic('connect.rpc.describe.failure', { attemptId, code: diagnosticCode(error) })
        if (error instanceof DshApiError) throw error
        throw new DshApiError('PROTOCOL', 0, 'The DS Harness Remote host does not support the OMPiUI web handoff')
      }
      recordDshDiagnostic('connect.rpc.web_open.start', { attemptId })
      let lease: { id: string; result: unknown }
      try {
        lease = await rpc('dsh.web.open', 'LEASE_FAILED')
        recordDshDiagnostic('connect.rpc.web_open.success', { attemptId })
      } catch (error) {
        recordDshDiagnostic('connect.rpc.web_open.failure', { attemptId, code: diagnosticCode(error) })
        throw error
      }
      const grant = parseDshBrowserGrant(lease.result)
      recordDshDiagnostic('connect.success', { attemptId })
      let closeRequest: string | undefined
      let closing: Promise<void> | undefined
      const closed = (async (): Promise<DshConnectionEnd> => {
        try {
          while (true) {
            const update = await wire.next(signal)
            if (update.type === 'error' && update.payload.connectionId === undefined) {
              return { error: await this.activeFailure(wire, tokens, refreshed, signal, update.payload.code) }
            }
            if (update.type === 'error' && update.payload.connectionId === connectionId) return {}
            if (update.type !== 'relay' || update.payload.connectionId !== connectionId || update.payload.targetDeviceId !== this.identity.deviceId) continue
            const response = parseDshFrame(channelReady.receive(update.payload.counter, update.payload.ciphertext))
            if (response.type === DSH_WEB_LEASE_ENDED && response.payload.requestId === lease.id && isDshWebLeaseEnd(response.payload.reason)) {
              return { leaseEnd: response.payload.reason }
            }
            if (closeRequest && response.payload.requestId === closeRequest && ['rpc.response', 'rpc.error'].includes(response.type)) return {}
          }
        } catch {
          return signal.aborted ? {} : { error: await this.activeFailure(wire, tokens, refreshed, signal) }
        } finally { closeWire() }
      })()
      return { grant, closed, close: () => closing ??= (async () => {
        try {
          const request = dshFrame('rpc.request', { method: 'dsh.web.close', params: {} })
          closeRequest = request.id
          wire.send('relay', { ...target, ...channelReady.send(request) })
          const deadline = AbortSignal.timeout(1_500)
          await Promise.race([closed, new Promise<void>(resolve => deadline.addEventListener('abort', () => resolve(), { once: true }))])
        } catch { /* The control socket may already be down. */ }
        finally { closeWire() }
      })() }
    } catch (error) {
      closeWire()
      if (error instanceof DshApiError) throw error
      throw wireFailure(wire, stage === 'handshake' ? 'DSH_UNREACHABLE' : 'LEASE_FAILED')
    }
  }

  private async openControl(signal: AbortSignal, handshake: AbortSignal, attemptId: string) {
    let rejected: string | undefined
    for (;;) {
      const tokens = await this.getTokens(handshake, rejected)
      handshake.throwIfAborted()
      const wire = new DshControlWire(signal, attemptId)
      const socketStarted = Date.now()
      recordDshDiagnostic('connect.websocket.start', { attemptId })
      try {
        await wire.open(handshake)
        recordDshDiagnostic('connect.websocket.open', { attemptId, durationMs: Date.now() - socketStarted })
        wire.send('hello', {
          role: 'client', deviceId: this.identity.deviceId, accessToken: tokens.accessToken,
          protocols: [1], clientVersion: __APP_VERSION__, capabilities: [DSH_RELAY_CAPABILITY],
        })
        recordDshDiagnostic('connect.hello.sent', { attemptId })
        const ack = await wire.next(handshake)
        if (ack.type === 'error') {
          recordDshDiagnostic('connect.hello.failure', { attemptId, frameCode: ack.payload.code })
          throw wireFailure(wire, 'PROTOCOL', ack.payload.code)
        }
        if (ack.type !== 'hello.ack' || ack.payload.protocol !== 1
          || (Array.isArray(ack.payload.capabilities) && !ack.payload.capabilities.includes(DSH_RELAY_CAPABILITY))) {
          throw new DshApiError('PROTOCOL', 0)
        }
        try { wire.limit(ack.payload.maxControlFrameBytes, ack.payload.maxRelayFrameBytes) } catch { throw new DshApiError('PROTOCOL', 0) }
        recordDshDiagnostic('connect.hello.ack', { attemptId })
        return { wire, tokens, refreshed: rejected !== undefined }
      } catch (error) {
        const failure = error instanceof DshApiError ? error : wireFailure(wire, 'DSH_UNREACHABLE')
        if (!signal.aborted) recordDshDiagnostic('connect.websocket.failure', {
          attemptId, durationMs: Date.now() - socketStarted, code: diagnosticCode(failure),
          closeCode: wire.closeInfo?.code, closeReason: wire.closeInfo?.reason,
        })
        wire.close()
        signal.throwIfAborted()
        if (!shouldRefreshDshHello(failure, rejected !== undefined)) throw failure
        rejected = tokens.accessToken
      }
    }
  }

  private async activeFailure(wire: DshControlWire, tokens: DshDeviceTokens, refreshed: boolean, signal: AbortSignal, code?: unknown): Promise<unknown> {
    const failure = wireFailure(wire, 'LEASE_FAILED', code)
    if (failure.code !== 'DSH_AUTH_INVALID' || refreshed) return failure
    try { await this.getTokens(signal, tokens.accessToken) } catch (error) { return error }
    return new DshApiError('LEASE_FAILED', 0)
  }

  invalidate(): void {
    this.lifetime.abort()
    this.tokens = { accessToken: '', accessTokenExpiresAt: 0, refreshToken: '', refreshTokenExpiresAt: 0 }
    this.pinnedPeers.clear()
    this.store?.(null)
  }

  async revoke(): Promise<void> {
    await this.request('/api/v1/devices/self', { method: 'DELETE' }, AbortSignal.timeout(15_000)).catch(error => {
      if (!isDshControllerAuthFailure(error)) throw error
    })
    this.invalidate()
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const send = (tokens: DshDeviceTokens, endpoint = path, request = init) =>
      dshRequest(endpoint, { ...request, headers: { authorization: `Bearer ${tokens.accessToken}` } }, signal)
    const ownEndpoint = path === '/api/v1/devices/self' || path.startsWith('/api/v1/devices?')
    const deniesAuth = (error: DshApiError) => error.status === 401 || ['AUTH_INVALID', 'TOKEN_EXPIRED'].includes(error.code)
    const checkOwnAuth = async (tokens: DshDeviceTokens) => {
      try { await send(tokens, '/api/v1/devices?limit=1', {}) } catch (error) {
        if (error instanceof DshApiError) {
          if (error.code === 'DEVICE_REVOKED') throw controllerAuthError('DEVICE_REVOKED')
          if (deniesAuth(error)) throw controllerAuthError('AUTH_INVALID')
        }
        throw error
      }
    }
    const tokens = await this.getTokens(signal)
    try { return await send(tokens) } catch (error) {
      if (!(error instanceof DshApiError)) throw error
      if (error.code === 'DEVICE_REVOKED') {
        if (ownEndpoint) throw controllerAuthError('DEVICE_REVOKED')
        // A detail request can describe a revoked target instead of a revoked controller.
        await checkOwnAuth(tokens)
        throw error
      }
      if (!deniesAuth(error)) throw error
      const refreshed = await this.getTokens(signal, tokens.accessToken)
      try { return await send(refreshed) } catch (retry) {
        if (!(retry instanceof DshApiError)) throw retry
        if (ownEndpoint && retry.code === 'DEVICE_REVOKED') throw controllerAuthError('DEVICE_REVOKED')
        if (ownEndpoint && deniesAuth(retry)) throw controllerAuthError('AUTH_INVALID')
        if (!ownEndpoint && (deniesAuth(retry) || retry.code === 'DEVICE_REVOKED')) await checkOwnAuth(refreshed)
        throw retry
      }
    }
  }

  private getTokens(signal: AbortSignal, rejected?: string): Promise<DshDeviceTokens> {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    if (this.tokens.accessToken !== rejected && this.tokens.accessTokenExpiresAt > Date.now() + TOKEN_SKEW) {
      if (this.unsavedTokens) { this.store?.(this.tokens); this.unsavedTokens = false }
      return Promise.resolve(this.tokens)
    }
    this.refreshing ??= (async () => {
      if (this.tokens.refreshTokenExpiresAt <= Date.now()) throw controllerAuthError('AUTH_INVALID')
      try {
        const tokens = parseDshDeviceTokens(await dshRequest('/api/v1/auth/refresh', {
          method: 'POST', body: JSON.stringify({ deviceId: this.identity.deviceId, refreshToken: this.tokens.refreshToken }),
        }, this.lifetime.signal))
        this.lifetime.signal.throwIfAborted()
        if (tokens.accessTokenExpiresAt <= Date.now()) throw controllerAuthError('AUTH_INVALID')
        // 刷新已轮换凭据；保存失败仍保留新值，下次请求先重试保存。
        this.tokens = tokens
        this.unsavedTokens = true
        this.store?.(tokens)
        this.unsavedTokens = false
        return tokens
      } catch (error) {
        if (error instanceof DshApiError) {
          if (error.code === 'DEVICE_REVOKED') throw controllerAuthError('DEVICE_REVOKED')
          if (error.status === 401 || error.code === 'AUTH_INVALID' || error.code === 'TOKEN_EXPIRED') throw controllerAuthError('AUTH_INVALID')
        }
        throw error
      }
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing.then(tokens => { signal.throwIfAborted(); return tokens })
  }
}
