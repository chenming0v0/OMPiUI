import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, LoaderCircle, Monitor, RefreshCw } from 'lucide-react'
import type { DiscoveredDevice } from '@ompiui/protocol'
import { discoverDevices, deviceDiscoveryUrl, supportsDeviceDiscovery } from '../../../utils/deviceDiscovery'

type Network = DiscoveredDevice['network']
type DiscoveryState = { devices: DiscoveredDevice[]; loading: boolean; error: string }
const empty = (): DiscoveryState => ({ devices: [], loading: false, error: '' })
const networks: Network[] = ['lan', 'tailscale']

export function PhoneDeviceDiscovery({ address, disabled, onSelect }: {
  address: string; disabled: boolean; onSelect: (device: DiscoveredDevice) => void
}) {
  const { t } = useTranslation('settings')
  const supported = supportsDeviceDiscovery()
  const [states, setStates] = useState<Record<Network, DiscoveryState>>({ lan: empty(), tailscale: empty() })
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const cancel = useCallback(() => {
    generation.current++
    controller.current?.abort()
    controller.current = null
  }, [])
  const refresh = useCallback(() => {
    cancel()
    const current = generation.current
    const scan = new AbortController()
    controller.current = scan
    setStates({ lan: { ...empty(), loading: true }, tailscale: { ...empty(), loading: true } })
    for (const network of networks) {
      void discoverDevices(network, scan.signal).then(devices => {
        if (scan.signal.aborted || current !== generation.current) return
        setStates(previous => ({ ...previous, [network]: { devices, loading: false, error: '' } }))
      }).catch(reason => {
        if (scan.signal.aborted || current !== generation.current) return
        const message = reason instanceof Error ? reason.message : String(reason)
        const code = message.split(':', 1)[0]
        const error = message.startsWith('Tailscale discovery unavailable: node is stopped') || message.startsWith('Tailscale discovery requires Running state')
          ? 'discoveryTailscaleLogin' : code.startsWith('discovery') ? code : message
        setStates(previous => ({ ...previous, [network]: { ...empty(), error } }))
      })
    }
  }, [cancel])
  useEffect(() => {
    if (!supported) return
    let disposed = false
    const start = setTimeout(() => {
      if (disposed) return
      if (!disabled && !document.hidden) refresh()
      else {
        cancel()
        setStates(previous => ({ lan: { ...previous.lan, loading: false }, tailscale: { ...previous.tailscale, loading: false } }))
      }
    }, 0)
    const visibility = () => {
      if (!document.hidden) return
      cancel()
      setStates(previous => ({ lan: { ...previous.lan, loading: false }, tailscale: { ...previous.tailscale, loading: false } }))
    }
    document.addEventListener('visibilitychange', visibility)
    return () => { disposed = true; clearTimeout(start); cancel(); document.removeEventListener('visibilitychange', visibility) }
  }, [supported, disabled, refresh, cancel])
  if (!supported) return null
  const localErrors = ['discoveryUnavailable', 'discoveryTimeout', 'discoveryPermissionDenied', 'discoveryTailscaleLogin', 'discoveryBusy', 'discoveryFailed']
  const errorText = (message: string) => localErrors.includes(message)
    ? t(`authentication.${message}`) : message.startsWith('discovery') ? t('authentication.discoveryFailed') : message
  return <div className="grid min-w-0 gap-3 rounded-lg border border-border-200/60 bg-bg-200/30 p-3">
    <div className="flex items-center justify-between gap-2">
      <span className="text-[length:var(--fs-sm)] font-medium text-text-100">{t('authentication.discoveryTitle')}</span>
      <button type="button" disabled={disabled} onClick={refresh}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] text-accent-main-100 hover:bg-accent-main-100/10 disabled:opacity-50">
        <RefreshCw size={13} />{t('authentication.discoveryRefresh')}
      </button>
    </div>
    <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('authentication.discoveryHint')}</p>
    {networks.map(network => <div key={network} className="grid min-w-0 gap-2">
      <div className="flex items-center gap-2 text-[length:var(--fs-xs)] font-medium text-text-300">
        {t(`authentication.discoveryNetwork.${network}`)}
        {states[network].loading && <LoaderCircle size={12} className="animate-spin" />}
      </div>
      {states[network].error && <p role="status" className="break-words text-[length:var(--fs-xs)] leading-relaxed text-text-400">
        {errorText(states[network].error)}
      </p>}
      {!states[network].loading && !states[network].error && states[network].devices.length === 0 &&
        <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t(`authentication.discoveryEmpty.${network}`)}</p>}
      {states[network].devices.map(device => {
        const url = deviceDiscoveryUrl(device)
        const selected = address.replace(/\/+$/, '') === url
        return <button key={`${device.instanceId}:${url}`} type="button" disabled={disabled} aria-pressed={selected}
          onClick={() => onSelect(device)}
          className={`flex min-h-12 min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${selected ? 'border-accent-main-100/50 bg-accent-main-100/10' : 'border-border-200/60 bg-bg-100 hover:border-border-300'}`}>
          <Monitor size={16} className="shrink-0 text-accent-main-100" />
          <span className="grid min-w-0 flex-1 gap-1">
            <span className="break-words text-[length:var(--fs-xs)] font-medium text-text-100">{device.displayName}</span>
            <span className="break-all font-mono text-[length:var(--fs-xs)] text-text-400">{url}</span>
          </span>
          {selected && <Check size={14} className="shrink-0 text-accent-main-100" />}
        </button>
      })}
    </div>)}
  </div>
}
