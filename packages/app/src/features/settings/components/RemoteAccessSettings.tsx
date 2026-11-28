import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CircleCheck, Clock, Copy, Globe, Loader2, RefreshCw, Server, TriangleAlert, Wifi } from 'lucide-react'
import type { HostNetworkInfo, PairInviteInfo, TunnelStatus } from '@ompiui/protocol'
import { DeepSeekIcon } from '../../../components/Icons'
import { QrCode } from '../../../components/QrCode'
import {
  fetchHostNetwork,
  fetchPairInvite,
  fetchHostTunnel,
  mintPairInvite,
} from '../../../omp/transport/index.js'
import { serverStorage } from '../../../utils'
import { useServerStore } from '../../../hooks'
import { ChannelBoard, Card, NextAction, PageHead, PanelRow, PanelSplit, type ChannelTile, type LampTone } from './ChannelBoard'
import { DshHostPanel } from './DshHostPanel'
import { RelaySettings } from './RelaySettings'
import { useBackendTailscale } from './useBackendTailscale'
import { useDshHost } from './useDshHost'
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
  const [editingRelay, setEditingRelay] = useState(false)
  const [copied, setCopied] = useState<'invite' | 'address' | null>(null)
  const tailscale = useBackendTailscale()
  const dshHost = useDshHost(desktop)

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
  const tailscaleBase = tailscale.running ? tailscale.tailscale?.url ?? null : null
  const relayBase = tunnel?.state === 'connected' ? tunnel.publicUrl?.replace(/\/+$/, '') ?? null : null
  const base = tab === 'relay' ? relayBase : tab === 'tailscale' ? tailscaleBase : tab === 'lan' ? lanBase : null

  const pairUrl = invite && !expired && !invite.redeemed && base ? `${base}/?pair=${encodeURIComponent(invite.pair)}` : null

  const copy = async (value: string, what: 'invite' | 'address') => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
      window.setTimeout(() => setCopied(null), 2000)
    } catch {
      // 剪贴板不可用时用户可以手动选中
    }
  }

  const switchTab = (next: RemoteTab) => {
    setTab(next)
    serverStorage.set(REMOTE_TAB_KEY, next)
  }

  const loading = (
    <p role="status" className="cb-hint flex items-center justify-center gap-2">
      <Loader2 size={13} className="animate-spin" />{t('settings:service.backendStatusLoading')}
    </p>
  )
  const unavailable = <p role="status" className="cb-hint text-center">{t('settings:service.backendStatusUnavailable')}</p>
  // 中转和监听存在本机服务的启动环境里，只有连着本机后端的桌面版能改。
  const local = desktop && Boolean(activeServer?.isDefault)
  const serviceAction = desktop && onOpenService
    ? <button type="button" className="cb-btn" onClick={onOpenService}>{t('settings:host.openService')}</button>
    : undefined

  /** 这条通道已经可达：给出二维码、配对码和地址。配对码用掉或失效时换成对应的下一步。 */
  const ticket = (reachable: string) => {
    if (invite?.redeemed) {
      return (
        <NextAction tone="ok" icon={<CircleCheck size={34} />} title={t('settings:service.remoteApproved')}
          actions={<button type="button" className="cb-btn" onClick={reMint}><RefreshCw size={14} />{t('settings:host.mintAnother')}</button>} />
      )
    }
    if (!invite && !inviteGone) return loading
    if (!invite || expired || !pairUrl) {
      return (
        <NextAction tone="warn" icon={<TriangleAlert size={34} />}
          title={t(invite && expired ? 'settings:host.inviteExpired' : 'settings:service.remoteQrUnavailable')}
          actions={<button type="button" className="cb-btn" data-variant="primary" onClick={reMint}><RefreshCw size={14} />{t('settings:service.remoteRefresh')}</button>} />
      )
    }
    return (
      <div className="cb-ticket" data-testid="pair-ticket">
        <div className="cb-qr"><QrCode text={pairUrl} size={172} /></div>
        <div className="cb-code" data-testid="pair-code" aria-label={t('settings:host.pairCode')}>
          <span>{invite.code.slice(0, 4)}</span><span>{invite.code.slice(4)}</span>
        </div>
        <p className="cb-expiry">
          <Clock size={13} /><span>{t('settings:service.remoteExpiresLater', { time: formatCountdown(invite.expiresAt, now) })}</span>
          <button type="button" className="cb-link" onClick={reMint}>{t('settings:service.remoteRefresh')}</button>
        </p>
        <div className="cb-copy">
          <code data-testid="pair-address" title={reachable}>{reachable}</code>
          <button type="button" className="cb-icon-btn" onClick={() => void copy(reachable, 'address')}
            title={t('settings:host.copyAddress')} aria-label={t('settings:host.copyAddress')}>
            {copied === 'address' ? <Check size={14} className="text-success-100" /> : <Copy size={14} />}
          </button>
        </div>
        <button type="button" className="cb-btn" onClick={() => void copy(pairUrl, 'invite')}>
          {copied === 'invite' ? <Check size={14} className="text-success-100" /> : <Copy size={14} />}
          {copied === 'invite' ? t('settings:service.remoteCopied') : t('settings:service.remoteCopyInvite')}
        </button>
      </div>
    )
  }

  const lanTile: Pick<ChannelTile<RemoteTab>, 'tone' | 'state'> = networkLoading
    ? { tone: 'busy', state: t('settings:host.loading') }
    : lanBase && address
      ? { tone: 'on', state: address }
      : { tone: 'warn', state: t(lanLocalOnly ? 'settings:host.lanLocalOnly' : 'settings:host.unavailable') }
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
    { id: 'lan', icon: <Wifi size={17} />, name: t('settings:service.remoteTabLan'), ...lanTile },
    { id: 'tailscale', icon: <Globe size={17} />, name: t('settings:service.remoteTabTailscale'), ...tailscale.tile },
    { id: 'relay', icon: <Server size={17} />, name: t('settings:service.remoteTabRelay'), ...relayTile },
    ...(desktop ? [{ id: 'dsh' as const, icon: <DeepSeekIcon size={17} />, name: t('settings:dshRemote.tab'), tone: dshTone, state: dshState }] : []),
  ]

  let panel: React.ReactNode
  if (tab === 'lan') {
    panel = <>
      {networkLoading ? loading : lanBase ? ticket(lanBase) : (
        <NextAction tone="warn" icon={<Wifi size={34} />} actions={lanNotListening ? serviceAction : undefined}
          title={t(lanLocalOnly ? 'settings:host.lanLocalOnlyTitle' : 'settings:service.remoteQrUnavailable')}>
          {lanReason}
        </NextAction>
      )}
      <PanelSplit>
        <PanelRow title={t('settings:service.remoteNic')}>
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
            className="cb-icon-btn"
            title={t('common:refresh')}
            aria-label={t('common:refresh')}
            disabled={networkLoading}
            onClick={() => {
              setNetwork(null)
              setNetworkLoading(true)
              setNetworkRefresh(value => value + 1)
            }}
          >
            <RefreshCw size={15} className={networkLoading ? 'animate-spin' : undefined} />
          </button>
        </PanelRow>
      </PanelSplit>
    </>
  } else if (tab === 'tailscale') {
    panel = !tailscale.tailscale ? (tailscale.statusError ? unavailable : loading)
      : tailscaleBase ? <>
        {ticket(tailscaleBase)}
        <PanelSplit>
          <PanelRow title="Tailscale">{tailscale.controls({ inline: true, hideStatus: true })}</PanelRow>
        </PanelSplit>
      </> : (
        <NextAction tone={tailscale.approval ? 'warn' : tailscale.waiting || tailscale.restoring ? 'busy' : 'idle'}
          icon={tailscale.waiting || tailscale.restoring ? <Loader2 size={34} className="animate-spin" /> : <Globe size={34} />}
          title={tailscale.tile.state}
          actions={<div className="cb-stack">{tailscale.controls({ layout: 'phone', hideStatus: !tailscale.waiting && !tailscale.approval })}</div>} />
      )
  } else if (tab === 'relay') {
    panel = tunnel === undefined ? loading
      : !tunnel ? unavailable
      : local && (editingRelay || !tunnel.enabled) ? (
        <RelaySettings onCancel={tunnel.enabled ? () => setEditingRelay(false) : undefined} />
      ) : !tunnel.enabled ? (
        <NextAction icon={<Server size={34} />} title={t('settings:host.relayOffTitle')}>
          {t('settings:service.remoteRelayManageHint')}
        </NextAction>
      ) : <>
        {relayBase ? ticket(relayBase) : (
          <NextAction tone="warn" icon={<Server size={34} />} title={t('settings:host.relayOfflineTitle')}>
            {tunnel.lastError}
          </NextAction>
        )}
        <PanelSplit>
          <PanelRow title={t('settings:service.tunnelUrl')}>
            <code title={tunnel.relayUrl ?? undefined}>{tunnel.relayUrl}</code>
            {local && <button type="button" className="cb-btn" onClick={() => setEditingRelay(true)}>{t('common:edit')}</button>}
          </PanelRow>
        </PanelSplit>
      </>
  } else {
    panel = <DshHostPanel host={dshHost} />
  }

  // 被控端配置的是「当前连着的那台后端」。连的是本机时不用说；切到别的服务器才提示，避免改错机器。
  const subject = activeServer && !activeServer.isDefault && (
    <>
      <TriangleAlert size={13} />
      <span>{t('settings:host.configuring')}</span>
      <strong title={activeServer.name}>{activeServer.name}</strong>
    </>
  )

  return (
    <div className="cb-page">
      <Card>
        <PageHead title={t('settings:host.title')} subject={subject} />
        <ChannelBoard testId="host-channels" tiles={tiles} selected={tab} onSelect={switchTab}>
          {panel}
        </ChannelBoard>
      </Card>
    </div>
  )
}
