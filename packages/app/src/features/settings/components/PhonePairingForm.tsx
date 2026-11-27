import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, Link2, LoaderCircle, Plus, ScanLine } from 'lucide-react'
import { AuthAlert } from './AuthPanelUI'
import { NextAction } from './ChannelBoard'
import { parseConnectionLink, parseDisplayCode, parsePairingServerAddress, resolveConnectionLink } from '../../../utils/connectionLink'
import { redeemDisplayCode } from '../../../omp/transport'
import { scanPairingQr } from '../../../utils/qrScanner'
import { PhoneDeviceDiscovery } from './PhoneDeviceDiscovery'
import { deviceDiscoveryUrl } from '../../../utils/deviceDiscovery'
import { isTauriMobile } from '../../../utils/tauri'
import { useServerConnect } from './useServerConnect'

/** 配对：扫码、粘贴配对链接，或输入 8 位配对码加电脑地址。 */
export function PhonePairingForm({ onPaired, onOpenServers, onOpenTailscale }: {
  onPaired?: () => void
  onOpenServers?: () => void
  /** 有「虚拟组网」通道时，发现列表只列局域网，并指路到那条通道。 */
  onOpenTailscale?: () => void
}) {
  const { t } = useTranslation('settings')
  const [input, setInput] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState<'scanning' | 'connecting' | null>(null)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState('')
  const inFlight = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const connectServer = useServerConnect()
  const parsed = parseConnectionLink(input)
  const manualCode = !parsed && /^[\d\s-]+$/.test(input.trim())

  const connect = async (value: string) => {
    const link = parseConnectionLink(value)
    const code = link ? null : parseDisplayCode(value)
    if (!link && !code) throw new Error(/^[\d\s-]+$/.test(value.trim()) ? 'invalidCode' : 'invalidLink')
    const base = code ? parsePairingServerAddress(address) : null
    if (code && !base) throw new Error(address.trim() ? 'invalidAddress' : 'addressRequired')
    setBusy('connecting')
    const result = link
      ? await resolveConnectionLink(link)
      : await redeemDisplayCode(code!, base!, AbortSignal.timeout(15_000))
    connectServer(result, link && !link.pair ? 'manual' : 'pair')
    setInput('')
    setAddress('')
    setConnected(new URL(result.url).host)
    onPaired?.()
  }

  const run = async (scan: boolean, value = input) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(scan ? 'scanning' : 'connecting')
    setError('')
    try {
      if (scan) {
        const contents = await scanPairingQr(t('authentication.scanPrompt'))
        if (contents === null) return
        setInput(contents)
        await connect(contents)
      } else {
        await connect(value)
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const localErrors = ['invalidLink', 'invalidCode', 'addressRequired', 'invalidAddress', 'scanUnavailable', 'scanPermissionDenied', 'scanFailed']
      setError(localErrors.includes(message) ? t(`authentication.${message}`) : message)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  if (connected) {
    return (
      <div role="status">
        <NextAction tone="ok" icon={<CircleCheck size={18} />} title={t('authentication.connected')}
          actions={<>
            {onOpenServers && <button type="button" className="cb-btn" onClick={onOpenServers}>{t('controller.openServers')}</button>}
            <button type="button" className="cb-btn" onClick={() => setConnected('')}><Plus size={14} />{t('controller.pairAnother')}</button>
          </>}>
          {t('controller.pairedBody', { name: connected })}
        </NextAction>
      </div>
    )
  }

  return (
    <form onSubmit={event => { event.preventDefault(); void run(false) }} aria-busy={busy !== null} className="cb-form">
      {/* 扫码依赖手机 App 的相机桥接，桌面和网页只提供粘贴与手动输入。 */}
      {isTauriMobile() && <>
        <button type="button" disabled={busy !== null} onClick={() => void run(true)}
          className="cb-btn touch-target-sm" data-variant="primary" data-size="xl">
          {busy === 'scanning' ? <LoaderCircle size={19} className="animate-spin" /> : <ScanLine size={19} />}
          {t('authentication.scan')}
        </button>
        <div className="cb-or">{t('authentication.orManual')}</div>
      </>}
      <PhoneDeviceDiscovery address={address} disabled={busy !== null} only={onOpenTailscale ? 'lan' : undefined}
        title={onOpenTailscale ? t('controller.lanFound') : undefined}
        hint={onOpenTailscale && <>
          {t('authentication.discoveryHint')}{' '}
          <button type="button" className="cb-link" onClick={onOpenTailscale}>{t('controller.pairOverTailscale')}</button>
        </>}
        onSelect={device => {
          setAddress(deviceDiscoveryUrl(device))
          setError('')
          if (parsed) setInput('')
          inputRef.current?.focus()
        }} />
      <div className="cb-pair-row">
        <div className="cb-field">
          <label htmlFor="phone-pairing-link" className="cb-row-title">{t('authentication.pairingInfo')}</label>
          <input ref={inputRef} id="phone-pairing-link" type="text" value={input} disabled={busy !== null}
            autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
            placeholder={t('authentication.pairingPlaceholder')}
            data-code={manualCode ? '' : undefined}
            onChange={event => { setInput(event.target.value); setError('') }}
            onPaste={event => {
              const text = event.clipboardData.getData('text')
              if (!text) return
              const field = event.currentTarget
              const value = input.slice(0, field.selectionStart ?? input.length) + text + input.slice(field.selectionEnd ?? input.length)
              event.preventDefault()
              setInput(value)
              setError('')
              if (parseConnectionLink(value)) void run(false, value)
            }}
            className="cb-input cb-code-input" />
        </div>
        <div className="cb-field">
          <label htmlFor="phone-pairing-address" className="cb-row-title">{t('authentication.serverAddress')}</label>
          <input id="phone-pairing-address" type="text" inputMode="url" value={address} disabled={busy !== null || Boolean(parsed)}
            autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
            aria-describedby="phone-pairing-hint"
            placeholder={parsed ? t('authentication.addressInLink') : t('authentication.serverAddressPlaceholder')}
            onChange={event => { setAddress(event.target.value); setError('') }}
            className="cb-input font-mono" />
        </div>
        <button type="submit" disabled={busy !== null || !input.trim()} className="cb-btn cb-pair-go touch-target-sm" data-variant="primary">
          {busy === 'connecting' ? <LoaderCircle size={15} className="animate-spin" /> : <Link2 size={15} />}
          {t('authentication.connect')}
        </button>
      </div>
      {parsed
        ? <p id="phone-pairing-hint" className="cb-parsed"><Link2 size={13} />{parsed.url}</p>
        : <p id="phone-pairing-hint" className="cb-hint">{t('authentication.manualCodeHint')}</p>}
      {error && <AuthAlert>{error}</AuthAlert>}
    </form>
  )
}
