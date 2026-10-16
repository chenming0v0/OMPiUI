/** 只有 xterm 解析完成的游标才可确认或写入恢复快照。 */
export function createTerminalOutputConsumer(
  write: (data: string, consumed: () => void) => void,
  onConsumed: (cursor: number) => void,
  sendAck: (cursor: number) => void,
  isCurrent: () => boolean,
) {
  let pending = 0
  let disposed = false
  let ackCursor: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let drainWaiters: Array<() => void> = []
  return {
    write(data: string, cursor: number, acknowledge: boolean): void {
      pending++
      write(data, () => {
        pending--
        if (isCurrent()) onConsumed(cursor)
        if (disposed || !acknowledge || !isCurrent()) {
          if (!pending) drainWaiters.splice(0).forEach(resolve => resolve())
          return
        }
        ackCursor = cursor
        timer ??= setTimeout(() => {
          timer = undefined
          if (!disposed && isCurrent() && ackCursor !== undefined) sendAck(ackCursor)
        }, 50)
        if (!pending) drainWaiters.splice(0).forEach(resolve => resolve())
      })
    },
    ready(cursor: number): void {
      if (!pending && !disposed && isCurrent()) onConsumed(cursor)
    },
    drain(): Promise<void> {
      if (!pending) return Promise.resolve()
      return new Promise(resolve => drainWaiters.push(resolve))
    },
    dispose(): void {
      disposed = true
      clearTimeout(timer)
    },
  }
}
