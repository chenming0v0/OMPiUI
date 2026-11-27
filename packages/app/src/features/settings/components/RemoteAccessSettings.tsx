import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, Clock, Globe, Monitor, Server, TriangleAlert, Wifi } from 'lucide-react'
import type { HostNetworkInfo, PairInviteInfo, TunnelStatus } from '@ompiui/protocol'
import { CheckIcon, CopyIcon, DeepSeekIcon, RetryIcon, SpinnerIcon } from '../../../components/Icons'
import { QrCode } from '../../../components/QrCode'
import {
  fetchHostNetwork,
  fetchPairInvite,
  fetchTailscale,
  fetchHostTunnel,
  mintPairInvite,
  startTailscaleLogin,
  disconnectTailscale,
} from '../../../omp/transport/index.js'
import { serverStorage } from '../../../utils'
import { useServerStore } from '../../../hooks'
import { useTailscaleLoginFlow } from '../../../hooks/useTailscaleLoginFlow'
import { TailscaleControls } from './TailscaleControls'
import { AuthStatusPill } from './AuthPanelUI'
import { ChannelBoard, NextAction, PageHead, PanelRow, PanelSplit, type ChannelTile, type LampTone } from './ChannelBoard'
import { DshHostPanel } from './DshHostPanel'
import { useDshHost } from './useDshHost'
import { openTailscaleLogin } from '../../../utils/tailscaleLogin'
import { isTauri, isTauriMobile } from '../../../utils/tauri'

const REMOTE_TAB_KEY = 'ompiui-remote-tab'
const PAIR_POLL_MS = 3_000
const TUNNEL_POLL_MS = 5_000

type RemoteTab = 'lan' | 'tailscale' | 'relay' | 'dsh'

function formatCountdown(expiresAt: number, now: number): string {
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000))
  const minutes = String(Math.floor(remaining / 60)).padStart(2, '0')
  const seconds = String(remaining % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^(?:::ffff:)?127\./.test(host)
}

export function RemoteAccessSettings({ onOpenService }: { onOpenService?: () => void }) {
  const { activeServerGeneration } = useServerStore()
  // Addresses, invites and pending actions belong to one server generation.
  // Remount before rendering a new server, not after its first async response.
  return <RemoteAccessPanel key={activeServerGeneration} onOpenService={onOpenService} />
}

