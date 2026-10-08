import type { Writable } from "node:stream"

// Per virtual connection, including Node's writable buffer. Never pause the
// shared control WebSocket: one slow visitor must not stall other streams.
export const RESPONSE_BUFFER_MAX = 1024 * 1024
export const RESPONSE_QUEUE_MAX = 1024

export class ResponseSink {
  private queue: Buffer[] = []
  private queuedBytes = 0
  private blocked = false
  private ending = false
  private endSent = false
  private disposed = false

  constructor(
    private readonly output: Writable,
    private readonly onAbort: () => void,
    private readonly onFinish: () => void,
  ) {
    output.on("drain", this.drain)
    output.on("close", this.abort)
    output.on("error", this.abort)
    output.on("finish", this.finish)
  }

  write(chunk: Buffer): void {
    if (this.disposed || this.ending || chunk.length === 0) return
    if (this.queuedBytes + this.output.writableLength + chunk.length > RESPONSE_BUFFER_MAX
      || this.queue.length >= RESPONSE_QUEUE_MAX) {
      this.abort()
      return
    }
    if (this.blocked) {
      // Frames can share a large WS receive buffer; retain only this payload.
      this.queue.push(Buffer.from(chunk))
      this.queuedBytes += chunk.length
      return
    }
    this.writeOutput(chunk)
  }

  end(): void {
    if (this.disposed) return
    this.ending = true
    this.flushEnd()
  }

  dispose(): void {
    this.disposed = true
    this.queue = []
    this.queuedBytes = 0
    this.output.removeListener("drain", this.drain)
    this.output.removeListener("close", this.abort)
    this.output.removeListener("error", this.abort)
    this.output.removeListener("finish", this.finish)
  }

  private writeOutput(chunk: Buffer): void {
    try {
      this.blocked = !this.output.write(chunk)
    } catch {
      this.abort()
    }
  }

  private drain = (): void => {
    if (this.disposed) return
    this.blocked = false
    while (!this.disposed && !this.blocked && this.queue.length > 0) {
      const chunk = this.queue.shift()!
      this.queuedBytes -= chunk.length
      this.writeOutput(chunk)
    }
    this.flushEnd()
  }

  private flushEnd(): void {
    if (this.disposed || !this.ending || this.blocked || this.endSent) return
    this.endSent = true
    try {
      this.output.end()
    } catch {
      this.abort()
    }
  }

  private abort = (): void => {
    if (this.disposed) return
    this.dispose()
    this.output.destroy()
    this.onAbort()
  }

  private finish = (): void => {
    if (this.disposed) return
    this.dispose()
    this.onFinish()
  }
}
