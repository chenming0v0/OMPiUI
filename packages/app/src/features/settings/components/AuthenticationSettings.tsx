import { useTranslation } from 'react-i18next'
import { isAndroidTailscalePlatform } from '../../../utils/androidTailscale'
import { AndroidTailscaleSettings } from './AndroidTailscaleSettings'
import { RemoteAccessSettings } from './RemoteAccessSettings'
import { RelaySettings } from './RelaySettings'
import { SettingsSection } from './SettingsUI'

export function AuthenticationSettings({ onAuthenticated }: { onAuthenticated?: () => void }) {
  const { t } = useTranslation('settings')
  if (isAndroidTailscalePlatform()) {
    return (
      <SettingsSection title={t('authentication.title')}>
        <AndroidTailscaleSettings onAuthenticated={onAuthenticated} />
      </SettingsSection>
    )
  }
  return (
    <>
      <RemoteAccessSettings />
      <RelaySettings />
    </>
  )
}
