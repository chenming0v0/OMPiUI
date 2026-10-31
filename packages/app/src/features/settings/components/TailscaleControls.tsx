import { useState } from 'react'
import { LogIn, Power, ExternalLink, Link2, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { QrCode } from '../../../components/QrCode'
import { SpinnerIcon } from '../../../components/Icons'
import type { TailscaleAuthPhase } from '../../../hooks/useTailscaleLoginFlow'

export function TailscaleControls({ state, authUrl, ips, enabled, available, busy, error, authPhase, onOpenAuthUrl, showAuthQr = true, onLogin, onDisconnect }: {
  state?: string | null
  authUrl?: string | null
  ips: string[]
  enabled: boolean
  available: boolean
  busy: boolean
  error?: string | null
  authPhase?: TailscaleAuthPhase
  onOpenAuthUrl?: (url: string) => void
  showAuthQr?: boolean
  onLogin: () => void
  onDisconnect: () => void
}) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  const waiting = authPhase === 'starting' || authPhase === 'waitingAuthUrl'
  const copyAuthUrl = async () => {
    if (!authUrl) return
    try {
      await navigator.clipboard.writeText(authUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时授权链接本身可见，可以手动选中复制
    }
  }
  return (
    <div className="grid min-w-0 gap-2">
      <div role="status" className={`break-words text-[length:var(--fs-xs)] ${state === 'Running' ? 'text-success-100' : 'text-text-400'}`}>
        {state === 'Running'
          ? t('service.remoteTailscaleRunning', { ip: ips[0] ?? '' })
          : state === 'NeedsMachineAuth'
            ? t('service.remoteTailscaleApproval')
            : authPhase === 'starting'
              ? t('service.remoteTailscaleStarting')
              : authPhase === 'waitingAuthUrl'
                ? t('service.remoteTailscaleWaitingAuthUrl')
                : authPhase === 'authorizing'
                  ? t('service.remoteTailscaleAuthorizing')
                  : enabled ? t('service.remoteTailscaleConnecting') : t('service.remoteTailscaleStopped')}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {state !== 'Running' && available && (
          <button type="button" disabled={busy || waiting} onClick={() => {
            // 已有授权链接时任何点击都只是再次打开它，不重复发起登录。
            if (authUrl && onOpenAuthUrl) onOpenAuthUrl(authUrl)
            else onLogin()
          }}
            className="inline-flex min-h-11 sm:min-h-8 items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] text-accent-main-100 hover:bg-accent-main-100/10 disabled:opacity-50">
            {waiting ? <SpinnerIcon size={14} className="animate-spin" /> : authUrl ? <ExternalLink size={14} /> : <LogIn size={14} />}
            {waiting ? t('service.remoteTailscaleLogin')
              : authUrl ? t('service.remoteTailscaleAuthorize') : t('service.remoteTailscaleLogin')}
          </button>
        )}
        {enabled && (
          <button type="button" disabled={busy} onClick={onDisconnect}
            className="inline-flex min-h-11 sm:min-h-8 items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] text-text-400 hover:bg-bg-200 disabled:opacity-50">
            <Power size={14} />{t('service.remoteTailscaleDisconnect')}
          </button>
        )}
      </div>
      {!available && <p className="text-[length:var(--fs-xs)] text-warning-100">{t('service.remoteTailscaleMissing')}</p>}
      {authUrl && state !== 'Running' && onOpenAuthUrl && (
        <div className="grid gap-1">
          <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('service.remoteTailscaleAuthUrlHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => onOpenAuthUrl(authUrl)}
              className="inline-flex min-h-11 sm:min-h-8 max-w-full items-center gap-1.5 truncate rounded-md px-2 font-mono text-[length:var(--fs-xs)] text-accent-main-100 hover:bg-accent-main-100/10">
              <Link2 size={14} className="shrink-0" />{authUrl}
            </button>
            <button type="button" disabled={busy} onClick={() => void copyAuthUrl()}
              className="inline-flex min-h-11 sm:min-h-8 items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] text-text-400 hover:bg-bg-200 disabled:opacity-50">
              {copied ? <Check size={14} className="text-success-100" /> : <Link2 size={14} />}
              {t(copied ? 'service.remoteTailscaleAuthUrlCopied' : 'service.remoteTailscaleCopyAuthUrl')}
            </button>
          </div>
        </div>
      )}
      {showAuthQr && authUrl && state !== 'Running' && (
        <div className="flex flex-wrap items-center gap-3">
          <QrCode text={authUrl} size={128} />
        </div>
      )}
      {error && <p role="alert" className="break-words text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
    </div>
  )
}
