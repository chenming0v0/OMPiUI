import { randomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { diagnostics } from '../diagnostics/recorder.ts'
import { DshRemoteAccount } from './dsh-remote-account.ts'
import { runDshHost } from './dsh-host.ts'
import { DshHostPairing, type DshHostPairingView } from './dsh-host-pairing.ts'

export type DshHostState = 'unregistered' | 'disabled' | 'connecting' | 'online' | 'error' | 'stopped'

export interface DshHostLastError { code: string; message: string }

export interface DshHostStatus {
  available: boolean
  reason: 'loopback' | 'web' | null
  enabled: boolean
  registered: boolean
  deviceId: string | null
  state: DshHostState
  lastError: DshHostLastError | null
  updatedAt: number
  /** 正在进行或刚结束的扫码配对；没有时为 null。 */
  pairing: DshHostPairingView | null
}

// Only these listeners can be reached as 127.0.0.1:<port> by the hosted tunnel.
const LOOPBACK_BINDS = new Set(['127.0.0.1', '::ffff:127.0.0.1', '0.0.0.0', '::'])
// A host that lost its authorization or slot cannot recover by retrying.
const TERMINAL_CODES = new Set(['DSH_ALREADY_CONNECTED', 'DSH_AUTH_INVALID', 'DSH_DEVICE_REVOKED'])

export function deriveDshHostState(value: {
  registered: boolean; enabled: boolean; online: boolean; stopped: boolean; lastError: DshHostLastError | null
}): DshHostState {
  if (!value.registered) return 'unregistered'
  if (value.online) return 'online'
  if (value.enabled) return 'connecting'
  if (value.stopped) return 'stopped'
  if (value.lastError) return 'error'
  return 'disabled'
}

export function dshHostFailure(error: unknown): DshHostLastError {
  const failure = error as { replaced?: boolean; code?: string; message?: string } | undefined
  if (failure?.replaced || failure?.code === 'ALREADY_CONNECTED') return { code: 'DSH_ALREADY_CONNECTED', message: 'This DS Harness Remote host is already connected elsewhere' }
  if (failure?.code === 'AUTH_INVALID') return { code: 'DSH_AUTH_INVALID', message: 'DS Harness Remote no longer accepts this device authorization' }
  if (failure?.code === 'DEVICE_REVOKED') return { code: 'DSH_DEVICE_REVOKED', message: 'This device has been removed from DS Harness Remote' }
  if (!failure?.code || failure.code === 'DSH_UNREACHABLE') return { code: 'DSH_UNREACHABLE', message: 'Could not reach DS Harness Remote' }
  return { code: 'DSH_HOST_ERROR', message: typeof failure.message === 'string' ? failure.message : 'DS Harness Remote host connection failed' }
}

export function isTerminalDshHostFailure(failure: DshHostLastError): boolean {
  return TERMINAL_CODES.has(failure.code)
}

/** Publish atomically so multiple server starts share the same local-only secret. */
export async function loadDshManagementToken(dataDir: string): Promise<string> {
  const directory = join(dataDir, 'dsh-remote')
  const path = join(directory, 'management-token')
  const existing = await readFile(path, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (existing && /^[a-f0-9]{64}$/.test(existing)) return existing
  if (existing !== undefined) throw new Error('Invalid local DS Harness Remote management credential')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const token = randomBytes(32).toString('hex')
  try {
    await writeFile(temporary, token, { flag: 'wx', mode: 0o600 })
    await link(temporary, path).catch(error => { if (error?.code !== 'EEXIST') throw error })
    return await readFile(path, 'utf8')
  } finally { await rm(temporary, { force: true }) }
}

export class DshHostedManager {
  readonly origins = new Set<string>()
  private readonly directory: string
  private readonly statePath: string
  private readonly account: DshRemoteAccount
  private readonly pairing: DshHostPairing
  private port?: number
  private loopback = true
  private enabled = false
  private stopped = false
  private stop?: AbortController
  private task?: Promise<void>
  private operations = Promise.resolve()
  private terminal?: DshHostLastError
  private online = false
  private lastError: DshHostLastError | null = null
  private updatedAt = Date.now()
  private signature = ''
  private disposed = false

  constructor(dataDir: string, version: string, private readonly startupEnabled: boolean,
    private readonly run: typeof runDshHost = runDshHost, request: typeof fetch = fetch, pairingPollMs?: number) {
    this.account = new DshRemoteAccount(dataDir, version, request)
    this.pairing = new DshHostPairing(this.account, () => this.openAfterPairing(), request, pairingPollMs)
    this.directory = join(dataDir, 'dsh-remote')
    this.statePath = join(this.directory, 'enabled.json')
  }

  /** Attach a listener with a Web build, even if it is not reachable over IPv4 loopback. */
  attach(port: number, address = '127.0.0.1'): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return
      this.port = port
      this.loopback = LOOPBACK_BINDS.has(address)
      const saved = await readFile(this.statePath, 'utf8').catch(error => {
        if (error?.code === 'ENOENT') return undefined
        throw error
      })
      this.enabled = saved === undefined ? this.startupEnabled : saved === 'true'
      this.stopped = false
      this.start()
    })
  }

  async status(): Promise<DshHostStatus> {
    let registered = false
    let deviceId: string | null = null
    let unreadable: DshHostLastError | null = null
    try {
      const account = await this.account.status()
      registered = account.registered
      deviceId = account.deviceId
    } catch (error) {
      unreadable = { code: 'DSH_STATE_UNREADABLE', message: error instanceof Error ? error.message : 'Could not read the DS Harness Remote device file' }
    }
    const available = this.port !== undefined && this.loopback
    const reason = this.port === undefined ? 'web' : this.loopback ? null : 'loopback'
    const lastError = unreadable ?? this.lastError
    const state = unreadable ? 'error' : deriveDshHostState({
      registered, enabled: this.enabled, online: this.online, stopped: this.stopped, lastError: this.lastError,
    })
    const signature = JSON.stringify([available, reason, this.enabled, registered, deviceId, state,
      lastError?.code ?? null, lastError?.message ?? null])
    if (signature !== this.signature) {
      this.signature = signature
      this.updatedAt = Date.now()
    }
    return {
      available, reason, enabled: this.enabled, registered, deviceId, state, lastError, updatedAt: this.updatedAt,
      pairing: this.pairing.view(),
    }
  }

  manage(action: unknown, code?: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) throw dshHostError('DSH_UNAVAILABLE', 'The OMPiUI host is shutting down')
      if (this.port === undefined) throw dshHostError('DSH_UNAVAILABLE', 'DS Harness Remote needs a local OMPiUI web listener')
      if (!this.loopback) throw dshHostError('DSH_LOOPBACK_REQUIRED', 'DS Harness Remote needs an IPv4 loopback-accessible listener')
      await this.persistTerminal()
      if (action === 'register' && typeof code === 'string') {
        await this.account.register(code)
        this.lastError = null
        this.stopped = false
        this.start()
      } else if (action === 'enable') {
        if (!(await this.account.status()).registered) throw dshHostError('DSH_NOT_REGISTERED', 'Register this OMPiUI host first')
        await this.setEnabled(true)
        // A terminal event may have arrived during the write. Persist it and join the old
        // task before honoring this explicit enable, otherwise start() would be a no-op.
        if (this.terminal) {
          await this.persistTerminal()
          await this.setEnabled(true)
        }
        this.lastError = null
        this.stopped = false
        this.start()
      } else if (action === 'pair') {
        await this.pairing.start()
      } else if (action === 'pair-confirm') {
        // 手机上的验证码只走这个本机管理入口，由人在这台电脑的界面里输入。
        await this.pairing.confirm(typeof code === 'string' ? code : undefined)
      } else if (action === 'pair-cancel') {
        await this.pairing.cancel()
      } else if (action === 'disable' || action === 'revoke' || action === 'reset') {
        if (action !== 'disable') await this.pairing.cancel()
        await this.setEnabled(false)
        await this.halt()
        await this.persistTerminal()
        this.stopped = true
        if (action === 'revoke') await this.account.revoke()
        if (action === 'reset') await this.account.resetUnreadable()
        if (action !== 'disable') this.lastError = null
      } else throw new Error('Invalid DS Harness Remote host operation')
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.enqueue(async () => { await this.pairing.cancel(); await this.halt(); await this.persistTerminal() })
  }

  /** 人在这台电脑上输入验证码确认过的手机，应当马上能连进来：配对成功就打开远程访问。 */
  private openAfterPairing(): void {
    void this.enqueue(async () => {
      if (this.disposed || this.port === undefined || !this.loopback) return
      await this.persistTerminal()
      await this.setEnabled(true)
      this.lastError = null
      this.stopped = false
      this.start()
    }).catch(() => console.error('[ompiui-dsh] Could not open remote access after pairing'))
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.operations.then(action)
    this.operations = next.catch(() => undefined)
    return next
  }

  private async persistTerminal(): Promise<void> {
    if (!this.terminal) return
    await this.task
    try {
      await this.setEnabled(false)
    } catch (cause) {
      this.enabled = false
      const message = 'Could not persist the stopped DS Harness Remote host state'
      this.lastError = { code: 'DSH_STATE_WRITE_FAILED', message }
      throw Object.assign(new Error(message, { cause }), { code: this.lastError.code })
    }
    this.lastError = this.terminal
    this.terminal = undefined
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, String(enabled), { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.statePath)
      this.enabled = enabled
    } finally { await rm(temporary, { force: true }) }
  }

  private async halt(): Promise<void> {
    this.stop?.abort()
    this.origins.clear()
    await this.task
    this.online = false
  }

  private start(): void {
    const port = this.port
    if (this.disposed || !this.enabled || !this.loopback || port === undefined || this.task) return
    const stop = new AbortController()
    const signal = stop.signal
    this.stop = stop
    this.task = (async () => {
      while (!signal.aborted) {
        const attemptStartedAt = Date.now()
        diagnostics.record('dsh.host.connection.attempt')
        try {
          if (!(await this.account.status()).registered) return
          signal.throwIfAborted()
          await this.run(this.account, port, signal, this.origins, () => {
            this.online = true
            this.lastError = null
            diagnostics.record('dsh.host.online', { durationMs: Date.now() - attemptStartedAt })
            console.info('[ompiui-dsh] DS Harness Remote host online')
          })
          if (!signal.aborted) diagnostics.record('dsh.host.connection.ended', { durationMs: Date.now() - attemptStartedAt }, 'warn')
        } catch (error) {
          if (signal.aborted) break
          const failure = dshHostFailure(error)
          diagnostics.record('dsh.host.connection.failed', {
            durationMs: Date.now() - attemptStartedAt, errorCode: failure.code,
          }, 'warn')
          if (isTerminalDshHostFailure(failure)) {
            // Persisted enabled=true would retry the same dead authorization after every restart.
            this.enabled = false
            this.stopped = false
            this.terminal = failure
            // The task never waits on the management queue; queued actions can join it safely.
            void this.enqueue(() => this.persistTerminal()).catch(error => console.error('[ompiui-dsh]', error))
            return
          }
          this.lastError = failure
        } finally { this.online = false }
        await delay(3_000 + Math.random() * 12_000, undefined, { signal, ref: false })
      }
    })().catch(() => { if (!signal.aborted) this.lastError = dshHostFailure(new Error('DS Harness Remote host connection failed')) })
      .finally(() => { this.stop = undefined; this.task = undefined })
  }
}

function dshHostError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}
