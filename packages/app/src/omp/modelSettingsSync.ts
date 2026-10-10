import { subscribeToConnectionState } from '../api/events'
import { serverStore } from '../store/serverStore'
import { loadPiModels } from './controllers/index.js'
import { loadPiModelRoles } from './controllers/modelRoles'
import { piModelsStore } from './state/piModelsStore'
import { piModelRolesStore } from './state/piModelRolesStore'

let installed = false

export function markModelSettingsDisconnected(): void {
  piModelsStore.markDisconnected()
  piModelRolesStore.markDisconnected()
}

export function refreshModelSettings(): void {
  void loadPiModels().catch(() => undefined)
  if (piModelRolesStore.hasRequested()) void loadPiModelRoles(true).catch(() => undefined)
}

export function installModelSettingsSync(): void {
  if (installed) return
  installed = true
  // 跟随侧边栏已有的服务器健康订阅，不另建连接或轮询。
  let disconnected = false
  subscribeToConnectionState(info => {
    const health = serverStore.getHealth(serverStore.getActiveServerId())
    if (info.state === 'error' || health?.status === 'offline') {
      if (!disconnected) markModelSettingsDisconnected()
      disconnected = true
    } else if (info.state === 'connected' && disconnected) {
      disconnected = false
      refreshModelSettings()
    }
  })
  window.addEventListener('offline', () => {
    disconnected = true
    markModelSettingsDisconnected()
  })
  window.addEventListener('online', () => {
    disconnected = false
    refreshModelSettings()
  })
}
