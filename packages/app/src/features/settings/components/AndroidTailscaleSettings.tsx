import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Copy, Share2, Smartphone } from 'lucide-react'
import { SpinnerIcon } from '../../../components/Icons'
import { AuthCard, AuthStatusPill, authSecondaryButtonClass } from './AuthPanelUI'
import {
  disconnectAndroidTailscale, getAndroidTailscaleStatus, isAndroidTailscalePlatform,
  loginAndroidTailscale, type AndroidTailscaleStatus,
  copyAndroidTailscaleDiagnostics, exportAndroidTailscaleDiagnostics,
} from '../../../utils/androidTailscale'
import { useTailscaleLoginFlow } from '../../../hooks/useTailscaleLoginFlow'
import { serverStore } from '../../../store/serverStore'
import { TailscaleControls } from './TailscaleControls'
import { openTailscaleLogin } from '../../../utils/tailscaleLogin'

export function AndroidTailscaleSettings() {
  return isAndroidTailscalePlatform() ? <AndroidTailscalePanel /> : null
}

function AndroidTailscalePanel() {
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
    statusPollMs: 3_000,
    paused: busy,
    onPollError: err => setStatusError(err instanceof Error ? err.message : String(err)),
  })

  const run = (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    void action().catch(err => {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    }).finally(() => { if (mounted.current) setBusy(false) })
  }
  return (
    <AuthCard testId="phone-tailscale-login" icon={<Smartphone size={18} />}
      title={t('service.remoteTailscalePhoneTitle')} description={t('service.remoteTailscalePhoneDesc')}>
      {!status && !statusError ? <AuthStatusPill role="status" tone="idle" icon={<SpinnerIcon size={12} className="shrink-0 animate-spin" />}>
        {t('service.backendStatusLoading')}
      </AuthStatusPill> : <TailscaleControls state={status?.BackendState}
        authUrl={flow.authUrl}
        ips={status?.TailscaleIPs ?? []}
        enabled={status?.enabled ?? false} available={status !== null} busy={busy}
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
      <details open={Boolean(error || statusError || flow.error || status?.startupInterrupted) || undefined} className="group -mx-4 -mb-4 min-w-0 border-t border-border-200/60 px-4 pb-1">
        <summary className="flex min-h-11 w-full cursor-pointer list-none items-center gap-1.5 text-[length:var(--fs-xs)] text-text-400 hover:text-text-200 focus-visible:outline-2 focus-visible:outline-accent-main-100 [&::-webkit-details-marker]:hidden">
          <ChevronRight size={14} className="shrink-0 transition-transform group-open:rotate-90" />
          {t('service.remoteTailscalePhoneTroubleshooting')}
        </summary>
      <div className="grid grid-cols-2 gap-2 pb-3">
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
      {diagnosticsCopied && <p role="status" className="pb-3 text-[length:var(--fs-xs)] text-success-100">
        {t('service.remoteTailscaleDiagnosticsCopied')}
      </p>}
      </details>
    </AuthCard>
  )
}
