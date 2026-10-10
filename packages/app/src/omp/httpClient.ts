import { isCustomizedLocalServerUrl, LOCAL_SERVER_ID, serverStore } from '../store/serverStore'
import { getHttpFetch, isTauri } from '../utils/tauri'
import { PROTOCOL_VERSION } from '@ompiui/protocol'
import { resolveAndroidTailscaleUrl } from '../utils/androidTailscale'
import { auditHttpRequest } from './trafficAudit/http'

const DEFAULT_BASE = 'http://127.0.0.1:8787'
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

// 请求代次 + 在途请求注册表：server 切换/重连时一锅端中止，旧 server 的响应
// 不可能回来污染新 server 的状态（参考原 UI 基线的 generation 模式）。
let requestGeneration = 0
const inflightControllers = new Set<AbortController>()

export function abortInFlightPiRequests(): void {
  requestGeneration += 1
  for (const controller of inflightControllers) controller.abort()
  inflightControllers.clear()
}

// 网络错误也可能发生在 server 已提交写操作之后，不能据此重放写请求。
// 仅 GET/HEAD 允许重试；有副作用的 GET（如生成配对邀请）必须显式禁用。
const NETWORK_RETRY_DELAYS_MS = [300, 900]

export type PiRequestInit = RequestInit & {
  /** Retry network failures for GET/HEAD only (default true); never enables write retries. */
  retry?: boolean
}

function isNetworkLevelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false
  if (error instanceof TypeError) return true
  return /fetch failed|network|econnrefused|econnreset|enotfound|connection|error sending request/i.test(error.message)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function waitForNetworkRetry(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * HTTP transport base for the OMPiUI server.
 * Browser dev uses same-origin + Vite proxy (`/api` → :8787) to avoid CORS.
 * Tauri 壳的同源是 tauri://localhost，不是 API，必须始终用完整 URL。
 * Browser 与 Tauri 一样跟随 serverStore：选中的远程服务器和改过地址的默认
 * local 条目始终直连；VITE_OMPIUI_API 只在未改动的默认 local 上兜底。
 */
export function getApiBase(): string {
  const envBase = (import.meta as ImportMeta & { env?: { VITE_OMPIUI_API?: string } }).env?.VITE_OMPIUI_API
  if (typeof window !== 'undefined') {
    const active = serverStore.getActiveServer()
    if (isTauri()) {
      if (active?.url) return active.url.replace(/\/$/, '')
      return envBase?.replace(/\/$/, '') || DEFAULT_BASE
    }
    // 浏览器里跟随用户选择，不被构建期 VITE_OMPIUI_API 钉死（与 Tauri 一致）。
    if (active && active.id !== LOCAL_SERVER_ID) return active.url.replace(/\/$/, '')
    const storedLocal = serverStore.getStoredServers().find(server => server.id === LOCAL_SERVER_ID)
    if (active && storedLocal && active.url !== storedLocal.url) return active.url.replace(/\/$/, '')
    // 用户改过默认 local 地址后必须直连保存值，否则会话请求、SSE 和终端
    // WebSocket 仍打页面同源，和设置页显示的地址不一致。
    if (active && storedLocal && isCustomizedLocalServerUrl(storedLocal.url)) return active.url.replace(/\/$/, '')
    if (envBase) return envBase.replace(/\/$/, '')
    return ''
  }
  return envBase?.replace(/\/$/, '') || DEFAULT_BASE
}

function piHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  const activeToken = serverStore.getActiveToken()
  if (activeToken) {
    headers.set('authorization', `Bearer ${activeToken}`)
    return headers
  }
  const token = (import.meta as ImportMeta & { env?: { VITE_OMPIUI_TOKEN?: string } }).env?.VITE_OMPIUI_TOKEN
  if (token) headers.set('authorization', `Bearer ${token}`)
  return headers
}

export function getPiAuthToken(): string | undefined {
  const activeToken = serverStore.getActiveToken()
  if (activeToken) return activeToken
  return (import.meta as ImportMeta & { env?: { VITE_OMPIUI_TOKEN?: string } }).env?.VITE_OMPIUI_TOKEN
}

export async function piFetch(input: string, init?: PiRequestInit): Promise<Response> {
  const { retry = true, ...requestInit } = init ?? {}
  const method = (requestInit.method ?? 'GET').toUpperCase()
  const canRetry = retry && (method === 'GET' || method === 'HEAD')
  const generation = requestGeneration
  const auditServer = serverStore.getActiveServer()?.url
  const inflight = new AbortController()
  inflightControllers.add(inflight)
  try {
    const fetchImpl = await getHttpFetch()
    if (generation !== requestGeneration) {
      throw new DOMException('Stale OMPiUI request: server changed', 'AbortError')
    }
    const timeout = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS)
    const signals = [inflight.signal, timeout]
    if (init?.signal) signals.push(init.signal)
    const signal = AbortSignal.any(signals)
    const headers = piHeaders(init?.headers)

    let lastError: unknown
    for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt++) {
      signal.throwIfAborted()
      try {
        return await auditHttpRequest(input, { ...requestInit, signal }, async () => {
          const resolved = await resolveAndroidTailscaleUrl(input)
          signal.throwIfAborted()
          return fetchImpl(resolved, { ...requestInit, signal, headers })
        }, input.startsWith('/') ? auditServer : undefined, attempt + 1)
      } catch (error) {
        if (!canRetry || signal.aborted || isAbortError(error) || !isNetworkLevelError(error)) throw error
        lastError = error
        const delay = NETWORK_RETRY_DELAYS_MS[attempt]
        if (delay === undefined) break
        await waitForNetworkRetry(delay, signal)
      }
    }
    throw lastError
  } finally {
    inflightControllers.delete(inflight)
  }
}

export async function isPiServerUp(): Promise<boolean> {
  try {
    const res = await piFetch(`${getApiBase()}/api/v1/host/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const body = (await res.json()) as { service?: string; protocolVersion?: number }
    return body.service === 'ompiui-server' && body.protocolVersion === PROTOCOL_VERSION
  } catch {
    return false
  }
}
