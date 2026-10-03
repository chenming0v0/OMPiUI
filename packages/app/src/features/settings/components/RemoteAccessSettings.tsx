import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanInterfaceInfo, PairInviteInfo, TunnelStatus } from '@ompiui/protocol'
import { CheckIcon, CopyIcon, RetryIcon, SpinnerIcon } from '../../../components/Icons'
import { QrCode } from '../../../components/QrCode'
import {
  fetchHostNetwork,
  fetchPairInvite,
  fetchTailscale,
  fetchHostTunnel,
  mintPairInvite,
  startTailscaleInstall,
  startTailscaleLogin,
} from '../../../omp/transport/index.js'
import { serverStorage } from '../../../utils'
import { useServerStore } from '../../../hooks'
import { serviceStore } from '../../../store/serviceStore'
import { settingsFieldClass, SettingsSection } from './SettingsUI'

const REMOTE_TAB_KEY = 'ompiui-remote-tab'
const PAIR_POLL_MS = 3_000
const TUNNEL_POLL_MS = 5_000

type RemoteTab = 'lan' | 'relay'

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
  const { t } = useTranslation(['settings', 'common'])
  const { activeServerGeneration } = useServerStore()
  const [tab, setTab] = useState<RemoteTab>(() => (serverStorage.get(REMOTE_TAB_KEY) === 'relay' ? 'relay' : 'lan'))
  const [interfaces, setInterfaces] = useState<LanInterfaceInfo[]>([])
  const [selectedAddress, setSelectedAddress] = useState('')
  const [invite, setInvite] = useState<PairInviteInfo | null>(null)
  const [inviteGone, setInviteGone] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null)
  const [tailscale, setTailscale] = useState<import('@ompiui/protocol').TailscaleInfo | null>(null)
  const [tailscaleBusy, setTailscaleBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const listenPort = serviceStore.envVars.find(item => item.key.trim().toUpperCase() === 'OMPIUI_PORT')?.value.trim() || '8787'

  // 网卡列表：拿不到（旧版服务端）就整体隐藏本区
  useEffect(() => {
    let cancelled = false
    void fetchHostNetwork()
      .then(result => {
        if (cancelled) return
        setInterfaces(result.interfaces)
        setSelectedAddress(previous => {
          if (previous && result.interfaces.some(item => item.address === previous)) return previous
          const lan = result.interfaces.find(item => !item.tailscale) ?? result.interfaces[0]
          return lan?.address ?? ''
        })
      })
      .catch(() => {
        if (!cancelled) setInterfaces([])
      })
    return () => {
      cancelled = true
    }
  }, [activeServerGeneration])

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
  }, [activeServerGeneration])

  const inviteId = invite?.id ?? null
  useEffect(() => {
    if (!inviteId) return
    let cancelled = false
    const timer = window.setInterval(() => {
      void fetchPairInvite(inviteId)
        .then(next => {
          if (!cancelled) setInvite(previous => (previous && previous.id === next.id ? next : previous))
        })
        .catch(() => undefined)
    }, PAIR_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [inviteId])

  // 秒级倒计时
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // 自建中转 + 内置 Tailscale 状态轮询
  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetchHostTunnel()
        .then(next => {
          if (!cancelled) setTunnel(next)
        })
        .catch(() => {
          if (!cancelled) {
            setTunnel({
              enabled: false,
              state: 'disabled',
              relayUrl: null,
              tunnelId: null,
              publicUrl: null,
              lastError: null,
              reconnectAttempts: 0,
            })
          }
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
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeServerGeneration])

  const reMint = useCallback(() => {
    void mintPairInvite()
      .then(next => setInvite(next))
      .catch(() => undefined)
  }, [])

  const base = useMemo((): string | null => {
    if (tab === 'relay') {
      const publicUrl = tunnel?.publicUrl?.replace(/\/+$/, '')
      return tunnel?.state === 'connected' && publicUrl ? publicUrl : null
    }
    if (!selectedAddress) return null
    return `http://${selectedAddress}:${listenPort}`
  }, [tab, tunnel?.state, tunnel?.publicUrl, selectedAddress, listenPort])

  const pairUrl = invite && base ? `${base}/?pair=${invite.pair}` : null
  const expired = invite !== null && now >= invite.expiresAt

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
    void action()
      .catch(() => undefined)
      .finally(() => setTailscaleBusy(false))
  }

  if (interfaces.length === 0 && inviteGone) {
    // 服务端没有配对/网卡接口（旧版本）：本区整体不显示
    return null
  }

  const tailscalePanel = tailscale && (
    <div className="mt-1 grid gap-1.5">
      <div className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('settings:service.remoteTailscaleTitle')}</div>
      {!tailscale.supported && (
        <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('settings:service.remoteTailscaleUnsupported')}</div>
      )}
      {tailscale.supported && !tailscale.installed && tailscale.installState === 'idle' && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="h-7 rounded-md px-2 text-[length:var(--fs-xs)] font-medium text-accent-main-100 transition-colors hover:bg-accent-main-100/10"
            onClick={() => runTailscaleAction(startTailscaleInstall)}
          >
            {t('settings:service.remoteTailscaleInstall')}
          </button>
          <span className="text-[length:var(--fs-xxs)] leading-relaxed text-text-500">{t('settings:service.remoteTailscaleInstallHint')}</span>
        </div>
      )}
      {(tailscale.installState === 'downloading' || tailscale.installState === 'installing') && (
        <div className="flex items-center gap-2 text-[length:var(--fs-xs)] text-text-400">
          <SpinnerIcon size={13} className="animate-spin" />
          {t('settings:service.remoteTailscaleInstalling')}
          {tailscale.installProgress !== null && ` ${Math.round(tailscale.installProgress * 100)}%`}
        </div>
      )}
      {tailscale.installState === 'error' && tailscale.installError && (
        <div className="break-all text-[length:var(--fs-xs)] text-danger-100">{tailscale.installError}</div>
      )}
      {tailscale.installed && !tailscale.reachable && (
        <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('settings:service.remoteTailscaleNotRunning')}</div>
      )}
      {tailscale.reachable && tailscale.backendState !== 'Running' && (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-7 rounded-md px-2 text-[length:var(--fs-xs)] font-medium text-accent-main-100 transition-colors hover:bg-accent-main-100/10"
              disabled={tailscaleBusy}
              onClick={() => runTailscaleAction(startTailscaleLogin)}
            >
              {tailscaleBusy ? <SpinnerIcon size={12} className="animate-spin" /> : t('settings:service.remoteTailscaleLogin')}
            </button>
          </div>
          {tailscale.authUrl && (
            <div className="flex items-center gap-3">
              <QrCode text={tailscale.authUrl} size={128} />
              <div className="min-w-0 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
                {t('settings:service.remoteTailscaleLoginHint')}
              </div>
            </div>
          )}
        </div>
      )}
      {tailscale.reachable && tailscale.backendState === 'Running' && (
        <div className="text-[length:var(--fs-xs)] leading-relaxed text-success-100">
          {t('settings:service.remoteTailscaleRunning', { ip: tailscale.ips[0] ?? '' })}
          {tailscale.hostName ? <span className="text-text-500"> · {tailscale.hostName}</span> : null}
        </div>
      )}
      {tailscale.supported && (
        <div className="text-[length:var(--fs-xxs)] leading-relaxed text-text-500">{t('settings:service.remoteTailscalePhoneHint')}</div>
      )}
    </div>
  )

  return (
    <SettingsSection title={t('settings:service.remoteTitle')} description={t('settings:service.remoteDesc')}>
      <div className="rounded-lg border border-border-200/60 bg-bg-100 p-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[length:var(--fs-md)] font-medium text-text-100">{t('settings:service.remotePairTitle')}</div>
            <div className="mt-0.5 text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('settings:service.remotePairDesc')}</div>

            <div className="mt-2.5 flex items-center gap-1">
              {(
                [
                  ['lan', t('settings:service.remoteTabLan')],
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
                    className={`${settingsFieldClass} max-w-64`}
                    onChange={event => setSelectedAddress(event.target.value)}
                  >
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
                    onClick={() => setNow(Date.now())}
                  >
                    <RetryIcon size={13} />
                  </button>
                </div>
                <div>
                  <div className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('settings:service.remotePort')}</div>
                  <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('settings:service.remotePortDesc')}</div>
                  <input
                    type="text"
                    value={listenPort}
                    readOnly
                    aria-label={t('settings:service.remotePort')}
                    className={`${settingsFieldClass} mt-1 w-28 font-mono`}
                  />
                </div>
              </div>
            )}

            {tab === 'relay' && (
              <div className="mt-3 text-[length:var(--fs-xs)] leading-relaxed">
                {!tunnel?.enabled ? (
                  <span className="text-text-400">{t('settings:service.remoteRelayNotConfigured')}</span>
                ) : tunnel.state === 'connected' ? (
                  <span className="text-success-100">
                    {t('settings:service.remoteRelayConnected')}
                    <span className="ml-1 font-mono text-text-500">{tunnel.publicUrl}</span>
                  </span>
                ) : (
                  <span className="text-warning-100/80">{t('settings:service.remoteRelayOffline')}</span>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col items-center gap-1.5">
            {pairUrl ? (
              <QrCode text={pairUrl} size={176} />
            ) : (
              <div className="flex h-[186px] w-[186px] items-center justify-center rounded-lg bg-bg-200/60 text-[length:var(--fs-xs)] text-text-500">
                <SpinnerIcon size={16} className="animate-spin" />
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
          {invite?.redeemed ? t('settings:service.remoteApproved') : t('settings:service.remoteWaiting', { url: pairUrl ?? '…' })}
        </div>
      </div>

      {tab === 'lan' && tailscalePanel}
    </SettingsSection>
  )
}
