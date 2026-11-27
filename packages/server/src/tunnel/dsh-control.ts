import { WebSocket, type RawData } from 'ws'
import {
  DSH_REMOTE_ORIGIN, DSH_RELAY_CAPABILITY as RELAY, DSH_CONTROL_LIMIT as CONTROL_LIMIT, DSH_RELAY_LIMIT as WS_LIMIT,
  DshNoise, decodeDshBase64, dshControlFailure, dshFrame, dshId, dshRecord as record, parseDshFrame as parseFrame,
  type DshFrame as Frame, type DshIdentity,
} from '@ompiui/protocol/dsh-remote'
import { DshRemoteAccount } from './dsh-remote-account.ts'

type Payload = Record<string, unknown>
export type DshControlSocketFactory = (url: string, options: { handshakeTimeout: number; maxPayload: number; perMessageDeflate: false }) => WebSocket
const openSocket: DshControlSocketFactory = (url, options) => new WebSocket(url, options)

export function dshControlError(code?: unknown, close?: { code: number; reason: string }): Error {
  const failure = dshControlFailure(code, close)
  return Object.assign(new Error({
    DEVICE_REVOKED: 'This DS Harness Remote device has been revoked',
    ALREADY_CONNECTED: 'This DS Harness Remote device is already connected',
    AUTH_INVALID: 'DS Harness Remote refused this device authorization',
    DSH_UNREACHABLE: 'The DS Harness Remote control connection ended',
  }[failure]), { code: failure })
}
export const dshDeviceId = dshId
export const dshConnectionId = dshId

export class DshControl {
  readonly closed: Promise<number>
  private queue: Frame[] = []
  private wake?: () => void
  private closeInfo?: { code: number; reason: string }
  private controlLimit = CONTROL_LIMIT
  private relayLimit = WS_LIMIT
  private timeout?: NodeJS.Timeout
  private pendingBytes = 0

  private constructor(private readonly socket: WebSocket, signal?: AbortSignal) {
    const abort = () => this.close()
    signal?.addEventListener('abort', abort, { once: true })
    this.closed = new Promise(resolve => socket.once('close', (code, reason) => {
      signal?.removeEventListener('abort', abort)
      clearTimeout(this.timeout)
      this.closeInfo = { code, reason: reason.toString() }
      this.wake?.()
      resolve(code)
    }))
    socket.on('error', () => socket.terminate())
    socket.on('message', (value: RawData, binary: boolean) => {
      try {
        if (binary) throw new Error('Unexpected DS Harness Remote binary control frame')
        const bytes = Array.isArray(value) ? Buffer.concat(value) : Buffer.from(value as Buffer)
        const message = parseFrame(bytes)
        if (bytes.length > (message.type === 'relay' ? this.relayLimit : this.controlLimit)) throw new Error('DS Harness Remote frame too large')
        this.resetTimeout()
        if (message.type === 'ping') {
          this.send('pong', message.payload)
          return
        }
        if (this.queue.length >= 16 || this.pendingBytes + bytes.length > WS_LIMIT) throw new Error('DS Harness Remote control queue full')
        this.pendingBytes += bytes.length
        this.queue.push(Object.assign(message, { receivedBytes: bytes.length }))
        this.wake?.()
      } catch {
        socket.close(1002, 'invalid control frame')
      }
    })
  }

