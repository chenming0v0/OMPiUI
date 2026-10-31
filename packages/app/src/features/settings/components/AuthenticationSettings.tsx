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
        <div data-testid="phone-computer-pairing" className="mt-4 rounded-xl border border-border-200/60 bg-bg-100 p-4">
          <h3 className="text-[length:var(--fs-md)] font-medium text-text-100">{t('authentication.phoneConnectComputer')}</h3>
          <p className="mt-1 text-[length:var(--fs-xs)] leading-relaxed text-text-300">{t('authentication.phoneConnectComputerDesc')}</p>
          <PhonePairingForm onPaired={onPaired} />
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
