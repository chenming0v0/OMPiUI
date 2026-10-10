import { isTauri } from './tauri'

export type AndroidTailscaleStatus = {
  enabled: boolean
  BackendState: string
  AuthURL?: string
  TailscaleIPs?: string[]
  lastError?: string
  startupInterrupted?: boolean
  Self?: { DNSName?: string }
}

type NativeBridge = { request(id: string, method: string, payload: string): void }
declare global {
  interface Window {
    __ompiui_tailscale?: NativeBridge
  }
}

export function isAndroidTailscalePlatform(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
}

export function isTailnetUrl(input: string): boolean {
  try {
    const url = new URL(input)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const parts = host.split('.')
    const ipv4 = parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    return (ipv4 && Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127) ||
      host.startsWith('fd7a:115c:a1e0:') || host.endsWith('.ts.net')
  } catch {
    return false
  }
}

async function nativeRequest<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  // Android 在 WebView 创建后注入桥，冷启动时等待它就绪。
  for (let attempt = 0; !window.__ompiui_tailscale && attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const bridge = window.__ompiui_tailscale
  if (!bridge) throw new Error('This Android build does not include the Tailscale component')
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; result?: T; error?: string }>).detail
      if (detail.id !== id) return
      window.removeEventListener('ompiui-tailscale-result', listener)
      clearTimeout(timer)
      if (detail.error) reject(new Error(detail.error))
      else resolve(detail.result as T)
    }
    const timer = setTimeout(() => {
      window.removeEventListener('ompiui-tailscale-result', listener)
      reject(new Error('Tailscale native operation timed out'))
    }, 30_000)
    window.addEventListener('ompiui-tailscale-result', listener)
    try {
      bridge.request(id, method, JSON.stringify(payload))
    } catch (error) {
      clearTimeout(timer)
      window.removeEventListener('ompiui-tailscale-result', listener)
      reject(error)
    }
  })
}

export function getAndroidTailscaleStatus(): Promise<AndroidTailscaleStatus> {
  return nativeRequest('status')
}

export function loginAndroidTailscale(): Promise<AndroidTailscaleStatus> {
  return nativeRequest('login')
}

export function openAndroidTailscaleLogin(url: string): Promise<void> {
  return nativeRequest('openLogin', { url })
}

export function copyAndroidTailscaleDiagnostics(): Promise<void> {
  return nativeRequest('copyDiagnostics')
}

export function exportAndroidTailscaleDiagnostics(): Promise<void> {
  return nativeRequest('exportDiagnostics')
}

const routeRequests = new Map<string, Promise<string>>()

export async function disconnectAndroidTailscale(): Promise<void> {
  routeRequests.clear()
  await nativeRequest('disconnect')
}

/** 地址仍保存为 Tailnet 源；仅在发请求时映射到原生回环通道。 */
export async function resolveAndroidTailscaleUrl(input: string): Promise<string> {
  if (!isAndroidTailscalePlatform() || !isTailnetUrl(input)) return input
  const url = new URL(input)
  const websocket = url.protocol === 'ws:' || url.protocol === 'wss:'
  const origin = `${url.protocol === 'https:' || url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`
  let route = routeRequests.get(origin)
  if (!route) {
    route = nativeRequest<string>('route', { origin }).catch(error => {
      routeRequests.delete(origin)
      throw error
    })
    routeRequests.set(origin, route)
  }
  const local = new URL(await route)
  local.protocol = websocket ? 'ws:' : 'http:'
  local.pathname = url.pathname
  local.search = url.search
  return local.toString()
}
