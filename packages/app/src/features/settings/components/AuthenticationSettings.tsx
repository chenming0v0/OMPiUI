import { useTranslation } from 'react-i18next'
import { isAndroidTailscalePlatform } from '../../../utils/androidTailscale'
import { AndroidTailscaleSettings } from './AndroidTailscaleSettings'
import { RemoteAccessSettings } from './RemoteAccessSettings'
import { RelaySettings } from './RelaySettings'
import { SettingsSection } from './SettingsUI'
import { PhonePairingForm } from './PhonePairingForm'

export function AuthenticationSettings({ onPaired }: { onPaired?: () => void }) {
  const { t } = useTranslation('settings')
  if (isAndroidTailscalePlatform()) {
    return (
      <SettingsSection title={t('authentication.title')}>
        <AndroidTailscaleSettings />
        <PhonePairingForm onPaired={onPaired} />
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
