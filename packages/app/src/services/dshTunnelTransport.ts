import { parseDshBrowserGrant, type DshBrowserGrant } from '@ompiui/protocol/dsh-remote'

interface TunnelSession {
  cookie: string
  controller: AbortController
  close(): void
}

// null 只保留已关闭的来源，阻止切换服务器后滞留的请求继续发送。
const sessions = new Map<string, TunnelSession | null>()

function readTunnelCookie(headers: Headers): string {
  const cookies = new Map<string, string>()
  for (const entry of headers.getSetCookie()) {
    const [pair, ...attributes] = entry.split(';').map(part => part.trim())
    if (!pair.startsWith('__Host-')) continue
    const separator = pair.indexOf('=')
    const name = pair.slice(0, separator)
    const value = pair.slice(separator + 1)
    const content = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
    if (separator < 0 || !/^__Host-[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(content) || cookies.has(name)) {
      throw new Error('Invalid DS tunnel cookie')
    }
    const flags = new Map<string, string>()
    for (const attribute of attributes) {
      if (!attribute) continue
      const equals = attribute.indexOf('=')
      const key = (equals < 0 ? attribute : attribute.slice(0, equals)).trim().toLowerCase()
      if (flags.has(key)) throw new Error('Invalid DS tunnel cookie attributes')
      flags.set(key, equals < 0 ? '' : attribute.slice(equals + 1).trim())
    }
    if (flags.get('secure') !== '' || flags.get('httponly') !== '' || flags.get('path') !== '/' || flags.has('domain')) {
      throw new Error('Unsafe DS tunnel cookie attributes')
    }
    const maxAge = flags.get('max-age')
    const expires = flags.get('expires')
    if (maxAge !== undefined ? !/^\d+$/.test(maxAge) || Number(maxAge) <= 0
      : expires !== undefined && !(Date.parse(expires) > Date.now())) {
      throw new Error('Expired DS tunnel cookie')
    }
    cookies.set(name, `${name}=${value}`)
  }
  if (!cookies.size) throw new Error('Missing DS tunnel cookie')
  return [...cookies.values()].join('; ')
}

function cancelBody(response: Response | undefined): Promise<void> | undefined {
  return response?.body?.cancel().catch(() => {})
}

export async function openDshTunnelTransport(grant: DshBrowserGrant, signal: AbortSignal): Promise<{ url: string; close(): void }> {
  const validated = parseDshBrowserGrant(grant)
  signal.throwIfAborted()
  // 直接使用原生 HTTP，避免经 utils/tauri 与请求包装形成循环依赖。
  const { fetch } = await import('@tauri-apps/plugin-http')
  signal.throwIfAborted()
  const origin = new URL(validated.url).origin
  const endpoint = `${origin}/__remote/session`
  let response: Response | undefined
  let cookie: string
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Referer: validated.url },
      body: new URLSearchParams({ browserGrant: validated.browserGrant }).toString(),
      signal, credentials: 'omit', redirect: 'manual', maxRedirections: 0,
    })
    signal.throwIfAborted()
    if (response.status !== 303 || response.headers.get('location') !== '/' || response.redirected
      || (response.url && response.url !== endpoint)) {
      throw new Error('Invalid DS tunnel session exchange response')
    }
    cookie = readTunnelCookie(response.headers)
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally {
    await cancelBody(response)
  }
  signal.throwIfAborted()

  const controller = new AbortController()
  const session: TunnelSession = { cookie, controller, close }
  function close(): void {
    if (controller.signal.aborted) return
    signal.removeEventListener('abort', close)
    if (sessions.get(origin) === session) sessions.set(origin, null)
    session.cookie = ''
    controller.abort(signal.reason ?? new DOMException('DS tunnel session closed', 'AbortError'))
  }
  sessions.get(origin)?.close()
  signal.throwIfAborted()
  sessions.set(origin, session)
  signal.addEventListener('abort', close, { once: true })
  return { url: validated.url, close }
}

export function getDshTunnelSocketAuth(url: string): { cookie: string; origin: string } | undefined {
  let target: URL
  try { target = new URL(url) } catch { return undefined }
  if (target.protocol !== 'wss:' || target.username || target.password) return undefined
  target.protocol = 'https:'
  const session = sessions.get(target.origin)
  return session ? { cookie: session.cookie, origin: target.origin } : undefined
}

export function withDshTunnelFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    let target: URL
    try { target = new URL(input instanceof Request ? input.url : String(input)) }
    catch { return fetchImpl(input, init) }
    if (target.protocol === 'dsh:') throw new Error('DS tunnel is not connected')
    const session = sessions.get(target.origin)
    if (session === undefined) return fetchImpl(input, init)
    if (!session) throw new DOMException('DS tunnel session closed', 'AbortError')
    if (target.username || target.password) throw new TypeError('Invalid DS tunnel request URL')

    const request = input instanceof Request ? input : undefined
    const callerSignal = init?.signal === undefined ? request?.signal : init.signal
    const signal = callerSignal ? AbortSignal.any([session.controller.signal, callerSignal]) : session.controller.signal
    signal.throwIfAborted()
    const headers = new Headers(init?.headers ?? request?.headers)
    headers.set('Cookie', session.cookie)
    headers.set('Origin', target.origin)
    // hostc 会注入本机凭据，不能把当前 App 的其他服务器令牌发给隧道。
    headers.delete('Authorization')
    const options = { ...init, headers, signal, credentials: 'omit' as const, redirect: 'error' as const, maxRedirections: 0 }
    let response: Response | undefined
    try {
      response = await fetchImpl(input, options)
      signal.throwIfAborted()
      if ([301, 302, 303, 307, 308].includes(response.status) || response.type === 'opaqueredirect'
        || response.redirected || (response.url && new URL(response.url).origin !== target.origin)) {
        throw new TypeError('DS tunnel redirects are not allowed')
      }
      return response
    } catch (error) {
      await cancelBody(response)
      signal.throwIfAborted()
      throw error
    }
  }
}
