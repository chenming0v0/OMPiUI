import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const [copied, setCopied] = useState(false)
  const tailscaleFlow = useTailscaleLoginFlow({
    // 与手机端一致：拿到授权链接前持续显示进行中状态，而不是转一下就还原。
    start: async () => {
      const result = await startTailscaleLogin()
      const next = await fetchTailscale()
      setTailscale(next)
      return { backendState: next.backendState, authUrl: result.authUrl ?? next.authUrl ?? null }
    },
    poll: async () => {
      const next = await fetchTailscale()
      setTailscale(next)
      return { backendState: next.backendState, authUrl: next.authUrl ?? null }
    },
    open: openTailscaleLogin,
    timeoutMessage: t('settings:service.remoteTailscaleAuthUrlTimeout'),
  })
  // 登录完成（或进入设备批准阶段）后把授权流程状态清回 idle。
  const { reset: resetAuthFlow } = tailscaleFlow
  useEffect(() => {
    if (tailscale?.backendState === 'Running' || tailscale?.backendState === 'NeedsMachineAuth') resetAuthFlow()
  }, [tailscale?.backendState, resetAuthFlow])

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

  // 自建中转 + 内置 Tailscale 状态轮询
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
      void fetchTailscale()
        .then(next => {
          if (!cancelled) setTailscale(next)
        })
        .catch(() => {
          if (!cancelled) setTailscale(null)
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
    : tab === 'tailscale' ? (tailscale?.backendState === 'Running' ? tailscale.url : null)
    : lanBase

  const pairUrl = invite && !expired && !invite.redeemed && base ? `${base}/?pair=${encodeURIComponent(invite.pair)}` : null
  const pairPending = (!invite && !inviteGone) || (tab === 'lan' ? networkLoading : tunnel === undefined)
  const tailscaleNeedsLogin = tab === 'tailscale' && tailscale !== null
    && tailscale.backendState !== 'Running' && tailscale.backendState !== 'NeedsMachineAuth'
    && (tailscale.backendState === 'NeedsLogin' || Boolean(tailscale.authUrl))

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
      .catch(error => setTailscaleError(error instanceof Error ? error.message : String(error)))
      .finally(() => setTailscaleBusy(false))
  }

  const tailscalePanel = tailscale && (
    <div className="mt-1 grid gap-1.5">
      <div className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('settings:service.remoteTailscaleTitle')}</div>
      <TailscaleControls state={tailscale.backendState}
        authUrl={tailscale.backendState === 'Running' ? null : tailscaleFlow.authUrl ?? tailscale.authUrl ?? null}
        ips={tailscale.ips}
        enabled={tailscale.enabled} available={tailscale.mode === 'embedded' && tailscale.installed}
        busy={tailscaleBusy} error={tailscaleError || tailscaleFlow.error || tailscale.lastError}
        authPhase={tailscaleFlow.phase} onOpenAuthUrl={url => { void tailscaleFlow.reopenAuthPage(url) }}
        onLogin={() => { void tailscaleFlow.beginLogin() }}
        onDisconnect={() => runTailscaleAction(async () => {
          await disconnectTailscale()
          tailscaleFlow.reset()
          setTailscale(await fetchTailscale())
        })} />
    </div>
  )

  return (
    <SettingsSection title={t('settings:authentication.title')} description={t('settings:service.remoteBackendDesc')}>
      <div className="rounded-lg border border-border-200/60 bg-bg-100 p-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[length:var(--fs-md)] font-medium text-text-100">{t('settings:service.remotePairTitle')}</div>
            <div className="mt-0.5 text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('settings:service.remotePairDesc')}</div>

            <div className="mt-2.5 flex items-center gap-1">
              {(
                [
                  ['lan', t('settings:service.remoteTabLan')],
                  ['tailscale', t('settings:service.remoteTabTailscale')],
                  ['relay', t('settings:service.remoteTabRelay')],
                ] as Array<[RemoteTab, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => switchTab(value)}
                  aria-pressed={tab === value}
                  className={`h-7 rounded-md px-2.5 text-[length:var(--fs-xs)] font-medium transition-colors ${
                    tab === value ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200/50 hover:text-text-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'lan' && (
              <div className="mt-3 grid gap-2.5">
                <div>
                  <div className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('settings:service.remoteNic')}</div>
                  <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('settings:service.remoteNicDesc')}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={selectedAddress}
                    aria-label={t('settings:service.remoteNic')}
                    disabled={networkLoading || interfaces.length === 0}
                    className={`${settingsFieldClass} max-w-64`}
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
                    className="flex h-7 w-7 items-center justify-center rounded-md text-text-400 hover:bg-bg-200/70 hover:text-text-200"
                    title={t('common:refresh')}
                    aria-label={t('common:refresh')}
                    disabled={networkLoading}
                    onClick={() => {
                      setNetwork(null)
                      setNetworkLoading(true)
                      setNetworkRefresh(value => value + 1)
                    }}
                  >
                    <RetryIcon size={13} />
                  </button>
                </div>
                <div>
                  <div className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('settings:service.remotePort')}</div>
                  <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('settings:service.remoteServerPortDesc')}</div>
                  <div aria-label={t('settings:service.remotePort')} className="mt-1 font-mono text-[length:var(--fs-sm)] text-text-200">
                    {listenPort ?? '—'}
                  </div>
                  {!networkLoading && !listenPort && (
                    <p role="status" className="mt-1 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
                      {t('settings:service.remotePortUnavailable')}
                    </p>
                  )}
                </div>
                {lanUnavailable && (
                  <p role="status" className="break-words text-[length:var(--fs-xs)] leading-relaxed text-warning-100/80">
                    {lanUnavailable}
                  </p>
                )}
              </div>
            )}

            {tab === 'relay' && (
              <div className="mt-3 text-[length:var(--fs-xs)] leading-relaxed">
                {!tunnel ? (
                  <span className="text-text-400">{tunnel === undefined
                    ? t('settings:service.backendStatusLoading')
                    : t('settings:service.backendStatusUnavailable')}</span>
                ) : !tunnel.enabled ? (
                  <span className="text-text-400">{t(desktop ? 'settings:service.remoteRelayNotConfigured' : 'settings:service.remoteRelayManageHint')}</span>
                ) : tunnel.state === 'connected' ? (
                  <span className="break-all text-success-100">
                    {t('settings:service.remoteRelayConnected')}
                    <span className="ml-1 font-mono text-text-500">{tunnel.publicUrl}</span>
                  </span>
                ) : (
                  <span className="text-warning-100/80">{t('settings:service.remoteRelayOffline')}</span>
                )}
              </div>
            )}
            {tab === 'tailscale' && (
              <div className="mt-3">
                {tailscalePanel ?? <p role="status" className="text-[length:var(--fs-xs)] text-text-400">
                  {t('settings:service.backendStatusUnavailable')}
                </p>}
              </div>
            )}
          </div>

          <div className="flex flex-col items-center gap-1.5">
            {pairUrl ? (
              <QrCode text={pairUrl} size={176} />
            ) : (
              <div role="status" className="flex h-[186px] w-[186px] items-center justify-center rounded-lg bg-bg-200/60 p-4 text-center text-[length:var(--fs-xs)] leading-relaxed text-text-400">
                {tab === 'lan' && lanUnavailable
                  ? t('settings:service.remoteQrUnavailable')
                  : tailscaleNeedsLogin
                  ? t('settings:service.remoteTailscalePairLoginRequired')
                  : pairPending
                  ? <span className="flex items-center gap-2"><SpinnerIcon size={16} className="shrink-0 animate-spin" />{t('settings:service.backendStatusLoading')}</span>
                  : t('settings:service.remoteQrUnavailable')}
              </div>
            )}
            {invite && !expired && !invite.redeemed && (
              <div className="text-[length:var(--fs-xs)] text-text-400">
                {t('settings:service.remoteExpiresLater', { time: formatCountdown(invite.expiresAt, now) })}
                <button type="button" className="ml-2 text-accent-main-100 hover:underline" onClick={reMint}>
                  {t('settings:service.remoteRefresh')}
                </button>
              </div>
            )}
            {invite && expired && !invite.redeemed && (
              <div className="text-[length:var(--fs-xs)] text-warning-100/80">
                {t('settings:service.remoteExpired')}
                <button type="button" className="ml-2 text-accent-main-100 hover:underline" onClick={reMint}>
                  {t('settings:service.remoteRefresh')}
                </button>
              </div>
            )}
            {invite?.redeemed && <div className="text-[length:var(--fs-xs)] text-success-100">{t('settings:service.remoteApproved')}</div>}
            {inviteGone && (
              <button type="button" className="text-[length:var(--fs-xs)] text-accent-main-100 hover:underline" onClick={reMint}>
                {t('settings:service.remoteRefresh')}
              </button>
            )}
            {invite && !invite.redeemed && (
              <div className="text-[length:var(--fs-xs)] text-text-500">
                {t('settings:service.remoteManualCode', { code: groupedCode(invite.code) })}
              </div>
            )}
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[length:var(--fs-xs)] text-text-400 transition-colors hover:bg-bg-200/70 hover:text-text-200"
              onClick={() => void copyInvite()}
              disabled={!pairUrl}
            >
              {copied ? <CheckIcon size={12} className="text-success-100" /> : <CopyIcon size={12} />}
              {copied ? t('settings:service.remoteCopied') : t('settings:service.remoteCopyInvite')}
            </button>
          </div>
        </div>

        <ol className="mt-3 grid gap-1.5 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
          <li className="flex gap-2">
            <span className="font-medium text-text-300">1</span>
            <span>{t('settings:service.remoteStep1')}</span>
          </li>
          <li className="flex gap-2">
            <span className="font-medium text-text-300">2</span>
            <span>{t('settings:service.remoteStep2')}</span>
          </li>
          <li className="flex gap-2">
            <span className="font-medium text-text-300">3</span>
            <span>{t('settings:service.remoteStep3')}</span>
          </li>
        </ol>

        <div className="mt-3 break-all border-t border-border-200/50 pt-2 font-mono text-[length:var(--fs-xs)] text-text-500">
          {invite?.redeemed
            ? t('settings:service.remoteApproved')
            : pairUrl
              ? t('settings:service.remoteWaiting', { url: pairUrl })
              : tab === 'lan' && lanUnavailable
                ? lanUnavailable
                : tailscaleNeedsLogin
                ? t('settings:service.remoteTailscalePairLoginRequired')
                : t('settings:service.remotePairUnavailable')}
        </div>
      </div>
    </SettingsSection>
  )
}
