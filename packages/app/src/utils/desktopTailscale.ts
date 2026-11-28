import type { TailscaleInfo } from '@ompiui/protocol'
import { serverStore } from '../store/serverStore'
import { isTailnetUrl } from './androidTailscale'
import { TAILSCALE_READY_EVENT } from './tailscaleEvents'
import { getHttpFetch, isTauri, isTauriMobile } from './tauri'

/**
 * 桌面版经本机后端的内置节点向外连接 Tailnet。
 * 这里的请求固定打向本机后端，与当前选中的服务器无关：回环路由只在这台电脑上有效。
 */

/** 路由有效期：到期后重新向本机后端确认，节点重启后旧端口最多保留这么久。 */
const ROUTE_TTL_MS = 5_000
/** 节点未运行的结论只保留很短时间，让启动恢复和刚登录的节点尽快生效。 */
const UNAVAILABLE_TTL_MS = 1_000

export function isDesktopTailscalePlatform(): boolean {
  return isTauri() && !isTauriMobile()
}

type LocalRequest = { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal; timeoutMs?: number }

async function localRequest<T>(path: string, { method = 'GET', body, signal, timeoutMs = 20_000 }: LocalRequest = {}): Promise<T> {
  const backend = serverStore.getLocalBackend()
  if (!backend) throw new Error('The local OMPiUI backend is unavailable')
  const fetchImpl = await getHttpFetch()
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await fetchImpl(`${backend.url}${path}`, {
    method,
    headers: {
      ...(backend.token ? { authorization: `Bearer ${backend.token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text
    try {
      const problem = JSON.parse(text) as { message?: unknown }
      if (typeof problem.message === 'string') message = problem.message
    } catch {
      // 非 JSON 的错误正文原样作为说明。
    }
    throw Object.assign(new Error(message || `${path} ${response.status}`), { status: response.status })
  }
  return (await response.json()) as T
}

export function fetchDesktopTailscale(signal?: AbortSignal): Promise<TailscaleInfo> {
  return localRequest<TailscaleInfo>('/api/v1/host/tailscale', { signal })
}

export function startDesktopTailscaleLogin(): Promise<{ ok: boolean; authUrl?: string | null }> {
  // 首次登录要等内置节点启动，后端的启动预算是 30 秒。
  return localRequest('/api/v1/host/tailscale/login', { method: 'POST', body: {}, timeoutMs: 40_000 })
}

export async function disconnectDesktopTailscale(): Promise<void> {
  await localRequest('/api/v1/host/tailscale/disconnect', { method: 'POST', body: {} })
}

export async function discoverDesktopTailscale(signal: AbortSignal): Promise<unknown> {
  const result = await localRequest<{ devices?: unknown }>('/api/v1/host/tailscale/discover', { method: 'POST', body: {}, signal })
  return result.devices
}

type RouteEntry = { route: Promise<string | null>; expires: number }
const routes = new Map<string, RouteEntry>()
/** 最近一次路由请求的结果；undefined 表示还没有问过。 */
let routed: boolean | undefined

function requestRoute(origin: string): Promise<string | null> {
  const entry: RouteEntry = { expires: Date.now() + ROUTE_TTL_MS, route: Promise.resolve(null) }
  entry.route = localRequest<{ url?: unknown }>('/api/v1/host/tailscale/route', { method: 'POST', body: { origin }, timeoutMs: 5_000 })
    .then(result => (typeof result.url === 'string' ? result.url : null), () => null)
    .then(url => {
      if (routes.get(origin) !== entry) return url
      if (!url) entry.expires = Date.now() + UNAVAILABLE_TTL_MS
      const recovered = url !== null && routed === false
      routed = url !== null
      // 节点从不可用变为可用：让停在退避里的连接立刻重试。
      if (recovered) window.dispatchEvent(new Event(TAILSCALE_READY_EVENT))
      return url
    })
  routes.set(origin, entry)
  return entry.route
}

/**
 * 地址仍保存为 Tailnet 源；发请求时映射到本机节点的回环路由。
 * 本机节点没在运行时原样返回，装了系统 Tailscale 的电脑照常直连。
 */
export async function resolveDesktopTailscaleUrl(input: string): Promise<string> {
  const url = new URL(input)
  const websocket = url.protocol === 'ws:' || url.protocol === 'wss:'
  const origin = `${url.protocol === 'https:' || url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`
  const cached = routes.get(origin)
  const route = await (cached && cached.expires > Date.now() ? cached.route : requestRoute(origin))
  if (!route) return input
  const local = new URL(route)
  local.protocol = websocket ? 'ws:' : 'http:'
  local.pathname = url.pathname
  local.search = url.search
  return local.toString()
}

/**
 * 本机节点登录或退出后调用：丢掉旧路由，并让保存的 Tailnet 服务器立刻重新探测。
 * ready 为真时同时唤醒停在退避里的当前连接。
 */
export function refreshDesktopTailscaleRoutes(ready: boolean): void {
  routes.clear()
  routed = undefined
  if (ready) window.dispatchEvent(new Event(TAILSCALE_READY_EVENT))
  for (const server of serverStore.getServers()) {
    if (isTailnetUrl(server.url)) void serverStore.checkHealth(server.id)
  }
}
