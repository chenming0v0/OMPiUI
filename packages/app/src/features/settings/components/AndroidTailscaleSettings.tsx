import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Copy, Share2 } from 'lucide-react'
import {
  disconnectAndroidTailscale, getAndroidTailscaleStatus, isAndroidTailscalePlatform,
  loginAndroidTailscale, type AndroidTailscaleStatus,
  copyAndroidTailscaleDiagnostics, exportAndroidTailscaleDiagnostics,
} from '../../../utils/androidTailscale'
import { serverStore } from '../../../store/serverStore'
import { TailscaleControls } from './TailscaleControls'
import { openTailscaleLogin } from '../../../utils/tailscaleLogin'

export function AndroidTailscaleSettings({ onAuthenticated }: { onAuthenticated?: () => void }) {
  return isAndroidTailscalePlatform() ? <AndroidTailscalePanel onAuthenticated={onAuthenticated} /> : null
}

function AndroidTailscalePanel({ onAuthenticated }: { onAuthenticated?: () => void }) {
  const { t } = useTranslation('settings')
  const [status, setStatus] = useState<AndroidTailscaleStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false)
  const waitingForAuth = useRef(false)
  const loginRequested = useRef(false)
  const authenticatedRef = useRef(onAuthenticated)
  useEffect(() => { authenticatedRef.current = onAuthenticated }, [onAuthenticated])
  useEffect(() => {
    let cancelled = false
    const load = () => void getAndroidTailscaleStatus().then(next => {
      if (!cancelled) {
        setStatus(next)
        setStatusError('')
        if (loginRequested.current && next.BackendState === 'Running') {
          loginRequested.current = false
          waitingForAuth.current = false
          authenticatedRef.current?.()
          return
        }
        if (waitingForAuth.current && next.AuthURL) {
          waitingForAuth.current = false
          void openTailscaleLogin(next.AuthURL).catch(err => setError(err instanceof Error ? err.message : String(err)))
        }
      }
    }).catch(err => {
      if (!cancelled) setStatusError(err instanceof Error ? err.message : String(err))
    })
    load()
    const timer = window.setInterval(load, 3_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  const run = (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    void action().catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false))
  }
  const login = async () => {
    const next = await loginAndroidTailscale()
    setStatus(next)
    loginRequested.current = next.BackendState !== 'Running'
    if (next.BackendState === 'Running') {
      authenticatedRef.current?.()
      return
    }
    if (next.AuthURL) await openTailscaleLogin(next.AuthURL)
    else waitingForAuth.current = next.BackendState !== 'Running'
  }
  return (
    <div className="grid min-w-0 gap-3">
      <h3 className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('service.remoteTailscalePhoneTitle')}</h3>
      {!status && !statusError ? <p role="status" className="text-[length:var(--fs-xs)] text-text-400">
        {t('service.backendStatusLoading')}
      </p> : <TailscaleControls state={status?.BackendState} authUrl={status?.AuthURL} ips={status?.TailscaleIPs ?? []}
        enabled={status?.enabled ?? false} available={status !== null} busy={busy}
        error={error || statusError || (status?.startupInterrupted ? t('service.remoteTailscaleStartupInterrupted') : status?.lastError)}
        showAuthQr={false}
        onLogin={() => run(login)}
        onDisconnect={() => run(async () => {
          await disconnectAndroidTailscale()
          waitingForAuth.current = false
          loginRequested.current = false
          setStatus(await getAndroidTailscaleStatus())
          serverStore.checkAllHealth()
        })} />}
      <div className="flex flex-wrap items-center gap-3">
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
      {status?.BackendState === 'Running' && onAuthenticated && (
        <button type="button" onClick={onAuthenticated} disabled={busy}
          className="inline-flex min-h-11 items-center justify-self-start gap-1.5 rounded-md px-2 text-[length:var(--fs-sm)] text-accent-main-100 hover:bg-accent-main-100/10 disabled:opacity-50">
          <ArrowRight size={15} />{t('authentication.addConnection')}
        </button>
      )}
    </div>
  )
}
