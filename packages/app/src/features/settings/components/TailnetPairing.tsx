import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link2, LoaderCircle } from 'lucide-react'
import { useServerStore } from '../../../hooks'
import { redeemDisplayCode } from '../../../omp/transport'
import { parseDisplayCode } from '../../../utils/connectionLink'
import { deviceDiscoveryUrl } from '../../../utils/deviceDiscovery'
import { AuthAlert } from './AuthPanelUI'
import { PhoneDeviceDiscovery } from './PhoneDeviceDiscovery'
import { useServerConnect } from './useServerConnect'

/** 虚拟组网里的电脑：点一台，就地输入它的 8 位配对码。 */
export function TailnetPairing({ onPaired }: { onPaired?: () => void }) {
  const { t } = useTranslation('settings')
  const { servers } = useServerStore()
  const connectServer = useServerConnect()
  const [picked, setPicked] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const connectedUrls = useMemo(() => servers.map(server => server.url), [servers])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    const digits = parseDisplayCode(code)
    if (!digits) { setError(t('authentication.invalidCode')); return }
    setBusy(true)
    setError('')
    try {
      const result = await redeemDisplayCode(digits, picked, AbortSignal.timeout(15_000))
      connectServer(result, 'pair')
      setPicked('')
      setCode('')
      onPaired?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-w-0 gap-3" data-testid="tailnet-pairing">
      <PhoneDeviceDiscovery only="tailscale" address={picked} disabled={false} connectedUrls={connectedUrls}
        title={t('controller.tailnetComputers')} hint={t('controller.tailnetHint')}
        onSelect={device => {
          if (busy) return
          const url = deviceDiscoveryUrl(device)
          setPicked(previous => (previous === url ? '' : url))
          setCode('')
          setError('')
        }}
        renderSelected={device => (
          <form className="cb-inline-pair" aria-busy={busy} onSubmit={event => void submit(event)}>
            <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} autoFocus
              className="cb-input cb-code-input" data-code={code ? '' : undefined} disabled={busy}
              aria-label={t('controller.tailnetCode', { name: device.displayName })}
              placeholder={t('controller.tailnetCode', { name: device.displayName })}
              value={code} onChange={event => { setCode(event.target.value); setError('') }} />
            <button type="submit" className="cb-btn cb-pair-go touch-target-sm" data-variant="primary" disabled={busy || !code.trim()}>
              {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Link2 size={15} />}
              {t('authentication.connect')}
            </button>
          </form>
        )} />
      {error && <AuthAlert>{error}</AuthAlert>}
    </div>
  )
}
