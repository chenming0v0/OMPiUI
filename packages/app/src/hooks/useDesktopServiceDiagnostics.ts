import { useEffect } from 'react'
import { desktopDiagnosticsStore, isServiceBusy } from '../store/desktopDiagnosticsStore'
let consumers = 0
let stopPolling: (() => void) | undefined

export function useDesktopServiceDiagnostics() {
  useEffect(() => {
    consumers++
    if (stopPolling)
      return () => {
        if (--consumers === 0) stopPolling?.()
      }
    let disposed = false
    let busy = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (disposed || busy) return
      if (document.visibilityState === 'hidden') return
      busy = true
      let delay = 15_000
      try {
        const { readDesktopServiceDiagnostics } = await import('../services/desktopService')
        if (disposed) return
        const diagnostics = await readDesktopServiceDiagnostics()
        if (disposed) return
        desktopDiagnosticsStore.receive(diagnostics)
        failures = 0
        if (isServiceBusy(diagnostics.phase) || (diagnostics.phase === 'running' && !diagnostics.workerReady))
          delay = 1000
      } catch {
        if (!disposed) desktopDiagnosticsStore.queryFailed()
        delay = Math.min(60_000, 15_000 * 2 ** ++failures)
      }
      busy = false
      if (!disposed) timer = setTimeout(() => void poll(), delay)
    }
    void poll()
    const visibility = () => {
      clearTimeout(timer)
      if (document.visibilityState !== 'hidden') void poll()
    }
    document.addEventListener('visibilitychange', visibility)
    stopPolling = () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
      stopPolling = undefined
    }
    return () => {
      if (--consumers === 0) stopPolling?.()
    }
  }, [])
}
