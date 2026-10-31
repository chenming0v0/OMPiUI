import { useTranslation } from 'react-i18next'
import { Monitor } from 'lucide-react'
import { AuthCard } from './AuthPanelUI'
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
        <div className="grid min-w-0 gap-3">
          <AndroidTailscaleSettings />
          <AuthCard testId="phone-computer-pairing" icon={<Monitor size={18} />}
            title={t('authentication.phoneConnectComputer')} description={t('authentication.phoneConnectComputerDesc')}>
            <PhonePairingForm onPaired={onPaired} />
          </AuthCard>
        </div>
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
