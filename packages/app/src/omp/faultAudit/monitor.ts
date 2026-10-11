import type { FaultNotice, FaultStatus } from '@ompiui/protocol'

export type ConnectionMemory = {
  runId?: string
  checkedAt?: number
  busySessions: string[]
}

/** 健康探测与 WebSocket 分开判定，反复打开又断开的连接不算已经恢复。 */
export class FaultMonitor {
  private memory: ConnectionMemory
  private healthDownSince?: number
  private socketDownSince?: number
  private socketOpenedAt?: number
  private lastFailureCode = 'CONNECTION_UNAVAILABLE'
  private reportedConnection = false
  private baselineVerified = false
  private readonly startedAt: number
  private readonly serverId: string
  private readonly detect: (notice: FaultNotice) => void
  private readonly persist: (memory: ConnectionMemory) => void
  private readonly now: () => number
  private readonly graceMs: number

  constructor(
    serverId: string,
    detect: (notice: FaultNotice) => void,
    persist: (memory: ConnectionMemory) => void,
    memory: ConnectionMemory = { busySessions: [] },
    now = Date.now,
    graceMs = 45_000,
  ) {
    this.serverId = serverId
    this.detect = detect
    this.persist = persist
    this.now = now
    this.graceMs = graceMs
    this.memory = { ...memory, busySessions: [...memory.busySessions] }
    this.startedAt = now()
  }

  sessionState(sessionId: string, state: Record<string, unknown>): void {
    // 断线期间刷回的空闲预览不是中断前运行态的权威来源，先保留用于重启判断。
    if (this.healthDownSince !== undefined || this.socketDownSince !== undefined) return
    const busy = state.isStreaming || state.isCompacting || state.hasPendingAsyncWork || state.isBashRunning
    if (!busy && !this.baselineVerified) return
    this.memory.busySessions = busy
      ? [...new Set([...this.memory.busySessions, sessionId])]
      : this.memory.busySessions.filter(id => id !== sessionId)
    this.persist(this.memory)
  }

  healthy(status: FaultStatus): void {
    const since = this.memory.checkedAt ?? this.startedAt - 60_000
    if (this.memory.runId && this.memory.runId !== status.runId && this.memory.busySessions.length) {
      this.detect({
        id: `restart:${this.serverId}:${status.runId}`, kind: 'server_restarted',
        time: new Date(this.now()).toISOString(), sessionId: this.memory.busySessions[0], errorCode: 'SERVER_RUN_CHANGED',
      })
      this.memory.busySessions = []
    }
    for (const notice of status.faults) {
      if (Date.parse(notice.time) >= since) this.detect(notice)
    }
    this.memory = { ...this.memory, runId: status.runId, checkedAt: this.now() }
    this.baselineVerified = true
    if (status.activeSessionIds) this.memory.busySessions = [...status.activeSessionIds]
    this.healthDownSince = undefined
    if (this.socketDownSince === undefined) this.reportedConnection = false
    this.persist(this.memory)
  }

  failed(code = 'CONNECTION_UNAVAILABLE'): void {
    this.healthDownSince ??= this.now()
    this.lastFailureCode = code
  }
  socketClosed(code: number): void {
    this.socketDownSince ??= this.now()
    this.socketOpenedAt = undefined
    this.lastFailureCode = `WS_CLOSE_${code}`
  }
  socketOpened(): void { this.socketOpenedAt = this.now() }
  socketUnused(): void {
    this.socketDownSince = undefined
    this.socketOpenedAt = undefined
    if (this.healthDownSince === undefined) this.reportedConnection = false
  }
  suspend(): void {
    this.healthDownSince = undefined
    this.socketDownSince = undefined
    this.socketOpenedAt = undefined
    this.reportedConnection = false
  }
  tick(eligible = true): void {
    if (!eligible) { this.suspend(); return }
    if (this.socketOpenedAt !== undefined && this.now() - this.socketOpenedAt >= 10_000) {
      this.socketDownSince = undefined
      if (this.healthDownSince === undefined) this.reportedConnection = false
    }
    const since = Math.min(this.healthDownSince ?? Infinity, this.socketDownSince ?? Infinity)
    if (this.reportedConnection || this.now() - since < this.graceMs) return
    this.reportedConnection = true
    this.detect({
      id: `connection:${this.serverId}:${since}`, kind: 'connection_lost',
      time: new Date(this.now()).toISOString(), sessionId: this.memory.busySessions[0], errorCode: this.lastFailureCode,
    })
  }
}
