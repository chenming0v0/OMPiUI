import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, Clock, Globe, Network, QrCode as QrCodeIcon, Server, Smartphone, Wifi } from 'lucide-react'
import type { HostNetworkInfo, PairInviteInfo, TunnelStatus } from '@ompiui/protocol'
import { CheckIcon, CopyIcon, RetryIcon, SpinnerIcon } from '../../../components/Icons'
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
import { settingsFieldClass, SettingsSection } from './SettingsUI'
import { TailscaleControls } from './TailscaleControls'
import { AuthCard, AuthStatusPill, authSecondaryButtonClass } from './AuthPanelUI'
import { openTailscaleLogin } from '../../../utils/tailscaleLogin'
import { isTauri, isTauriMobile } from '../../../utils/tauri'

const REMOTE_TAB_KEY = 'ompiui-remote-tab'
const PAIR_POLL_MS = 3_000
const TUNNEL_POLL_MS = 5_000

type RemoteTab = 'lan' | 'tailscale' | 'relay'

function formatCountdown(expiresAt: number, now: number): string {
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000))
  const minutes = String(Math.floor(remaining / 60)).padStart(2, '0')
  const seconds = String(remaining % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function groupedCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code
}

export function RemoteAccessSettings() {
  const { activeServerGeneration } = useServerStore()
  // Addresses, invites and pending actions belong to one server generation.
  // Remount before rendering a new server, not after its first async response.
  return <RemoteAccessPanel key={activeServerGeneration} />
}

