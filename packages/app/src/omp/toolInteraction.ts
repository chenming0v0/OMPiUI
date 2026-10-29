import {
  isToolInteractionDescriptor, splitJsonText, toolInteractionKey, TOOL_INTERACTION_MAX_INPUT_BYTES,
  type ToolInteractionClientFrame, type ToolInteractionDescriptor, type ToolInteractionLease,
  type ToolInteractionServerFrame, type ToolInteractionSnapshot,
} from '@ompiui/protocol'
import { getApiBase, piFetch } from './httpClient'
import { postPiSessionCommand } from './transport'
import { PI_SOCKET_OPEN, type PiSocket } from './ompSocket'

export function descriptorFromDetails(details: unknown, sessionId: string, toolCallId: string) {
  const value = details && typeof details === 'object' ? (details as { toolInteraction?: unknown }).toolInteraction : undefined
  return isToolInteractionDescriptor(value) && value.sessionId === sessionId && value.toolCallId === toolCallId ? value : undefined
}

export async function listToolInteractions(sessionId: string, signal?: AbortSignal): Promise<ToolInteractionSnapshot> {
  return postPiSessionCommand<ToolInteractionSnapshot>(sessionId, 'toolInteraction', { operation: 'list' }, signal)
}

export async function issueToolInteractionTicket(descriptor: ToolInteractionDescriptor, signal?: AbortSignal) {
  const response = await piFetch(`${getApiBase()}${interactionPath(descriptor)}/stream-ticket`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeId: descriptor.runtimeId, toolCallId: descriptor.toolCallId }), signal,
  })
  if (!response.ok) throw Object.assign(new Error(`Tool stream ticket: ${response.status}`), { status: response.status })
  const result = await response.json() as { ticket: string; expiresAt: number }
  if (typeof result.ticket !== 'string' || !result.ticket) throw new Error('Invalid tool stream ticket')
  return result
}

function interactionPath(descriptor: ToolInteractionDescriptor) {
  return `/api/v1/sessions/${encodeURIComponent(descriptor.sessionId)}/tool-interactions/${encodeURIComponent(descriptor.executionId)}`
}
export function toolInteractionWebSocketUrl(descriptor: ToolInteractionDescriptor, ticket: string, cursor?: number) {
  const base = getApiBase() || window.location.origin
  const url = new URL(`${base.replace(/^http/, 'ws')}${interactionPath(descriptor)}/stream`)
  url.searchParams.set('ticket', ticket)
  if (cursor !== undefined) url.searchParams.set('cursor', String(cursor))
  return url.toString()
}

const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
export function parseToolInteractionFrame(value: unknown): ToolInteractionServerFrame | undefined {
  if (!value || typeof value !== 'object') return undefined
  const frame = value as Record<string, unknown>
  switch (frame.type) {
    case 'hello': case 'exit': return isToolInteractionDescriptor(frame.descriptor) ? value as ToolInteractionServerFrame : undefined
    case 'lease': {
      const lease = frame.lease as ToolInteractionLease | null | undefined
      return lease === null || (lease && typeof lease.writerId === 'string' && typeof lease.writerEpoch === 'string' &&
        natural(lease.lastAcceptedSequence) && typeof lease.expiresAt === 'number') ? value as ToolInteractionServerFrame : undefined
    }
    case 'input_ack': return natural(frame.sequence) && natural(frame.lastAcceptedSequence) ? value as ToolInteractionServerFrame : undefined
    case 'output': return natural(frame.fromCursor) && natural(frame.cursor) && frame.cursor >= frame.fromCursor &&
      typeof frame.data === 'string' && frame.cursor === frame.fromCursor + frame.data.length && typeof frame.reset === 'boolean' ? value as ToolInteractionServerFrame : undefined
    case 'problem': return typeof frame.code === 'string' && typeof frame.message === 'string' ? value as ToolInteractionServerFrame : undefined
    default: return undefined
  }
}

export type ToolInputState = 'viewer' | 'reconnecting' | 'writer' | 'paused' | 'closed'
type Chunk = { sequence: number; data: string; bytes: number }
const encoder = new TextEncoder()
export const MAX_PENDING_TOOL_INPUT_BYTES = 1024 * 1024