  static async open(account: DshRemoteAccount, signal: AbortSignal, rejected?: string,
    socketFactory = openSocket): Promise<{ control: DshControl; identity: DshIdentity; accessToken: string; refreshed: boolean }> {
    for (;;) {
      signal.throwIfAborted()
      const auth = await account.authorization(rejected)
      if (!auth) throw Object.assign(new Error('Authorize this device with DS Harness Remote first'), { code: 'AUTH_INVALID' })
      signal.throwIfAborted()
      const socket = socketFactory(DSH_REMOTE_ORIGIN.replace(/^https:/, 'wss:') + '/ws/v1/connect', {
        handshakeTimeout: 8_000, maxPayload: WS_LIMIT, perMessageDeflate: false,
      })
      const control = new DshControl(socket, signal)
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve)
          void control.closed.then(() => reject(control.failure()))
        })
        signal.throwIfAborted()
        control.send('hello', {
          role: account.role, deviceId: auth.identity.deviceId, accessToken: auth.tokens.accessToken,
          protocols: [1], clientVersion: account.clientVersion, capabilities: [RELAY],
        })
        const ack = await control.next(AbortSignal.any([signal, AbortSignal.timeout(8_000)]))
        if (ack?.type === 'error') throw control.failure(ack.payload.code)
        if (!ack) throw control.failure()
        if (ack.type !== 'hello.ack' || ack.payload.protocol !== 1
          || (Array.isArray(ack.payload.capabilities) && !ack.payload.capabilities.includes(RELAY))) {
          throw new Error('DS Harness Remote refused Relay authentication')
        }
        const limits = ack.payload
        if (typeof limits.maxControlFrameBytes !== 'number' || !Number.isSafeInteger(limits.maxControlFrameBytes)
          || limits.maxControlFrameBytes <= 0 || limits.maxControlFrameBytes > CONTROL_LIMIT
          || typeof limits.maxRelayFrameBytes !== 'number' || !Number.isSafeInteger(limits.maxRelayFrameBytes)
          || limits.maxRelayFrameBytes <= 0 || limits.maxRelayFrameBytes > WS_LIMIT) throw new Error('Invalid DS Harness Remote frame limits')
        control.controlLimit = limits.maxControlFrameBytes
        control.relayLimit = limits.maxRelayFrameBytes
        return { control, identity: auth.identity, accessToken: auth.tokens.accessToken, refreshed: rejected !== undefined }
      } catch (error) {
        control.close()
        signal.throwIfAborted()
        if ((error as { code?: string })?.code !== 'AUTH_INVALID' || rejected !== undefined) throw error
        rejected = auth.tokens.accessToken
      }
    }
  }

  failure(frameCode?: unknown): Error { return dshControlError(frameCode, this.closeInfo) }

  async next(signal: AbortSignal): Promise<Frame | undefined> {
    while (this.queue.length === 0 && this.closeInfo === undefined) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const abort = () => { this.wake = undefined; reject(signal.reason) }
        this.wake = () => {
          signal.removeEventListener('abort', abort)
          this.wake = undefined
          resolve()
        }
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    signal.throwIfAborted()
    const value = this.queue.shift() as (Frame & { receivedBytes: number }) | undefined
    if (value) this.pendingBytes -= value.receivedBytes
    return value
  }

  send(type: string, payload: Payload): void {
    if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > WS_LIMIT) throw new Error('DS Harness Remote socket unavailable')
    const message = JSON.stringify(dshFrame(type, payload))
    if (Buffer.byteLength(message) > (type === 'relay' ? this.relayLimit : this.controlLimit)) throw new Error('DS Harness Remote frame too large')
    this.socket.send(message)
  }

  sendSecure(connectionId: string, targetDeviceId: string, noise: DshNoise, type: string, payload: Payload): string {
    const message = dshFrame(type, payload)
    this.send('relay', { connectionId, targetDeviceId, ...noise.send(message) })
    return message.id
  }

  close(): void { this.socket.terminate() }

  private resetTimeout() {
    clearTimeout(this.timeout)
    this.timeout = setTimeout(() => this.close(), 60_000)
    this.timeout.unref()
  }
}

export function parseDshSecure(noise: DshNoise, payload: Payload): Frame {
  return parseFrame(noise.receive(payload.counter, payload.ciphertext))
}

export async function verifyDshPeer(account: DshRemoteAccount, role: 'host' | 'client', id: string, signal: AbortSignal,
  expectedKey?: unknown): Promise<string> {
  const value = record(await account.deviceRequest(`/api/v1/devices/${encodeURIComponent(id)}`, { signal }))
  const key = value?.identityKey
  if (value?.role !== role || value.deviceId !== id || typeof key !== 'string' || decodeDshBase64(key, 32).length !== 32
    || (expectedKey !== undefined && key !== expectedKey) || typeof value.membershipId !== 'string' || !value.membershipId) {
    throw new Error('DS Harness Remote did not authorize that peer')
  }
  await account.pinPeer(id, key)
  return key
}
