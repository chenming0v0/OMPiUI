import {
  DSH_CONTROL_LIMIT, DSH_RELAY_CAPABILITY, DSH_RELAY_LIMIT, DSH_REMOTE_ORIGIN,
  DshNoise, createDshIdentity, decodeDshBase64, dshFrame, dshId, dshRecord, isDshExpiry, isDshToken,
  parseDshBrowserGrant, parseDshDeviceTokens, parseDshFrame, requireDshOmpiuiWeb,
  type DshBrowserGrant, type DshDeviceTokens, type DshFrame, type DshIdentity,
} from '@ompiui/protocol/dsh-remote'
import { getDesktopPlatform, getHttpFetch, isTauriMobile } from '../utils/tauri'

export interface DshLoginProvider { id: string; label: string; start: string }
export interface DshHostListItem { id: string; name: string; online?: boolean }
export interface DshAppConnection { grant: DshBrowserGrant; closed: Promise<void>; close(): void }

const TOKEN_SKEW = 60_000
const WSS = DSH_REMOTE_ORIGIN.replace('https:', 'wss:') + '/ws/v1/connect'
const textEncoder = new TextEncoder()

export class DshApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number, message = `DS Harness Remote (${status})`) {
    super(message)
    this.code = code
    this.status = status
  }
}

// Only hosts other than this device are selectable, even when the service lists every device.
export function selectDshHosts(items: readonly unknown[], selfId: string): DshHostListItem[] {
  const hosts = new Map<string, DshHostListItem>()
  for (const item of items) {
    const entry = dshRecord(item)
    if (!entry) continue
    // Older services omit role; an explicit non-host role is never a work computer.
    if (entry.role !== undefined && entry.role !== 'host') continue
    const id = dshId(entry.deviceId)
    if (id === selfId) continue
    if (typeof entry.name !== 'string' || !entry.name.trim()) throw new Error('Invalid DSH host')
    hosts.set(id, { id, name: entry.name.slice(0, 128), online: typeof entry.online === 'boolean' ? entry.online : undefined })
  }
  return [...hosts.values()]
}

