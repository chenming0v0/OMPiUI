import { useCallback, useEffect, useId, useLayoutEffect, useRef } from 'react'
import { registerSessionConsumer } from '../hooks/useGlobalEvents'
import { serverStore } from '../store/serverStore'
import { getPiResourceVersion } from './transport/index.js'

type ResourceUpdate = { sessionId?: string; workspacePath?: string; version?: string; resourceVersion?: string }

type LoadResources = () => Promise<boolean>

/** Reconcile read-only resource views without reloading the native session. */
export function useSessionResourceRefresh(sessionId: string | null | undefined, workspacePath: string | null | undefined, load: LoadResources) {
  const consumerId = useId()
  const applied = useRef<{ version?: string; load: LoadResources } | null>(null)
  const workspace = useRef(workspacePath)
  useEffect(() => { workspace.current = workspacePath }, [workspacePath])
  const checkRequest = useRef<AbortController | null>(null)
  useLayoutEffect(() => () => checkRequest.current?.abort(), [checkRequest, load, sessionId])
  const check = useCallback(async (announcedVersion?: string) => {
    checkRequest.current?.abort()
    const controller = new AbortController()
    checkRequest.current = controller
    const generation = serverStore.getActiveServerGeneration()
    let version = announcedVersion
    if (version === undefined && sessionId) {
      // A cold session or older backend may not expose a live version. Keep
      // the existing read-only loaders as the fallback, not session attach.
      try { version = await getPiResourceVersion(sessionId, controller.signal) } catch { /* read the available data below */ }
    }
    if (controller.signal.aborted || generation !== serverStore.getActiveServerGeneration()) return
    if (version !== undefined && applied.current?.version === version && applied.current.load === load) return
    const next = { version, load }
    applied.current = next
    const loaded = await load()
    if (loaded === false && applied.current === next) applied.current = null
  }, [load, sessionId])

  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<ResourceUpdate>).detail
      if (!sessionId || !detail) return
      if (detail.sessionId === sessionId) void check(detail.version ?? detail.resourceVersion)
      else if (detail.workspacePath && detail.workspacePath === workspace.current) void check()
    }
    window.addEventListener('ompiui:session-resources-updated', changed)
    window.addEventListener('ompiui:registry-updated', changed)
    const unsubscribe = registerSessionConsumer(consumerId, sessionId ?? null, { onReconnected: () => { void check() } })
    void check()
    return () => {
      checkRequest.current?.abort()
      unsubscribe()
      window.removeEventListener('ompiui:session-resources-updated', changed)
      window.removeEventListener('ompiui:registry-updated', changed)
    }
  }, [check, consumerId, sessionId])

  return check
}
