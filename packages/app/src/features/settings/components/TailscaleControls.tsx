import { useEffect, useRef, useState } from 'react'
import { LogIn, Power, ExternalLink, Link2, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { QrCode } from '../../../components/QrCode'
import { SpinnerIcon } from '../../../components/Icons'
import { copyTextToClipboard } from '../../../utils/clipboard'
import { isValidTailscaleAuthUrl } from '../../../utils/tailscaleLogin'
import type { TailscaleAuthPhase } from '../../../hooks/useTailscaleLoginFlow'

export function TailscaleControls({ state, authUrl, ips, enabled, available, busy, error, authPhase, onOpenAuthUrl, authLinkMode = false, onAuthLinkClick, showAuthQr = true, layout = 'default', onLogin, onDisconnect }: {
  state?: string | null
  authUrl?: string | null
  ips: string[]
  enabled: boolean
  available: boolean
  busy: boolean
  error?: string | null
  authPhase?: TailscaleAuthPhase
  onOpenAuthUrl?: (url: string) => void
  authLinkMode?: boolean
  onAuthLinkClick?: () => void
  showAuthQr?: boolean
  layout?: 'default' | 'phone'
  onLogin: () => void
  onDisconnect: () => void
}) {
  const { t } = useTranslation('settings')
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const copyTimer = useRef<number | null>(null)
  const copyToken = useRef({ cancelled: false })
  useEffect(() => {
    const token = { cancelled: false }
    copyToken.current = token
    return () => {
      token.cancelled = true
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [authUrl])
  const waiting = authPhase === 'starting' || authPhase === 'waitingAuthUrl' || authPhase === 'opening'
  const disabled = busy || waiting
  const needsAuth = state !== 'Running' && state !== 'NeedsMachineAuth'
  const target = needsAuth && authUrl && isValidTailscaleAuthUrl(authUrl) ? authUrl : null
  const copied = target !== null && copiedUrl === target
  const copyAuthUrl = async () => {
    if (!target) return
    const token = copyToken.current
    try {
      await copyTextToClipboard(target)
      if (token.cancelled) return
      setCopiedUrl(target)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopiedUrl(null), 2000)
    } catch {
      // 剪贴板不可用时授权链接本身可见，可以手动选中复制。
    }
  }
  const phone = layout === 'phone'
  const authButtonClass = `inline-flex ${phone ? 'touch-target-sm min-h-12 w-full text-[length:var(--fs-sm)]' : 'min-h-11 sm:min-h-9 text-[length:var(--fs-xs)]'} items-center justify-center gap-2 rounded-md px-3 font-medium disabled:opacity-50 aria-disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-main-100 ${showAuthQr ? 'text-accent-main-100 hover:bg-accent-main-100/10' : 'bg-accent-main-100 text-bg-100 hover:bg-accent-main-100/90'}`
  const authLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (disabled) event.preventDefault()
    else onAuthLinkClick?.()
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
                : authPhase === 'opening'
                  ? t('service.remoteTailscaleOpening')
                  : authPhase === 'authReady'
                    ? t('service.remoteTailscaleAuthReady')
                    : authPhase === 'authorizing'
                      ? t('service.remoteTailscaleAuthorizing')
                      : enabled ? t('service.remoteTailscaleConnecting') : t('service.remoteTailscaleStopped')}
      </div>
      <div className={phone ? 'grid min-w-0 gap-2' : 'flex flex-wrap items-center gap-2'}>
        {needsAuth && available && (
          target && authLinkMode && !waiting ? (
            <a href={target} target="_blank" rel="noopener noreferrer" aria-disabled={disabled} onClick={authLinkClick} className={authButtonClass}>
              <ExternalLink size={14} />{t('service.remoteTailscaleAuthorize')}
            </a>
          ) : (
            <button type="button" disabled={disabled} onClick={() => {
              if (target && onOpenAuthUrl) onOpenAuthUrl(target)
              else onLogin()
            }} className={authButtonClass}>
              {waiting ? <SpinnerIcon size={14} className="animate-spin" /> : target ? <ExternalLink size={14} /> : <LogIn size={14} />}
              {waiting ? t('service.remoteTailscaleLogin')
                : target ? t('service.remoteTailscaleAuthorize') : t('service.remoteTailscaleLogin')}
            </button>
          )
        )}
        {(enabled || waiting || target) && (
          <button type="button" disabled={busy} onClick={onDisconnect}
            className="inline-flex min-h-11 sm:min-h-8 w-fit items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] text-text-400 hover:bg-bg-200 disabled:opacity-50">
            <Power size={14} />{t('service.remoteTailscaleDisconnect')}
          </button>
        )}
      </div>
      {!available && <p className="text-[length:var(--fs-xs)] text-warning-100">{t('service.remoteTailscaleMissing')}</p>}
      {target && (onOpenAuthUrl || authLinkMode) && (
        <details open={showAuthQr || undefined} className="min-w-0 text-[length:var(--fs-xs)] text-text-400">
          <summary className="w-fit cursor-pointer py-1.5 hover:text-text-200 focus-visible:outline-2 focus-visible:outline-accent-main-100">{t('service.remoteTailscaleLinkFallback')}</summary>
          <div className="mt-1 grid min-w-0 gap-1">
          <p className="leading-relaxed">{t('service.remoteTailscaleAuthUrlHint')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {authLinkMode ? (
              <a href={target} target="_blank" rel="noopener noreferrer" aria-disabled={disabled} onClick={authLinkClick}
                className="inline-flex min-h-10 max-w-full items-center gap-1.5 break-all py-1 font-mono text-[length:var(--fs-xs)] text-accent-main-100 hover:underline disabled:opacity-50 aria-disabled:opacity-50">
                <Link2 size={14} className="shrink-0" />{target}
              </a>
            ) : (
              <button type="button" disabled={disabled} onClick={() => onOpenAuthUrl?.(target)}
                className="inline-flex min-h-10 max-w-full items-center gap-1.5 break-all py-1 font-mono text-[length:var(--fs-xs)] text-accent-main-100 hover:underline disabled:opacity-50 aria-disabled:opacity-50">
                <Link2 size={14} className="shrink-0" />{target}
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void copyAuthUrl()}
              className="inline-flex min-h-11 sm:min-h-8 w-fit items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] text-text-400 hover:bg-bg-200 disabled:opacity-50">
              {copied ? <Check size={14} className="text-success-100" /> : <Link2 size={14} />}
              {t(copied ? 'service.remoteTailscaleAuthUrlCopied' : 'service.remoteTailscaleCopyAuthUrl')}
            </button>
          </div>
          </div>
        </details>
      )}
      {showAuthQr && target && (
        <div className="grid gap-1.5">
          <p className="text-[length:var(--fs-xs)] text-text-400">{t('service.remoteTailscaleAuthQrHint')}</p>
          <QrCode text={target} size={128} />
        </div>
      )}
      {error && <p role="alert" className="break-words text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
    </div>
  )
}