/** Sequence and opaque lease survive socket replacement. Never replay an unknown epoch. */
export class ToolInteractionInput {
  readonly writerId = crypto.randomUUID()
  private epoch: string | undefined
  private nextSequence = 1
  private accepted = 0
  private chunks: Chunk[] = []
  private bytes = 0
  private socket: PiSocket | undefined
  private inFlight: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private listeners = new Set<() => void>()
  private snapshot: ToolInputState = 'viewer'
  wantsControl = false
  get state() { return this.snapshot }
  get pendingBytes() { return this.bytes }
  get writerEpoch() { return this.epoch }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  private setState(state: ToolInputState) { this.snapshot = state; for (const listener of this.listeners) listener() }
  send(frame: ToolInteractionClientFrame): boolean {
    if (this.socket?.readyState !== PI_SOCKET_OPEN) return false
    try { this.socket.send(JSON.stringify(frame)); return true } catch { this.disconnect(); return false }
  }
  connect(socket: PiSocket) {
    this.socket = socket
    this.inFlight = undefined
    if (this.state === 'closed') return
    if (this.wantsControl) this.claim()
    else this.setState('viewer')
  }
  claim() {
    if (this.state === 'closed') return
    if (this.state === 'paused' && !this.bytes) { this.epoch = undefined; this.accepted = 0; this.nextSequence = 1 }
    this.wantsControl = true
    this.setState('reconnecting')
    this.send({ type: 'claim', writerId: this.writerId, ...(this.epoch ? { writerEpoch: this.epoch } : {}) })
  }
  lease(lease: ToolInteractionLease | null) {
    clearTimeout(this.timer)
    this.inFlight = undefined
    if (this.state === 'closed') return
    if (!this.wantsControl) return
    if (!lease || lease.writerId !== this.writerId || (this.epoch && lease.writerEpoch !== this.epoch && this.chunks.length)) {
      this.setState('paused'); return
    }
    if (this.epoch !== lease.writerEpoch) { this.accepted = 0; this.nextSequence = 1 }
    this.epoch = lease.writerEpoch
    if (lease.lastAcceptedSequence < this.accepted) { this.setState('paused'); return }
    this.dropAccepted(lease.lastAcceptedSequence)
    this.nextSequence = Math.max(this.nextSequence, lease.lastAcceptedSequence + 1)
    this.setState('writer')
    this.pump()
  }
  enqueue(text: string): 'queued' | 'full' | 'closed' {
    if (this.state !== 'writer') return 'closed'
    const bytes = encoder.encode(text).byteLength
    if (bytes + this.bytes > MAX_PENDING_TOOL_INPUT_BYTES) return 'full'
    if (!text) return 'queued'
    const parts = splitJsonText(text, TOOL_INTERACTION_MAX_INPUT_BYTES)
    if (parts.length + this.chunks.length > 1024) return 'full'
    for (const data of parts) this.chunks.push({ sequence: this.nextSequence++, data, bytes: encoder.encode(data).byteLength })
    this.bytes += bytes
    this.pump()
    return 'queued'
  }
  acknowledge(sequence: number, lastAcceptedSequence: number) {
    if (this.state !== 'writer' || this.inFlight !== sequence || lastAcceptedSequence < sequence) return
    // Ignore impossible acknowledgements instead of dropping unsent text.
    if (lastAcceptedSequence >= this.nextSequence) { this.setState('paused'); return }
    clearTimeout(this.timer)
    this.inFlight = undefined
    this.dropAccepted(lastAcceptedSequence)
    this.setState('writer')
    this.pump()
  }
  private dropAccepted(sequence: number) {
    this.accepted = sequence
    while (this.chunks[0] && this.chunks[0].sequence <= sequence) this.bytes -= this.chunks.shift()!.bytes
  }
  private pump() {
    if (this.state !== 'writer' || this.inFlight !== undefined || !this.chunks[0]) return
    const chunk = this.chunks[0]
    this.inFlight = chunk.sequence
    if (!this.send({ type: 'input', sequence: chunk.sequence, data: chunk.data })) return
    this.timer = setTimeout(() => {
      const socket = this.socket
      this.disconnect()
      socket?.close(4008, 'Tool input acknowledgement timed out')
    }, 15_000)
  }
  disconnect() {
    clearTimeout(this.timer)
    this.socket = undefined
    this.inFlight = undefined
    if (this.state !== 'closed') this.setState(this.wantsControl ? 'reconnecting' : 'viewer')
  }
  pause() { clearTimeout(this.timer); this.inFlight = undefined; if (this.state !== 'closed') this.setState('paused') }
  discardPending() { this.chunks = []; this.bytes = 0; this.nextSequence = this.accepted + 1; this.setState(this.state) }
  release() {
    if (this.bytes) return false // Unknown delivery must be explicitly discarded first.
    if (!this.send({ type: 'release' })) return false
    this.epoch = undefined; this.accepted = 0; this.nextSequence = 1
    this.wantsControl = false
    this.setState('viewer')
    return true
  }
  cancel() { if (this.state === 'writer') this.send({ type: 'cancel' }) }
  resize(cols: number, rows: number) { if (this.state === 'writer') this.send({ type: 'resize', cols, rows }) }
  close() { clearTimeout(this.timer); this.socket = undefined; this.wantsControl = false; this.chunks = []; this.bytes = 0; this.setState('closed') }
}

const inputs = new Map<string, ToolInteractionInput>()
export function getToolInteractionInput(serverId: string, descriptor: ToolInteractionDescriptor) {
  const id = JSON.stringify([serverId, toolInteractionKey(descriptor)])
  let input = inputs.get(id)
  if (!input) {
    // Never evict unknown pending delivery merely to make room.
    for (const [key, value] of inputs) if (inputs.size >= 64 && !value.pendingBytes) inputs.delete(key)
    input = new ToolInteractionInput()
    inputs.set(id, input)
  }
  return input
}
