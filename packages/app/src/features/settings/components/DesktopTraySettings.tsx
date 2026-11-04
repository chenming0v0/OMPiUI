import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getDesktopTraySettings,
  setDesktopTraySettings,
  redactBackgroundError,
  type DesktopTraySettings as TraySettings,
} from '../../../services/desktopService'
import { SettingRow, SettingsSection, Toggle } from './SettingsUI'

export function DesktopTraySettings() {
  const { t, i18n } = useTranslation('settings')
  const [settings, setSettings] = useState<TraySettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    void getDesktopTraySettings(i18n.language).then(saved => {
      if (!disposed) setSettings(saved)
    }).catch(reason => {
      if (!disposed) setError(redactBackgroundError(String(reason)))
    })
    return () => { disposed = true }
  }, [i18n.language])

  const toggle = async () => {
    if (!settings?.supported || busy) return
    setBusy(true)
    setError('')
    try {
      setSettings(await setDesktopTraySettings(!settings.closeToTray, i18n.language))
    } catch (reason) {
      setError(redactBackgroundError(String(reason)))
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || !settings?.supported
  return (
    <SettingsSection title={t('service.trayTitle')} description={t('service.trayDesc')}>
      <SettingRow
        label={t('service.closeToTray')}
        description={t('service.closeToTrayDesc')}
        disabled={disabled}
        onClick={() => void toggle()}
      >
        <Toggle enabled={settings?.closeToTray ?? false} disabled={disabled} onChange={() => void toggle()} />
      </SettingRow>
      {settings && !settings.supported && <p className="text-[length:var(--fs-xs)] text-text-400">{t('service.trayUnavailable')}</p>}
      {error && <p role="alert" className="break-all text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
    </SettingsSection>
  )
}
