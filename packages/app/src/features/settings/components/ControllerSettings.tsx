import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, RefreshCw, Wifi } from 'lucide-react'
import { DeepSeekIcon } from '../../../components/Icons'
import { useServerStore } from '../../../hooks'
import { useLocalOmpMissing } from '../../../store/desktopDiagnosticsStore'
import { supportsDeviceDiscovery } from '../../../utils/deviceDiscovery'
import { isTauri, isTauriMobile } from '../../../utils/tauri'
import { isAndroidTailscalePlatform } from '../../../utils/androidTailscale'
import { AndroidTailscaleSettings } from './AndroidTailscaleSettings'
import { Card, PageHead, Section, State } from './ChannelBoard'
import { DiscoveredRows } from './DiscoveredComputers'
import { useDeviceDiscovery } from './useDeviceDiscovery'
import { useBackendTailscale } from './useBackendTailscale'

const DshRemoteConnectSettings = lazy(() =>
  import('./DshRemoteSettings').then(module => ({ default: module.DshRemoteConnectSettings })),
)

/** 局域网里发现的电脑。只有手机 App 能做设备发现。 */
function LanSection({ onPaired }: { onPaired?: () => void }) {
  const { t } = useTranslation('settings')
  const discovery = useDeviceDiscovery('lan', true)
  return (
    <Section id="lan" icon={<Wifi size={16} />} name={t('service.remoteTabLan')} mount="stay"
      status={discovery.loading
        ? <State tone="busy">{t('host.loading')}</State>
        : <State>{t('controller.found', { count: discovery.devices.length })}</State>}
      action={
        <button type="button" className="cb-icon-btn" disabled={discovery.loading} onClick={discovery.refresh}
          title={t('authentication.discoveryRefresh')} aria-label={t('authentication.discoveryRefresh')}>
          <RefreshCw size={15} className={discovery.loading ? 'animate-spin' : undefined} />
        </button>
      }>
      <DiscoveredRows network="lan" discovery={discovery} onPaired={onPaired} />
    </Section>
  )
}

/**
 * 桌面版没有 OMP 运行时就没有「被控端」，本机后端内置节点的登录放到这里。
 * 它操作的是当前连着的后端，所以只在当前服务器是本机时出现。
 */
function BackendTailscaleSection() {
  const { t } = useTranslation('settings')
  const tailscale = useBackendTailscale()
  const { running, restoring, busy, tile, disconnect } = tailscale
  return (
    <Section id="tailscale" icon={<Globe size={16} />} name={t('service.remoteTabTailscale')} mount="stay"
      status={<State tone={tile.tone}>{running ? t('host.connected') : tile.state}</State>}
      action={running
        ? <button type="button" className="cb-link" disabled={busy} onClick={disconnect}>{t('controller.signOut')}</button>
        : restoring
          ? <button type="button" className="cb-link" disabled={busy} onClick={disconnect}>{t('dshRemote.cancel')}</button>
          : undefined}>
      <div data-testid="backend-tailscale-login" className="cb-sec-body">
        {running
          ? <div className="cb-copy"><code>{tailscale.tailscale?.url ?? tailscale.tailscale?.ips[0]}</code></div>
          : restoring
            ? <p role="status" className="cb-hint px-0.5">{t('service.remoteTailscaleRestoring')}</p>
            : <div className="cb-logins">{tailscale.controls({ layout: 'phone' })}</div>}
      </div>
    </Section>
  )
}

/** 控制端：用这台设备连接别的电脑。按来源分组，组里就是和「服务器」页一样的行。 */
export function ControllerSettings({ onPaired }: { onPaired?: () => void }) {
  const { t } = useTranslation('settings')
  const { activeServer } = useServerStore()
  const desktop = isTauri() && !isTauriMobile()
  const ompMissing = useLocalOmpMissing()
  return (
    <div className="cb-page">
      <Card>
        <PageHead title={t('controller.title')} />
        <div className="cb-body" data-testid="controller-sections">
          {supportsDeviceDiscovery() && <LanSection onPaired={onPaired} />}
          {/* 有运行时的时候，虚拟组网的登录在「被控端」里。 */}
          {isAndroidTailscalePlatform()
            ? <AndroidTailscaleSettings onPaired={onPaired} />
            : desktop && ompMissing && activeServer?.isDefault && <BackendTailscaleSection />}
          <Suspense fallback={
            <Section id="dsh" icon={<DeepSeekIcon size={16} />} name={t('dshRemote.tab')}>{null}</Section>
          }>
            <DshRemoteConnectSettings />
          </Suspense>
        </div>
      </Card>
    </div>
  )
}
