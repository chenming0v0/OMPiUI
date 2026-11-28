import { useCallback } from 'react'
import { useRouter, useServerStore } from '../../../hooks'
import { disconnectDshServer } from '../../../services/dshServerConnection'
import { clearSessionRuntimeState } from '../../../utils/sessionLifecycle'
import type { ServerSource } from '../../../store/serverStore'

/** 点一行就切换服务器：清掉当前会话的运行状态、切过去、回首页、查一次连通。 */
export function useServerSelect() {
  const { activeServer, setActiveServer, checkHealth } = useServerStore()
  const { navigateHome, sessionId } = useRouter()
  return useCallback((id: string) => {
    if (activeServer?.id === id) {
      // 原服务器仍处于选中状态时，也可以取消尚未完成的 DS 连接。
      if (activeServer.source !== 'dsh') void disconnectDshServer()
      return
    }
    if (sessionId) clearSessionRuntimeState(sessionId)
    setActiveServer(id) // 内部触发 serverChangeListeners → reconnectSSE()
    navigateHome()
    void checkHealth(id)
  }, [activeServer?.id, activeServer?.source, checkHealth, sessionId, setActiveServer, navigateHome])
}

/** 配对或手动添加成功后的收尾：存下这台服务器、切过去、回首页、查一次连通。 */
export function useServerConnect() {
  const { addServer, setActiveServer, checkHealth } = useServerStore()
  const { navigateHome, sessionId } = useRouter()
  return useCallback((target: { url: string; token?: string; name?: string }, source: ServerSource) => {
    const server = addServer({ name: target.name || new URL(target.url).host, url: target.url, token: target.token, source })
    if (sessionId) clearSessionRuntimeState(sessionId)
    setActiveServer(server.id)
    navigateHome()
    void checkHealth(server.id)
    return server
  }, [addServer, setActiveServer, checkHealth, navigateHome, sessionId])
}
