import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Loader2, QrCode as QrIcon, RefreshCw, ShieldCheck, Smartphone, TriangleAlert } from 'lucide-react'
import { QrCode } from '../../../components/QrCode'
import { NextAction } from './ChannelBoard'
import type { DshHost, DshHostPairing } from './useDshHost'

function countdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** 被控端 → DS 远程 → 扫码配对的起点：还没有二维码时给一个按钮。 */
export function DshHostPairingStart({ host }: { host: DshHost }) {
  const { t } = useTranslation('settings')
  return (
    <NextAction icon={<QrIcon size={18} />} title={t('host.dshPairStartTitle')} testId="dsh-pair-start"
      actions={<button type="button" className="cb-btn" data-variant="primary" disabled={host.busy} onClick={() => void host.manage('pair')}>
        {host.busy ? <Loader2 size={14} className="animate-spin" /> : <QrIcon size={14} />}{t('host.dshPairShow')}
      </button>}>
      {t('host.dshPairStartBody')}
    </NextAction>
  )
}

/**
 * 一轮扫码配对：电脑出二维码，手机扫码后显示 8 位验证码，人在这里输入并确认。
 * 验证码只能在这台电脑的界面里提交，而且只有一次机会。
 */
export function DshHostPairingCard({ host, pairing }: { host: DshHost; pairing: DshHostPairing }) {
  const { t } = useTranslation('settings')
  const { busy, manage } = host
  const [code, setCode] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const ticking = pairing.state === 'created' || pairing.state === 'claimed'

  useEffect(() => {
    if (!ticking) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1_000)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [ticking])

  const phone = pairing.phone?.name || t('host.dshPairPhone')
  const renew = (primary: boolean) => (
    <button type="button" className="cb-btn" data-variant={primary ? 'primary' : undefined} disabled={busy}
      onClick={() => { setCode(''); void manage('pair') }}>
      <RefreshCw size={14} />{t('host.dshPairRenew')}
    </button>
  )
  const cancel = (
    <button type="button" className="cb-btn" disabled={busy} onClick={() => { setCode(''); void manage('pair-cancel') }}>
      {t('dshRemote.cancel')}
    </button>
  )

  if (pairing.state === 'completed') {
    return (
      <NextAction tone="ok" icon={<ShieldCheck size={18} />} title={t('host.dshPairDoneTitle', { phone })} testId="dsh-pair-done"
        actions={<>
          <button type="button" className="cb-btn" data-variant="primary" disabled={busy} onClick={() => void manage('pair-cancel')}>{t('host.dshPairDone')}</button>
          <button type="button" className="cb-btn" disabled={busy} onClick={() => void manage('pair')}>{t('host.dshPairAnother')}</button>
        </>}>
        {t('host.dshPairDoneBody')}
      </NextAction>
    )
  }
  if (pairing.state === 'failed' || pairing.state === 'cancelled' || pairing.state === 'expired') {
    const failed = pairing.state === 'failed'
    return (
      <NextAction tone="warn" icon={<TriangleAlert size={18} />} testId="dsh-pair-ended"
        title={t(failed ? 'host.dshPairFailedTitle' : 'host.dshPairExpiredTitle')} actions={<>{renew(true)}{cancel}</>}>
        {failed
          ? t(`host.dshPairFailed.${pairing.failure || 'default'}`, { defaultValue: t('host.dshPairFailed.default') })
          : t('host.dshPairExpiredBody')}
      </NextAction>
    )
  }
  if (pairing.retry || pairing.state === 'approved') {
    return (
      <NextAction icon={<Loader2 size={18} className={pairing.retry ? undefined : 'animate-spin'} />} testId="dsh-pair-pending"
        title={t(pairing.retry ? 'host.dshPairRetryTitle' : 'host.dshPairFinishing')}
        actions={pairing.retry ? <>
          <button type="button" className="cb-btn" data-variant="primary" disabled={busy} onClick={() => void manage('pair-confirm')}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{t('host.dshPairRetry')}
          </button>
          {cancel}
        </> : undefined}>
        {pairing.retry ? t('host.dshPairRetryBody') : null}
      </NextAction>
    )
  }
  if (pairing.state === 'claimed') {
    const ready = /^\d{8}$/.test(code)
    return (
      <div data-testid="dsh-pair-code">
        <NextAction icon={<Smartphone size={18} />} title={t('host.dshPairCodeTitle')}>
          {t('host.dshPairCodeBody', { phone })}
        </NextAction>
        <form className="mt-4 flex flex-wrap items-center gap-2" onSubmit={event => {
          event.preventDefault()
          if (busy || !ready) return
          void manage('pair-confirm', code).then(() => setCode(''))
        }}>
          <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} autoFocus maxLength={8}
            className="cb-input cb-code-input" data-code={code ? '' : undefined} style={{ width: 190, height: 44 }}
            placeholder={t('host.dshPairCodeLabel')} aria-label={t('host.dshPairCodeLabel')}
            value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))} />
          <button type="submit" className="cb-btn" data-variant="primary" disabled={busy || !ready}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}{t('host.dshPairConfirm')}
          </button>
          {cancel}
        </form>
        <p className="cb-hint mt-3">{t('host.dshPairCodeOnce')}</p>
      </div>
    )
  }
  return (
    <div data-testid="dsh-pair-ticket">
      <div className="cb-ticket">
        <div className="cb-qr">{pairing.qr && <QrCode text={pairing.qr} size={172} />}</div>
        <div className="min-w-0">
          <div className="cb-ticket-top">
            <span className="cb-row-title">{t('host.dshPairScanTitle')}</span>
            <span className="cb-expiry"><Clock size={13} />{t('host.dshPairExpires', { time: countdown(pairing.expiresAt, now) })}</span>
          </div>
          <p className="cb-hint mt-1">{t('host.dshPairScanBody')}</p>
          <span className="cb-label mt-3 block">{t('host.dshPairFingerprint')}</span>
          <code className="cb-addr" data-testid="dsh-pair-fingerprint">{pairing.fingerprint}</code>
          <div className="flex flex-wrap gap-2">{renew(false)}{cancel}</div>
        </div>
      </div>
      <p className="cb-waiting"><span aria-hidden className="cb-waiting-dot" /><span>{t('host.dshPairWaiting')}</span></p>
    </div>
  )
}
