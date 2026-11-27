import { NqHandshake, chachaPoly, noiseIk, sha256H, x25519Dh, x25519Keygen, type TransportState } from '@lukeburns/clatterjs'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

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

// ============================================
// 扫码配对（device-pairing-v1）：电脑出二维码，手机扫码后显示 8 位验证码，在电脑上输入确认。
// 两端都用这里的校验和签名，线上格式以 ds-harness-remote 的 docs/device-pairing-v1.md 为准。
// ============================================

export const DSH_PAIRING_ROOT = '/api/v1/device-pairing/sessions'
export type DshPairingSide = 'host' | 'mobile'
export type DshPairingState = 'created' | 'claimed' | 'approved' | 'completed' | 'failed' | 'cancelled' | 'expired'
const PAIRING_STATES: readonly string[] = ['created', 'claimed', 'approved', 'completed', 'failed', 'cancelled', 'expired']
const PAIRING_KEY = /^[A-Za-z0-9_-]{43}$/
const PAIRING_SESSION = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

export interface DshPairingDevice { deviceId: string; name: string; role: 'host' | 'client'; platform: string; identityKey: string }
export interface DshPairingSession { sessionId: string; expiresAt: number; serverPublicKey: string; scanSecret: string; host: DshPairingDevice }
export interface DshPairingStatus {
  state: DshPairingState
  failureReason: string | null
  mobile: DshPairingDevice | null
  /** 只在 completed 时有：发给查询这一侧自己的设备授权。 */
  tokens: DshDeviceTokens | null
}

function pairingKey(value: unknown): value is string {
  if (typeof value !== 'string' || !PAIRING_KEY.test(value)) return false
  try { return decodeDshBase64(value, 32).length === 32 } catch { return false }
}

function pairingDevice(value: unknown): DshPairingDevice {
  const device = dshRecord(value)
  if (typeof device?.deviceId !== 'string' || !DSH_ID.test(device.deviceId) || typeof device.name !== 'string' || device.name.length > 256
    || (device.role !== 'host' && device.role !== 'client') || typeof device.platform !== 'string' || device.platform.length > 64
    || !pairingKey(device.identityKey)) throw new Error('Invalid DS Harness Remote pairing device')
  return { deviceId: device.deviceId, name: device.name, role: device.role, platform: device.platform, identityKey: device.identityKey }
}

const samePairingDevice = (a: DshPairingDevice, b: { deviceId: string; identityKey: string }) =>
  a.deviceId.toLowerCase() === b.deviceId.toLowerCase() && a.identityKey === b.identityKey

/** 创建会话或解析短码的回复。ticket 是扫到的短码，必须和会话里的一致。 */
export function parseDshPairingSession(value: unknown, ticket?: string): DshPairingSession {
  const data = dshRecord(value)
  if (data?.v !== 1 || typeof data.sessionId !== 'string' || !PAIRING_SESSION.test(data.sessionId) || !isDshExpiry(data.expiresAt)
    || !pairingKey(data.serverPublicKey) || !pairingKey(data.scanSecret) || (ticket !== undefined && data.scanSecret !== ticket)) {
    throw new Error('Invalid DS Harness Remote pairing session')
  }
  const host = pairingDevice(data.host)
  // 会话只活三分钟；远在未来的截止时间不是一个真会话。
  if (host.role !== 'host' || host.identityKey === data.serverPublicKey || data.expiresAt > Date.now() + 10 * 60_000) {
    throw new Error('Invalid DS Harness Remote pairing session')
  }
  return { sessionId: data.sessionId, expiresAt: data.expiresAt, serverPublicKey: data.serverPublicKey, scanSecret: data.scanSecret, host }
}