function RemoteAccessPanel({ onOpenService }: { onOpenService?: () => void }) {
  const { t } = useTranslation(['settings', 'common'])
  const { activeServer } = useServerStore()
  const desktop = isTauri() && !isTauriMobile()
  const [tab, setTab] = useState<RemoteTab>(() => {
    const stored = serverStorage.get(REMOTE_TAB_KEY)
    // DS Harness Remote 只由桌面壳绑定，网页端不展示这个入口。
    if (stored === 'dsh') return desktop ? 'dsh' : 'lan'
    return stored === 'relay' || stored === 'tailscale' ? stored : 'lan'
  })
  const [network, setNetwork] = useState<HostNetworkInfo | null>(null)
  const [networkLoading, setNetworkLoading] = useState(true)
  const [networkRefresh, setNetworkRefresh] = useState(0)
  const [selectedAddress, setSelectedAddress] = useState('')
  const [invite, setInvite] = useState<PairInviteInfo | null>(null)
  const [inviteGone, setInviteGone] = useState(false)
  const [inviteRefresh, setInviteRefresh] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [tunnel, setTunnel] = useState<TunnelStatus | null | undefined>(undefined)
  const [tailscale, setTailscale] = useState<import('@ompiui/protocol').TailscaleInfo | null>(null)
  const [tailscaleBusy, setTailscaleBusy] = useState(false)
  const [tailscaleError, setTailscaleError] = useState('')
  const [tailscaleStatusError, setTailscaleStatusError] = useState('')
  const [copied, setCopied] = useState(false)
  const dshHost = useDshHost(desktop)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const pollTailscale = async (signal: AbortSignal) => {
    const next = await fetchTailscale(signal)
    if (!signal.aborted) {
      setTailscale(next)
      setTailscaleStatusError('')
    }
    return { backendState: next.backendState, authUrl: next.authUrl ?? null }
  }
  const tailscaleFlow = useTailscaleLoginFlow({
    start: async signal => {
      const result = await startTailscaleLogin()
      if (signal.aborted) return {}
      // POST 已给出链接时立刻打开，不让后续 GET 的延迟或失败拦住授权。
      if (result.authUrl) return { authUrl: result.authUrl }
      return pollTailscale(signal)
    },
    poll: pollTailscale,
    open: openTailscaleLogin,
    timeoutMessage: t('settings:service.remoteTailscaleAuthUrlTimeout'),
    connectionTimeoutMessage: t('settings:service.remoteTailscaleConnectionTimeout'),
    statusPollMs: TUNNEL_POLL_MS,
    paused: tailscaleBusy,
    onPollError: err => setTailscaleStatusError(err instanceof Error ? err.message : String(err)),
  })

  const interfaces = network?.interfaces ?? []
  const port = network?.port
  const listenPort = typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null

  // Older backends may not report a port. Never substitute this device's config.
  useEffect(() => {
    let cancelled = false
    void fetchHostNetwork()
      .then(result => {
        if (cancelled) return
        setNetwork(result)
        setSelectedAddress(previous => {
          if (previous && result.interfaces.some(item => item.address === previous)) return previous
          const lan = result.interfaces.find(item => !item.tailscale) ?? result.interfaces[0]
          return lan?.address ?? ''
        })
      })
      .catch(() => {
        if (!cancelled) setNetwork(null)
      })
      .finally(() => {
        if (!cancelled) setNetworkLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [networkRefresh])

  // 一次性邀请：进面板铸造一次；之后轮询兑换状态
  useEffect(() => {
    let cancelled = false
    void mintPairInvite()
      .then(next => {
        if (!cancelled) setInvite(next)
      })
      .catch(() => {
        if (!cancelled) setInviteGone(true)
      })
    return () => {
      cancelled = true
    }
  }, [inviteRefresh])

  const inviteId = invite?.id ?? null
  const expired = invite !== null && now >= invite.expiresAt
  const inviteActive = Boolean(invite && !expired && !invite.redeemed)
  const inviteExpiresAt = invite?.expiresAt
  useEffect(() => {
    if (!inviteId || !inviteActive) return
    let cancelled = false
    let pending = false
    const poll = () => {
      if (cancelled || pending || document.visibilityState === 'hidden' ||
        (inviteExpiresAt !== undefined && Date.now() >= inviteExpiresAt)) return
      pending = true
      void fetchPairInvite(inviteId)
        .then(next => {
          if (!cancelled) setInvite(previous => (previous && previous.id === next.id ? next : previous))
        })
        .catch(() => undefined)
        .finally(() => { pending = false })
    }
    const timer = window.setInterval(poll, PAIR_POLL_MS)
    document.addEventListener('visibilitychange', poll)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [inviteId, inviteActive, inviteExpiresAt])

  // 秒级倒计时
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // 自建中转状态轮询；Tailscale 由登录 hook 统一刷新。
  useEffect(() => {
    let cancelled = false
    const load = () => {
      if (document.visibilityState === 'hidden') return
      void fetchHostTunnel()
        .then(next => {
          if (!cancelled) setTunnel(next)
        })
        .catch(() => {
          if (!cancelled) setTunnel(null)
        })
    }
    load()
    const timer = window.setInterval(load, TUNNEL_POLL_MS)
    const resume = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', resume)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [])

  const reMint = () => {
    setInvite(null)
    setInviteGone(false)
    setInviteRefresh(value => value + 1)
  }

  const address = interfaces.some(item => item.address === selectedAddress) ? selectedAddress : null
  const listenHost = network?.host
  const lanListening = Boolean(address && listenHost &&
    ['0.0.0.0', '::', '::ffff:0.0.0.0', address, `::ffff:${address}`].includes(listenHost))
  const lanBase = address && listenPort && lanListening ? `http://${address}:${listenPort}` : null
  // 端口和网卡都有、只是监听地址不对时，才是「去改监听」能解决的问题。
  const lanNotListening = Boolean(listenPort && address && !lanListening)
  const lanLocalOnly = lanNotListening && Boolean(listenHost && isLoopbackHost(listenHost))
  // 局域网通道用不了的原因，按先后顺序只给最根本的那一个。
  const lanReason = !listenPort ? t('settings:service.remotePortUnavailable')
    : !address ? t('settings:service.remoteNoNetwork')
    : t(listenHost ? 'settings:service.remoteLanNotListening' : 'settings:service.remoteHostUnavailable', { host: listenHost })
  const tailscaleRunning = !tailscaleStatusError && tailscale?.backendState === 'Running'
  const tailscaleBase = tailscaleRunning ? tailscale?.url ?? null : null
  const relayBase = tunnel?.state === 'connected' ? tunnel.publicUrl?.replace(/\/+$/, '') ?? null : null
  const base = tab === 'relay' ? relayBase : tab === 'tailscale' ? tailscaleBase : tab === 'lan' ? lanBase : null

  const pairUrl = invite && !expired && !invite.redeemed && base ? `${base}/?pair=${encodeURIComponent(invite.pair)}` : null

  const copyInvite = async () => {
    if (!pairUrl) return
    try {
      await navigator.clipboard.writeText(pairUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时用户可以手动选中
    }
  }

  const switchTab = (next: RemoteTab) => {
    setTab(next)
    serverStorage.set(REMOTE_TAB_KEY, next)
  }

  const runTailscaleAction = (action: () => Promise<void>) => {
    setTailscaleBusy(true)
    setTailscaleError('')
    void action()
      .catch(error => { if (mounted.current) setTailscaleError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (mounted.current) setTailscaleBusy(false) })
  }

  const tailscaleControls = (inline: boolean) => tailscale && (
    <TailscaleControls state={tailscale.backendState}
      authUrl={tailscaleFlow.authUrl}
      ips={tailscale.ips}
      enabled={tailscale.enabled} available={tailscale.mode === 'embedded' && tailscale.installed}
      busy={tailscaleBusy} error={tailscaleError || tailscaleStatusError || tailscaleFlow.error || tailscale.lastError}
      authPhase={tailscaleFlow.phase} authLinkMode={!isTauri()} showAuthQr={false} inline={inline}
      onAuthLinkClick={() => { setTailscaleError(''); tailscaleFlow.clearError() }}
      onOpenAuthUrl={url => { setTailscaleError(''); void tailscaleFlow.reopenAuthPage(url) }}
      onLogin={() => { setTailscaleError(''); void tailscaleFlow.beginLogin() }}
      onDisconnect={() => {
        const signal = tailscaleFlow.reset()
        runTailscaleAction(async () => {
          await disconnectTailscale()
          if (!signal.aborted) await tailscaleFlow.refreshStatus(true)
        })
      }} />
  )

  const loading = (
    <p role="status" className="cb-hint flex items-center gap-2">
      <SpinnerIcon size={13} className="animate-spin" />{t('settings:service.backendStatusLoading')}
    </p>
  )
  const serviceAction = desktop && onOpenService
    ? <button type="button" className="cb-btn" onClick={onOpenService}>{t('settings:host.openService')}</button>
    : undefined

  /** 这条通道已经可达：给出二维码、配对码和地址。配对码用掉或失效时换成对应的下一步。 */
  const ticket = (reachable: string) => {
    if (invite?.redeemed) {
      return (
        <NextAction tone="ok" icon={<CircleCheck size={18} />} title={t('settings:service.remoteApproved')}
          actions={<button type="button" className="cb-btn" onClick={reMint}><RetryIcon size={14} />{t('settings:host.mintAnother')}</button>}>
          {t('settings:host.redeemedBody')}
        </NextAction>
      )
    }
    if (!invite && !inviteGone) return loading
    if (!invite || expired || !pairUrl) {
      return (
        <NextAction tone="warn" icon={<TriangleAlert size={18} />}
          title={t(invite && expired ? 'settings:host.inviteExpired' : 'settings:service.remoteQrUnavailable')}
          actions={<button type="button" className="cb-btn" onClick={reMint}><RetryIcon size={14} />{t('settings:service.remoteRefresh')}</button>}>
          {t(invite && expired ? 'settings:host.inviteExpiredBody' : 'settings:service.remotePairUnavailable')}
        </NextAction>
      )
    }
    return (
      <div data-testid="pair-ticket">
        <div className="cb-ticket">
          <div className="cb-qr"><QrCode text={pairUrl} size={172} /></div>
          <div className="min-w-0">
            <div className="cb-ticket-top">
              <span className="cb-label">{t('settings:host.pairCode')}</span>
              <span className="cb-expiry">
                <Clock size={13} />{t('settings:service.remoteExpiresLater', { time: formatCountdown(invite.expiresAt, now) })}
                <button type="button" className="cb-link" onClick={reMint}><RetryIcon size={12} />{t('settings:service.remoteRefresh')}</button>
              </span>
            </div>
            <div className="cb-code" data-testid="pair-code">
              <span>{invite.code.slice(0, 4)}</span><span>{invite.code.slice(4)}</span>
            </div>
            <span className="cb-label">{t('settings:host.pairAddress')}</span>
            <code className="cb-addr" data-testid="pair-address">{reachable}</code>
            <button type="button" className="cb-btn" onClick={() => void copyInvite()}>
              {copied ? <CheckIcon size={14} className="text-success-100" /> : <CopyIcon size={14} />}
              {copied ? t('settings:service.remoteCopied') : t('settings:service.remoteCopyInvite')}
            </button>
          </div>
        </div>
        <p className="cb-waiting"><span aria-hidden className="cb-waiting-dot" /><span>{t('settings:host.waiting')}</span></p>
      </div>
    )
  }

  const lanTile: Pick<ChannelTile<RemoteTab>, 'tone' | 'state'> = networkLoading
    ? { tone: 'busy', state: t('settings:host.loading') }
    : lanBase && address
      ? { tone: 'on', state: address }
      : { tone: 'warn', state: t(lanLocalOnly ? 'settings:host.lanLocalOnly' : 'settings:host.unavailable') }
  const tailscaleWaiting = tailscaleFlow.phase !== 'idle' && tailscaleFlow.phase !== 'error'
  const tailscaleTile: Pick<ChannelTile<RemoteTab>, 'tone' | 'state'> = tailscaleRunning
    ? { tone: 'on', state: tailscale?.ips[0] ?? t('settings:host.connected') }
    : tailscale?.backendState === 'NeedsMachineAuth'
      ? { tone: 'warn', state: t('settings:host.tsApproval') }
      : tailscaleWaiting
        ? { tone: 'busy', state: t('settings:host.tsAuthorizing') }
        : !tailscale
          ? (tailscaleStatusError ? { tone: 'off', state: t('settings:host.unavailable') } : { tone: 'busy', state: t('settings:host.loading') })
          : { tone: 'off', state: t('settings:host.tsSignedOut') }
  const relayTile: Pick<ChannelTile<RemoteTab>, 'tone' | 'state'> = tunnel === undefined
    ? { tone: 'busy', state: t('settings:host.loading') }
    : !tunnel
      ? { tone: 'off', state: t('settings:host.unavailable') }
      : !tunnel.enabled
        ? { tone: 'off', state: t('settings:host.relayOff') }
        : tunnel.state === 'connected'
          ? { tone: 'on', state: t('settings:host.connected') }
          : { tone: 'warn', state: t('settings:host.relayOffline') }
  const dshTone: LampTone = dshHost.tone
  const dshState = dshHost.state === 'loading' ? t('settings:host.loading')
    : dshHost.state === 'unavailable' ? t('settings:dshRemote.hostUnavailableShort')
    : t(`settings:dshRemote.hostState.${dshHost.state}`)
  const tiles: ChannelTile<RemoteTab>[] = [
    { id: 'lan', icon: <Wifi size={16} />, name: t('settings:service.remoteTabLan'), ...lanTile },
    { id: 'tailscale', icon: <Globe size={16} />, name: t('settings:service.remoteTabTailscale'), ...tailscaleTile },
    { id: 'relay', icon: <Server size={16} />, name: t('settings:service.remoteTabRelay'), ...relayTile },
    ...(desktop ? [{ id: 'dsh' as const, icon: <DeepSeekIcon size={16} />, name: t('settings:dshRemote.tab'), tone: dshTone, state: dshState }] : []),
  ]

  let panel: React.ReactNode
  if (tab === 'lan') {
    panel = <>
      {networkLoading ? loading : lanBase ? ticket(lanBase) : (
        <NextAction tone="warn" icon={<TriangleAlert size={18} />} actions={lanNotListening ? serviceAction : undefined}
          title={t(lanLocalOnly ? 'settings:host.lanLocalOnlyTitle' : 'settings:service.remoteQrUnavailable')}>
          {lanReason}
        </NextAction>
      )}
      <PanelSplit>
        <PanelRow title={t('settings:service.remoteNic')} hint={t('settings:service.remoteNicDesc')}>
          <select
            value={selectedAddress}
            aria-label={t('settings:service.remoteNic')}
            disabled={networkLoading || interfaces.length === 0}
            className="cb-input"
            onChange={event => setSelectedAddress(event.target.value)}
          >
            {interfaces.length === 0 && <option value="">{t('settings:service.remoteNoNetwork')}</option>}
            {interfaces.map(item => (
              <option key={item.address} value={item.address}>
                {item.name} · {item.address}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="cb-btn"
            data-size="icon"
            title={t('common:refresh')}
            aria-label={t('common:refresh')}
            disabled={networkLoading}
            onClick={() => {
              setNetwork(null)
              setNetworkLoading(true)
              setNetworkRefresh(value => value + 1)
            }}
          >
            <RetryIcon size={14} className={networkLoading ? 'animate-spin' : undefined} />
          </button>
        </PanelRow>
        <PanelRow title={t('settings:service.remotePort')} hint={t('settings:service.remoteServerPortDesc')}>
          <code aria-label={t('settings:service.remotePort')} className="cb-value">{listenPort ?? '—'}</code>
        </PanelRow>
      </PanelSplit>
    </>
  } else if (tab === 'tailscale') {
    const approval = tailscale?.backendState === 'NeedsMachineAuth'
    panel = !tailscale ? (
      tailscaleStatusError
        ? <p role="status" className="cb-hint">{t('settings:service.backendStatusUnavailable')}</p>
        : loading
    ) : tailscaleBase ? <>
      {ticket(tailscaleBase)}
      <PanelSplit>
        <PanelRow title={t('settings:service.remoteTabTailscale')} hint={t('settings:host.tsPeerHint')}>
          {tailscaleControls(true)}
        </PanelRow>
      </PanelSplit>
    </> : (
      <NextAction tone={approval ? 'warn' : 'idle'} icon={<Globe size={18} />}
        title={t(approval ? 'settings:service.remoteTailscaleApproval' : 'settings:host.tsJoinTitle')}>
        <p>{t(approval ? 'settings:service.remotePairApprovalRequired' : 'settings:host.tsJoinBody')}</p>
        <div className="mt-3.5">{tailscaleControls(false)}</div>
      </NextAction>
    )
  } else if (tab === 'relay') {
    panel = tunnel === undefined ? loading
      : !tunnel ? <p role="status" className="cb-hint">{t('settings:service.backendStatusUnavailable')}</p>
      : !tunnel.enabled ? (
        <NextAction icon={<Server size={18} />} title={t('settings:host.relayOffTitle')} actions={serviceAction}>
          {t(desktop ? 'settings:service.remoteRelayNotConfigured' : 'settings:service.remoteRelayManageHint')}
        </NextAction>
      ) : relayBase ? <>
        {ticket(relayBase)}
        <PanelSplit>
          <PanelRow title={t('settings:host.relayEntry')} hint={t('settings:service.remoteRelayConnected')}>
            <AuthStatusPill tone="success">{t('settings:host.connected')}</AuthStatusPill>
          </PanelRow>
        </PanelSplit>
      </> : (
        <NextAction tone="warn" icon={<Server size={18} />} title={t('settings:host.relayOfflineTitle')}>
          {t('settings:service.remoteRelayOffline')}
        </NextAction>
      )
  } else {
    panel = <DshHostPanel host={dshHost} />
  }

  const subject = activeServer && (
    <>
      <Monitor size={14} />
      <span>{t('settings:host.configuring')}</span>
      <strong>{activeServer.name}</strong>
      <code>{activeServer.url.replace(/^https?:\/\//, '')}</code>
    </>
  )

  return (
    <div className="cb-page">
      <PageHead title={t('settings:host.title')} description={t('settings:host.description')} subject={subject} />
      <ChannelBoard testId="host-channels" tiles={tiles} selected={tab} onSelect={switchTab}>
        {panel}
      </ChannelBoard>
      {!desktop && <p className="cb-footnote">{t('settings:host.dshDesktopOnly')}</p>}
    </div>
  )
}
