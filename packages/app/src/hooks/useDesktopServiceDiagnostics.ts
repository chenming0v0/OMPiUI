import { useEffect } from 'react'
import { desktopDiagnosticsStore, isServiceBusy } from '../store/desktopDiagnosticsStore'

export function useDesktopServiceDiagnostics() {
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      let delay = 3000
      try {
        const { readDesktopServiceDiagnostics } = await import('../services/desktopService')
        if (disposed) return
        const diagnostics = await readDesktopServiceDiagnostics()
        if (disposed) return
        desktopDiagnosticsStore.receive(diagnostics)
        if (isServiceBusy(diagnostics.phase)) delay = 1000
      } catch {
        if (!disposed) desktopDiagnosticsStore.queryFailed()
      }
      if (!disposed) timer = setTimeout(() => void poll(), delay)
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [])
}
