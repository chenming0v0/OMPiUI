import type { Writable } from "node:stream"

export interface StdinWriteHandle {
  /** write 已被调用后，超时只能报告结果未知，不能撤销或重放。 */
  readonly sent: boolean
  cancel(): boolean
}

type Entry = {
  line: string
  bytes: number
  done: (error: Error | undefined, sent: boolean) => void
  sent: boolean
  settled: boolean
  returned: boolean
  written: boolean
  needsDrain: boolean
  drained: boolean
}

/** OMP stdin 的独立预算；排队正文可撤销，写入中的预算保留到 callback + drain。 */
export class OmpStdinSender {
  private readonly queue = new Set<Entry>()
  private current?: Entry
  private bytes = 0
  private count = 0
  private flushing = false
  private ending = false
  private ended = false
  private closedError?: Error

  constructor(
    private readonly stdin: Writable,
    private readonly onFailure: (error: Error) => void,
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxItems = 1024,
  ) {
    stdin.on("drain", this.onDrain)
    stdin.on("error", this.onError)
    stdin.on("close", this.onClose)
  }

  write(line: string, done: Entry["done"]): StdinWriteHandle {
    if (this.closedError) throw this.closedError
    if (this.ending || this.stdin.destroyed || this.stdin.writableEnded) {
      throw Object.assign(new Error("omp RPC stdin is closed"), { code: "OMP_STDIN_CLOSED" })
    }
    const bytes = Buffer.byteLength(line, "utf8")
    if (this.bytes + bytes > this.maxBytes || this.count >= this.maxItems) {
      throw Object.assign(new Error("omp RPC stdin capacity reached"), { code: "RATE_LIMITED" })
    }
    const entry: Entry = {
      line, bytes, done, sent: false, settled: false,
      returned: false, written: false, needsDrain: false, drained: false,
    }
    this.bytes += bytes
    this.count += 1
    this.queue.add(entry)
    const handle: StdinWriteHandle = {
      get sent() { return entry.sent },
      cancel: () => {
        if (!this.queue.has(entry)) return false
        this.finish(entry)
        this.flush()
        return true
      },
    }
    this.flush()
    return handle
  }

  /** 正常关闭保留已接纳正文的顺序；调用方的退出预算仍可用 close 强制收尾。 */
  end(): void {
    this.ending = true
    this.flush()
  }

  close(error: Error): void {
    if (this.closedError) return
    this.closedError = error
    this.stdin.off("drain", this.onDrain)
    // 终态后不再保留 Writable 自己的缓冲；已经写出的部分仍可能被 OMP 执行。
    this.stdin.destroy()
    if (this.current) this.finish(this.current, error)
    for (const entry of this.queue) this.finish(entry, error)
  }

  private readonly onError = (error: Error): void => {
    if (this.closedError) return
    this.close(error)
    this.onFailure(error)
  }

  private readonly onClose = (): void => {
    if (!this.closedError) {
      const error = Object.assign(new Error("omp RPC stdin closed"), { code: "OMP_STDIN_CLOSED" })
      if (this.ended && !this.current && this.queue.size === 0) this.close(error)
      else this.onError(error)
    }
    this.stdin.off("error", this.onError)
    this.stdin.off("close", this.onClose)
  }

  private readonly onDrain = (): void => {
    const entry = this.current
    if (!entry) return
    entry.drained = true
    this.finishWrite(entry)
  }

  private finish(entry: Entry, error?: Error): void {
    if (entry.settled) return
    entry.settled = true
    this.queue.delete(entry)
    if (this.current === entry) this.current = undefined
    entry.line = ""
    this.bytes -= entry.bytes
    this.count -= 1
    entry.done(error, entry.sent)
  }

  private finishWrite(entry: Entry): void {
    if (entry.settled || !entry.returned || !entry.written || (entry.needsDrain && !entry.drained)) return
    this.finish(entry)
    this.flush()
  }

  private flush(): void {
    if (this.flushing || this.current || this.closedError) return
    this.flushing = true
    try {
      while (!this.current && !this.closedError) {
        const entry = this.queue.values().next().value
        if (!entry) {
          if (this.ending && !this.ended) {
            this.ended = true
            try { this.stdin.end() }
            catch (error) { this.onError(error instanceof Error ? error : new Error(String(error))) }
          }
          return
        }
        this.queue.delete(entry)
        this.current = entry
        entry.sent = true
        try {
          const writable = this.stdin.write(entry.line, "utf8", error => {
            if (entry.settled) return
            if (error) {
              this.onError(error)
              return
            }
            entry.written = true
            this.finishWrite(entry)
          })
          entry.line = ""
          entry.returned = true
          entry.needsDrain = !writable
          this.finishWrite(entry)
        } catch (error) {
          this.onError(error instanceof Error ? error : new Error(String(error)))
        }
      }
    } finally {
      this.flushing = false
    }
  }
}