function RemoteAccessPanel() {
  const { t } = useTranslation(['settings', 'common'])
  const desktop = isTauri() && !isTauriMobile()
  const [tab, setTab] = useState<RemoteTab>(() => {
    const stored = serverStorage.get(REMOTE_TAB_KEY)
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
  const lanUnavailable = !networkLoading && listenPort && address && !lanListening
    ? t(listenHost ? 'settings:service.remoteLanNotListening' : 'settings:service.remoteHostUnavailable', { host: listenHost })
    : null
  const base = tab === 'relay'
    ? (tunnel?.state === 'connected' ? tunnel.publicUrl?.replace(/\/+$/, '') : null)
    : tab === 'tailscale' ? (!tailscaleStatusError && tailscale?.backendState === 'Running' ? tailscale.url : null)
    : lanBase

  const pairUrl = invite && !expired && !invite.redeemed && base ? `${base}/?pair=${encodeURIComponent(invite.pair)}` : null
  const pairPending = (!invite && !inviteGone) || (tab === 'lan' ? networkLoading : tunnel === undefined)

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

  const tailscalePanel = tailscale && (
    <div className="grid min-w-0 gap-3">
      <div>
        <h4 className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('settings:service.remoteServerLoginTitle')}</h4>
        <p className="mt-0.5 text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('settings:service.remoteServerLoginDesc')}</p>
      </div>
      <TailscaleControls state={tailscale.backendState}
        authUrl={tailscaleFlow.authUrl}
        ips={tailscale.ips}
        enabled={tailscale.enabled} available={tailscale.mode === 'embedded' && tailscale.installed}
        busy={tailscaleBusy} error={tailscaleError || tailscaleStatusError || tailscaleFlow.error || tailscale.lastError}
        authPhase={tailscaleFlow.phase} authLinkMode={!isTauri()} showAuthQr={false}
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
    </div>
  )

  const tabs: Array<[RemoteTab, string, React.ReactNode]> = [
    ['lan', t('settings:service.remoteTabLan'), <Wifi size={14} />],
    ['tailscale', t('settings:service.remoteTabTailscale'), <Globe size={14} />],
    ['relay', t('settings:service.remoteTabRelay'), <Server size={14} />],
  ]
  const steps = [t('settings:service.remoteStep1'), t('settings:service.remoteStep2'), t('settings:service.remoteStep3')]

  return (
    <SettingsSection title={t('settings:authentication.title')} description={t('settings:service.remoteBackendDesc')}>
      <div className="grid min-w-0 gap-3">
        <AuthCard testId="remote-network-setup" icon={<Network size={18} />}
          title={t('settings:service.remoteConnectionTitle')} description={t('settings:service.remoteConnectionDesc')}>
          <div className="min-w-0">
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-bg-200/60 p-1">
              {tabs.map(([value, label, icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => switchTab(value)}
                  aria-pressed={tab === value}
                  className={`inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent-main-100 sm:min-h-8 ${
                    tab === value ? 'bg-bg-100 text-text-100 shadow-sm ring-1 ring-border-200/60' : 'text-text-400 hover:bg-bg-100/50 hover:text-text-200'
                  }`}
                >
                  <span className={`shrink-0 ${tab === value ? 'text-accent-main-100' : ''}`}>{icon}</span>
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>

            {tab === 'lan' && (
              <div className="mt-4 grid divide-y divide-border-200/60">
                <div className="grid gap-2 pb-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
                  <div className="min-w-0">
                    <div className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('settings:service.remoteNic')}</div>
                    <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('settings:service.remoteNicDesc')}</div>
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <select
                      value={selectedAddress}
                      aria-label={t('settings:service.remoteNic')}
                      disabled={networkLoading || interfaces.length === 0}
                      className={`${settingsFieldClass} sm:w-60`}
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
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-200 text-text-400 transition-colors hover:bg-bg-200 hover:text-text-200 disabled:opacity-50"
                      title={t('common:refresh')}
                      aria-label={t('common:refresh')}
                      disabled={networkLoading}
                      onClick={() => {
                        setNetwork(null)
                        setNetworkLoading(true)
                        setNetworkRefresh(value => value + 1)
                      }}
                    >
                      <RetryIcon size={13} className={networkLoading ? 'animate-spin' : undefined} />
                    </button>
                  </div>
                </div>
                <div className="grid gap-2 pt-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
                  <div className="min-w-0">
                    <div className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('settings:service.remotePort')}</div>
                    <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('settings:service.remoteServerPortDesc')}</div>
                  </div>
                  <div aria-label={t('settings:service.remotePort')}
                    className="w-fit rounded-md border border-border-200/60 bg-bg-200/60 px-2.5 py-1 font-mono text-[length:var(--fs-sm)] text-text-200">
                    {listenPort ?? '—'}
                  </div>
                  {!networkLoading && !listenPort && (
                    <p role="status" className="text-[length:var(--fs-xs)] leading-relaxed text-text-400 sm:col-span-2">
                      {t('settings:service.remotePortUnavailable')}
                    </p>
                  )}
                </div>
                {lanUnavailable && (
                  <div className="pt-3">
                    <p role="status" className="break-words rounded-lg border border-warning-100/25 bg-warning-100/10 px-3 py-2 text-[length:var(--fs-xs)] leading-relaxed text-warning-100">
                      {lanUnavailable}
                    </p>
                  </div>
                )}
              </div>
            )}

            {tab === 'relay' && (
              <div className="mt-4 text-[length:var(--fs-xs)] leading-relaxed">
                {!tunnel ? (
                  <AuthStatusPill tone="idle">{tunnel === undefined
                    ? t('settings:service.backendStatusLoading')
                    : t('settings:service.backendStatusUnavailable')}</AuthStatusPill>
                ) : !tunnel.enabled ? (
                  <p className="rounded-lg bg-bg-200/50 px-3 py-2.5 text-text-400">{t(desktop ? 'settings:service.remoteRelayNotConfigured' : 'settings:service.remoteRelayManageHint')}</p>
                ) : tunnel.state === 'connected' ? (
                  <div className="grid gap-2">
                    <AuthStatusPill tone="success">{t('settings:service.remoteRelayConnected')}</AuthStatusPill>
                    <span className="break-all font-mono text-text-400">{tunnel.publicUrl}</span>
                  </div>
                ) : (
                  <AuthStatusPill tone="warning">{t('settings:service.remoteRelayOffline')}</AuthStatusPill>
                )}
              </div>
            )}
            {tab === 'tailscale' && (
              <div className="mt-4">
                {tailscalePanel ?? <p role="status" className="text-[length:var(--fs-xs)] text-text-400">
                  {t('settings:service.backendStatusUnavailable')}
                </p>}
              </div>
            )}
          </div>
        </AuthCard>

        <AuthCard testId="remote-device-pairing" icon={<Smartphone size={18} />}
          title={t('settings:service.remoteConnectPhoneTitle')} description={t('settings:service.remoteConnectPhoneDesc')}>
          {invite?.redeemed && (
            <div className="flex items-center gap-2 rounded-lg border border-success-100/25 bg-success-100/10 px-3 py-2.5 text-[length:var(--fs-sm)] text-success-100">
              <CircleCheck size={16} className="shrink-0" />{t('settings:service.remoteApproved')}
            </div>
          )}
          {!pairUrl && !invite?.redeemed && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-200 bg-bg-200/30 px-4 py-6 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-200 text-text-400">
                {pairPending && !(tab === 'lan' && lanUnavailable) && !(tab === 'tailscale' && !base)
                  ? <SpinnerIcon size={18} className="animate-spin" />
                  : <QrCodeIcon size={18} />}
              </div>
              <div role="status" className="max-w-sm text-[length:var(--fs-xs)] leading-relaxed text-text-400">
                {tab === 'lan' && lanUnavailable
                  ? t('settings:service.remoteQrUnavailable')
                  : tab === 'tailscale' && !base
                  ? t(tailscale?.backendState === 'NeedsMachineAuth' ? 'settings:service.remotePairApprovalRequired' : 'settings:service.remotePairServerLoginRequired')
                  : pairPending
                  ? t('settings:service.backendStatusLoading')
                  : t('settings:service.remoteQrUnavailable')}
              </div>
              {invite && expired && !invite.redeemed && (
                <div className="text-[length:var(--fs-xs)] text-warning-100">
                  {t('settings:service.remoteExpired')}
                  <button type="button" className="ml-1 font-medium text-accent-main-100 hover:underline" onClick={reMint}>
                    {t('settings:service.remoteRefresh')}
                  </button>
                </div>
              )}
              {inviteGone && (
                <button type="button" className={`${authSecondaryButtonClass} min-h-9 text-[length:var(--fs-xs)]`} onClick={reMint}>
                  <RetryIcon size={12} />{t('settings:service.remoteRefresh')}
                </button>
              )}
            </div>
          )}

          {pairUrl && invite && (
            <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-stretch">
              <div className="shrink-0 rounded-xl bg-white p-2 shadow-sm ring-1 ring-black/5">
                <QrCode text={pairUrl} size={176} />
              </div>
              <div className="flex w-full min-w-0 flex-1 flex-col justify-between gap-4">
                <div className="grid gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <AuthStatusPill tone="progress" icon={<Clock size={12} className="shrink-0" />}>
                      {t('settings:service.remoteExpiresLater', { time: formatCountdown(invite.expiresAt, now) })}
                    </AuthStatusPill>
                    <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[length:var(--fs-xs)] font-medium text-accent-main-100 hover:bg-accent-main-100/10" onClick={reMint}>
                      <RetryIcon size={12} />{t('settings:service.remoteRefresh')}
                    </button>
                  </div>
                  <div className="rounded-lg border border-border-200/60 bg-bg-200/40 px-3 py-2.5 font-mono text-[length:var(--fs-sm)] tracking-wide text-text-200">
                    {t('settings:service.remoteManualCode', { code: groupedCode(invite.code) })}
                  </div>
                </div>
                <button
                  type="button"
                  className={`${authSecondaryButtonClass} min-h-10 w-full text-[length:var(--fs-xs)] sm:w-fit`}
                  onClick={() => void copyInvite()}
                >
                  {copied ? <CheckIcon size={12} className="text-success-100" /> : <CopyIcon size={12} />}
                  {copied ? t('settings:service.remoteCopied') : t('settings:service.remoteCopyInvite')}
                </button>
              </div>
            </div>
          )}

          {pairUrl && <ol className="grid gap-2 sm:grid-cols-3">
            {steps.map((step, index) => (
              <li key={index} className="flex gap-2.5 rounded-lg bg-bg-200/40 p-3 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-main-100/15 text-[11px] font-semibold text-accent-main-100">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>}

          {pairUrl && <div className="flex min-w-0 items-start gap-2 text-[length:var(--fs-xs)] text-text-500">
            <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent-main-100" />
            <span className="min-w-0 break-all">{t('settings:service.remoteWaiting', { url: pairUrl })}</span>
          </div>}
        </AuthCard>
      </div>
    </SettingsSection>
  )
}
