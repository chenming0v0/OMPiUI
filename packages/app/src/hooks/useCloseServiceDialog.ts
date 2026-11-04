import { useCallback, useEffect, useState } from 'react'
import { isTauri, isTauriMobile } from '../utils/tauri'
import { uiErrorHandler } from '../utils'

interface CloseRequest {
  closeToTray: boolean
  exitApp: boolean
}

export function useCloseServiceDialog() {
  const [request, setRequest] = useState<CloseRequest | null>(null)

  useEffect(() => {
    if (!isTauri() || isTauriMobile()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      if (disposed) return
      const stop = await listen<CloseRequest>('close-requested', event => {
        setRequest({ closeToTray: event.payload?.closeToTray ?? false, exitApp: event.payload?.exitApp ?? false })
      })
      if (disposed) stop()
      else unlisten = stop
    }).catch(error => uiErrorHandler('listen for close', error))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const confirmClose = useCallback(async (stopService: boolean) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('confirm_close_app', { stopService, exitApp: request?.exitApp ?? false })
      setRequest(null)
    } catch (error) {
      uiErrorHandler('close app', error)
      throw error
    }
  }, [request])

  const cancelClose = useCallback(() => setRequest(null), [])
  return { showCloseDialog: request !== null, closeToTray: request?.closeToTray ?? false, confirmClose, cancelClose }
}
