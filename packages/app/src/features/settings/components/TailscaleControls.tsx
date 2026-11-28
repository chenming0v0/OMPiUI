import { useEffect, useRef, useState } from 'react'
import { LogIn, Power, ExternalLink, Link2, Check, Copy, ChevronRight, ShieldCheck } from 'lucide-react'
import { AuthAlert, AuthStatusPill, type AuthTone } from './AuthPanelUI'
import { useTranslation } from 'react-i18next'
import { QrCode } from '../../../components/QrCode'
import { SpinnerIcon } from '../../../components/Icons'
import { copyTextToClipboard } from '../../../utils/clipboard'
import { isValidTailscaleAuthUrl } from '../../../utils/tailscaleLogin'
import type { TailscaleAuthPhase } from '../../../hooks/useTailscaleLoginFlow'
import './channelBoard.css'

export function TailscaleControls({ state, authUrl, ips, enabled, available, busy, error, recoveryPaused = false, authPhase, onOpenAuthUrl, authLinkMode = false, onAuthLinkClick, showAuthQr = true, layout = 'default', inline = false, hideStatus = false, onLogin, onDisconnect }: {
  state?: string | null
  authUrl?: string | null
  ips: string[]
  enabled: boolean
  available: boolean
  busy: boolean
  error?: string | null
  recoveryPaused?: boolean
  authPhase?: TailscaleAuthPhase
  onOpenAuthUrl?: (url: string) => void
  authLinkMode?: boolean
  onAuthLinkClick?: () => void
  showAuthQr?: boolean
  layout?: 'default' | 'phone'
  /** 状态和按钮排成一行，放进设置行右侧。 */
  inline?: boolean
  /** 外层已经显示了同一句状态时，不再重复那颗状态胶囊。 */
  hideStatus?: boolean
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
  const waiting = authPhase === 'starting' || authPhase === 'connecting' || authPhase === 'waitingAuthUrl' || authPhase === 'opening'
  const recovering = enabled && (state === 'Starting' || state === 'NoState')
  const disabled = busy || waiting || (recovering && !error)
  const needsAuth = state !== 'Running' && state !== 'NeedsMachineAuth'
  const target = needsAuth && !recovering && authUrl && isValidTailscaleAuthUrl(authUrl) ? authUrl : null
  const reconnect = recoveryPaused || (enabled && state !== 'NeedsLogin' && !target)
  const actionLabel = t(reconnect ? 'service.remoteTailscaleReconnect' : 'service.remoteTailscaleLogin')
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
  // 竖排时按钮占满一行；主动作是实心按钮，授权二维码在场时退成文字链接。
  const authButtonClass = `${showAuthQr ? 'cb-link justify-center' : 'cb-btn'}${phone ? ' touch-target-sm w-full' : ''}`
  const authVariant = showAuthQr ? undefined : 'primary'
  const disconnectClass = `cb-btn${phone ? ' w-full' : ''}`
  const authLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (disabled) event.preventDefault()
    else onAuthLinkClick?.()
  }
  const tone: AuthTone = state === 'Running' ? 'success'
    : state === 'NeedsMachineAuth' ? 'warning'
    : authPhase === 'authReady' || authPhase === 'authorizing' || waiting ? 'progress'
    : enabled ? 'progress' : 'idle'
  const showAuthAction = needsAuth && available
  const showDisconnect = enabled || waiting || Boolean(target)
  return (
    <div className={inline ? 'flex min-w-0 flex-wrap items-center justify-end gap-2' : 'grid min-w-0 gap-3'}>
      {!hideStatus && <AuthStatusPill role="status" tone={tone}
        icon={waiting ? <SpinnerIcon size={12} className="shrink-0 animate-spin" /> : state === 'Running' ? <ShieldCheck size={13} className="shrink-0" /> : undefined}>
        {state === 'Running'
          ? t('service.remoteTailscaleRunning', { ip: ips[0] ?? '' })
          : state === 'NeedsMachineAuth'
            ? t('service.remoteTailscaleApproval')
            : authPhase === 'starting'
              ? t('service.remoteTailscaleStarting')
              : authPhase === 'connecting' || recovering
                ? t('service.remoteTailscaleRestoring')
              : authPhase === 'waitingAuthUrl'
                ? t('service.remoteTailscaleWaitingAuthUrl')
                : authPhase === 'opening'
                  ? t('service.remoteTailscaleOpening')
                  : authPhase === 'authReady'
                    ? t('service.remoteTailscaleAuthReady')
                    : authPhase === 'authorizing'
                      ? t('service.remoteTailscaleAuthorizing')
                      : recoveryPaused ? t('service.remoteTailscaleRecoveryPaused')
                        : state === 'NeedsLogin' ? t('service.remoteTailscaleSignInRequired')
                        : enabled ? t('service.remoteTailscaleRestoring') : t('service.remoteTailscaleStopped')}
      </AuthStatusPill>}
      {(showAuthAction || showDisconnect) && (
        <div className={phone ? 'grid min-w-0 gap-2' : 'flex flex-wrap items-center gap-2'}>
          {showAuthAction && (
            target && authLinkMode && !waiting ? (
              <a href={target} target="_blank" rel="noopener noreferrer" aria-disabled={disabled} onClick={authLinkClick} className={authButtonClass} data-variant={authVariant}>
                <ExternalLink size={15} />{t('service.remoteTailscaleAuthorize')}
              </a>
            ) : (
              <button type="button" disabled={disabled} onClick={() => {
                if (target && onOpenAuthUrl) onOpenAuthUrl(target)
                else onLogin()
              }} className={authButtonClass} data-variant={authVariant}>
                {waiting ? <SpinnerIcon size={15} className="animate-spin" /> : target ? <ExternalLink size={15} /> : <LogIn size={15} />}
                {waiting ? actionLabel
                  : target ? t('service.remoteTailscaleAuthorize') : actionLabel}
              </button>
            )
          )}
          {showDisconnect && (
            <button type="button" disabled={busy} onClick={onDisconnect} className={disconnectClass}>
              <Power size={14} />{t('service.remoteTailscaleDisconnect')}
            </button>
          )}
        </div>
      )}
      {!available && (
        <p className="rounded-lg border border-warning-100/25 bg-warning-100/10 px-3 py-2 text-[length:var(--fs-xs)] leading-relaxed text-warning-100">
          {t('service.remoteTailscaleMissing')}
        </p>
      )}
      {target && (onOpenAuthUrl || authLinkMode) && (
        <details open={showAuthQr || undefined} className="group min-w-0 rounded-lg border border-border-200/60 bg-bg-200/30 text-[length:var(--fs-xs)] text-text-400">
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 px-3 hover:text-text-200 focus-visible:outline-2 focus-visible:outline-accent-main-100 [&::-webkit-details-marker]:hidden">
            <ChevronRight size={14} className="shrink-0 transition-transform group-open:rotate-90" />
            {t('service.remoteTailscaleLinkFallback')}
          </summary>
          <div className="grid min-w-0 gap-2 border-t border-border-200/60 px-3 py-3">
            <p className="leading-relaxed">{t('service.remoteTailscaleAuthUrlHint')}</p>
            <div className="flex min-w-0 items-stretch gap-2 max-sm:flex-col">
              {authLinkMode ? (
                <a href={target} target="_blank" rel="noopener noreferrer" aria-disabled={disabled} onClick={authLinkClick}
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-1.5 break-all rounded-md bg-bg-100 px-2.5 py-1.5 font-mono text-[length:var(--fs-xs)] text-accent-main-100 ring-1 ring-border-200/60 hover:underline aria-disabled:opacity-50">
                  <Link2 size={14} className="shrink-0" />{target}
                </a>
              ) : (
                <button type="button" disabled={disabled} onClick={() => onOpenAuthUrl?.(target)}
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-1.5 break-all rounded-md bg-bg-100 px-2.5 py-1.5 text-left font-mono text-[length:var(--fs-xs)] text-accent-main-100 ring-1 ring-border-200/60 hover:underline disabled:opacity-50">
                  <Link2 size={14} className="shrink-0" />{target}
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => void copyAuthUrl()}
                className="cb-btn shrink-0">
                {copied ? <Check size={14} className="text-success-100" /> : <Copy size={14} />}
                {t(copied ? 'service.remoteTailscaleAuthUrlCopied' : 'service.remoteTailscaleCopyAuthUrl')}
              </button>
            </div>
          </div>
        </details>
      )}
      {showAuthQr && target && (
        <div className="grid justify-items-start gap-2">
          <p className="text-[length:var(--fs-xs)] text-text-400">{t('service.remoteTailscaleAuthQrHint')}</p>
          <div className="rounded-xl bg-white p-2 shadow-sm ring-1 ring-black/5"><QrCode text={target} size={128} /></div>
        </div>
      )}
      {error && <div className={inline ? 'w-full' : undefined}><AuthAlert>{error}</AuthAlert></div>}
    </div>
  )
}
