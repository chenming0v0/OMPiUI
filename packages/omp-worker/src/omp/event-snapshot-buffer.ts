/** 合并累计更新，但在同一运行的非更新事件之前排空，保证结果与消息边界有序。 */
export class EventSnapshotBuffer<T> {
  private readonly pending = new Map<string, { scope: string; event: T }>()
  private timer?: NodeJS.Timeout

  constructor(private readonly emit: (event: T) => void, private readonly intervalMs = 50) {}

  push(scope: string, update: string | undefined, event: T): void {
    if (!update) {
      this.flush(scope)
      this.emit(event)
      return
    }
    this.pending.set(`${scope}\0${update}`, { scope, event })
    if (this.pending.size >= 256) this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs)
      this.timer.unref()
    }
  }

  flush(scope?: string): void {
    for (const [key, item] of this.pending) {
      if (scope && item.scope !== scope) continue
      this.pending.delete(key)
      this.emit(item.event)
    }
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
