import { useCallback } from 'react'
import { useRouter, useServerStore } from '../../../hooks'
import { clearSessionRuntimeState } from '../../../utils/sessionLifecycle'
import type { ServerSource } from '../../../store/serverStore'

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