/** 状态回复必须还是同一个会话、同一台电脑，且（完成时）授权确实发给查询的这一侧。 */
export function parseDshPairingStatus(value: unknown, session: DshPairingSession, side: DshPairingSide,
  self: { deviceId: string; identityKey: string }, pinnedMobile?: DshPairingDevice | null): DshPairingStatus {
  const data = dshRecord(value)
  if (data?.v !== 1 || data.sessionId !== session.sessionId || typeof data.state !== 'string' || !PAIRING_STATES.includes(data.state)) {
    throw new Error('Invalid DS Harness Remote pairing status')
  }
  const state = data.state as DshPairingState
  if (!samePairingDevice(pairingDevice(data.host), session.host)) throw new Error('The DS Harness Remote pairing computer changed')
  const mobile = data.mobile == null ? null : pairingDevice(data.mobile)
  if (mobile && (mobile.role !== 'client' || mobile.deviceId.toLowerCase() === session.host.deviceId.toLowerCase()
    || mobile.identityKey === session.host.identityKey
    || (side === 'mobile' && !samePairingDevice(mobile, self)) || (pinnedMobile && !samePairingDevice(mobile, pinnedMobile)))) {
    throw new Error('The DS Harness Remote pairing phone changed')
  }
  if (side === 'mobile' && !mobile) throw new Error('The DS Harness Remote pairing phone changed')
  let tokens: DshDeviceTokens | null = null
  if (state === 'completed') {
    const credentials = dshRecord(data.credentials)
    const device = pairingDevice(credentials?.device)
    if (!samePairingDevice(device, self) || device.role !== (side === 'host' ? 'host' : 'client')) {
      throw new Error('Invalid DS Harness Remote pairing credentials')
    }
    tokens = parseDshDeviceTokens(credentials?.tokens)
  }
  const reason = typeof data.failureReason === 'string' && /^[A-Za-z_]{1,80}$/.test(data.failureReason) ? data.failureReason : null
  return { state, failureReason: reason, mobile, tokens }
}

/** X-DSH-Pairing-Proof：证明这一侧持有设备私钥，并把操作路径和请求正文绑在一起。body 必须是实际发出去的原文。 */
export function dshPairingProof(privateKey: string, serverPublicKey: string, sessionId: string, side: DshPairingSide,
  path: string, body: string): string {
  const shared = x25519Dh(decodeDshBase64(privateKey, 32), decodeDshBase64(serverPublicKey, 32))
  const key = hkdf(sha256, shared, encoder.encode(sessionId), encoder.encode(`dsh-pairing-v1/${side}`), 32)
  try {
    return encodeDshBase64(hmac(sha256, key, encoder.encode(`POST\n${path}\n${bytesToHex(sha256(encoder.encode(body)))}`)))
  } finally {
    shared.fill(0)
    key.fill(0)
  }
}

/** 两端核对用的指纹：公钥的 SHA-256，按四位一组显示。 */
export function dshPairingFingerprint(identityKey: string): string {
  return bytesToHex(sha256(decodeDshBase64(identityKey, 32))).replace(/(.{4})(?=.)/g, '$1 ')
}

/** 二维码里的内容。服务器支持时用只带一张票的短码，否则带上整段会话。 */
export function dshPairingQr(session: DshPairingSession, compact: boolean): string {
  return compact ? `${DSH_REMOTE_ORIGIN}/pair#v1.${session.scanSecret}`
    : JSON.stringify({ type: 'dsh.remote.pairing', v: 1, serverUrl: DSH_REMOTE_ORIGIN, ...session })
}

/** 手机扫到的内容。只认本应用使用的那台服务器；内容不当网址打开，也不跟随跳转。 */
export function parseDshPairingScan(text: string): { ticket: string } | { session: DshPairingSession } {
  const value = text.trim()
  if (encoder.encode(value).length > 4096) throw new Error('Invalid DS Harness Remote pairing code')
  if (value.startsWith('{')) {
    let data: Record<string, unknown> | undefined
    try { data = dshRecord(JSON.parse(value)) } catch { data = undefined }
    if (data?.type !== 'dsh.remote.pairing' || data.serverUrl !== DSH_REMOTE_ORIGIN) throw new Error('Invalid DS Harness Remote pairing code')
    return { session: parseDshPairingSession(data) }
  }
  const prefix = `${DSH_REMOTE_ORIGIN}/pair#v1.`
  const ticket = value.startsWith(prefix) ? value.slice(prefix.length) : ''
  if (!pairingKey(ticket)) throw new Error('Invalid DS Harness Remote pairing code')
  return { ticket }
}
