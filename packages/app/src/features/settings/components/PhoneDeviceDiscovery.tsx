import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, LoaderCircle, Monitor, RefreshCw } from 'lucide-react'
import type { DiscoveredDevice } from '@ompiui/protocol'
import { discoverDevices, deviceDiscoveryUrl, supportsDeviceDiscovery } from '../../../utils/deviceDiscovery'
import './channelBoard.css'

type Network = DiscoveredDevice['network']
type DiscoveryState = { devices: DiscoveredDevice[]; loading: boolean; error: string }
const empty = (): DiscoveryState => ({ devices: [], loading: false, error: '' })
const allNetworks: Network[] = ['lan', 'tailscale']

/**
 * 发现到的电脑。默认两个网络都列；传 only 时只列一个网络，并去掉网络小标题。
 * 选中只是填好地址，不代表已经授权。
 */
export function PhoneDeviceDiscovery({ address, disabled, onSelect, only, title, hint, connectedUrls, renderSelected }: {
  address: string
  disabled: boolean
  onSelect: (device: DiscoveredDevice) => void
  only?: Network
  title?: string
  hint?: React.ReactNode
  /** 已经保存过的地址：标成「已连接」，不再提供配对。 */
  connectedUrls?: string[]
  /** 紧贴在选中那台电脑下面的内容，比如就地输入配对码。 */
  renderSelected?: (device: DiscoveredDevice) => React.ReactNode
}) {
  const { t } = useTranslation('settings')
  const supported = supportsDeviceDiscovery()
  const networks = useMemo(() => (only ? [only] : allNetworks), [only])
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
  }, [cancel, networks])
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
  const selectedAddress = address.replace(/\/+$/, '')
  return <div className="cb-list">
    <div className="cb-list-head">
      <span className="cb-row-title">{title ?? t('authentication.discoveryTitle')}</span>
      <button type="button" disabled={disabled} onClick={refresh} className="cb-link">
        <RefreshCw size={12} />{t('authentication.discoveryRefresh')}
      </button>
    </div>
    {networks.map(network => <div key={network} className="grid min-w-0 gap-2">
      {(!only || states[network].loading) && <div className="cb-label flex items-center gap-2">
        {!only && t(`authentication.discoveryNetwork.${network}`)}
        {states[network].loading && <LoaderCircle size={12} className="animate-spin" />}
      </div>}
      {states[network].error && <p role="status" className="cb-hint break-words">
        {errorText(states[network].error)}
      </p>}
      {!states[network].loading && !states[network].error && states[network].devices.length === 0 &&
        <p className="cb-hint">{t(`authentication.discoveryEmpty.${network}`)}</p>}
      {states[network].devices.map(device => {
        const url = deviceDiscoveryUrl(device)
        const key = `${device.instanceId}:${url}`
        const label = <>
          <Monitor size={17} />
          <span className="cb-device-main">
            <span className="cb-device-name">{device.displayName}</span>
            <span className="cb-device-meta font-mono">{url}</span>
          </span>
        </>
        if (connectedUrls?.includes(url)) {
          return <div key={key} className="cb-device">{label}<span className="cb-tag">{t('controller.alreadyConnected')}</span></div>
        }
        const selected = selectedAddress === url
        const extra = selected ? renderSelected?.(device) : null
        return <Fragment key={key}>
          <button type="button" disabled={disabled} aria-pressed={selected} data-expanded={extra ? '' : undefined}
            onClick={() => onSelect(device)} className="cb-device">
            {label}
            {selected && <Check size={15} className="text-accent-main-100" />}
          </button>
          {extra}
        </Fragment>
      })}
    </div>)}
    <p className="cb-hint">{hint ?? t('authentication.discoveryHint')}</p>
  </div>
}
