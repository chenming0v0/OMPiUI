import { splitJsonText, type TerminalStreamServerFrame } from '@ompiui/protocol'
import { PI_SOCKET_OPEN, type PiSocket } from './ompSocket'

export const MAX_PENDING_TERMINAL_INPUT_BYTES = 1024 * 1024
const MAX_PENDING_INPUT_FRAMES = 1024
const INPUT_CHUNK_JSON_BYTES = 32 * 1024
const INPUT_FRAMES_PER_SECOND = 60
const INPUT_BYTES_PER_SECOND = 512 * 1024
const INPUT_ACK_TIMEOUT_MS = 15_000
const encoder = new TextEncoder()

type InputAcknowledgement = Extract<TerminalStreamServerFrame, { type: 'input_ack' }>
type InputChunk = { data: string; bytes: number; jsonBytes: number; inputId?: number }
export type TerminalInputState = 'ready' | 'unsupported' | 'interrupted'
export type TerminalInputEnqueueResult = 'queued' | 'full' | 'closed' | Exclude<TerminalInputState, 'ready'>

/** 兼容旧调用方：无确认协议时仅按 JSON 字节拆分并发送。 */
export function sendTerminalInput(socket: PiSocket, text: string): void {
  if (socket.readyState !== PI_SOCKET_OPEN || !text) return
  for (const data of splitJsonText(text, 64 * 1024 - 128)) {
    socket.send(JSON.stringify({ type: 'input', data }))
  }
}

/** 保留输入直到 PTY 明确受理；只有明确拒绝才可重试。 */
export class TerminalInputQueue {
  private readonly chunks: InputChunk[] = []
  private socket: PiSocket | null = null
  private supportsAcknowledgements: boolean | null = null
  private queuedBytes = 0
  private nextInputId = 1
  private awaitingAcknowledgement = false
  private nextSendAt = 0
  private retryAt = 0
  private rejectionDelay = 50
  private timer: number | undefined
  private disposed = false
  private currentState: TerminalInputState = 'ready'
  private readonly listeners = new Set<(state: TerminalInputState) => void>()

  private readonly onStateChange?: (state: TerminalInputState) => void

  constructor(onStateChange?: (state: TerminalInputState) => void) {
    this.onStateChange = onStateChange
  }

