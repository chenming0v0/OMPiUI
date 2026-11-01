import { parseDeviceDiscoveryInfo, type DiscoveredDevice } from '@ompiui/protocol'
import { discoverAndroidTailscale, isAndroidTailscalePlatform, isTailnetUrl } from './androidTailscale'

type DiscoveryBridge = { request(id: string, method: string, payload: string): void }
declare global {
  interface Window { __ompiui_device_discovery?: DiscoveryBridge }
}

export const supportsDeviceDiscovery = isAndroidTailscalePlatform

export function deviceDiscoveryUrl(device: Pick<DiscoveredDevice, 'address' | 'port'>): string {
  return `http://${device.address.includes(':') ? `[${device.address}]` : device.address}:${device.port}`
}

export function parseDiscoveredDevices(value: unknown, network: DiscoveredDevice['network']): DiscoveredDevice[] {
  if (!Array.isArray(value)) return []
  const devices = new Map<string, DiscoveredDevice>()
  for (const entry of value.slice(0, 64)) {
    const info = parseDeviceDiscoveryInfo(entry)
    const address = entry?.address
    if (!info || typeof address !== 'string' || address.includes('%')) continue
    const parts = address.split('.')
    const ipv4 = parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    const ipv6 = address.includes(':') && /^[a-f\d:]+$/i.test(address)
    if (!ipv4 && !ipv6) continue
    if (ipv4 && (Number(parts[0]) === 0 || Number(parts[0]) === 127 || Number(parts[0]) >= 224)) continue
    if (['::', '::1'].includes(address) || address.toLowerCase().startsWith('ff') || address.toLowerCase().startsWith('fe80:')) continue
    if (network === 'lan' && ipv4) {
      const [a, b] = parts.map(Number)
      if (!(a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254)) continue
    }
    if (network === 'lan' && ipv6 && !/^(fc|fd)/i.test(address)) continue
    const device: DiscoveredDevice = { ...info, address, network }
    try {
      const url = new URL(deviceDiscoveryUrl(device))
      if (network === 'tailscale' ? !isTailnetUrl(url.href) : isTailnetUrl(url.href)) continue
    } catch { continue }
    devices.set(`${info.instanceId}:${address}:${info.port}`, device)
  }
  return [...devices.values()].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.address.localeCompare(b.address))
}

async function discoverLan(signal: AbortSignal): Promise<unknown> {
  for (let attempt = 0; !window.__ompiui_device_discovery && attempt < 30; attempt++) {
    signal.throwIfAborted()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  signal.throwIfAborted()
  const bridge = window.__ompiui_device_discovery
  if (!bridge) throw new Error('discoveryUnavailable')
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      window.removeEventListener('ompiui-discovery-result', listener)
    }
    const cancelNative = () => {
      try { bridge.request(crypto.randomUUID(), 'cancel', JSON.stringify({ requestId: id })) } catch { /* Native activity may be closed. */ }
    }
    const abort = () => { cleanup(); cancelNative(); reject(signal.reason) }
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; result?: unknown; error?: string }>).detail
      if (detail?.id !== id) return
      cleanup()
      if (detail.error) reject(new Error(detail.error))
      else resolve(detail.result)
    }
    const timer = setTimeout(() => { cleanup(); cancelNative(); reject(new Error('discoveryTimeout')) }, 10_000)
    window.addEventListener('ompiui-discovery-result', listener)
    signal.addEventListener('abort', abort, { once: true })
    try { bridge.request(id, 'discover', '{}') } catch (error) { cleanup(); reject(error) }
  })
}

export async function discoverDevices(network: DiscoveredDevice['network'], signal: AbortSignal): Promise<DiscoveredDevice[]> {
  const result = network === 'lan' ? await discoverLan(signal) : await discoverAndroidTailscale(signal)
  signal.throwIfAborted()
  return parseDiscoveredDevices(result, network)
}
