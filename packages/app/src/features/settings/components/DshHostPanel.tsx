import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'
import { DSH_REMOTE_ORIGIN } from '@ompiui/protocol/dsh-remote'
import { AuthAlert } from './AuthPanelUI'
import { NextAction, PanelRow, PanelSplit, Step, Steps } from './ChannelBoard'
import { Toggle } from './SettingsUI'
import type { DshHost } from './useDshHost'

const portal = `${DSH_REMOTE_ORIGIN}/app`

async function openSite(url: string) {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

/** 被控端 → DS 远程：把这台电脑绑定到账号，再决定要不要放开远程访问。 */
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

  const hostError = (errorCode: string, message = '') =>
    t(`dshRemote.hostError.${errorCode || 'default'}`, { defaultValue: message || t('dshRemote.hostError.default') })
  const error = portalFailed ? t('dshRemote.portalFailed')
    : failure ? (failure.code ? hostError(failure.code, failure.message) : t('dshRemote.hostOperationFailed')) : ''
  const unavailable = status?.reason === 'loopback' ? t('dshRemote.hostLoopbackOnly') : t('dshRemote.hostNoWeb')
  const lastError = status?.lastError
  const warning = status && (status.available || unreadable) && lastError && state !== 'unregistered' && state !== 'disabled'
    ? hostError(lastError.code, lastError.message) : ''
  const confirmThen = (action: 'revoke' | 'reset') => {
    if (!confirmRevoke) { setConfirmRevoke(true); return }
    void manage(action).then(done => { if (done) setConfirmRevoke(false) })
  }

  let body: React.ReactNode
  if (!status) {
    body = unreachable
      ? <NextAction tone="warn" icon={<TriangleAlert size={18} />} title={t('dshRemote.hostUnavailableShort')}>{t('dshRemote.hostUnavailable')}</NextAction>
      : <p className="cb-hint flex items-center gap-2"><Loader2 size={13} className="animate-spin" />{t('dshRemote.hostLoading')}</p>
  } else if (!status.available && !unreadable) {
    body = <NextAction tone="warn" icon={<TriangleAlert size={18} />} title={t('dshRemote.hostUnavailableShort')}>{unavailable}</NextAction>
  } else if (unreadable) {
    body = (
      <NextAction tone="warn" icon={<TriangleAlert size={18} />} title={t('dshRemote.hostState.error')}
        actions={<button type="button" className="cb-btn" data-variant={confirmRevoke ? 'danger' : undefined} disabled={busy} onClick={() => confirmThen('reset')}>
          {t(confirmRevoke ? 'dshRemote.confirmReset' : 'dshRemote.resetBinding')}
        </button>}>
        {warning}
      </NextAction>
    )
  } else if (!status.registered) {
    body = (
      <Steps>
        <Step index={1} title={t('dshRemote.stepPortal')}>
          <p>{t('dshRemote.stepPortalDesc')}</p>
          <button type="button" className="cb-btn w-fit" onClick={() => { setPortalFailed(false); void openSite(portal).catch(() => setPortalFailed(true)) }}>
            <ExternalLink size={14} />{t('dshRemote.portal')}
          </button>
        </Step>
        <Step index={2} title={t('dshRemote.stepBind')}>
          <form className="flex flex-wrap items-center gap-2" onSubmit={event => {
            event.preventDefault()
            if (busy) return
            setPortalFailed(false)
            void manage('register', code).then(done => { if (done) setCode('') })
          }}>
            <input type="text" autoComplete="off" spellCheck={false}
              className="cb-input font-mono uppercase tracking-[0.18em]" style={{ width: 170 }}
              placeholder="XXXX-XXXX" maxLength={9} aria-label={t('dshRemote.hostCode')}
              value={code} onChange={event => setCode(event.target.value.toUpperCase())} />
            <button type="submit" className="cb-btn" data-variant="primary" disabled={busy || !/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(code.trim())}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}{t('dshRemote.register')}
            </button>
          </form>
          <p>{t('dshRemote.bindNote')}</p>
        </Step>
      </Steps>
    )
  } else {
    const online = state === 'online'
    body = <>
      <NextAction tone={online ? 'ok' : warning ? 'warn' : 'idle'}
        icon={state === 'connecting' ? <Loader2 size={18} className="animate-spin" /> : <ShieldCheck size={18} />}
        title={t(online ? 'host.dshOnlineTitle' : state === 'connecting' ? 'dshRemote.hostConnectingDesc' : state === 'error' ? 'dshRemote.hostState.error' : 'host.dshOffTitle')}>
        {warning || t('host.dshBody')}
      </NextAction>
      <PanelSplit>
        <PanelRow title={t('host.dshAccess')} hint={t('host.dshAccessHint')} label={t('host.dshAccess')}>
          <Toggle enabled={status.enabled} disabled={busy} ariaLabel={t('host.dshAccess')}
            onChange={() => void manage(status.enabled ? 'disable' : 'enable')} />
        </PanelRow>
        <PanelRow title={t('host.dshBinding')}
          hint={<>{status.deviceId && <><code className="font-mono">{status.deviceId}</code>{' · '}</>}{t('host.dshBindingHint')}</>}>
          {confirmRevoke ? <>
            <button type="button" className="cb-btn" data-variant="danger" disabled={busy} onClick={() => confirmThen('revoke')}>{t('dshRemote.confirmRevoke')}</button>
            <button type="button" className="cb-btn" disabled={busy} onClick={() => setConfirmRevoke(false)}>{t('dshRemote.cancel')}</button>
          </> : <button type="button" className="cb-btn" disabled={busy} onClick={() => setConfirmRevoke(true)}>{t('dshRemote.revoke')}</button>}
        </PanelRow>
      </PanelSplit>
    </>
  }

  return (
    <div data-testid="dsh-remote-host" data-setting-label={t('dshRemote.hostTitle')} className="min-w-0">
      {error && <div className="mb-4"><AuthAlert>{error}</AuthAlert></div>}
      {body}
    </div>
  )
}
