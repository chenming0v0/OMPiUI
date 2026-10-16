import type { WorkerMessage, WorkerResponse } from "./ipc.js"
import { jsonByteSize } from "@ompiui/protocol"

const RESERVED_EVENT_BYTES = 256 * 1024

type QueuedMessage = {
  message: WorkerMessage
  bytes: number
  control?: boolean
  done?: (error?: Error) => void
  completed?: boolean
}

export interface WorkerResponseReservation {
  send: (message: WorkerResponse) => Promise<void>
  cancel: () => void
  release: () => void
}

type Reservation = { bytes: number; item?: QueuedMessage; released: boolean }

function capacityError(): Error {
  return Object.assign(new Error("worker IPC output capacity reached"), { code: "RATE_LIMITED" })
}

/** 硬上限包含发送中的消息及生成响应前预留的容量。 */
export class WorkerIpcSender {
  private readonly queue: QueuedMessage[] = []
  private readonly control: QueuedMessage[] = []
  private readonly reservations = new Set<Reservation>()
  private readonly writableListeners = new Set<() => void>()
  private heartbeat?: QueuedMessage
  private sending?: QueuedMessage
  private paused = false
  private pendingBytes = 0
  private normalPendingCount = 0
  private controlPendingCount = 0
  private reservedBytes = 0
  private reservedCount = 0
  private closed?: Error

  get isPaused(): boolean { return this.paused }
  get responseByteLimit(): number { return this.highWaterBytes - this.controlBytes }
  private get reservedEventBytes(): number {
    return Math.min(RESERVED_EVENT_BYTES, Math.floor(this.responseByteLimit / 8))
  }
  get responseReservationLimit(): number { return this.responseByteLimit - this.reservedEventBytes }
  private get controlBytes(): number { return Math.min(64 * 1024, Math.max(64, Math.floor(this.highWaterBytes / 8))) }
  private get normalCountLimit(): number { return Math.max(1, this.highWaterMark * 2) }
  private get controlCountLimit(): number { return Math.max(2, this.highWaterMark) }

  constructor(
    private readonly transmit: (message: WorkerMessage, done: (error?: Error) => void) => void,
    private readonly backpressure: (paused: boolean) => void,
    private readonly highWaterMark = 32,
    private readonly highWaterBytes = 8 * 1024 * 1024,
  ) {}

  send(message: WorkerMessage, done?: (error?: Error) => void): void {
    this.enqueue(message, false, done)
  }

  /** 小型预留通道只承载协议错误与最终崩溃或释放通知，不承载数据页。 */
  sendControl(message: WorkerMessage, done?: (error?: Error) => void): void {
    this.enqueue(message, true, done)
  }

  onWritable(listener: () => void): () => void {
    this.writableListeners.add(listener)
    return () => this.writableListeners.delete(listener)
  }

  tryReserveResponse(bytes: number, priority = false): WorkerResponseReservation | undefined {
    if (this.closed || bytes > this.responseByteLimit ||
      this.pendingBytes + this.reservedBytes + bytes > this.responseReservationLimit ||
      this.normalPendingCount + this.reservedCount >= this.normalCountLimit ||
      (!priority && this.reservations.size >= Math.max(1, Math.floor(this.normalCountLimit / 2)))) return undefined
    const reservation: Reservation = { bytes, released: false }
    this.reservations.add(reservation)
    this.reservedBytes += bytes
    this.reservedCount++
    this.updateBackpressure()
    const release = () => {
      if (reservation.released || reservation.item) return
      reservation.released = true
      this.reservations.delete(reservation)
      this.reservedBytes -= bytes
      this.reservedCount--
      this.capacityChanged()
    }
    return {
      send: message => new Promise<void>((resolve, reject) => {
        if (reservation.released || reservation.item || this.closed) {
          reject(this.closed ?? new Error("worker response reservation already consumed"))
          return
        }
        let size = jsonByteSize(message, bytes)
        if (size > bytes) {
          message = {
            kind: "response", id: message.id, generation: message.generation, ok: false,
            error: { code: "FILE_TOO_LARGE", message: "Worker response exceeds its IPC byte budget; request a smaller page" },
          }
          size = jsonByteSize(message, bytes)
        }
        if (size > bytes) {
          reject(capacityError())
          return
        }
        const item: QueuedMessage = {
          message, bytes: size, control: false,
          done: error => {
            reservation.released = true
            this.reservations.delete(reservation)
            if (error) reject(error)
            else resolve()
          },
        }
        reservation.item = item
        this.reservedBytes -= bytes
        this.reservedCount--
        this.pendingBytes += size
        this.normalPendingCount++
        this.queue.push(item)
        this.updateBackpressure()
        this.drain()
      }),
      cancel: () => {
        const item = reservation.item
        if (!item) { release(); return }
        if (item === this.sending || item.completed) return
        const index = this.queue.indexOf(item)
        if (index < 0) return
        this.queue.splice(index, 1)
        this.finish(item, Object.assign(new Error("worker request cancelled"), { code: "REQUEST_ABORTED" }))
        this.capacityChanged()
      },
      release,
    }
  }

