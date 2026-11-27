import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Copy, Globe, Share2 } from 'lucide-react'
import { SpinnerIcon } from '../../../components/Icons'
import { AuthStatusPill, authSecondaryButtonClass } from './AuthPanelUI'
import { NextAction } from './ChannelBoard'
import {
  disconnectAndroidTailscale, getAndroidTailscaleStatus, isAndroidTailscalePlatform,
  loginAndroidTailscale, type AndroidTailscaleStatus,
  copyAndroidTailscaleDiagnostics, exportAndroidTailscaleDiagnostics,
} from '../../../utils/androidTailscale'
import { useTailscaleLoginFlow, type TailscaleAuthPhase } from '../../../hooks/useTailscaleLoginFlow'
import { serverStore } from '../../../store/serverStore'
import { TailscaleControls } from './TailscaleControls'
import { openTailscaleLogin } from '../../../utils/tailscaleLogin'
import { TAILSCALE_STATUS_EVENT } from '../../../utils/tailscaleEvents'

/** 通道条要显示的手机组网状态。 */
export type AndroidTailscaleState = { backendState: string | null; phase: TailscaleAuthPhase }

export function AndroidTailscaleSettings({ onState }: { onState?: (state: AndroidTailscaleState) => void }) {
  return isAndroidTailscalePlatform() ? <AndroidTailscalePanel onState={onState} /> : null
}

function AndroidTailscalePanel({ onState }: { onState?: (state: AndroidTailscaleState) => void }) {
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
  useEffect(() => { onState?.({ backendState, phase: flow.phase }) }, [onState, backendState, flow.phase])

  const run = (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    void action().catch(err => {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    }).finally(() => { if (mounted.current) setBusy(false) })
  }
  return (
    <div data-testid="phone-tailscale-login" className="grid min-w-0 gap-4">
      <NextAction tone={backendState === 'Running' ? 'ok' : 'idle'} icon={<Globe size={18} />} title={t('service.remoteTailscalePhoneTitle')}>
        <p>{t('service.remoteTailscalePhoneDesc')}</p>
      </NextAction>
      {!status && !statusError ? <AuthStatusPill role="status" tone="idle" icon={<SpinnerIcon size={12} className="shrink-0 animate-spin" />}>
        {t('service.backendStatusLoading')}
      </AuthStatusPill> : <TailscaleControls state={status?.BackendState}
        authUrl={flow.authUrl}
        ips={status?.TailscaleIPs ?? []}
        enabled={status?.enabled ?? false} available={status !== null} busy={busy}
        recoveryPaused={status?.startupInterrupted}
        authPhase={flow.phase} layout="phone" showAuthQr={false}
        onOpenAuthUrl={url => { setError(''); void flow.reopenAuthPage(url) }}
        error={error || statusError || flow.error || (status?.startupInterrupted ? t('service.remoteTailscaleStartupInterrupted') : status?.lastError)}
        onLogin={() => { setError(''); void flow.beginLogin() }}
        onDisconnect={() => {
          const signal = flow.reset()
          run(async () => {
            await disconnectAndroidTailscale()
            if (signal.aborted) return
            await flow.refreshStatus(true)
            if (mounted.current) serverStore.checkAllHealth()
          })
        }} />}
      <details open={Boolean(error || statusError || flow.error || status?.startupInterrupted) || undefined} className="group min-w-0 border-t border-border-200/60">
        <summary className="flex min-h-11 w-full cursor-pointer list-none items-center gap-1.5 text-[length:var(--fs-xs)] text-text-400 hover:text-text-200 focus-visible:outline-2 focus-visible:outline-accent-main-100 [&::-webkit-details-marker]:hidden">
          <ChevronRight size={14} className="shrink-0 transition-transform group-open:rotate-90" />
          {t('service.remoteTailscalePhoneTroubleshooting')}
        </summary>
      <div className="grid grid-cols-2 gap-2 pb-1">
        <button type="button" disabled={busy} onClick={() => run(async () => {
          await copyAndroidTailscaleDiagnostics()
          setDiagnosticsCopied(true)
        })} className={`${authSecondaryButtonClass} min-h-11 text-[length:var(--fs-xs)]`}>
          <Copy size={14} />{t('service.remoteTailscaleCopyDiagnostics')}
        </button>
        <button type="button" disabled={busy} onClick={() => run(exportAndroidTailscaleDiagnostics)}
          className={`${authSecondaryButtonClass} min-h-11 text-[length:var(--fs-xs)]`}>
          <Share2 size={14} />{t('service.remoteTailscaleExportDiagnostics')}
        </button>
      </div>
      {diagnosticsCopied && <p role="status" className="pt-2 text-[length:var(--fs-xs)] text-success-100">
        {t('service.remoteTailscaleDiagnosticsCopied')}
      </p>}
      </details>
    </div>
  )
}
