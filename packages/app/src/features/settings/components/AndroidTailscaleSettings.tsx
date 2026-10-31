import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Share2, Smartphone } from 'lucide-react'
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
    <section data-testid="phone-tailscale-login" className="grid min-w-0 gap-4 rounded-xl border border-border-200/60 bg-bg-100 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-main-100/10 text-accent-main-100"><Smartphone size={22} /></div>
        <div className="min-w-0">
          <h3 className="text-[length:var(--fs-md)] font-medium text-text-100">{t('service.remoteTailscalePhoneTitle')}</h3>
          <p className="mt-1 text-[length:var(--fs-xs)] leading-relaxed text-text-300">{t('service.remoteTailscalePhoneDesc')}</p>
        </div>
      </div>
      {!status && !statusError ? <p role="status" className="text-[length:var(--fs-xs)] text-text-400">
        {t('service.backendStatusLoading')}
      </p> : <TailscaleControls state={status?.BackendState}
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
      <details open={Boolean(error || statusError || flow.error || status?.startupInterrupted) || undefined} className="min-w-0 border-t border-border-200/60 pt-3">
        <summary className="w-fit cursor-pointer py-1 text-[length:var(--fs-xs)] text-text-400 hover:text-text-200 focus-visible:outline-2 focus-visible:outline-accent-main-100">{t('service.remoteTailscalePhoneTroubleshooting')}</summary>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={() => run(async () => {
          await copyAndroidTailscaleDiagnostics()
          setDiagnosticsCopied(true)
        })} className="inline-flex min-h-11 items-center gap-1.5 text-[length:var(--fs-xs)] text-text-300 hover:text-text-100 disabled:opacity-50">
          <Copy size={14} />{t('service.remoteTailscaleCopyDiagnostics')}
        </button>
        <button type="button" disabled={busy} onClick={() => run(exportAndroidTailscaleDiagnostics)}
          className="inline-flex min-h-11 items-center gap-1.5 text-[length:var(--fs-xs)] text-text-300 hover:text-text-100 disabled:opacity-50">
          <Share2 size={14} />{t('service.remoteTailscaleExportDiagnostics')}
        </button>
      </div>
      {diagnosticsCopied && <p role="status" className="text-[length:var(--fs-xs)] text-text-300">
        {t('service.remoteTailscaleDiagnosticsCopied')}
      </p>}
      </details>
    </section>
  )
}
