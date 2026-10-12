import type { WorkerMessage } from "./ipc.js"

type QueuedMessage = { message: WorkerMessage; bytes: number; done?: (error?: Error) => void }

/** 只允许一个 IPC 发送在途；排队过多时暂停 RPC 输入，不让序列化队列无限增长。 */
export class WorkerIpcSender {
  private readonly queue: QueuedMessage[] = []
  private heartbeat?: QueuedMessage
  private sending = false
  private paused = false
  private pendingBytes = 0

  constructor(
    private readonly transmit: (message: WorkerMessage, done: (error?: Error) => void) => void,
    private readonly backpressure: (paused: boolean) => void,
    private readonly highWaterMark = 32,
    private readonly highWaterBytes = 8 * 1024 * 1024,
  ) {}

  send(message: WorkerMessage, done?: (error?: Error) => void): void {
    const item = { message, done, bytes: Buffer.byteLength(JSON.stringify(message)) }
    if (message.kind === "heartbeat") {
      if (this.heartbeat) this.pendingBytes -= this.heartbeat.bytes
      this.heartbeat = item
    } else this.queue.push(item)
    this.pendingBytes += item.bytes
    this.updateBackpressure()
    this.drain()
  }

  private updateBackpressure(): void {
    const paused = this.paused
      ? this.queue.length > this.highWaterMark / 2 || this.pendingBytes > this.highWaterBytes / 2
      : this.queue.length >= this.highWaterMark || this.pendingBytes >= this.highWaterBytes
    if (paused === this.paused) return
    this.paused = paused
    this.backpressure(paused)
  }

  private drain(): void {
    if (this.sending) return
    const item = this.heartbeat ?? this.queue.shift()
    if (!item) {
      this.updateBackpressure()
      return
    }
    if (item === this.heartbeat) this.heartbeat = undefined
    this.sending = true
    this.transmit(item.message, error => {
      this.sending = false
      this.pendingBytes -= item.bytes
      item.done?.(error)
      // 背压释放可能同步读取更多帧；先让已有队列推进。
      this.drain()
      this.updateBackpressure()
    })
  }
}
