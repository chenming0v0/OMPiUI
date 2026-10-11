import { useCallback, useSyncExternalStore } from 'react'
import { useSessionNavigation } from '../../../contexts/SessionNavigationContext'
import { piSessionStateStore } from '../../../omp/state/index.js'

/** 只用已确认的后端空闲状态；未加载状态不推断工具已结束。 */
export function useTaskRuntimeStopped(enabled = true): boolean {
  const { currentSessionId } = useSessionNavigation()
  const getStopped = useCallback(() => {
    if (!enabled || !currentSessionId) return false
    const state = piSessionStateStore.getState(currentSessionId)
    return Boolean(state?.isIdle === true && !state.isStreaming && !state.isCompacting &&
      !state.isRetrying && !state.isBashRunning && !state.hasPendingAsyncWork)
  }, [currentSessionId, enabled])
  return useSyncExternalStore(piSessionStateStore.subscribe, getStopped, getStopped)
}
