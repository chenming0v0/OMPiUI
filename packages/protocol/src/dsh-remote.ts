import { NqHandshake, chachaPoly, noiseIk, sha256H, x25519Keygen, type TransportState } from '@lukeburns/clatterjs'

export const DSH_REMOTE_ORIGIN = 'https://dsh.r2049.cn'
export const DSH_RELAY_CAPABILITY = 'transport.relay'
export const OMPIUI_DSH_WEB_CAPABILITY = 'ompiui.web.v1'
export const DSH_CONTROL_LIMIT = 64 * 1024
export const DSH_RELAY_LIMIT = 1024 * 1024

const DSH_ID = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i
const TUNNEL_HOST = /^(?:[tp][abcdefghijkmnpqrstuvwxyz23456789]{11}\.(?:hostc|tun)|t[abcdefghijkmnpqrstuvwxyz23456789]{11}\.(?:hostc-test|tun-test))\.4ba\.io$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface DshIdentity {
  deviceId: string
  identityKey: string
  privateKey: string
}

export interface DshBrowserGrant { url: string; browserGrant: string; expiresAt: number }
export type DshWebLeaseEnd = 'hostc-closed' | 'check-failed' | 'expired'
export const DSH_WEB_LEASE_ENDED = 'dsh.web.ended'

export function isDshWebLeaseEnd(value: unknown): value is DshWebLeaseEnd {
  return value === 'hostc-closed' || value === 'check-failed' || value === 'expired'
}

export type DshControlFailure = 'AUTH_INVALID' | 'DEVICE_REVOKED' | 'ALREADY_CONNECTED' | 'DSH_UNREACHABLE'

/** Only use for control-wide errors, never errors scoped to a peer connection. */
export function dshControlFailure(frameCode?: unknown, close?: { code: number; reason: string }): DshControlFailure {
  const reason = close?.reason.trim().toUpperCase().replaceAll(' ', '_')
  if (close?.code === 4004 || frameCode === 'DEVICE_REVOKED' || (close?.code === 4002 && reason === 'DEVICE_REVOKED')) return 'DEVICE_REVOKED'
  if (close?.code === 4003 || frameCode === 'ALREADY_CONNECTED') return 'ALREADY_CONNECTED'
  if (frameCode === 'AUTH_INVALID' || frameCode === 'TOKEN_EXPIRED' || close?.code === 4002) return 'AUTH_INVALID'
  // 4001 and ordinary server-side shutdowns do not mean the credentials are invalid.
  return 'DSH_UNREACHABLE'
}

export interface DshHostListItem { id: string; name: string; online?: boolean }

export function selectDshHosts(items: readonly unknown[], controllerId: string, localHostId?: string | null): DshHostListItem[] {
  const excluded = new Set([controllerId.toLowerCase(), localHostId?.toLowerCase()])
  const hosts = new Map<string, DshHostListItem>()
  for (const item of items) {
    const entry = dshRecord(item)
    if (entry?.role !== 'host') continue
    const id = dshId(entry.deviceId)
    if (excluded.has(id.toLowerCase())) continue
    if (typeof entry.name !== 'string' || !entry.name.trim()) throw new Error('Invalid DSH host name')
    hosts.set(id, { id, name: entry.name.slice(0, 128), online: typeof entry.online === 'boolean' ? entry.online : undefined })
  }
  return [...hosts.values()]
}
export interface DshDeviceTokens {
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken: string
  refreshTokenExpiresAt: number
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> { return crypto.getRandomValues(new Uint8Array(length)) }

export function dshId(value: unknown): string {
  if (typeof value !== 'string' || !DSH_ID.test(value)) throw new Error('Invalid DS Harness Remote identifier')
  return value
}

export function encodeDshBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeDshBase64(value: unknown, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid DSH Remote wire encoding')
  }
  const decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
  if (decoded.length > max || encodeDshBase64(decoded) !== value) throw new Error('Invalid DSH Remote wire encoding')
  return decoded
}

export function createDshIdentity(): DshIdentity {
  const key = x25519Keygen(randomBytes)
  return { deviceId: crypto.randomUUID(), identityKey: encodeDshBase64(key.publicKey), privateKey: encodeDshBase64(key.secretKey) }
}

export function dshWireId(): string {
  const time = BigInt(Date.now()) << 80n
  let entropy = 0n
  for (const byte of randomBytes(10)) entropy = (entropy << 8n) | BigInt(byte)
  let value = time | entropy
  let id = ''
  for (let i = 0; i < 26; i++) {
    id = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(value & 31n)] + id
    value >>= 5n
  }
  return id
}

export function dshRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function requireDshOmpiuiWeb(value: unknown): void {
  const capabilities = dshRecord(value)?.capabilities
  if (!Array.isArray(capabilities) || !capabilities.includes('dsh.web.v1') || !capabilities.includes(OMPIUI_DSH_WEB_CAPABILITY)) {
    throw new Error('The selected host does not offer hosted OMPiUI web access')
  }
}

export function parseDshBrowserGrant(value: unknown): DshBrowserGrant {
  const data = dshRecord(value)
  if (typeof data?.url !== 'string' || typeof data.browserGrant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.browserGrant)
    || typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now()) {
    throw new Error('Invalid DS Harness Remote browser grant')
  }
  const url = new URL(data.url)
  if (url.href !== `https://${url.hostname}/` || !TUNNEL_HOST.test(url.hostname)) throw new Error('Invalid DS Harness Remote browser origin')
  return { url: url.href, browserGrant: data.browserGrant, expiresAt: data.expiresAt }
}