function rethrowHostLookup(error: unknown): never {
  if (error instanceof DshApiError) {
    if (error.status === 401 || error.status === 403) {
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

function wireFailure(wire: BrowserDshControl, stage: 'connect' | 'handshake' | 'lease', message: string): DshApiError {
  const code = wire.closeCode
  if (code === 4003) return new DshApiError('HOST_BUSY', 409, 'The DS Harness Remote host is already connected elsewhere')
  if (code === 4001 || code === 4002) return new DshApiError('HOST_UNAUTHORIZED', 401, 'DS Harness Remote declined this device connection')
  return new DshApiError(stage === 'connect' ? 'HOST_OFFLINE' : stage === 'handshake' ? 'PROTOCOL' : 'LEASE_FAILED', 0, message)
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
  if (url.origin !== DSH_REMOTE_ORIGIN || url.username || url.password || /[\x00-\x1f\x7f]/.test(value.scanUrl)) throw new Error('Invalid DSH login URL')
  return { id: value.qrId, url: url.href, expiresAt: Date.now() + Math.min(value.expiresIn, 600) * 1000 }
}

export async function pollDshLogin(id: string, signal: AbortSignal): Promise<'pending' | 'expired' | DshAppSession> {
  if (!/^[a-z0-9_-]{8,100}$/i.test(id)) throw new Error('Invalid DSH login ID')
  const value = dshRecord(await dshRequest(`/api/v1/auth/oauth/qr/${encodeURIComponent(id)}`, {}, signal))
  if (value?.status === 'pending' || value?.status === 'expired') return value.status
  if (value?.status !== 'complete' || !isDshToken(value.token)) throw new Error('Invalid DSH login response')
  const identity = createDshIdentity()
  const platform = isTauriMobile() ? (/Android/i.test(navigator.userAgent) ? 'android' : 'ios') : getDesktopPlatform()
  const result = await dshRequest('/api/v1/devices/register', {
    method: 'POST', headers: { authorization: `Bearer ${value.token}` },
    body: JSON.stringify({ v: 1, device: {
      deviceId: identity.deviceId, name: `OMPiUI (${platform})`, role: 'client', platform,
      identityKey: identity.identityKey, clientVersion: __APP_VERSION__,
    } }),
  }, signal)
  return new DshAppSession(identity, parseDshDeviceTokens(result))
}

export class DshAppSession {
  private refreshing?: Promise<DshDeviceTokens>
  private readonly pinnedPeers = new Map<string, string>()
  private readonly lifetime = new AbortController()
  private readonly identity: DshIdentity
  private tokens: DshDeviceTokens

  constructor(identity: DshIdentity, tokens: DshDeviceTokens) {
    this.identity = identity
    this.tokens = tokens
  }

  async listHosts(signal: AbortSignal): Promise<DshHostListItem[]> {
    const hosts = new Map<string, DshHostListItem>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) })
      const result = dshRecord(await this.request(`/api/v1/devices?${query}`, {}, signal))
      if (!Array.isArray(result?.items)) throw new Error('Invalid DSH host list')
      for (const host of selectDshHosts(result.items, this.identity.deviceId)) hosts.set(host.id, host)
      if (result.nextCursor == null) break
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor) || cursors.size >= 200) throw new Error('Invalid DSH host list cursor')
      cursor = result.nextCursor
      cursors.add(cursor)
    } while (cursor)
    return [...hosts.values()]
  }

  async connect(hostId: string, caller: AbortSignal): Promise<DshAppConnection> {
    dshId(hostId)
    const signal = AbortSignal.any([this.lifetime.signal, caller])
    const handshake = AbortSignal.any([signal, AbortSignal.timeout(40_000)])
    let value: Record<string, unknown> | undefined
    try {
      value = dshRecord(await this.request(`/api/v1/devices/${encodeURIComponent(hostId)}`, {}, handshake))
    } catch (error) { rethrowHostLookup(error) }
    if (value?.role !== 'host' || value.deviceId !== hostId || typeof value.identityKey !== 'string'
      || decodeDshBase64(value.identityKey, 32).length !== 32 || typeof value.membershipId !== 'string' || !value.membershipId) {
      throw new DshApiError('HOST_UNAUTHORIZED', 403, 'DS Harness Remote did not authorize the selected host')
    }
    const pinned = this.pinnedPeers.get(hostId)
    if (pinned && pinned !== value.identityKey) throw new DshApiError('HOST_UNAUTHORIZED', 403, 'The DS Harness Remote host identity changed')
    this.pinnedPeers.set(hostId, value.identityKey)
    let tokens: DshDeviceTokens
    try {
      tokens = await this.getTokens(handshake)
    } catch (error) {
      if (error instanceof DshApiError && error.code === 'AUTH_INVALID') {
        throw new DshApiError('HOST_UNAUTHORIZED', 401, 'Sign in to DS Harness Remote again')
      }
      throw error
    }
    const wire = new BrowserDshControl(signal)
    let channel: DshNoise | undefined
    let connection: string | undefined
    let ready = false
    let stage: 'connect' | 'handshake' | 'lease' = 'connect'
    const close = () => {
      // Best effort: let the host release the web lease before this control socket goes away.
      if (ready && channel && connection) {
        try { wire.send('relay', { connectionId: connection, targetDeviceId: hostId, ...channel.send(dshFrame('rpc.request', { method: 'dsh.web.close', params: {} })) }) } catch { /* Closing is best effort. */ }
      }
      channel?.destroy()
      wire.close()
    }
    try {
      await wire.open(handshake)
      wire.send('hello', {
        role: 'client', deviceId: this.identity.deviceId, accessToken: tokens.accessToken,
        protocols: [1], clientVersion: __APP_VERSION__, capabilities: [DSH_RELAY_CAPABILITY],
      })
      const ack = await wire.next(handshake)
      if (ack.type === 'error') {
        throw new DshApiError(relayErrorCode(ack.payload.code) || 'HOST_UNAUTHORIZED', 401, 'DS Harness Remote declined this device connection')
      }
      if (ack.type !== 'hello.ack' || ack.payload.protocol !== 1
        || (Array.isArray(ack.payload.capabilities) && !ack.payload.capabilities.includes(DSH_RELAY_CAPABILITY))) {
        throw new DshApiError('PROTOCOL', 0, 'DS Harness Remote declined the Relay connection')
      }
      try { wire.limit(ack.payload.maxControlFrameBytes, ack.payload.maxRelayFrameBytes) } catch {
        throw new DshApiError('PROTOCOL', 0, 'Invalid DS Harness Remote frame limits')
      }
      stage = 'handshake'
      wire.send('connect.request', { hostDeviceId: hostId, preferredTransports: ['relay'] })
      const accepted = await wire.next(handshake)
      if (accepted.type === 'error') {
        throw new DshApiError(relayErrorCode(accepted.payload.code) || 'HOST_OFFLINE', 409, 'DS Harness Remote could not reach the selected host')
      }
      if (accepted.type !== 'connect.accepted') throw new DshApiError('PROTOCOL', 0, 'DS Harness Remote declined this device connection')
      const connectionId = dshId(accepted.payload.connectionId)
      connection = connectionId
      const target = { connectionId, targetDeviceId: hostId }
      channel = new DshNoise(this.identity, value.identityKey, connectionId, hostId, this.identity.deviceId)
      wire.send('transport.selected', { ...target, transport: 'relay' })
      wire.send('secure.handshake', { ...target, step: 1, data: channel.write() })
      let frame = await wire.next(handshake)
      while (frame.type === 'transport.selected') frame = await wire.next(handshake)
      if (frame.type !== 'secure.handshake' || frame.payload.connectionId !== connectionId
        || frame.payload.targetDeviceId !== this.identity.deviceId || frame.payload.step !== 2) {
        throw new DshApiError('PROTOCOL', 0, 'The DS Harness Remote host failed the secure handshake')
      }
      channel.read(frame.payload.data)
      ready = true
      stage = 'lease'
      const channelReady = channel
      const rpc = async (method: string, fallback: 'PROTOCOL' | 'LEASE_FAILED') => {
        const request = dshFrame('rpc.request', { method, params: {} })
        wire.send('relay', { ...target, ...channelReady.send(request) })
        while (true) {
          const next = await wire.next(handshake)
          if (next.type === 'error' && (next.payload.connectionId === undefined || next.payload.connectionId === connectionId)) {
            throw new DshApiError(relayErrorCode(next.payload.code) || fallback, 0, 'DS Harness Remote rejected the web handoff')
          }
          if (next.type !== 'relay' || next.payload.connectionId !== connectionId || next.payload.targetDeviceId !== this.identity.deviceId) continue
          const response = parseDshFrame(channelReady.receive(next.payload.counter, next.payload.ciphertext))
          if (response.payload.requestId !== request.id) continue
          if (response.type === 'rpc.response') return response.payload.result
          if (response.type === 'rpc.error') {
            const code = String(response.payload.code ?? '')
            throw new DshApiError(code === 'RATE_LIMITED' ? 'HOST_BUSY' : fallback, 0, 'The DS Harness Remote host could not open a web tunnel')
          }
          throw new DshApiError(fallback, 0, 'The DS Harness Remote host could not open a web tunnel')
        }
      }
      try { requireDshOmpiuiWeb(await rpc('harness.transport.describe', 'PROTOCOL')) } catch (error) {
        if (error instanceof DshApiError) throw error
        throw new DshApiError('PROTOCOL', 0, 'The DS Harness Remote host does not support the OMPiUI web handoff')
      }
      const grant = parseDshBrowserGrant(await rpc('dsh.web.open', 'LEASE_FAILED'))
      void (async () => {
        while (true) {
          const update = await wire.next(signal)
          if (update.type === 'error' && (update.payload.connectionId === undefined || update.payload.connectionId === connectionId)) return
        }
      })().catch(() => {}).finally(close)
      return { grant, close, closed: wire.closed }
    } catch (error) {
      close()
      if (error instanceof DshApiError) throw error
      throw wireFailure(wire, stage, stage === 'connect'
        ? 'Could not connect to the DS Harness Remote host'
        : 'The DS Harness Remote connection failed')
    }
  }

  async revoke(): Promise<void> {
    await this.request('/api/v1/devices/self', { method: 'DELETE' }, AbortSignal.timeout(15_000)).catch(error => {
      if (!(error instanceof DshApiError && ['AUTH_INVALID', 'DEVICE_REVOKED'].includes(error.code))) throw error
    })
    this.lifetime.abort()
    this.tokens = { accessToken: '', accessTokenExpiresAt: 0, refreshToken: '', refreshTokenExpiresAt: 0 }
    this.pinnedPeers.clear()
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const tokens = await this.getTokens(signal)
    return dshRequest(path, { ...init, headers: { authorization: `Bearer ${tokens.accessToken}` } }, signal)
  }

  private getTokens(signal: AbortSignal): Promise<DshDeviceTokens> {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    if (this.tokens.accessTokenExpiresAt > Date.now() + TOKEN_SKEW) return Promise.resolve(this.tokens)
    this.refreshing ??= (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.tokens.refreshTokenExpiresAt <= Date.now()) throw new DshApiError('AUTH_INVALID', 401)
        this.tokens = parseDshDeviceTokens(await dshRequest('/api/v1/auth/refresh', {
          method: 'POST', body: JSON.stringify({ deviceId: this.identity.deviceId, refreshToken: this.tokens.refreshToken }),
        }, this.lifetime.signal))
        if (this.tokens.accessTokenExpiresAt > Date.now()) return this.tokens
      }
      throw new DshApiError('AUTH_INVALID', 401)
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
}

