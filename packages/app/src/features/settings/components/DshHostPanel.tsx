import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2, TriangleAlert } from 'lucide-react'
import { DSH_REMOTE_ORIGIN } from '@ompiui/protocol/dsh-remote'
import { AuthAlert } from './AuthPanelUI'
import { NextAction, PanelRow, PanelSplit } from './ChannelBoard'
import { Toggle } from './SettingsUI'
import { DshHostPairingCard, DshHostPairingStart } from './DshHostPairingCard'
import type { DshHost } from './useDshHost'

const portal = `${DSH_REMOTE_ORIGIN}/app`

async function openSite(url: string) {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

/** 被控端 → DS 远程：一进来就出二维码给手机扫；下面是官网绑定码、远程访问开关和撤销绑定。 */
export function DshHostPanel({ host }: { host: DshHost }) {
  const { t } = useTranslation('settings')
  const { status, unreachable, unreadable, state, busy, failure, manage } = host
  const [code, setCode] = useState('')
  const [portalFailed, setPortalFailed] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  useEffect(() => {
    if (!confirmRevoke) return
    const timer = setTimeout(() => setConfirmRevoke(false), 5_000)
    return () => clearTimeout(timer)
  }, [confirmRevoke])

  // 打开这条通道就向托管服务要一次二维码；之后取消或失败了不再自动重来，由按钮触发。
  const requested = useRef(false)
  const canPair = Boolean(status?.available) && !unreadable && !status?.pairing
  const requestPair = useRef(manage)
  useEffect(() => { requestPair.current = manage })
  useEffect(() => {
    if (!canPair || requested.current) return
    requested.current = true
    void requestPair.current('pair')
  }, [canPair])

  const hostError = (errorCode: string, message = '') =>
    t(`dshRemote.hostError.${errorCode || 'default'}`, { defaultValue: message || t('dshRemote.hostError.default') })
  const error = portalFailed ? t('dshRemote.portalFailed')
    : failure ? (failure.code ? hostError(failure.code, failure.message) : t('dshRemote.hostOperationFailed')) : ''
  const unavailable = status?.reason === 'loopback' ? t('dshRemote.hostLoopbackOnly') : t('dshRemote.hostNoWeb')
  const lastError = status?.lastError
  const warning = status && (status.available || unreadable) && lastError && state !== 'unregistered' && state !== 'disabled'
    ? hostError(lastError.code, lastError.message) : ''
  const pairing = status?.pairing
  const confirmThen = (action: 'revoke' | 'reset') => {
    if (!confirmRevoke) { setConfirmRevoke(true); return }
    void manage(action).then(done => { if (done) setConfirmRevoke(false) })
  }
  const ticket = pairing ? <DshHostPairingCard host={host} pairing={pairing} /> : <DshHostPairingStart host={host} />

  let body: React.ReactNode
  if (!status) {
    body = unreachable
      ? <NextAction tone="warn" icon={<TriangleAlert size={34} />} title={t('dshRemote.hostUnavailableShort')}>{t('dshRemote.hostUnavailable')}</NextAction>
      : <p role="status" className="cb-hint flex items-center justify-center gap-2"><Loader2 size={13} className="animate-spin" />{t('dshRemote.hostLoading')}</p>
  } else if (!status.available && !unreadable) {
    body = <NextAction tone="warn" icon={<TriangleAlert size={34} />} title={t('dshRemote.hostUnavailableShort')}>{unavailable}</NextAction>
  } else if (unreadable) {
    body = (
      <NextAction tone="warn" icon={<TriangleAlert size={34} />} title={t('dshRemote.hostState.error')}
        actions={<button type="button" className="cb-btn" data-variant={confirmRevoke ? 'danger' : undefined} disabled={busy} onClick={() => confirmThen('reset')}>
          {t(confirmRevoke ? 'dshRemote.confirmReset' : 'dshRemote.resetBinding')}
        </button>}>
        {warning}
      </NextAction>
    )
  } else if (!status.registered) {
    body = <>
      {ticket}
      <PanelSplit>
        <PanelRow title={t('host.dshPortalCode')}>
          <form className="contents" onSubmit={event => {
            event.preventDefault()
            if (busy) return
            setPortalFailed(false)
            void manage('register', code).then(done => { if (done) setCode('') })
          }}>
            <input type="text" autoComplete="off" spellCheck={false}
              className="cb-input font-mono uppercase tracking-[0.14em]" style={{ width: 132 }}
              placeholder="XXXX-XXXX" maxLength={9} aria-label={t('dshRemote.hostCode')}
              value={code} onChange={event => setCode(event.target.value.toUpperCase())} />
            <button type="button" className="cb-icon-btn" title={t('dshRemote.portal')} aria-label={t('dshRemote.portal')}
              onClick={() => { setPortalFailed(false); void openSite(portal).catch(() => setPortalFailed(true)) }}>
              <ExternalLink size={15} />
            </button>
            <button type="submit" className="cb-btn" disabled={busy || !/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code.trim())}>
              {t('dshRemote.register')}
            </button>
          </form>
        </PanelRow>
      </PanelSplit>
    </>
  } else {
    body = <>
      {warning && <AuthAlert>{warning}</AuthAlert>}
      {ticket}
      <PanelSplit>
        <PanelRow title={t('host.dshAccess')} label={t('host.dshAccess')}>
          <Toggle enabled={status.enabled} disabled={busy} ariaLabel={t('host.dshAccess')}
            onChange={() => void manage(status.enabled ? 'disable' : 'enable')} />
        </PanelRow>
        <PanelRow title={t('host.dshBinding')}>
          {confirmRevoke ? <>
            <button type="button" className="cb-btn" disabled={busy} onClick={() => setConfirmRevoke(false)}>{t('dshRemote.cancel')}</button>
            <button type="button" className="cb-btn" data-variant="danger" disabled={busy} onClick={() => confirmThen('revoke')}>{t('dshRemote.confirmRevoke')}</button>
          </> : <button type="button" className="cb-btn" data-variant="danger" disabled={busy} onClick={() => setConfirmRevoke(true)}>{t('dshRemote.revoke')}</button>}
        </PanelRow>
      </PanelSplit>
    </>
  }

  return (
    <div data-testid="dsh-remote-host" data-setting-label={t('dshRemote.hostTitle')} className="cb-stage-inner">
      {error && <AuthAlert>{error}</AuthAlert>}
      {body}
    </div>
  )
}