export function isDshToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value)
}
export function isDshExpiry(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
export function parseDshDeviceTokens(value: unknown): DshDeviceTokens {
  const data = dshRecord(value)
  if (!data || !isDshToken(data.accessToken) || !isDshToken(data.refreshToken)
    || !isDshExpiry(data.accessTokenExpiresAt) || !isDshExpiry(data.refreshTokenExpiresAt)) {
    throw new Error('Invalid DS Harness Remote device credentials')
  }
  return { accessToken: data.accessToken, accessTokenExpiresAt: data.accessTokenExpiresAt,
    refreshToken: data.refreshToken, refreshTokenExpiresAt: data.refreshTokenExpiresAt }
}

export type DshFrame = { v: 1; id: string; type: string; timestamp: number; payload: Record<string, unknown> }

export function dshFrame(type: string, payload: Record<string, unknown>): DshFrame {
  return { v: 1, id: dshWireId(), type, timestamp: Date.now(), payload }
}

export function parseDshFrame(bytes: Uint8Array | string): DshFrame {
  try {
    const text = typeof bytes === 'string' ? bytes : decoder.decode(bytes)
    const value = dshRecord(JSON.parse(text))
    if (value?.v !== 1 || typeof value.id !== 'string' || !DSH_ID.test(value.id)
      || typeof value.type !== 'string' || !Number.isSafeInteger(value.timestamp) || !dshRecord(value.payload)) throw new Error()
    // Detect duplicate field names, including names spelled with JSON escapes.
    const objects: Array<Set<string> | undefined> = []
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      if (char === '{') objects.push(new Set())
      else if (char === '[') objects.push(undefined)
      else if (char === '}' || char === ']') objects.pop()
      else if (char === '"') {
        const start = i
        for (i++; i < text.length; i++) {
          if (text[i] === '\\') i++
          else if (text[i] === '"') break
        }
        let next = i + 1
        while (/\s/.test(text[next] ?? '')) next++
        if (text[next] !== ':') continue
        const keys = objects.at(-1)
        const key: string = JSON.parse(text.slice(start, i + 1))
        if (!keys || keys.has(key)) throw new Error()
        keys.add(key)
      }
    }
    return value as DshFrame
  } catch {
    throw new Error('Invalid DS Harness Remote message')
  }
}

/** Same Noise provider, cipher suite and prologue as DS Harness Remote v1. */
export class DshNoise {
  private handshake: NqHandshake | undefined
  private transport: TransportState | undefined
  private readonly peer: Uint8Array

  constructor(local: DshIdentity, peer: string, connectionId: string, hostId: string, clientId: string) {
    this.peer = decodeDshBase64(peer, 32)
    const publicKey = decodeDshBase64(local.identityKey, 32)
    const secretKey = decodeDshBase64(local.privateKey, 32)
    if (this.peer.length !== 32 || publicKey.length !== 32 || secretKey.length !== 32) throw new Error('Invalid DSH Remote identity')
    const initiator = local.deviceId === clientId
    this.handshake = new NqHandshake(noiseIk(), {
      initiator, s: { secretKey, publicKey }, ...(initiator ? { rs: this.peer.slice() } : {}),
      prologue: encoder.encode(`DSH-REMOTE\0v=1\0connection=${dshId(connectionId)}\0host=${dshId(hostId)}\0client=${dshId(clientId)}`),
      cipher: chachaPoly, hash: sha256H, rng: randomBytes,
    })
    if (this.handshake.getName() !== 'Noise_IK_25519_ChaChaPoly_SHA256') throw new Error('Unexpected Noise cipher suite')
  }

  get ready(): boolean { return this.transport !== undefined }

  read(message: unknown): void {
    const handshake = this.handshake
    if (!handshake || handshake.isWriteTurn()) throw new Error('Unexpected Noise handshake step')
    const encoded = decodeDshBase64(message, 512)
    if (handshake.readMessage(encoded, new Uint8Array(encoded.length)) !== 0) throw new Error('Unexpected Noise handshake payload')
    const peerKey = handshake.getRemoteStatic()
    let mismatch = peerKey?.length === this.peer.length ? 0 : 1
    for (let i = 0; i < this.peer.length; i++) mismatch |= this.peer[i] ^ (peerKey?.[i] ?? 0)
    if (mismatch) throw new Error('Noise identity mismatch')
    this.finish(handshake)
  }

  write(): string {
    const handshake = this.handshake
    if (!handshake || !handshake.isWriteTurn()) throw new Error('Unexpected Noise handshake step')
    const output = new Uint8Array(handshake.getNextMessageOverhead())
    const length = handshake.writeMessage(new Uint8Array(), output)
    this.finish(handshake)
    return encodeDshBase64(output.subarray(0, length))
  }

  send(message: DshFrame | Record<string, unknown>): { counter: number; ciphertext: string } {
    const transport = this.transport
    if (!transport) throw new Error('Noise channel not ready')
    const body = encoder.encode(JSON.stringify(message))
    if (body.length > 48 * 1024) throw new Error('DSH Remote message too large')
    return { counter: Number(transport.sendingNonce()), ciphertext: encodeDshBase64(transport.sendVec(body)) }
  }

  receive(counter: unknown, ciphertext: unknown): Uint8Array {
    const transport = this.transport
    if (!transport || counter !== Number(transport.receivingNonce())) throw new Error('Unexpected Noise counter')
    return transport.receiveVec(decodeDshBase64(ciphertext, 65_535))
  }

  destroy(): void {
    this.handshake = undefined
    this.transport = undefined
    this.peer.fill(0)
  }

  private finish(handshake: NqHandshake): void {
    if (!handshake.isFinished()) return
    this.transport = handshake.finalize()
    this.handshake = undefined
  }
}
