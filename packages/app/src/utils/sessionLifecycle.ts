import { activeSessionStore } from '../store/activeSessionStore'
import { piBranchStore, piSessionStateStore } from '../omp/state/index.js'
import { piEventStream } from '../omp/eventStream'

export function clearSessionRuntimeState(sessionId: string) {
  piEventStream.disconnect(sessionId)
  piBranchStore.clear(sessionId)
  piSessionStateStore.clear(sessionId)
  activeSessionStore.removeSession(sessionId)
}
