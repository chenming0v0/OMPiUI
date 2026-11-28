import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, RefreshCw, Wifi } from 'lucide-react'
import { DeepSeekIcon } from '../../../components/Icons'
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

/** 局域网里发现的电脑。只有手机 App 能做局域网发现。 */
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
 * 桌面版的虚拟组网用本机后端的内置节点：登录后列出同一个网络里的电脑，连接也经这个节点出去。
 * 它固定操作本机后端，与当前选中的服务器无关。
 */
function DesktopTailscaleSection({ onPaired }: { onPaired?: () => void }) {
  const { t } = useTranslation('settings')
  const tailscale = useBackendTailscale('local')
  const { running, restoring, busy, tile, disconnect } = tailscale
  const discovery = useDeviceDiscovery('tailscale', running)
  return (
    <Section id="tailscale" icon={<Globe size={16} />} name={t('service.remoteTabTailscale')} mount="stay"
      status={<State tone={tile.tone}><span role="status">{running ? t('host.connected') : tile.state}</span></State>}
      action={running
        ? <>
          <button type="button" className="cb-icon-btn" disabled={discovery.loading} onClick={discovery.refresh}
            title={t('authentication.discoveryRefresh')} aria-label={t('authentication.discoveryRefresh')}>
            <RefreshCw size={15} className={discovery.loading ? 'animate-spin' : undefined} />
          </button>
          <button type="button" className="cb-link" disabled={busy} onClick={disconnect}>{t('controller.signOut')}</button>
        </>
        : restoring
          ? <button type="button" className="cb-link" disabled={busy} onClick={disconnect}>{t('dshRemote.cancel')}</button>
          : undefined}>
      <div data-testid="backend-tailscale-login" className="cb-sec-body">
        {running
          ? <DiscoveredRows network="tailscale" discovery={discovery} onPaired={onPaired} />
          : !restoring && <div className="cb-logins">{tailscale.controls({ layout: 'phone', hideStatus: true })}</div>}
      </div>
    </Section>
  )
}

/** 控制端：用这台设备连接别的电脑。按来源分组，组里就是和「服务器」页一样的行。 */
export function ControllerSettings({ onPaired }: { onPaired?: () => void }) {
  const { t } = useTranslation('settings')
  const desktop = isTauri() && !isTauriMobile()
  return (
    <div className="cb-page">
      <Card>
        <PageHead title={t('controller.title')} />
        <div className="cb-body" data-testid="controller-sections">
          {supportsDeviceDiscovery() && <LanSection onPaired={onPaired} />}
          {isAndroidTailscalePlatform()
            ? <AndroidTailscaleSettings onPaired={onPaired} />
            : desktop && <DesktopTailscaleSection onPaired={onPaired} />}
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
