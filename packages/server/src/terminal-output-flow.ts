import { RateBudget } from "./rate-budget.ts"

export const TERMINAL_OUTPUT_BURST = 4 * 1024 * 1024
export const TERMINAL_OUTPUT_PER_SECOND = 2 * 1024 * 1024
export const TERMINAL_OUTPUT_ACK_WINDOW = 256 * 1024

/** 线上 JSON 字节限速；新版客户端还需确认 xterm 已解析的输出边界。 */
export class TerminalOutputFlow {
  private readonly rate = new RateBudget(TERMINAL_OUTPUT_BURST, TERMINAL_OUTPUT_PER_SECOND)
  private readonly pending: Array<{ cursor: number; bytes: number }> = []
  private pendingBytes = 0
  private acknowledged = -1

  constructor(private readonly requiresAck: boolean) {}

  get hasPendingAcknowledgements(): boolean { return this.pending.length > 0 }

  retryAfterMs(bytes: number): number {
    if (this.requiresAck && this.pendingBytes + bytes > TERMINAL_OUTPUT_ACK_WINDOW) return Infinity
    return this.rate.retryAfterMs(bytes)
  }

  sent(cursor: number, bytes: number): void {
    this.rate.allow(bytes)
    if (this.requiresAck) {
      this.pending.push({ cursor, bytes })
      this.pendingBytes += bytes
    }
  }

  acknowledge(cursor: number): boolean {
    if (!this.requiresAck || !Number.isSafeInteger(cursor) || cursor < 0) return false
    if (cursor === this.acknowledged) return true
    const index = this.pending.findIndex(item => item.cursor === cursor)
    if (index < 0) return false
    for (const item of this.pending.splice(0, index + 1)) this.pendingBytes -= item.bytes
    this.acknowledged = cursor
    return true
  }
}
