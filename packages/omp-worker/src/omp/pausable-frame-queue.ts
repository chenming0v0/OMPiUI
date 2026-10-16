type Pending<T> = { iterator: Iterator<T>; measure: () => number; bytes?: number }

/** 分片按需生成，暂停发生在当前快照内部，而不只是下一条 stdout 输入之前。 */
export class PausableFrameQueue<T> {
  private readonly pending: Pending<T>[] = []
  private paused = false
  private draining = false

  constructor(private readonly emit: (frame: T) => void) {}

  push(frames: Iterable<T>, measure: () => number): void {
    if (this.pending.length >= 64) this.overflow()
    this.pending.push({ iterator: frames[Symbol.iterator](), measure })
    this.drain()
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (!paused) this.drain()
  }

  clear(): void {
    for (const item of this.pending.splice(0)) item.iterator.return?.()
  }

  private overflow(): never {
    throw Object.assign(new Error("pending stream snapshots exceed output capacity"), { code: "RATE_LIMITED" })
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    try {
      while (!this.paused && this.pending.length) {
        const item = this.pending[0]!
        const next = item.iterator.next()
        if (next.done) this.pending.shift()
        else this.emit(next.value)
      }
      // 正常增量同步排空，不重新遍历累计正文；只计量确实被背压保留的快照。
      let retained = 0
      for (const item of this.pending) {
        item.bytes ??= item.measure()
        retained += item.bytes
        if (retained > 64 * 1024 * 1024) this.overflow()
      }
    } finally {
      this.draining = false
    }
  }
}
