import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { acquireDirectoryLock } from '../omp/directory-lock.ts'

import {
  DSH_REMOTE_ORIGIN, createDshIdentity as newIdentity, isDshToken as isToken, isDshExpiry as isExpiry,
  parseDshDeviceTokens as deviceTokens, type DshIdentity, type DshDeviceTokens,
} from '@ompiui/protocol/dsh-remote'

export { DSH_REMOTE_ORIGIN }

const TOKEN_SKEW_MS = 60_000

interface Enrollment {
  identity: DshIdentity
  tokens: DshDeviceTokens | null
}

const knownErrors = new Map([
  ['HOST_REGISTRATION_CODE_NOT_FOUND', 'DS Harness Remote did not recognize that host registration code'],
  ['HOST_REGISTRATION_CODE_EXPIRED', 'The DS Harness Remote host registration code has expired'],
  ['HOST_REGISTRATION_CODE_CONSUMED', 'The DS Harness Remote host registration code has already been used'],
  ['DEVICE_OWNERSHIP_REQUIRED', 'The DS Harness Remote device belongs to another account'],
  ['AUTH_INVALID', 'DS Harness Remote no longer accepts this device authorization'],
  ['DEVICE_REVOKED', 'This device has been removed from DS Harness Remote'],
  ['RATE_LIMITED', 'DS Harness Remote is rate limiting requests. Try again later.'],
])

const hostRegistrationCodes = new Map([
  ['HOST_REGISTRATION_CODE_NOT_FOUND', 'DSH_CODE_INVALID'],
  ['HOST_REGISTRATION_CODE_EXPIRED', 'DSH_CODE_EXPIRED'],
  ['HOST_REGISTRATION_CODE_CONSUMED', 'DSH_CODE_CONSUMED'],
])

class DshRemoteError extends Error {
  constructor(readonly code: string, status: number, message?: string) {
    super(message ?? knownErrors.get(code) ?? `DS Harness Remote rejected the request (HTTP ${status})`)
  }
}

export class DshRemoteAccount {
  private readonly directory: string
  private readonly filename: string
  private refreshFlight?: Promise<{ identity: DshIdentity; tokens: DshDeviceTokens } | null>

  constructor(dataDir: string, private readonly version: string, private readonly request: typeof fetch = fetch,
    readonly role: 'host' | 'client' = 'host') {
    this.directory = join(dataDir, 'dsh-remote')
    this.filename = join(this.directory, `${role}.json`)
  }

  get clientVersion(): string { return this.version }

  async authorization(rejectedAccessToken?: string): Promise<{ identity: DshIdentity; tokens: DshDeviceTokens } | null> {
    const state = await this.load()
    if (!state?.tokens) return null
    if (state.tokens.accessToken !== rejectedAccessToken && state.tokens.accessTokenExpiresAt > Date.now() + TOKEN_SKEW_MS) {
      return { identity: state.identity, tokens: state.tokens }
    }
    this.refreshFlight ??= this.locked(async () => {
      const latest = await this.load()
      if (!latest?.tokens) return null
      const tokens = await this.refresh(latest.identity, latest.tokens, latest.tokens.accessToken === rejectedAccessToken)
      return { identity: latest.identity, tokens }
    }).finally(() => { this.refreshFlight = undefined })
    return this.refreshFlight
  }

