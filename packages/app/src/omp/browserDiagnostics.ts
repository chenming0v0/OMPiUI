import { PROTOCOL_VERSION, type BrowserDiagnosticMessage, type DiagnosticRunState } from '@ompiui/protocol'

type Fields = Omit<BrowserDiagnosticMessage, 'type' | 'protocolVersion' | 'event' | 'clientId'>

export class BrowserDiagnostics {
  private readonly clientId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : `page-${Date.now()}-${Math.random().toString(36).slice(2)}`
  private readonly states = new Map<string, string>()

  private readonly send: (message: BrowserDiagnosticMessage) => void

  constructor(send: (message: BrowserDiagnosticMessage) => void) {
    this.send = send
    window.addEventListener('pagehide', () => this.record('pagehide'))
    document.addEventListener('visibilitychange', () => {
      this.record('visibility', { visibility: document.visibilityState })
    })
  }

  record(event: BrowserDiagnosticMessage['event'], fields: Fields = {}): void {
    try {
      this.send({ type: 'diagnostic', protocolVersion: PROTOCOL_VERSION, clientId: this.clientId, event, ...fields })
    } catch {
      // 诊断记录不能影响正常连接和状态恢复。
    }
  }

  connected(code?: number): void {
    this.states.clear()
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    this.record('connected', { navigation: navigation?.type, visibility: document.visibilityState, code })
  }

  state(sessionId: string, value: Record<string, unknown> | null | undefined): void {
    if (!value) return
    const state: DiagnosticRunState = {}
    for (const key of ['isStreaming', 'isIdle', 'isCompacting', 'isBashRunning', 'hasPendingAsyncWork', 'readOnly'] as const) {
      if (typeof value[key] === 'boolean') state[key] = value[key]
    }
    if (typeof value.pendingMessageCount === 'number') state.pendingMessageCount = value.pendingMessageCount
    const goal = value.goal as { status?: string } | undefined
    if (typeof goal?.status === 'string') state.goalStatus = goal.status
    const fingerprint = JSON.stringify(state)
    if (this.states.get(sessionId) === fingerprint) return
    this.states.set(sessionId, fingerprint)
    this.record('state', { sessionId, state })
  }

  forget(sessionId: string): void {
    this.states.delete(sessionId)
  }

  error(event: 'state_error' | 'branch_error', sessionId: string, error: unknown): void {
    const candidate = error as { code?: unknown; name?: unknown } | null
    const errorCode = typeof candidate?.code === 'string' ? candidate.code
      : typeof candidate?.name === 'string' ? candidate.name : 'UNKNOWN'
    this.record(event, { sessionId, errorCode })
  }
}
