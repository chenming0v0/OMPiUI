import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, Monitor, QrCode } from 'lucide-react'
import { AuthCard, ConnectionMethods } from './AuthPanelUI'
import { isAndroidTailscalePlatform } from '../../../utils/androidTailscale'
import { AndroidTailscaleSettings } from './AndroidTailscaleSettings'
import { RemoteAccessSettings } from './RemoteAccessSettings'
import { RelaySettings } from './RelaySettings'
import { SettingsSection } from './SettingsUI'
import { PhonePairingForm } from './PhonePairingForm'

const DshRemoteSettings = lazy(() => import('./DshRemoteSettings'))

export function AuthenticationSettings({ onPaired, onManageController }: { onPaired?: () => void; onManageController?: () => void }) {
  const { t } = useTranslation('settings')
  const [method, setMethod] = useState<'pair' | 'dsh'>('pair')
  if (isAndroidTailscalePlatform()) {
    return (
      <SettingsSection title={t('authentication.title')}>
        <div className="grid min-w-0 gap-3">
          <AndroidTailscaleSettings />
          <AuthCard testId="phone-computer-pairing" icon={<Monitor size={18} />}
            title={t('authentication.phoneConnectComputer')} description={method === 'pair' ? t('authentication.phoneConnectComputerDesc') : undefined}>
            <ConnectionMethods options={[
              ['pair', t('dshRemote.directPairing'), <QrCode size={14} />],
              ['dsh', t('dshRemote.tab'), <Cloud size={14} />],
            ]} selected={method} onChange={setMethod} />
            {method === 'pair' && <PhonePairingForm onPaired={onPaired} />}
          </AuthCard>
          {method === 'dsh' && <Suspense fallback={null}><DshRemoteSettings onManage={onManageController} /></Suspense>}
        </div>
      </SettingsSection>
    )
  }
  return (
    <>
      <RemoteAccessSettings onManageController={onManageController} />
      <RelaySettings />
    </>
  )
}