  async deviceRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!path.startsWith('/api/v1/') || new URL(path, DSH_REMOTE_ORIGIN).origin !== DSH_REMOTE_ORIGIN) throw new Error('Invalid DS Harness Remote endpoint')
    const state = await this.authorization()
    if (!state) throw new DshRemoteError('AUTH_INVALID', 401)
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${state.tokens.accessToken}`)
    return this.call(path, { ...init, headers })
  }

  async pinPeer(deviceId: string, publicKey: string): Promise<void> {
    if (!/^(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i.test(deviceId)
      || !/^[A-Za-z0-9_-]{43}$/.test(publicKey) || Buffer.from(publicKey, 'base64url').toString('base64url') !== publicKey) {
      throw new Error('Invalid DS Harness Remote peer identity')
    }
    const directory = join(this.directory, `${this.role}-peers`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, deviceId.toLowerCase())
    try {
      await writeFile(path, publicKey, { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await readFile(path, 'utf8') !== publicKey) throw new Error('The DS Harness Remote peer identity changed')
    }
  }

  async status(): Promise<{ registered: boolean; deviceId: string | null }> {
    const state = await this.load()
    return {
      registered: Boolean(state?.tokens && state.tokens.refreshTokenExpiresAt > Date.now()),
      deviceId: state?.identity.deviceId ?? null,
    }
  }

  async registerClient(accountToken: string): Promise<{ deviceId: string }> {
    if (this.role !== 'client' || !isToken(accountToken)) throw new Error('A valid DS Harness Remote account authorization is required')
    return this.locked(async () => {
      const saved = await this.load()
      if (saved?.tokens && saved.tokens.refreshTokenExpiresAt > Date.now()) {
        throw new Error('Revoke the existing DS Harness Remote client authorization before signing in again')
      }
      const identity = saved?.tokens === null ? saved.identity : newIdentity()
      await this.save({ identity, tokens: null })
      const tokens = deviceTokens(await this.call('/api/v1/devices/register', {
        method: 'POST',
        headers: { authorization: `Bearer ${accountToken}` },
        body: JSON.stringify({ v: 1, device: this.descriptor(identity) }),
      }))
      await this.save({ identity, tokens })
      return { deviceId: identity.deviceId }
    })
  }

  async listLoginProviders(): Promise<Array<{ id: string; name: string; start: string }>> {
    const value = await this.call('/api/v1/auth/oauth/providers', { method: 'GET' }) as { items?: unknown[] } | null
    return (Array.isArray(value?.items) ? value.items : []).flatMap(entry => {
      const item = entry as { id?: unknown; displayName?: unknown; qrStartUrl?: unknown } | null
      return typeof item?.id === 'string' && /^[a-z0-9-]{1,40}$/.test(item.id)
        && typeof item.displayName === 'string' && !/[\x00-\x1f\x7f]/.test(item.displayName)
        && typeof item.qrStartUrl === 'string' && /^\/api\/v1\/auth\/oauth\/qr\/start(?:\?provider=[a-z0-9-]+)?$/.test(item.qrStartUrl)
        ? [{ id: item.id, name: item.displayName, start: item.qrStartUrl }] : []
    })
  }

  async startLogin(provider: string): Promise<{ qrId: string; scanUrl: string; expiresIn: number }> {
    const entry = (await this.listLoginProviders()).find(item => item.id === provider)
    if (!entry) throw new Error('That DS Harness Remote login method is not available')
    const value = await this.call(entry.start, { method: 'POST', body: '{}' }) as {
      qrId?: unknown; scanUrl?: unknown; expiresIn?: unknown; provider?: unknown
    } | null
    if (typeof value?.qrId !== 'string' || !/^[a-z0-9_-]{8,100}$/i.test(value.qrId) || typeof value.scanUrl !== 'string'
      || !isExpiry(value.expiresIn) || (value.provider !== undefined && value.provider !== provider)) throw new Error('Invalid DS Harness Remote login session')
    const url = new URL(value.scanUrl)
    if (url.origin !== DSH_REMOTE_ORIGIN || url.username || url.password || /[\x00-\x1f\x7f]/.test(value.scanUrl)) {
      throw new Error('Invalid DS Harness Remote login URL')
    }
    return { qrId: value.qrId, scanUrl: url.href, expiresIn: Math.min(value.expiresIn, 600) }
  }

  async finishLogin(qrId: string, signal?: AbortSignal): Promise<'pending' | 'complete' | 'expired'> {
    if (!/^[a-z0-9_-]{8,100}$/i.test(qrId)) throw new Error('Invalid DS Harness Remote login session')
    const value = await this.call(`/api/v1/auth/oauth/qr/${encodeURIComponent(qrId)}`, { method: 'GET', signal }) as { status?: unknown; token?: unknown } | null
    if (value?.status === 'pending' || value?.status === 'expired') return value.status
    if (value?.status !== 'complete' || !isToken(value.token)) throw new Error('Invalid DS Harness Remote login result')
    await this.registerClient(value.token)
    return 'complete'
  }

  private descriptor(identity: DshIdentity) {
    return {
      deviceId: identity.deviceId, role: this.role,
      name: `OMPiUI (${hostname().replace(/[^\x20-\x7e]/g, '').slice(0, 100) || this.role})`,
      platform: process.platform, identityKey: identity.identityKey, clientVersion: this.version,
    }
  }

  async register(input: string): Promise<{ deviceId: string }> {
    if (this.role !== 'host') throw new Error('Only a host can redeem a host registration code')
    const code = input.trim().toUpperCase()
    if (!/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code)) {
      throw new DshRemoteError('DSH_CODE_INVALID', 400, 'Enter a DS Harness Remote host registration code (XXXX-XXXX)')
    }
    const normalized = code.replace('-', '')
    return await this.locked(async () => {
      const saved = await this.load()
      if (saved?.tokens && saved.tokens.refreshTokenExpiresAt > Date.now()) {
        throw new DshRemoteError('DSH_ALREADY_REGISTERED', 409, 'This OMPiUI host is already registered with DS Harness Remote')
      }
      // Save the identity before redeeming a one-time code; a lost response must not change its key.
      const identity = saved?.tokens === null ? saved.identity : newIdentity()
      await this.save({ identity, tokens: null })
      let tokens: DshDeviceTokens
      try {
        tokens = deviceTokens(await this.call('/api/v1/devices/register-with-code', {
          method: 'POST',
          body: JSON.stringify({
            v: 1,
            code: `${normalized.slice(0, 4)}-${normalized.slice(4)}`,
            device: this.descriptor(identity),
          }),
        }))
      } catch (error) {
        // Keep the hosted service's one-time-code outcome visible to the settings panel.
        if (error instanceof DshRemoteError) {
          const mapped = hostRegistrationCodes.get(error.code)
          if (mapped) throw new DshRemoteError(mapped, 409, error.message)
        }
        throw error
      }
      await this.save({ identity, tokens })
      return { deviceId: identity.deviceId }
    })
  }

  /** 扫码配对要用的本机身份。还没有可用身份时先建一个并落盘；这一步不带任何授权。 */
  async pairingIdentity(): Promise<{ identity: DshIdentity; device: Record<string, unknown> }> {
    if (this.role !== 'host') throw new Error('Only a host can show a pairing code')
    return this.locked(async () => {
      const saved = await this.load()
      const reusable = saved && (saved.tokens === null || saved.tokens.refreshTokenExpiresAt > Date.now())
      const identity = reusable ? saved.identity : newIdentity()
      if (!reusable) await this.save({ identity, tokens: null })
      return { identity, device: this.descriptor(identity) }
    })
  }

  /** 配对完成后收下服务器发给这台电脑的授权。已经有有效授权时保留原来的。 */
  async adoptPairing(identity: DshIdentity, tokens: DshDeviceTokens): Promise<void> {
    await this.locked(async () => {
      const saved = await this.load()
      if (saved?.identity.deviceId !== identity.deviceId || saved.identity.identityKey !== identity.identityKey) {
        throw new DshRemoteError('DSH_PAIRING_IDENTITY_CHANGED', 409, 'This computer was rebound while pairing. Show a new code.')
      }
      if (saved.tokens && saved.tokens.refreshTokenExpiresAt > Date.now()) return
      await this.save({ identity: saved.identity, tokens })
    })
  }

  async resetUnreadable(): Promise<void> {
    await this.locked(async () => {
      try { await this.load() } catch (error) {
        if (!(error instanceof DshRemoteError) || error.code !== 'DSH_STATE_UNREADABLE') throw error
        await rename(this.filename, `${this.filename}.invalid-${randomUUID()}`)
        return
      }
      throw new DshRemoteError('DSH_RESET_NOT_REQUIRED', 409, 'Only a damaged binding can be reset')
    })
  }

  async revoke(): Promise<void> {
    await this.locked(async () => {
      const saved = await this.load()
      if (!saved) return
      if (saved.tokens) {
        try {
          const tokens = await this.refresh(saved.identity, saved.tokens)
          await this.call('/api/v1/devices/self', {
            method: 'DELETE',
            headers: { authorization: `Bearer ${tokens.accessToken}` },
          })
        } catch (error) {
          // A revoked or expired authorization no longer gives this installation remote access.
          if (!(error instanceof DshRemoteError && ['AUTH_INVALID', 'DEVICE_REVOKED'].includes(error.code))) throw error
        }
      }
      await rm(this.filename)
    })
  }

  private async refresh(identity: DshIdentity, tokens: DshDeviceTokens, force = false): Promise<DshDeviceTokens> {
    if (!force && tokens.accessTokenExpiresAt > Date.now() + TOKEN_SKEW_MS) return tokens
    let current = tokens
    // A recovered rotation can return an expired access token and a valid refresh token.
    for (let attempt = 0; attempt < (force ? 1 : 2); attempt++) {
      if (current.refreshTokenExpiresAt <= Date.now()) throw new DshRemoteError('AUTH_INVALID', 401)
      current = deviceTokens(await this.call('/api/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ deviceId: identity.deviceId, refreshToken: current.refreshToken }),
      }))
      await this.save({ identity, tokens: current })
      if (current.accessTokenExpiresAt > Date.now()) return current
    }
    throw new DshRemoteError('AUTH_INVALID', 401, 'DS Harness Remote did not issue a current access token')
  }

  private async call(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers)
    if (init.body) headers.set('content-type', 'application/json')
    const response = await this.request(`${DSH_REMOTE_ORIGIN}${path}`, {
      ...init,
      headers,
      redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    }).catch(() => { throw new DshRemoteError('DSH_UNREACHABLE', 0, 'Could not reach DS Harness Remote') })
    if (response.status === 204) return undefined
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const code = body?.error?.code
      const ownAuth = path === '/api/v1/auth/refresh' || path === '/api/v1/devices/self'
      throw new DshRemoteError(ownAuth && response.status === 401 && code !== 'DEVICE_REVOKED' ? 'AUTH_INVALID'
        : typeof code === 'string' ? code : '', response.status)
    }
    return body
  }

  private async load(): Promise<Enrollment | null> {
    const raw = await readFile(this.filename, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return null
      throw new Error('Could not read the DS Harness Remote device file')
    })
    if (raw === null) return null
    try {
      const saved = JSON.parse(raw) as Enrollment
      if (!/^[\da-f-]{36}$/.test(saved.identity.deviceId)
        || !/^[A-Za-z0-9_-]{43}$/.test(saved.identity.identityKey)
        || !/^[A-Za-z0-9_-]{43}$/.test(saved.identity.privateKey)) throw new Error()
      return { identity: saved.identity, tokens: saved.tokens === null ? null : deviceTokens(saved.tokens) }
    } catch {
      throw new DshRemoteError('DSH_STATE_UNREADABLE', 409, 'The DS Harness Remote device file is invalid')
    }
  }

  private async save(state: Enrollment): Promise<void> {
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.filename)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const lock = await acquireDirectoryLock(join(this.directory, 'locks'), this.role, { timeoutMs: 0 }).catch(error => {
      if (error?.code === 'SESSION_BUSY') {
        throw new DshRemoteError('DSH_OPERATION_IN_PROGRESS', 409, 'A DS Harness Remote authorization operation is in progress')
      }
      throw error
    })
    try { return await action() }
    finally { lock.release() }
  }
}
