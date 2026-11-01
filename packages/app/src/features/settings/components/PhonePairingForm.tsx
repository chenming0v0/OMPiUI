import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, Link2, LoaderCircle, ScanLine } from 'lucide-react'
import { AuthAlert, authPrimaryButtonClass, authSecondaryButtonClass } from './AuthPanelUI'
import { useRouter, useServerStore } from '../../../hooks'
import { parseConnectionLink, parseDisplayCode, parsePairingServerAddress, resolveConnectionLink } from '../../../utils/connectionLink'
import { redeemDisplayCode } from '../../../omp/transport'
import { scanPairingQr } from '../../../utils/qrScanner'
import { clearSessionRuntimeState } from '../../../utils/sessionLifecycle'
import { settingsFieldAreaClass, settingsFieldClass } from './SettingsUI'

export function PhonePairingForm({ onPaired }: { onPaired?: () => void }) {
  const { t } = useTranslation('settings')
  const [input, setInput] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState<'scanning' | 'connecting' | null>(null)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const inFlight = useRef(false)
  const { addServer, setActiveServer, checkHealth } = useServerStore()
  const { navigateHome, sessionId } = useRouter()
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
    const server = addServer({ name: new URL(result.url).host, url: result.url, token: result.token })
    if (sessionId) clearSessionRuntimeState(sessionId)
    setActiveServer(server.id)
    navigateHome()
    void checkHealth(server.id)
    setInput('')
    setConnected(true)
    onPaired?.()
  }

  const run = async (scan: boolean, value = input) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(scan ? 'scanning' : 'connecting')
    setError('')
    setConnected(false)
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

  return (
    <form onSubmit={event => { event.preventDefault(); void run(false) }}
      aria-busy={busy !== null} className="grid min-w-0 gap-3">
      <button type="button" disabled={busy !== null} onClick={() => void run(true)}
        className={`${authPrimaryButtonClass} min-h-12 w-full text-[length:var(--fs-sm)]`}>
        {busy === 'scanning' ? <LoaderCircle size={18} className="animate-spin" /> : <ScanLine size={18} />}
        {t('authentication.scan')}
      </button>
      <label htmlFor="phone-pairing-link"
        className="flex items-center gap-3 pt-1 text-[length:var(--fs-xs)] text-text-400 before:h-px before:flex-1 before:bg-border-200/60 after:h-px after:flex-1 after:bg-border-200/60">
        {t('authentication.pairingInfo')}
      </label>
      <textarea id="phone-pairing-link" rows={3} value={input} disabled={busy !== null}
        autoCapitalize="none" autoCorrect="off" spellCheck={false}
        placeholder={t('authentication.pairingPlaceholder')}
        onChange={event => { setInput(event.target.value); setError(''); setConnected(false) }}
        onPaste={event => {
          const text = event.clipboardData.getData('text')
          if (!text) return
          const field = event.currentTarget
          const value = input.slice(0, field.selectionStart) + text + input.slice(field.selectionEnd)
          event.preventDefault()
          setInput(value)
          setError('')
          setConnected(false)
          if (parseConnectionLink(value)) void run(false, value)
        }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          void run(false)
        }}
        className={`${settingsFieldAreaClass} break-all font-mono text-[length:var(--fs-xs)]`} />
      {manualCode && <div className="grid min-w-0 gap-2">
        <label htmlFor="phone-pairing-address" className="text-[length:var(--fs-xs)] font-medium text-text-200">
          {t('authentication.serverAddress')}
        </label>
        <input id="phone-pairing-address" type="text" inputMode="url" value={address} disabled={busy !== null}
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          aria-describedby="phone-pairing-address-hint"
          placeholder={t('authentication.serverAddressPlaceholder')}
          onChange={event => { setAddress(event.target.value); setError(''); setConnected(false) }}
          className={`${settingsFieldClass} min-h-11 font-mono text-[length:var(--fs-xs)]`} />
        <p id="phone-pairing-address-hint" className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">
          {t('authentication.manualCodeHint')}
        </p>
      </div>}
      {parsed && <p className="flex min-w-0 items-center gap-1.5 break-all rounded-md bg-bg-200/50 px-2.5 py-1.5 font-mono text-[length:var(--fs-xs)] text-text-300">
        <Link2 size={13} className="shrink-0 text-accent-main-100" />{parsed.url}
      </p>}
      {error && <AuthAlert>{error}</AuthAlert>}
      {connected && <p role="status" className="flex items-center gap-2 rounded-lg border border-success-100/25 bg-success-100/10 px-3 py-2 text-[length:var(--fs-xs)] text-success-100">
        <CircleCheck size={14} className="shrink-0" />{t('authentication.connected')}
      </p>}
      <button type="submit" disabled={busy !== null || !input.trim()}
        className={`${authSecondaryButtonClass} min-h-11 w-full text-[length:var(--fs-sm)]`}>
        {busy === 'connecting' ? <LoaderCircle size={16} className="animate-spin" /> : <Link2 size={16} />}
        {t('authentication.connect')}
      </button>
    </form>
  )
}
