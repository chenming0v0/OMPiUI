import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Copy, Globe, RefreshCw, Share2 } from 'lucide-react'
import { Section, State, type LampTone } from './ChannelBoard'
import {
  disconnectAndroidTailscale, getAndroidTailscaleStatus, isAndroidTailscalePlatform,
  loginAndroidTailscale, type AndroidTailscaleStatus,
  copyAndroidTailscaleDiagnostics, exportAndroidTailscaleDiagnostics,
} from '../../../utils/androidTailscale'
import { useTailscaleLoginFlow } from '../../../hooks/useTailscaleLoginFlow'
import { serverStore } from '../../../store/serverStore'
import { AuthAlert } from './AuthPanelUI'
import { DiscoveredRows } from './DiscoveredComputers'
import { useDeviceDiscovery } from './useDeviceDiscovery'
import { TailscaleControls } from './TailscaleControls'
import { openTailscaleLogin } from '../../../utils/tailscaleLogin'
import { TAILSCALE_STATUS_EVENT } from '../../../utils/tailscaleEvents'

/** 控制端 → 虚拟组网：这台手机自己登录 Tailscale，连上后列出同一个网络里的电脑。 */
export function AndroidTailscaleSettings({ defaultOpen, onPaired }: { defaultOpen?: boolean; onPaired?: () => void }) {
  return isAndroidTailscalePlatform() ? <AndroidTailscalePanel defaultOpen={defaultOpen} onPaired={onPaired} /> : null
}

function AndroidTailscalePanel({ defaultOpen, onPaired }: { defaultOpen?: boolean; onPaired?: () => void }) {
  const { t } = useTranslation('settings')
  const [status, setStatus] = useState<AndroidTailscaleStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const acceptStatus = (next: AndroidTailscaleStatus, signal: AbortSignal) => {
    if (!signal.aborted) {
      setStatus(next)
      setStatusError('')
    }
    return { backendState: next.BackendState, authUrl: next.AuthURL ?? null }
  }
  const flow = useTailscaleLoginFlow({
    start: async signal => acceptStatus(await loginAndroidTailscale(), signal),
    poll: async signal => acceptStatus(await getAndroidTailscaleStatus(), signal),
    open: openTailscaleLogin,
    timeoutMessage: t('service.remoteTailscaleAuthUrlTimeout'),
    connectionTimeoutMessage: t('service.remoteTailscaleConnectionTimeout'),
    statusEvent: TAILSCALE_STATUS_EVENT,
    statusPollMs: 3_000,
    paused: busy,
    onPollError: err => setStatusError(err instanceof Error ? err.message : String(err)),
  })

  const backendState = status?.BackendState ?? null
  const running = backendState === 'Running'
  const discovery = useDeviceDiscovery('tailscale', running)

  const run = (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    void action().catch(err => {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    }).finally(() => { if (mounted.current) setBusy(false) })
  }
  const disconnect = () => {
    const signal = flow.reset()
    run(async () => {
      await disconnectAndroidTailscale()
      if (signal.aborted) return
      await flow.refreshStatus(true)
      if (mounted.current) serverStore.checkAllHealth()
    })
  }

  const problem = error || statusError || flow.error ||
    (status?.startupInterrupted ? t('service.remoteTailscaleStartupInterrupted') : status?.lastError) || ''
  const waiting = flow.phase !== 'idle' && flow.phase !== 'error'
  // 上次登录过：打开应用后先自动恢复连接，这段时间只显示「正在恢复」。
  const restoring = !problem && (flow.phase === 'connecting' || Boolean(status?.enabled && (backendState === 'Starting' || backendState === 'NoState')))
  const state: { tone: LampTone; text: string } = !status && !statusError
    ? { tone: 'busy', text: t('host.loading') }
    : running
      ? { tone: 'on', text: t('host.connected') }
      : backendState === 'NeedsMachineAuth'
        ? { tone: 'warn', text: t('host.tsApproval') }
        : restoring
          ? { tone: 'busy', text: t('host.tsRestoring') }
          : waiting
            ? { tone: 'busy', text: t('host.tsAuthorizing') }
            : { tone: 'off', text: t('host.tsSignedOut') }

  const action = running ? <>
    <button type="button" className="cb-icon-btn" disabled={discovery.loading} onClick={discovery.refresh}
      title={t('authentication.discoveryRefresh')} aria-label={t('authentication.discoveryRefresh')}>
      <RefreshCw size={15} className={discovery.loading ? 'animate-spin' : undefined} />
    </button>
    <button type="button" className="cb-link" disabled={busy} onClick={disconnect}>{t('controller.signOut')}</button>
  </> : restoring
    ? <button type="button" className="cb-link" disabled={busy} onClick={disconnect}>{t('dshRemote.cancel')}</button>
    : undefined

  return (
    <Section id="tailscale" icon={<Globe size={16} />} name={t('service.remoteTabTailscale')} mount="stay" defaultOpen={defaultOpen}
      status={<State tone={state.tone}><span role="status">{state.text}</span></State>} action={action}>
      <div data-testid="phone-tailscale-login" className="cb-sec-body">
        {running ? <>
          {problem && <AuthAlert>{problem}</AuthAlert>}
          <DiscoveredRows network="tailscale" discovery={discovery} onPaired={onPaired} />
        </> : !restoring && (status || statusError) ? (
          <div className="cb-logins">
            <TailscaleControls state={status?.BackendState}
              authUrl={flow.authUrl}
              ips={status?.TailscaleIPs ?? []}
              enabled={status?.enabled ?? false} available={status !== null} busy={busy}
              recoveryPaused={status?.startupInterrupted}
              authPhase={flow.phase} layout="phone" showAuthQr={false} hideStatus
              onOpenAuthUrl={url => { setError(''); void flow.reopenAuthPage(url) }}
              error={problem}
              onLogin={() => { setError(''); void flow.beginLogin() }}
              onDisconnect={disconnect} />
          </div>
        ) : null}
        {!running && (
          <details open={Boolean(problem) || undefined} className="group min-w-0">
            <summary className="flex min-h-9 w-full cursor-pointer list-none items-center gap-1.5 text-[length:var(--fs-xs)] text-text-400 hover:text-text-200 focus-visible:outline-2 focus-visible:outline-accent-main-100 [&::-webkit-details-marker]:hidden">
              <ChevronRight size={14} className="shrink-0 transition-transform group-open:rotate-90" />
              {t('service.remoteTailscalePhoneTroubleshooting')}
            </summary>
            <div className="grid grid-cols-2 gap-2 pb-1">
              <button type="button" disabled={busy} onClick={() => run(async () => {
                await copyAndroidTailscaleDiagnostics()
                setDiagnosticsCopied(true)
              })} className="cb-btn">
                <Copy size={14} />{t('service.remoteTailscaleCopyDiagnostics')}
              </button>
              <button type="button" disabled={busy} onClick={() => run(exportAndroidTailscaleDiagnostics)} className="cb-btn">
                <Share2 size={14} />{t('service.remoteTailscaleExportDiagnostics')}
              </button>
            </div>
            {diagnosticsCopied && <p role="status" className="pt-2 text-[length:var(--fs-xs)] text-success-100">
              {t('service.remoteTailscaleDiagnosticsCopied')}
            </p>}
          </details>
        )}
      </div>
    </Section>
  )
}
