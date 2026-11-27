import { lazy, Suspense, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, CircleCheck, Globe, KeyRound, Plus, QrCode, ScanLine } from 'lucide-react'
import { DeepSeekIcon } from '../../../components/Icons'
import { useDshController } from '../../../store/dshControllerStore'
import { isTauri, isTauriMobile } from '../../../utils/tauri'
import { isAndroidTailscalePlatform } from '../../../utils/androidTailscale'
import { AddServerForm } from './AddServerForm'
import { AndroidTailscaleSettings, type AndroidTailscaleState } from './AndroidTailscaleSettings'
import { ChannelBoard, NextAction, PageHead, type ChannelTile } from './ChannelBoard'
import { PhonePairingForm } from './PhonePairingForm'
import { TailnetPairing } from './TailnetPairing'
import { useServerConnect } from './useServerConnect'

const DshRemoteConnectSettings = lazy(() =>
  import('./DshRemoteSettings').then(module => ({ default: module.DshRemoteConnectSettings })),
)

type ControllerTab = 'pair' | 'tailscale' | 'dsh' | 'manual'

/** 地址和密钥：直接填后端地址，添加后立刻用它。 */
function ManualConnect({ onPaired, onOpenServers }: { onPaired?: () => void; onOpenServers?: () => void }) {
  const { t } = useTranslation('settings')
  const connectServer = useServerConnect()
  const [added, setAdded] = useState('')
  if (added) {
    return (
      <div role="status">
        <NextAction tone="ok" icon={<CircleCheck size={18} />} title={t('controller.manualAdded', { name: added })}
          actions={<>
            {onOpenServers && <button type="button" className="cb-btn" onClick={onOpenServers}>{t('controller.openServers')}</button>}
            <button type="button" className="cb-btn" onClick={() => setAdded('')}><Plus size={14} />{t('controller.manualAnother')}</button>
          </>}>
          {t('controller.manualAddedBody')}
        </NextAction>
      </div>
    )
  }
  return (
    <AddServerForm submitLabel={t('controller.manualSubmit')} hint={t('controller.manualHint')}
      onAdd={server => {
        connectServer(server, server.source)
        setAdded(server.name)
        onPaired?.()
      }} />
  )
}

/** 控制端：用这台设备连接别的电脑。每条通道一张面板，连上的电脑都进「服务器」页。 */
export function ControllerSettings({ onPaired, onOpenServers }: {
  onPaired?: () => void
  onOpenServers?: () => void
}) {
  const { t } = useTranslation('settings')
  const android = isAndroidTailscalePlatform()
  const mobile = isTauriMobile()
  // DS 远程随桌面版和手机 App 一起走，网页端不展示。
  const native = isTauri()
  const [tab, setTab] = useState<ControllerTab>('pair')
  // DS 远程的面板一打开就会向托管服务要登录方式，所以等用户点到它再挂载；挂上之后保留，登录中途切走不会丢。
  const [dshOpened, setDshOpened] = useState(false)
  const [tailscale, setTailscale] = useState<AndroidTailscaleState>({ backendState: null, phase: 'idle' })
  const dsh = useDshController()

  const select = (next: ControllerTab) => {
    setTab(next)
    if (next === 'dsh') setDshOpened(true)
  }

  const tailscaleRunning = tailscale.backendState === 'Running'
  const tailscaleTile: Pick<ChannelTile<ControllerTab>, 'tone' | 'state'> = tailscaleRunning
    ? { tone: 'on', state: t('host.connected') }
    : tailscale.backendState === 'NeedsMachineAuth'
      ? { tone: 'warn', state: t('host.tsApproval') }
      : tailscale.phase !== 'idle' && tailscale.phase !== 'error'
        ? { tone: 'busy', state: t('host.tsAuthorizing') }
        : { tone: 'off', state: t('host.tsSignedOut') }
  const dshTile: Pick<ChannelTile<ControllerTab>, 'tone' | 'state'> = dsh.session
    ? { tone: 'on', state: t('controller.dshOnline', { count: dsh.hosts.filter(host => host.online === true).length }) }
    : dsh.signingIn
      ? { tone: 'busy', state: t('host.tsAuthorizing') }
      : { tone: 'off', state: t('dshRemote.notSignedIn') }
  const tiles: ChannelTile<ControllerTab>[] = [
    { id: 'pair', icon: mobile ? <ScanLine size={16} /> : <QrCode size={16} />, name: t('controller.tabPair'),
      state: t(mobile ? 'controller.pairStateMobile' : 'controller.pairState') },
    ...(android ? [{ id: 'tailscale' as const, icon: <Globe size={16} />, name: t('service.remoteTabTailscale'), ...tailscaleTile }] : []),
    ...(native ? [{ id: 'dsh' as const, icon: <DeepSeekIcon size={16} />, name: t('dshRemote.tab'), ...dshTile }] : []),
    { id: 'manual', icon: <KeyRound size={16} />, name: t('controller.manualTitle'), state: t('controller.manualState') },
  ]

  const footnote: React.ReactNode = native ? null : t('controller.footnoteWeb')

  return (
    <div className="cb-page">
      <PageHead title={t('controller.title')} description={t('controller.description')}
        aside={onOpenServers && (
          <button type="button" className="cb-link" onClick={onOpenServers}>{t('controller.serversPage')}<ChevronRight size={13} /></button>
        )} />
      <ChannelBoard testId="controller-channels" tiles={tiles} selected={tab} onSelect={select}>
        {tab === 'pair' && (
          <PhonePairingForm onPaired={onPaired} onOpenServers={onOpenServers}
            onOpenTailscale={android ? () => select('tailscale') : undefined} />
        )}
        {/* 手机的组网登录一直挂着：通道条要显示它的状态，登录中途切到别的通道也不能断。 */}
        {android && (
          <div hidden={tab !== 'tailscale'}>
            {tailscaleRunning && tab === 'tailscale' && <TailnetPairing onPaired={onPaired} />}
            <div className={tailscaleRunning ? 'cb-split' : undefined} style={tailscaleRunning ? { paddingTop: 18 } : undefined}>
              <AndroidTailscaleSettings onState={setTailscale} />
            </div>
          </div>
        )}
        {native && dshOpened && (
          <div hidden={tab !== 'dsh'}>
            <Suspense fallback={null}><DshRemoteConnectSettings onOpenServers={onOpenServers} /></Suspense>
          </div>
        )}
        {tab === 'manual' && <ManualConnect onPaired={onPaired} onOpenServers={onOpenServers} />}
      </ChannelBoard>
      {footnote && <p className="cb-footnote">{footnote}</p>}
    </div>
  )
}
