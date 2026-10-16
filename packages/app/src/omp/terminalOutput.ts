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
  return {
    write(data: string, cursor: number, acknowledge: boolean): void {
      pending++
      write(data, () => {
        pending--
        if (disposed || !isCurrent()) return
        onConsumed(cursor)
        if (!acknowledge) return
        ackCursor = cursor
        timer ??= setTimeout(() => {
          timer = undefined
          if (!disposed && isCurrent() && ackCursor !== undefined) sendAck(ackCursor)
        }, 50)
      })
    },
    ready(cursor: number): void {
      if (!pending && !disposed && isCurrent()) onConsumed(cursor)
    },
    dispose(): void {
      disposed = true
      clearTimeout(timer)
    },
  }
}
