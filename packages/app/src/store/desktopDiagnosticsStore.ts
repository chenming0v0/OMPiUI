import { useSyncExternalStore } from 'react'
import { backendRuntimeStatus, receiveBackendRuntimeHealth, useBackendRuntimeHealth } from './backendRuntimeHealth'

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
  /** 工作进程握手探测到的 OMP 版本，不以 IPC 就绪代替运行时可用。 */
  ompVersion?: string | null
  healthError: string | null
  healthUrl?: string | null
  healthCheckedAt?: number | null
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
    if (native.reachable && native.healthUrl && native.healthCheckedAt != null) {
      receiveBackendRuntimeHealth(native.healthUrl, native, native.healthCheckedAt)
    }
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
  const snapshot = useSyncExternalStore(desktopDiagnosticsStore.subscribe, desktopDiagnosticsStore.getSnapshot)
  const health = useBackendRuntimeHealth(snapshot.native?.healthUrl)
  return snapshot.native?.reachable && health
    ? { ...snapshot, native: { ...snapshot.native, workerReady: health.workerReady ?? null, ompVersion: health.ompVersion } }
    : snapshot
}

/**
 * 本机后端在运行、工作进程握手完成，却探测不到 OMP：这台电脑没有可用的运行时。
 * 状态还没读到时不算缺失。
 */
export function useLocalOmpMissing(): boolean {
  const snapshot = useDesktopDiagnostics()
  const native = snapshot.native
  return desktopServicePhase(snapshot) === 'running' && backendRuntimeStatus(native) === 'missing'
}
