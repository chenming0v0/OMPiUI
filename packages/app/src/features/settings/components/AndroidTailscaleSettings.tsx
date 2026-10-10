import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Check, Copy, Share2 } from 'lucide-react'
import {
  disconnectAndroidTailscale, getAndroidTailscaleStatus, isAndroidTailscalePlatform,
  loginAndroidTailscale, type AndroidTailscaleStatus,
  copyAndroidTailscaleDiagnostics, exportAndroidTailscaleDiagnostics,
} from '../../../utils/androidTailscale'
import { redeemPairCode } from '../../../omp/transport'
import { serverStore } from '../../../store/serverStore'
import { TailscaleControls } from './TailscaleControls'
import { openTailscaleLogin } from '../../../utils/tailscaleLogin'
import { settingsFieldClass } from './SettingsUI'

export function AndroidTailscaleSettings() {
  return isAndroidTailscalePlatform() ? <AndroidTailscalePanel /> : null
}

function AndroidTailscalePanel() {
  const { t } = useTranslation('settings')
  const [status, setStatus] = useState<AndroidTailscaleStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [invite, setInvite] = useState('')
  const [paired, setPaired] = useState(false)
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false)
  const waitingForAuth = useRef(false)
  useEffect(() => {
    let cancelled = false
    const load = () => void getAndroidTailscaleStatus().then(next => {
      if (!cancelled) {
        setStatus(next)
        setStatusError('')
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
    if (next.AuthURL) await openTailscaleLogin(next.AuthURL)
    else waitingForAuth.current = next.BackendState !== 'Running'
  }
  const pair = async () => {
    const parsed = new URL(invite.trim())
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(t('service.remotePairInvalid'))
    }
    const code = parsed.searchParams.get('pair')
    if (!code) throw new Error(t('service.remotePairInvalid'))
    const result = await redeemPairCode(code, parsed.origin, AbortSignal.timeout(15_000))
    const server = serverStore.addServer({ name: parsed.host, url: result.url, token: result.token })
    serverStore.setActiveServer(server.id)
    await serverStore.checkHealth(server.id)
    setInvite('')
    setPaired(true)
  }
  return (
    <div className="grid gap-3 border-b border-border-200/60 pb-4">
      <h3 className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('service.remoteTailscalePhoneTitle')}</h3>
      {!status && !statusError ? <p role="status" className="text-[length:var(--fs-xs)] text-text-400">
        {t('service.backendStatusLoading', { defaultValue: 'Loading server status…' })}
      </p> : <TailscaleControls state={status?.BackendState} authUrl={status?.AuthURL} ips={status?.TailscaleIPs ?? []}
        enabled={status?.enabled ?? false} available={status !== null} busy={busy}
        error={error || statusError || (status?.startupInterrupted ? t('service.remoteTailscaleStartupInterrupted') : status?.lastError)}
        showAuthQr={false}
        onLogin={() => run(login)}
        onDisconnect={() => run(async () => {
          await disconnectAndroidTailscale()
          waitingForAuth.current = false
          setStatus(await getAndroidTailscaleStatus())
          serverStore.checkAllHealth()
        })} />}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={() => run(async () => {
          await copyAndroidTailscaleDiagnostics()
          setDiagnosticsCopied(true)
        })} className="inline-flex min-h-8 items-center gap-1.5 text-[length:var(--fs-xs)] text-text-300 hover:text-text-100 disabled:opacity-50">
          <Copy size={14} />{t('service.remoteTailscaleCopyDiagnostics')}
        </button>
        <button type="button" disabled={busy} onClick={() => run(exportAndroidTailscaleDiagnostics)}
          className="inline-flex min-h-8 items-center gap-1.5 text-[length:var(--fs-xs)] text-text-300 hover:text-text-100 disabled:opacity-50">
          <Share2 size={14} />{t('service.remoteTailscaleExportDiagnostics')}
        </button>
      </div>
      {diagnosticsCopied && <p role="status" className="text-[length:var(--fs-xs)] text-text-300">
        {t('service.remoteTailscaleDiagnosticsCopied')}
      </p>}
      <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); run(pair) }}>
        <input aria-label={t('service.remotePairInput')} value={invite}
          onChange={event => { setInvite(event.target.value); setPaired(false) }}
          placeholder={t('service.remotePairInput')} className={`${settingsFieldClass} min-w-0 flex-1`} />
        <button type="submit" disabled={busy || !invite.trim()}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] text-accent-main-100 hover:bg-accent-main-100/10 disabled:opacity-50">
          <Link size={14} />{t('service.remotePairConnect')}
        </button>
      </form>
      {paired && <p role="status" className="flex items-center gap-1.5 text-[length:var(--fs-xs)] text-success-100">
        <Check size={14} />{t('service.remoteApproved')}
      </p>}
    </div>
  )
}