  get state(): TerminalInputState { return this.currentState }
  get pendingBytes(): number { return this.queuedBytes }
  subscribe(listener: (state: TerminalInputState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 包含确认中断前可能已执行的前缀，绝不自动重放。 */
  get pendingText(): string { return this.chunks.map(chunk => chunk.data).join('') }

  enqueue(text: string): TerminalInputEnqueueResult {
    if (this.disposed) return 'closed'
    if (this.currentState !== 'ready') return this.currentState
    const remaining = MAX_PENDING_TERMINAL_INPUT_BYTES - this.queuedBytes
    // 整段粘贴原子入队，绝不挤掉更早排队的输入。
    if (text.length > remaining) return 'full'
    const bytes = encoder.encode(text).byteLength
    if (bytes > remaining) return 'full'
    if (!text) return 'queued'
    const chunks = splitJsonText(text, INPUT_CHUNK_JSON_BYTES).map(data => ({
      data,
      bytes: encoder.encode(data).byteLength,
      jsonBytes: encoder.encode(JSON.stringify(data)).byteLength - 2
    }))
    const tail = this.chunks.at(-1)
    const mergeFirst = tail && tail.inputId === undefined && tail.jsonBytes + chunks[0].jsonBytes <= INPUT_CHUNK_JSON_BYTES
    if (this.chunks.length + chunks.length - (mergeFirst ? 1 : 0) > MAX_PENDING_INPUT_FRAMES) return 'full'
    if (mergeFirst) {
      tail.data += chunks[0].data
      tail.bytes += chunks[0].bytes
      tail.jsonBytes += chunks[0].jsonBytes
    }
    for (let index = mergeFirst ? 1 : 0; index < chunks.length; index++) this.chunks.push(chunks[index])
    this.queuedBytes += bytes
    this.pump()
    return 'queued'
  }

  connect(socket: PiSocket, supportsAcknowledgements: boolean): void {
    if (this.disposed) return
    if (this.socket !== socket) {
      if (this.socket) this.disconnect(this.socket)
      this.socket = socket
      this.nextInputId = 1
    }
    this.supportsAcknowledgements = supportsAcknowledgements
    if (this.currentState !== 'interrupted') this.setState(supportsAcknowledgements ? 'ready' : 'unsupported')
    this.pump()
  }

  disconnect(socket: PiSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.clearTimer()
    if (this.awaitingAcknowledgement) {
      // 对端可能已执行本帧，只是确认丢失；保留剩余文本供用户显式恢复，
      // 不自动重放结果未知的内容。
      this.setState('interrupted')
    } else if (this.chunks[0]) {
      this.chunks[0].inputId = undefined
    }
    this.awaitingAcknowledgement = false
    this.retryAt = 0
    this.nextSendAt = 0
  }

  acknowledge(socket: PiSocket, frame: InputAcknowledgement): void {
    if (this.socket !== socket || !this.awaitingAcknowledgement) return
    const head = this.chunks[0]
    if (!head || head.inputId !== frame.inputId) return
    if (frame.accepted !== true && (
      frame.accepted !== false || !Number.isSafeInteger(frame.retryAfterMs) ||
      frame.retryAfterMs < 0 || frame.retryAfterMs > 60_000
    )) return
    this.clearTimer()
    this.awaitingAcknowledgement = false
    if (frame.accepted) {
      this.chunks.shift()
      this.queuedBytes -= head.bytes
      this.retryAt = 0
      this.rejectionDelay = 50
    } else {
      this.retryAt = Date.now() + Math.max(frame.retryAfterMs, this.rejectionDelay)
      this.rejectionDelay = Math.min(5_000, this.rejectionDelay * 2)
    }
    this.pump()
  }

  discardInterruptedInput(): void {
    if (this.currentState !== 'interrupted') return
    this.chunks.length = 0
    this.queuedBytes = 0
    this.setState(this.supportsAcknowledgements === false ? 'unsupported' : 'ready')
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.socket = null
    this.chunks.length = 0
    this.queuedBytes = 0
    this.awaitingAcknowledgement = false
    this.listeners.clear()
  }

  private setState(state: TerminalInputState): void {
    if (this.currentState === state) return
    this.currentState = state
    this.onStateChange?.(state)
    for (const listener of this.listeners) listener(state)
  }

  private clearTimer(): void {
    window.clearTimeout(this.timer)
    this.timer = undefined
  }

  private pump(): void {
    const socket = this.socket
    if (
      this.disposed || this.currentState !== 'ready' || this.awaitingAcknowledgement || this.timer !== undefined ||
      !socket || socket.readyState !== PI_SOCKET_OPEN
    ) return
    const head = this.chunks[0]
    if (!head) return
    const now = Date.now()
    const delay = Math.max(this.nextSendAt, this.retryAt) - now
    if (delay > 0) {
      this.timer = window.setTimeout(() => { this.timer = undefined; this.pump() }, Math.ceil(delay))
      return
    }
    head.inputId ??= this.nextInputId++
    const frame = JSON.stringify({ type: 'input', inputId: head.inputId, data: head.data })
    const wireBytes = encoder.encode(frame).byteLength
    this.awaitingAcknowledgement = true
    this.nextSendAt = now + Math.max(
      1000 / INPUT_FRAMES_PER_SECOND,
      head.bytes * 1000 / INPUT_BYTES_PER_SECOND,
      wireBytes * 1000 / INPUT_BYTES_PER_SECOND,
    )
    this.timer = window.setTimeout(() => {
      this.disconnect(socket)
      socket.close(4008, 'Terminal input acknowledgement timed out')
    }, INPUT_ACK_TIMEOUT_MS)
    try {
      socket.send(frame)
    } catch {
      this.disconnect(socket)
      socket.close(4008, 'Terminal input delivery interrupted')
    }
  }
}
