import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Share2 } from 'lucide-react'
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
  const flow = useTailscaleLoginFlow({
    // 拿到授权链接前 busy 一直可见：点击后界面持续推进，不再"转一下就还原"。
    start: async () => {
      const next = await loginAndroidTailscale()
      setStatus(next)
      return { backendState: next.BackendState, authUrl: next.AuthURL ?? null }
    },
    poll: async () => {
      const next = await getAndroidTailscaleStatus()
      setStatus(next)
      return { backendState: next.BackendState, authUrl: next.AuthURL ?? null }
    },
    open: openTailscaleLogin,
    timeoutMessage: t('service.remoteTailscaleAuthUrlTimeout'),
  })
  useEffect(() => {
    let cancelled = false
    const load = () => {
      if (document.visibilityState === 'hidden') return
      void getAndroidTailscaleStatus().then(next => {
      if (!cancelled) {
        setStatus(next)
        setStatusError('')
      }
      }).catch(err => {
      if (!cancelled) setStatusError(err instanceof Error ? err.message : String(err))
      })
    }
    load()
    const timer = window.setInterval(load, 3_000)
    const resume = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', resume)
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', resume) }
  }, [])

  // 登录完成（或进入设备批准阶段）后把授权流程状态清回 idle。
  const { reset: resetAuthFlow } = flow
  useEffect(() => {
    if (status?.BackendState === 'Running' || status?.BackendState === 'NeedsMachineAuth') resetAuthFlow()
  }, [resetAuthFlow, status?.BackendState])

  const run = (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    void action().catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false))
  }
  return (
    <div className="grid min-w-0 gap-3">
      <h3 className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('service.remoteTailscalePhoneTitle')}</h3>
      {!status && !statusError ? <p role="status" className="text-[length:var(--fs-xs)] text-text-400">
        {t('service.backendStatusLoading')}
      </p> : <TailscaleControls state={status?.BackendState}
        authUrl={status?.BackendState === 'Running' ? null : flow.authUrl ?? status?.AuthURL ?? null}
        ips={status?.TailscaleIPs ?? []}
        enabled={status?.enabled ?? false} available={status !== null} busy={busy}
        authPhase={flow.phase} onOpenAuthUrl={url => { void flow.reopenAuthPage(url) }}
        error={error || statusError || flow.error || (status?.startupInterrupted ? t('service.remoteTailscaleStartupInterrupted') : status?.lastError)}
        onLogin={() => { void flow.beginLogin() }}
        onDisconnect={() => run(async () => {
          await disconnectAndroidTailscale()
          flow.reset()
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
    </div>
  )
}
