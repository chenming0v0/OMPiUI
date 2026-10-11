import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link2, LoaderCircle, ScanLine } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { useRouter, useServerStore } from '../../../hooks'
import { parseConnectionLink, resolveConnectionLink } from '../../../utils/connectionLink'
import { scanPairingQr } from '../../../utils/qrScanner'
import { clearSessionRuntimeState } from '../../../utils/sessionLifecycle'
import { settingsFieldAreaClass } from './SettingsUI'

export function PhonePairingForm({ onPaired }: { onPaired?: () => void }) {
  const { t } = useTranslation('settings')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<'scanning' | 'connecting' | null>(null)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const inFlight = useRef(false)
  const { addServer, setActiveServer, checkHealth } = useServerStore()
  const { navigateHome, sessionId } = useRouter()
  const parsed = parseConnectionLink(input)

  const connect = async (value: string) => {
    const link = parseConnectionLink(value)
    if (!link) throw new Error('invalidLink')
    setBusy('connecting')
    const result = await resolveConnectionLink(link)
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
      const localErrors = ['invalidLink', 'scanUnavailable', 'scanPermissionDenied', 'scanFailed']
      setError(localErrors.includes(message) ? t(`authentication.${message}`) : message)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  return (
    <form onSubmit={event => { event.preventDefault(); void run(false) }}
      aria-busy={busy !== null} className="mt-4 grid min-w-0 gap-3 border-t border-border-200/60 pt-4">
      <label htmlFor="phone-pairing-link" className="text-[length:var(--fs-sm)] font-medium text-text-200">
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
        className={`${settingsFieldAreaClass} break-all font-mono`} />
      {parsed && <p className="break-all text-[length:var(--fs-xs)] text-text-300">{parsed.url}</p>}
      {error && <p role="alert" className="break-words text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      {connected && <p role="status" className="text-[length:var(--fs-xs)] text-success-100">
        {t('authentication.connected')}
      </p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" className="min-h-11" disabled={busy !== null} onClick={() => void run(true)}>
          {busy === 'scanning' ? <LoaderCircle size={16} className="animate-spin" /> : <ScanLine size={16} />}
          {t('authentication.scan')}
        </Button>
        <Button type="submit" className="min-h-11" disabled={busy !== null || !input.trim()}>
          {busy === 'connecting' ? <LoaderCircle size={16} className="animate-spin" /> : <Link2 size={16} />}
          {t('authentication.connect')}
        </Button>
      </div>
    </form>
  )
}
