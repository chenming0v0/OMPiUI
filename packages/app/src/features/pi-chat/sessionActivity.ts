import type { PiSessionRuntimeState } from '../../omp/domain/index.js'

/** Stop targets foreground work, not queued messages or pending background jobs. */
export function hasStoppableSessionActivity(state: PiSessionRuntimeState | null | undefined, listedActive: boolean): boolean {
  if (!state || typeof state.isStreaming !== 'boolean') return listedActive
  return state.isStreaming || state.isCompacting === true || state.isRetrying === true || state.isBashRunning === true
}
