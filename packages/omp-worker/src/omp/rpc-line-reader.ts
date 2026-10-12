/** 分批消费 stdout，让心跳、IPC 响应和其他会话能在事件洪流中继续调度。 */
export class RpcLineReader {
  private buffer = ""
  private scheduled?: NodeJS.Immediate
  private closed = false
  private paused = false
  private finished?: () => void

  constructor(
    private readonly consume: (line: string) => void,
    private readonly pause: () => void,
    private readonly resume: () => void,
    private readonly batchSize = 64,
  ) {}

  push(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    if (!this.paused && !this.scheduled) this.drain()
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (paused) this.pause()
    else if (!this.scheduled && !this.closed) this.drain()
  }

  finish(callback: () => void): void {
    this.finished = callback
    if (!this.scheduled && !this.paused) this.drain()
  }

  private drain(): void {
    this.scheduled = undefined
    const started = performance.now()
    let count = 0
    let index: number
    while (!this.closed && !this.paused && (index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.consume(line)
      if (++count >= this.batchSize || performance.now() - started >= 4) break
    }
    if (this.closed || this.paused) return
    if (this.buffer.includes("\n")) {
      this.pause()
      this.scheduled = setImmediate(() => this.drain())
    } else {
      this.resume()
      const finished = this.finished
      this.finished = undefined
      finished?.()
    }
  }

  /**
   * 子进程已退出:不再等待 IPC 背压释放。只交付退出前已读入缓冲的完整行
   * (有界,不会等待更多输出),丢弃不完整的尾行。
   */
  flushForExit(): void {
    if (this.closed) return
    clearImmediate(this.scheduled)
    this.scheduled = undefined
    this.paused = false
    this.finished = undefined
    let index: number
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.consume(line)
    }
    this.buffer = ""
  }

  close(): void {
    this.closed = true
    if (this.scheduled) clearImmediate(this.scheduled)
    this.scheduled = undefined
    this.buffer = ""
    this.finished = undefined
  }
}
