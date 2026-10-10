import { useTranslation } from 'react-i18next'
import { isTauri, isTauriMobile } from '../../../utils/tauri'
import { serviceStore, useServiceStore } from '../../../store/serviceStore'
import { settingsFieldClass, SettingField, SettingsSection } from './SettingsUI'

const TUNNEL_URL_KEY = 'OMPIUI_TUNNEL_URL'
const TUNNEL_KEY_KEY = 'OMPIUI_TUNNEL_KEY'
const TUNNEL_ID_KEY = 'OMPIUI_TUNNEL_ID'

export function RelaySettings() {
  const { t } = useTranslation('settings')
  const { envVars } = useServiceStore()
  if (!isTauri() || isTauriMobile()) return null

  const valueOf = (key: string) =>
    envVars.find(item => item.key.trim().toUpperCase() === key)?.value || ''
  const setValue = (key: string, value: string) => {
    if (value.trim()) serviceStore.upsertEnvVar(key, value)
    else serviceStore.setEnvVars(serviceStore.envVars.filter(item => item.key.trim().toUpperCase() !== key))
  }

  return (
    <SettingsSection title={t('service.tunnelTitle')} description={t('service.localTunnelDesc')}>
      <SettingField label={t('service.tunnelUrl')} description={t('service.tunnelUrlDesc')}>
        <input type="text" value={valueOf(TUNNEL_URL_KEY)} placeholder="wss://relay.example.com"
          aria-label={t('service.tunnelUrl')} spellCheck={false}
          className={`${settingsFieldClass} font-mono`}
          onChange={event => setValue(TUNNEL_URL_KEY, event.target.value)} />
      </SettingField>
      <SettingField label={t('service.tunnelKey')} description={t('service.tunnelKeyDesc')}>
        <input type="password" value={valueOf(TUNNEL_KEY_KEY)} autoComplete="off"
          aria-label={t('service.tunnelKey')} spellCheck={false}
          className={`${settingsFieldClass} font-mono`}
          onChange={event => setValue(TUNNEL_KEY_KEY, event.target.value)} />
      </SettingField>
      <SettingField label={t('service.tunnelId')} description={t('service.tunnelIdDesc')}>
        <input type="text" value={valueOf(TUNNEL_ID_KEY)} placeholder="ompiui"
          aria-label={t('service.tunnelId')} spellCheck={false}
          className={`${settingsFieldClass} font-mono`}
          onChange={event => setValue(TUNNEL_ID_KEY, event.target.value)} />
      </SettingField>
      <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-300">{t('service.tunnelRestartHint')}</p>
      <p className="text-[length:var(--fs-xs)] leading-relaxed text-warning-100/80">{t('service.tunnelWarning')}</p>
    </SettingsSection>
  )
}
