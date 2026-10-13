import { serverStore, type ServerHealth } from '../store/serverStore'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface ConnectionInfo {
  state: ConnectionState
  error?: string
  lastEventTime: number
  reconnectAttempt: number
  reconnectedAt?: number
  reconnectReason?: 'network' | 'server-switch'
}

const HEALTH_POLL_INTERVAL_MS = 30_000

let connectionInfo: ConnectionInfo = {
  state: 'disconnected',
  lastEventTime: 0,
  reconnectAttempt: 0,
}

const listeners = new Set<(info: ConnectionInfo) => void>()

export function getConnectionInfo(): ConnectionInfo {
  return connectionInfo
}

function mapHealthToState(health: ServerHealth | null): ConnectionState {
  switch (health?.status) {
    case 'online':
      return 'connected'
    case 'checking':
      return 'connecting'
    case 'error':
    case 'unauthorized':
      return 'error'
    default:
      return 'disconnected'
  }
}

let tracking = false
let serverSwitchPending = false
// Last real auth rejection (401). Reconnect/offline churn must not erase it.
let lastAuthError: string | undefined

function syncFromStore(): void {
  const health = serverStore.getHealth(serverStore.getActiveServerId())
  const previousState = connectionInfo.state
  const nextState = mapHealthToState(health)
  if (health?.status === 'unauthorized') lastAuthError = health.error ?? lastAuthError
  else if (!health || health.status === 'online') lastAuthError = undefined
  connectionInfo = {
    ...connectionInfo,
    state: nextState,
    error: lastAuthError ?? health?.error,
    lastEventTime: health?.lastCheck ?? connectionInfo.lastEventTime,
  }
  if (previousState !== 'connected' && nextState === 'connected') {
    connectionInfo.reconnectedAt = Date.now()
    connectionInfo.reconnectReason = serverSwitchPending ? 'server-switch' : 'network'
    serverSwitchPending = false
  }
  for (const listener of listeners) listener(connectionInfo)
}

function checkActiveServerHealth(): void {
  if (document.hidden) return
  void serverStore.checkHealth(serverStore.getActiveServerId())
}

function ensureTracking(): void {
  if (tracking || typeof window === 'undefined') return
  tracking = true
  serverStore.subscribe(syncFromStore)
  serverStore.onServerChange(() => {
    serverSwitchPending = true
    syncFromStore()
    checkActiveServerHealth()
  })
  window.setInterval(checkActiveServerHealth, HEALTH_POLL_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkActiveServerHealth()
  })
  syncFromStore()
  checkActiveServerHealth()
}

export function subscribeToConnectionState(listener: (info: ConnectionInfo) => void): () => void {
  listeners.add(listener)
  ensureTracking()
  listener(connectionInfo)
  return () => listeners.delete(listener)
}