  close(error: Error): void {
    if (this.closed) return
    this.closed = error
    for (const item of this.queue.splice(0)) this.finish(item, error)
    for (const item of this.control.splice(0)) this.finish(item, error)
    if (this.heartbeat) this.finish(this.heartbeat, error)
    if (this.sending) this.finish(this.sending, error)
    this.heartbeat = undefined
    this.sending = undefined
    for (const reservation of this.reservations) reservation.released = true
    this.reservations.clear()
    this.reservedBytes = 0
    this.reservedCount = 0
    this.writableListeners.clear()
  }

  private enqueue(message: WorkerMessage, control: boolean, done?: (error?: Error) => void): void {
    if (this.closed) {
      if (done) done(this.closed)
      else throw this.closed
      return
    }
    const heartbeat = message.kind === "heartbeat"
    const limit = control || heartbeat ? this.controlBytes : this.responseByteLimit
    const bytes = jsonByteSize(message, limit)
    const previous = heartbeat ? this.heartbeat : undefined
    if (bytes > limit ||
      this.pendingBytes + this.reservedBytes - (previous?.bytes ?? 0) + bytes > (control || heartbeat ? this.highWaterBytes : this.responseByteLimit) ||
      (control || heartbeat
        ? this.controlPendingCount - (previous ? 1 : 0) >= this.controlCountLimit
        : this.normalPendingCount + this.reservedCount >= this.normalCountLimit)) {
      const error = capacityError()
      if (done) done(error)
      else throw error
      return
    }
    const item: QueuedMessage = { message, bytes, control: control || heartbeat, done }
    if (previous) {
      this.finish(previous, Object.assign(new Error("heartbeat replaced by a newer timestamp"), { code: "IPC_HEARTBEAT_SUPERSEDED" }))
    }
    if (heartbeat) this.heartbeat = item
    else if (control) this.control.push(item)
    else this.queue.push(item)
    this.pendingBytes += bytes
    if (item.control) this.controlPendingCount++
    else this.normalPendingCount++
    this.updateBackpressure()
    this.drain()
  }

  private finish(item: QueuedMessage, error?: Error): void {
    if (item.completed) return
    item.completed = true
    this.pendingBytes -= item.bytes
    if (item.control) this.controlPendingCount--
    else this.normalPendingCount--
    item.done?.(error)
  }

  private capacityChanged(): void {
    this.drain()
    // 新释放的容量先供待准入任务使用，然后再恢复 stdout。
    for (const listener of this.writableListeners) listener()
    this.updateBackpressure()
  }

  private updateBackpressure(): void {
    const byteLimit = Math.max(1, this.responseByteLimit - this.reservedBytes)
    const countLimit = Math.max(1, this.normalCountLimit - this.reservedCount)
    const fraction = this.paused ? 0.25 : 0.5
    const paused = this.normalPendingCount > 0 &&
      (this.normalPendingCount >= countLimit * fraction || this.pendingBytes >= byteLimit * fraction)
    if (paused === this.paused) return
    this.paused = paused
    this.backpressure(paused)
  }

  private drain(): void {
    if (this.closed || this.sending) return
    const item = this.heartbeat ?? this.control.shift() ?? this.queue.shift()
    if (!item) return
    if (item === this.heartbeat) this.heartbeat = undefined
    this.sending = item
    const done = (error?: Error) => {
      if (item.completed) return
      this.sending = undefined
      this.finish(item, error)
      this.capacityChanged()
    }
    try {
      this.transmit(item.message, done)
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
