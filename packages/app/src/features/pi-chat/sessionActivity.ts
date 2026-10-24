import type { PiSessionRuntimeState } from '../../omp/domain/index.js'

/** Queued work can keep native isSettled false after the foreground was stopped. */
export function hasStoppableSessionActivity(state: PiSessionRuntimeState | null | undefined, listedActive: boolean): boolean {
  if (!state || typeof state.isStreaming !== 'boolean') return listedActive
  return state.isStreaming || state.isCompacting === true || state.isRetrying === true || state.hasPendingAsyncWork === true || state.isBashRunning === true
}
