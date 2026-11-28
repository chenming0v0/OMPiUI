import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Wifi } from 'lucide-react'
import type { DiscoveredDevice } from '@ompiui/protocol'
import { useServerStore } from '../../../hooks'
import { redeemDisplayCode } from '../../../omp/transport'
import { parseDisplayCode } from '../../../utils/connectionLink'
import { deviceDiscoveryUrl } from '../../../utils/deviceDiscovery'
import { AuthAlert } from './AuthPanelUI'
import type { DeviceDiscovery } from './useDeviceDiscovery'
import { useServerConnect, useServerSelect } from './useServerConnect'
import './channelBoard.css'

type Network = DiscoveredDevice['network']

const localErrors = ['discoveryUnavailable', 'discoveryTimeout', 'discoveryPermissionDenied', 'discoveryTailscaleLogin', 'discoveryBusy', 'discoveryFailed']

/**
 * 发现到的电脑，和服务器页是同一种行。
 * 已经保存过的：点一下切换过去。没连过的：点一下就地输入它「被控端」页的 8 位配对码。
 */
export function DiscoveredRows({ network, discovery, onPaired }: {
  network: Network
  discovery: DeviceDiscovery
  onPaired?: () => void
}) {
  const { t } = useTranslation('settings')
  const { servers, activeServer } = useServerStore()
  const selectServer = useServerSelect()
  const connectServer = useServerConnect()
  const [picked, setPicked] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { devices, loading, error: scanError } = discovery

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

  return <>
    {scanError && <p role="status" className="cb-hint break-words">
      {localErrors.includes(scanError) ? t(`authentication.${scanError}`)
        : scanError.startsWith('discovery') ? t('authentication.discoveryFailed') : scanError}
    </p>}
    {!loading && !scanError && devices.length === 0 && <p className="cb-hint">{t(`authentication.discoveryEmpty.${network}`)}</p>}
    {devices.map(device => {
      const url = deviceDiscoveryUrl(device)
      const saved = servers.find(server => server.url.replace(/\/+$/, '') === url)
      const current = Boolean(saved && activeServer?.id === saved.id)
      const open = !saved && picked === url
      return (
        <div key={`${device.instanceId}:${url}`} className="cb-srv" data-current={current ? '' : undefined} data-testid="discovered-row">
          <div className="cb-srv-line">
            <button type="button" className="cb-srv-main touch-target-sm" aria-current={current ? 'true' : undefined}
              aria-expanded={saved ? undefined : open}
              onClick={() => {
                if (saved) { selectServer(saved.id); return }
                if (busy) return
                setPicked(open ? '' : url)
                setCode('')
                setError('')
              }}>
              <span className="cb-srv-name">{device.displayName}</span>
              <span className="cb-srv-meta"><code>{url}</code></span>
            </button>
            <div className="cb-srv-actions">
              <span className="cb-stat" data-tone="on" title={t('dshRemote.online')}><Wifi size={15} /></span>
            </div>
          </div>
          {open && (
            <div className="cb-srv-ext">
              <form className="cb-pair" aria-busy={busy} onSubmit={event => void submit(event)}>
                <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} autoFocus maxLength={9}
                  className="cb-input font-mono" disabled={busy}
                  aria-label={t('controller.tailnetCode', { name: device.displayName })}
                  placeholder={t('controller.pairCodePlaceholder')}
                  value={code} onChange={event => { setCode(event.target.value); setError('') }} />
                <button type="submit" className="cb-btn" data-variant="primary" disabled={busy || !code.trim()}>
                  {busy && <Loader2 size={14} className="animate-spin" />}
                  {t('controller.connect')}
                </button>
              </form>
              {error && <AuthAlert>{error}</AuthAlert>}
            </div>
          )}
        </div>
      )
    })}
  </>
}
