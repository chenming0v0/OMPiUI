import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { isTauri, isTauriMobile } from '../utils/tauri'
import { serviceStore, useServiceStore } from '../store/serviceStore'
import {
  applyDesktopServiceStart,
  getDesktopTraySettings,
  redactBackgroundError,
  type DesktopServiceStartResult,
} from '../services/desktopService'
import { uiErrorHandler } from '../utils'
import { notificationStore } from '../store/notificationStore'

export function useDesktopTray() {
  const { i18n } = useTranslation()
  const { envVars } = useServiceStore()
  const desktop = isTauri() && !isTauriMobile()
  const reportError = useCallback((error: unknown) => {
    const message = redactBackgroundError(String(error))
    uiErrorHandler('desktop tray', message)
    notificationStore.push('error', i18n.t('settings:service.trayError'), message, '')
  }, [i18n])

  useEffect(() => {
    if (!desktop) return
    // 仅同步菜单语言和启停环境到 native 内存，不写设置或启动后端。
    const timer = window.setTimeout(() => {
      void getDesktopTraySettings(i18n.language).catch(reportError)
    }, 500)
    return () => window.clearTimeout(timer)
  }, [desktop, envVars, i18n.language, reportError])

  useEffect(() => {
    if (!desktop) return
    let disposed = false
    const unlisteners: (() => void)[] = []
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const register = async <T,>(name: string, handle: (payload: T) => void) => {
        if (disposed) return
        const stop = await listen<T>(name, event => handle(event.payload))
        if (disposed) stop()
        else unlisteners.push(stop)
      }
      await register<DesktopServiceStartResult>('desktop-service-started', result => {
        try {
          applyDesktopServiceStart(result)
        } catch (error) {
          reportError(error)
        }
      })
      await register('desktop-service-stopped', () => {
        serviceStore.setRunning(false)
        serviceStore.setStartedByUs(false)
      })
      await register<string>('desktop-service-error', reportError)
    }).catch(reportError)
    return () => {
      disposed = true
      unlisteners.forEach(stop => stop())
    }
  }, [desktop, reportError])
}
