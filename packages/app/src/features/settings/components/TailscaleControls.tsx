import { LogIn, Power, ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { QrCode } from '../../../components/QrCode'
import { SpinnerIcon } from '../../../components/Icons'

export function TailscaleControls({ state, authUrl, ips, enabled, available, busy, error, showAuthQr = true, onLogin, onDisconnect }: {
  state?: string | null
  authUrl?: string | null
  ips: string[]
  enabled: boolean
  available: boolean
  busy: boolean
  error?: string | null
  showAuthQr?: boolean
  onLogin: () => void
  onDisconnect: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="grid min-w-0 gap-2">
      <div role="status" className={`break-words text-[length:var(--fs-xs)] ${state === 'Running' ? 'text-success-100' : 'text-text-400'}`}>
        {state === 'Running'
          ? t('service.remoteTailscaleRunning', { ip: ips[0] ?? '' })
          : state === 'NeedsMachineAuth'
            ? t('service.remoteTailscaleApproval')
            : enabled ? t('service.remoteTailscaleConnecting') : t('service.remoteTailscaleStopped')}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {state !== 'Running' && available && (
          <button type="button" disabled={busy} onClick={onLogin}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] text-accent-main-100 hover:bg-accent-main-100/10 disabled:opacity-50">
            {busy ? <SpinnerIcon size={14} className="animate-spin" /> : authUrl ? <ExternalLink size={14} /> : <LogIn size={14} />}
            {t(authUrl ? 'service.remoteTailscaleAuthorize' : 'service.remoteTailscaleLogin')}
          </button>
        )}
        {enabled && (
          <button type="button" disabled={busy} onClick={onDisconnect}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] text-text-400 hover:bg-bg-200 disabled:opacity-50">
            <Power size={14} />{t('service.remoteTailscaleDisconnect')}
          </button>
        )}
      </div>
      {!available && <p className="text-[length:var(--fs-xs)] text-warning-100">{t('service.remoteTailscaleMissing')}</p>}
      {showAuthQr && authUrl && state !== 'Running' && (
        <div className="flex flex-wrap items-center gap-3">
          <QrCode text={authUrl} size={128} />
        </div>
      )}
      {error && <p role="alert" className="break-words text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
    </div>
  )
}
