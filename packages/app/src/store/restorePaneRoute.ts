import { paneLayoutStore } from './paneLayoutStore'
import { serverStorage } from '../utils/perServerStorage'
import { STORAGE_KEY_LAST_DIRECTORY } from '../constants/storage'
import { serverStore } from './serverStore'

/** Native cold starts have no hash; explicit links (including Home) always win. */
export function restorePaneRoute(): void {
  if (serverStore.consumeExpiredRuntimeRoute()) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  if (window.location.hash) return
  const sessionId = paneLayoutStore.getFocusedSessionId()
  if (!sessionId) return
  const directory = serverStorage.get(STORAGE_KEY_LAST_DIRECTORY)
  const hash = `#/session/${sessionId}${directory ? `?dir=${encodeURIComponent(directory)}` : ''}`
  window.history.replaceState(null, '', hash)
}