class BrowserDshControl {
  readonly closed: Promise<void>
  closeCode?: number
  private readonly socket = new WebSocket(WSS)
  private readonly queue: Array<{ frame: DshFrame; size: number }> = []
  private readonly ended = new AbortController()
  private queuedBytes = 0
  private controlLimit = DSH_CONTROL_LIMIT
  private relayLimit = DSH_RELAY_LIMIT
  private wake?: () => void
  private idleTimer?: ReturnType<typeof setTimeout>

  constructor(signal: AbortSignal) {
    const abort = () => this.close()
    signal.addEventListener('abort', abort, { once: true })
    this.closed = new Promise(resolve => this.socket.addEventListener('close', event => {
      this.closeCode = event.code
      clearTimeout(this.idleTimer)
      signal.removeEventListener('abort', abort)
      this.ended.abort()
      this.queue.length = 0
      resolve()
    }, { once: true }))
    this.socket.addEventListener('error', () => this.close())
    this.socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string') throw new Error('Invalid DSH frame encoding')
        const size = textEncoder.encode(event.data).length
        if (size > this.relayLimit) throw new Error('DSH frame too large')
        const frame = parseDshFrame(event.data)
        if (frame.type !== 'relay' && size > this.controlLimit) throw new Error('DSH control frame too large')
        clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => this.close(), 60_000)
        if (frame.type === 'ping') { this.send('pong', frame.payload); return }
        if (this.queue.length >= 16 || this.queuedBytes + size > DSH_RELAY_LIMIT) throw new Error('DSH control queue full')
        this.queue.push({ frame, size })
        this.queuedBytes += size
        this.wake?.()
      } catch { this.close() }
    })
    if (signal.aborted) this.close()
  }

  async open(signal: AbortSignal): Promise<void> {
    const lifetime = AbortSignal.any([signal, this.ended.signal])
    lifetime.throwIfAborted()
    if (this.socket.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      const remove = () => {
        lifetime.removeEventListener('abort', abort)
        this.socket.removeEventListener('open', opened)
      }
      const abort = () => { remove(); reject(new Error('Could not connect to DS Harness Remote')) }
      const opened = () => { remove(); resolve() }
      lifetime.addEventListener('abort', abort, { once: true })
      this.socket.addEventListener('open', opened, { once: true })
    })
  }

  limit(control: unknown, relay: unknown): void {
    if (!isDshExpiry(control) || control > DSH_CONTROL_LIMIT || !isDshExpiry(relay) || relay > DSH_RELAY_LIMIT) throw new Error('Invalid DSH frame limits')
    this.controlLimit = control
    this.relayLimit = relay
  }

  send(type: string, payload: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > DSH_RELAY_LIMIT) throw new Error('DSH control connection is closed')
    const frame = JSON.stringify(dshFrame(type, payload))
    if (textEncoder.encode(frame).length > (type === 'relay' ? this.relayLimit : this.controlLimit)) throw new Error('DSH frame too large')
    this.socket.send(frame)
  }

  async next(signal: AbortSignal): Promise<DshFrame> {
    const lifetime = AbortSignal.any([signal, this.ended.signal])
    while (!this.queue.length) {
      lifetime.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const abort = () => { this.wake = undefined; reject(lifetime.reason) }
        this.wake = () => { this.wake = undefined; lifetime.removeEventListener('abort', abort); resolve() }
        lifetime.addEventListener('abort', abort, { once: true })
      })
    }
    lifetime.throwIfAborted()
    const item = this.queue.shift()!
    this.queuedBytes -= item.size
    return item.frame
  }

  close(): void {
    const wake = this.wake
    this.ended.abort()
    this.socket.close()
    // Wake a next() waiter that registered before the abort listener, then reject any later send.
    wake?.()
  }
}
