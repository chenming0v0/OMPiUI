import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiscoveredDevice } from '@ompiui/protocol'
import { discoverDevices } from '../../../utils/deviceDiscovery'

type Network = DiscoveredDevice['network']
type DiscoveryState = { devices: DiscoveredDevice[]; loading: boolean; error: string }
const empty = (): DiscoveryState => ({ devices: [], loading: false, error: '' })

/** 在一个网络里找电脑。enabled 为假时不扫描（比如虚拟组网还没连上）；页面切到后台就停。 */
export function useDeviceDiscovery(network: Network, enabled: boolean) {
  const [state, setState] = useState<DiscoveryState>(empty)
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
    setState({ ...empty(), loading: true })
    void discoverDevices(network, scan.signal).then(devices => {
      if (scan.signal.aborted || current !== generation.current) return
      setState({ devices, loading: false, error: '' })
    }).catch(reason => {
      if (scan.signal.aborted || current !== generation.current) return
      const message = reason instanceof Error ? reason.message : String(reason)
      const code = message.split(':', 1)[0]
      const error = message.startsWith('Tailscale discovery unavailable: node is stopped') || message.startsWith('Tailscale discovery requires Running state')
        ? 'discoveryTailscaleLogin' : code.startsWith('discovery') ? code : message
      setState({ ...empty(), error })
    })
  }, [cancel, network])
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    const start = setTimeout(() => {
      if (!disposed && !document.hidden) refresh()
    }, 0)
    const visibility = () => {
      if (!document.hidden) return
      cancel()
      setState(previous => ({ ...previous, loading: false }))
    }
    document.addEventListener('visibilitychange', visibility)
    return () => { disposed = true; clearTimeout(start); cancel(); document.removeEventListener('visibilitychange', visibility) }
  }, [enabled, refresh, cancel])
  return { ...state, refresh }
}

export type DeviceDiscovery = ReturnType<typeof useDeviceDiscovery>
