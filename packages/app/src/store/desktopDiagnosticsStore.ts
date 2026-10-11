import { useSyncExternalStore } from 'react'

export type DesktopServicePhase =
  'idle' | 'preparing' | 'checking' | 'starting' | 'waiting_health' | 'running' | 'stopping' | 'stopped' | 'failed'
export interface DesktopServiceDiagnostics {
  revision: number
  phase: DesktopServicePhase
  requestedAt: number | null
  spawnedAt: number | null
  completedAt: number | null
  pid: number | null
  error: string | null
  events: { time: number; phase: DesktopServicePhase }[]
  reachable: boolean | null
  workerReady: boolean | null
  healthError: string | null
  output: string[]
}

interface DesktopDiagnosticsSnapshot {
  native: DesktopServiceDiagnostics | null
  operation: { phase: 'preparing' | 'stopping'; requestedAt: number } | null
  commandError: string | null
  queryError: boolean
}

export function isServiceBusy(phase: string): boolean {
  return ['preparing', 'checking', 'starting', 'waiting_health', 'stopping'].includes(phase)
}

export function desktopServicePhase(
  snapshot: DesktopDiagnosticsSnapshot,
): DesktopServicePhase | 'unknown' | 'unreachable' {
  const { native, operation, commandError, queryError } = snapshot
  if (operation && (!native?.requestedAt || native.requestedAt < operation.requestedAt)) return operation.phase
  if (commandError) return 'failed'
  if (queryError) return 'unknown'
  if (!native) return 'unknown'
  if (isServiceBusy(native.phase)) return native.phase
  if (native.reachable) return 'running'
  if (native.phase === 'failed') return 'failed'
  if (native.phase === 'running') return 'unreachable'
  return 'stopped'
}

class DesktopDiagnosticsStore {
  private snapshot: DesktopDiagnosticsSnapshot = {
    native: null,
    operation: null,
    commandError: null,
    queryError: false,
  }
  private listeners = new Set<() => void>()
  private failedRequestAt: number | null = null
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<DesktopDiagnosticsSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach(listener => listener())
  }
  begin(phase: 'preparing' | 'stopping') {
    this.failedRequestAt = null
    this.update({ operation: { phase, requestedAt: Date.now() }, commandError: null })
  }
  finish(error?: unknown) {
    this.failedRequestAt = error === undefined ? null : (this.snapshot.operation?.requestedAt ?? Date.now())
    this.update({ operation: null, commandError: error === undefined ? null : String(error) })
  }
  receive(native: DesktopServiceDiagnostics) {
    // 其他桌面窗口重试后，新一轮原生启动状态替代本窗口的旧错误。
    const newAttempt =
      this.failedRequestAt !== null && native.requestedAt !== null && native.requestedAt > this.failedRequestAt
    if (newAttempt) this.failedRequestAt = null
    this.update({ native, queryError: false, ...(newAttempt ? { commandError: null } : {}) })
  }
  queryFailed() {
    this.update({ queryError: true })
  }
}

export const desktopDiagnosticsStore = new DesktopDiagnosticsStore()
export function useDesktopDiagnostics() {
  return useSyncExternalStore(desktopDiagnosticsStore.subscribe, desktopDiagnosticsStore.getSnapshot)
}
