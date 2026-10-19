type WatchdogCheck = (sessionId: string, signal: AbortSignal) => Promise<void>

/**
 * 独立的会话活动看门狗。
 *
 * 它只负责按固定频率触发轻量状态校准，不参与事件流收发，也不读取或写入
 * 会话历史。每个会话最多一个在途请求，避免慢请求堆积后反过来拖住 UI。
 */
export class SessionActivityWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly flights = new Map<string, AbortController>()
  private readonly getSessionIds: () => Iterable<string>
  private readonly check: WatchdogCheck
  private readonly intervalMs: number
  private readonly timeoutMs: number

  constructor(
    getSessionIds: () => Iterable<string>,
    check: WatchdogCheck,
    intervalMs = 1000,
    timeoutMs = 3000,
  ) {
    this.getSessionIds = getSessionIds
    this.check = check
    this.intervalMs = intervalMs
    this.timeoutMs = timeoutMs
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const controller of this.flights.values()) controller.abort()
    this.flights.clear()
  }

  cancel(sessionId: string): void {
    const controller = this.flights.get(sessionId)
    if (!controller) return
    controller.abort()
    this.flights.delete(sessionId)
  }

  private async tick(): Promise<void> {
    await this.checkSessions(this.getSessionIds())
  }

  private async checkSessions(sessionIds: Iterable<string>): Promise<void> {
    for (const sessionId of sessionIds) {
      if (this.flights.has(sessionId)) continue
      const controller = new AbortController()
      this.flights.set(sessionId, controller)
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      void this.check(sessionId, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timeout)
          if (this.flights.get(sessionId) === controller) this.flights.delete(sessionId)
        })
    }
  }
}
