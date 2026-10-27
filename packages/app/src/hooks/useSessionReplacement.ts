import { useEffect } from 'react'
import { paneLayoutStore } from '../store/paneLayoutStore'

interface SessionReplacementDetail {
  sourceSessionId?: string
  targetSessionId?: string
  targetCwd?: string
  reason?: string
}

/** Follow fork/new/import replacements, never a background runtime's reuse. */
export function useSessionReplacement(
  routeSessionId: string | null,
  routeDirectory: string | undefined,
  navigateToSession: (sessionId: string, directory?: string) => void,
) {
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SessionReplacementDetail>).detail
      if (!detail?.sourceSessionId || !detail.targetSessionId || detail.reason === 'runtime-reuse') return
      paneLayoutStore.remapSession(detail.sourceSessionId, detail.targetSessionId)
      if (routeSessionId === detail.sourceSessionId) {
        navigateToSession(detail.targetSessionId, detail.targetCwd ?? routeDirectory)
      }
      if (detail.sourceSessionId === detail.targetSessionId) {
        // Session metadata is reloaded by sessions-changed; all leaves retain
        // their same native id while the focused route adopts the new cwd.
        window.dispatchEvent(new CustomEvent('ompiui:workspace-changed', { detail }))
      }
    }
    window.addEventListener('ompiui:session-replaced', handler)
    window.addEventListener('ompiui:session-relocated', handler)
    return () => {
      window.removeEventListener('ompiui:session-replaced', handler)
      window.removeEventListener('ompiui:session-relocated', handler)
    }
  }, [routeSessionId, routeDirectory, navigateToSession])
}
