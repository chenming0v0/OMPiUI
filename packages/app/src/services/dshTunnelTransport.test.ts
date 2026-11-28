// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDshTunnelSocketAuth, openDshTunnelTransport, withDshTunnelFetch } from './dshTunnelTransport'

const native = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: native.fetch }))

const origin = `https://t${'a'.repeat(11)}.tun.4ba.io`
const otherOrigin = `https://p${'b'.repeat(11)}.hostc.4ba.io`
const cookie = '__Host-remote_session=session-token'
const setCookie = `${cookie}; Secure; HttpOnly; Path=/; SameSite=Lax`
const socketUrl = (base = origin) => `${base.replace('https:', 'wss:')}/ws`
const grant = (base = origin) => ({ url: `${base}/`, browserGrant: 'a'.repeat(43), expiresAt: Date.now() + 60_000 })
const controllers: AbortController[] = []

function controller(): AbortController {
  const value = new AbortController()
  controllers.push(value)
  return value
}

function exchange(cookies = [setCookie], location = '/', status = 303, base = origin): Response {
  const headers = new Headers({ Location: location })
  for (const value of cookies) headers.append('Set-Cookie', value)
  const response = new Response(null, { status, headers })
  Object.defineProperty(response, 'url', { value: `${base}/__remote/session` })
  return response
}

async function open(base = origin, cookies = [setCookie]) {
  native.fetch.mockResolvedValueOnce(exchange(cookies, '/', 303, base))
  return openDshTunnelTransport(grant(base), controller().signal)
}

beforeEach(() => native.fetch.mockReset())
afterEach(() => {
  for (const value of controllers.splice(0)) value.abort()
})

describe('DS tunnel session exchange', () => {
  it('exchanges once without following 303 and uses the issued cookie for HTTP and WS', async () => {
    const transport = await open(origin, ['preferences=dark; Path=/', setCookie])
    expect(transport.url).toBe(`${origin}/`)
    expect(native.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = native.fetch.mock.calls[0]
    expect(url).toBe(`${origin}/__remote/session`)
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'manual', maxRedirections: 0 })
    expect(new Headers(init?.headers).get('Origin')).toBe(origin)
    expect(new Headers(init?.headers).get('Referer')).toBe(`${origin}/`)
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    expect(new URLSearchParams(String(init?.body)).get('browserGrant')).toBe(grant().browserGrant)
    const response = Response.json({ ok: true })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    const headers = new Headers({ Authorization: 'Bearer local-secret', Cookie: 'stale=secret', Origin: 'https://tauri.localhost', Accept: 'text/event-stream' })
    expect(await withDshTunnelFetch(fetchImpl)(`${origin}/api/events`, { headers })).toBe(response)
    const options = fetchImpl.mock.calls[0][1]
    expect(options).toMatchObject({ redirect: 'error', maxRedirections: 0, credentials: 'omit' })
    const sent = new Headers(options?.headers)
    expect(sent.get('Cookie')).toBe(cookie)
    expect(sent.get('Origin')).toBe(origin)
    expect(sent.has('Authorization')).toBe(false)
    expect(sent.get('Accept')).toBe('text/event-stream')
    expect(headers.get('Authorization')).toBe('Bearer local-secret')
    expect(getDshTunnelSocketAuth(socketUrl())).toEqual({ cookie: sent.get('Cookie'), origin })
  })

  it.each([
    { url: 'https://example.com/' },
    { url: `${origin}/path` },
    { expiresAt: 1 },
    { browserGrant: 'invalid' },
  ])('rejects an invalid grant before exchanging: %j', async patch => {
    await expect(openDshTunnelTransport({ ...grant(), ...patch }, controller().signal)).rejects.toThrow()
    expect(native.fetch).not.toHaveBeenCalled()
    expect(getDshTunnelSocketAuth(socketUrl())).toBeUndefined()
  })

  it.each([
    [],
    ['session=token; Secure; HttpOnly; Path=/'],
    [`${cookie}; HttpOnly; Path=/`],
    [`${cookie}; Secure; Path=/`],
    [`${cookie}; Secure; HttpOnly; Path=/api`],
    [`${setCookie}; Domain=tun.4ba.io`],
    [`${setCookie}; Domain=`],
    [`${setCookie}; Path=/api`],
    [`${setCookie}; Max-Age=0`],
    [`${setCookie}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`],
    ['__Host-session; Secure; HttpOnly; Path=/'],
    ['__Host-session=; Secure; HttpOnly; Path=/'],
    [setCookie, setCookie],
  ].map(cookies => ({ cookies })))('rejects unsafe or missing host cookies: $cookies', async ({ cookies }) => {
    native.fetch.mockResolvedValueOnce(exchange(cookies))
    await expect(openDshTunnelTransport(grant(), controller().signal)).rejects.toThrow(/cookie/)
    expect(native.fetch).toHaveBeenCalledTimes(1)
    expect(getDshTunnelSocketAuth(socketUrl())).toBeUndefined()
  })

  it.each([
    { status: 200, location: '/' },
    { status: 302, location: '/' },
    { status: 303, location: 'https://example.com/' },
    { status: 303, location: '//example.com/' },
    { status: 303, location: '/next' },
  ])('rejects an unexpected exchange response without retry: %j', async ({ status, location }) => {
    native.fetch.mockResolvedValueOnce(exchange([setCookie], location, status))
    await expect(openDshTunnelTransport(grant(), controller().signal)).rejects.toThrow(/exchange/)
    expect(native.fetch).toHaveBeenCalledTimes(1)
    expect(getDshTunnelSocketAuth(socketUrl())).toBeUndefined()
  })

  it('does not retry a network error or register credentials', async () => {
    const error = new TypeError('connection failed')
    native.fetch.mockRejectedValueOnce(error)
    await expect(openDshTunnelTransport(grant(), controller().signal)).rejects.toBe(error)
    expect(native.fetch).toHaveBeenCalledTimes(1)
    expect(getDshTunnelSocketAuth(socketUrl())).toBeUndefined()
  })

  it('keeps a working session when a replacement exchange fails', async () => {
    await open()
    native.fetch.mockResolvedValueOnce(exchange([], '/', 403))
    await expect(openDshTunnelTransport(grant(), controller().signal)).rejects.toThrow(/exchange/)
    expect(native.fetch).toHaveBeenCalledTimes(2)
    expect(getDshTunnelSocketAuth(socketUrl())).toEqual({ cookie, origin })
  })

  it('does not consume a grant when already cancelled', async () => {
    const lifetime = controller()
    lifetime.abort()
    await expect(openDshTunnelTransport(grant(), lifetime.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.fetch).not.toHaveBeenCalled()
  })

  it('discards a late 303 after cancellation and releases its response body', async () => {
    const lifetime = controller()
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<Response>()
    native.fetch.mockImplementationOnce((_input, init) => {
      expect(init?.signal).toBe(lifetime.signal)
      started.resolve()
      return pending.promise
    })
    const opening = openDshTunnelTransport(grant(), lifetime.signal)
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise
    lifetime.abort()
    const cancel = vi.fn()
    pending.resolve(new Response(new ReadableStream({ cancel }), { status: 303, headers: { Location: '/', 'Set-Cookie': setCookie } }))
    await rejected
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(native.fetch).toHaveBeenCalledTimes(1)
    expect(getDshTunnelSocketAuth(socketUrl())).toBeUndefined()
  })
})

describe('DS tunnel request isolation and lifetime', () => {
  it('leaves other origins and ordinary servers unchanged and never gives them WS credentials', async () => {
    await open()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null))
    const wrapped = withDshTunnelFetch(fetchImpl)
    const init = { headers: new Headers({ Authorization: 'Bearer ordinary-server' }), redirect: 'follow' as const }
    for (const url of ['http://127.0.0.1:8080/api', `${otherOrigin}/api`, `${origin}:8443/api`, `${origin}.example.com/api`, '/api/local']) {
      await wrapped(url, init)
      expect(fetchImpl.mock.lastCall?.[0]).toBe(url)
      expect(fetchImpl.mock.lastCall?.[1]).toBe(init)
      expect(new Headers(fetchImpl.mock.lastCall?.[1]?.headers).has('Cookie')).toBe(false)
    }
    for (const url of [socketUrl(otherOrigin), socketUrl().replace('wss:', 'ws:'), `${socketUrl().replace('/ws', '')}:8443/ws`, `${origin}/ws`, 'invalid']) {
      expect(getDshTunnelSocketAuth(url)).toBeUndefined()
    }
  })

  it('preserves Request body and headers while honouring an overriding caller signal', async () => {
    await open()
    const inherited = controller()
    const caller = controller()
    const input = new Request(`${origin}/api/send`, {
      method: 'POST', body: 'message', headers: { Authorization: 'Bearer stale', 'X-Request-Id': 'id' }, signal: inherited.signal,
    })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null))
    await withDshTunnelFetch(fetchImpl)(input, { signal: caller.signal })
    const [sent, options] = fetchImpl.mock.calls[0]
    expect(sent).toBe(input)
    const effective = new Request(sent, options)
    expect(effective.method).toBe('POST')
    expect(await effective.text()).toBe('message')
    expect(effective.headers.get('X-Request-Id')).toBe('id')
    expect(effective.headers.has('Authorization')).toBe(false)
    expect(effective.headers.get('Cookie')).toBe(cookie)
    inherited.abort()
    expect(options?.signal?.aborted).toBe(false)
    caller.abort()
    expect(options?.signal?.aborted).toBe(true)
    expect(getDshTunnelSocketAuth(socketUrl())).toEqual({ cookie, origin })
  })

  it('passes inherited Request cancellation explicitly to the native implementation', async () => {
    await open()
    const caller = controller()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null))
    const input = new Request(`${origin}/api`, { signal: caller.signal })
    await withDshTunnelFetch(fetchImpl)(input)
    caller.abort()
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('rejects a cancelled caller before sending without closing the session', async () => {
    await open()
    const caller = controller()
    caller.abort()
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(withDshTunnelFetch(fetchImpl)(`${origin}/api`, { signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(getDshTunnelSocketAuth(socketUrl())).toEqual({ cookie, origin })
  })

  it.each([301, 302, 303, 307, 308])('rejects HTTP %i redirects and releases the body', async status => {
    await open()
    const cancel = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      status, headers: { Location: 'https://example.com/collect' },
    }))
    await expect(withDshTunnelFetch(fetchImpl)(`${origin}/api`)).rejects.toThrow(/redirect/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error', maxRedirections: 0 })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('aborts an already returned HTTP stream on close and blocks stale requests', async () => {
    const transport = await open()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => new Response(new ReadableStream({
      start(stream) { init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), { once: true }) },
    })))
    const wrapped = withDshTunnelFetch(fetchImpl)
    const response = await wrapped(`${origin}/api/events`)
    const reader = response.body!.getReader()
    const reading = expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    transport.close()
    transport.close()
    await reading
    expect(getDshTunnelSocketAuth(socketUrl())).toBeUndefined()
    await expect(wrapped(`${origin}/api/events`, { headers: { Cookie: cookie } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('closes an established session when its opening signal is cancelled', async () => {
    const lifetime = controller()
    native.fetch.mockResolvedValueOnce(exchange())
    await openDshTunnelTransport(grant(), lifetime.signal)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null))
    await withDshTunnelFetch(fetchImpl)(`${origin}/api`)
    lifetime.abort()
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(getDshTunnelSocketAuth(socketUrl())).toBeUndefined()
  })

  it('rejects a response completing after close', async () => {
    const transport = await open()
    const pending = Promise.withResolvers<Response>()
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    const request = withDshTunnelFetch(fetchImpl)(`${origin}/api`)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    transport.close()
    pending.resolve(new Response(null))
    await rejected
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('replaces a session without letting its old handle close the replacement or another origin', async () => {
    const previous = await open()
    await open(otherOrigin, ['__Host-other=other-token; Secure; HttpOnly; Path=/'])
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null))
    const wrapped = withDshTunnelFetch(fetchImpl)
    await wrapped(`${origin}/api`)
    const oldSignal = fetchImpl.mock.lastCall?.[1]?.signal
    const replacement = await open(origin, ['__Host-new=new-token; Secure; HttpOnly; Path=/'])
    expect(oldSignal?.aborted).toBe(true)
    previous.close()
    expect(getDshTunnelSocketAuth(socketUrl())).toEqual({ cookie: '__Host-new=new-token', origin })
    await wrapped(`${origin}/api`)
    expect(new Headers(fetchImpl.mock.lastCall?.[1]?.headers).get('Cookie')).toBe('__Host-new=new-token')
    replacement.close()
    expect(getDshTunnelSocketAuth(socketUrl(otherOrigin))).toEqual({ cookie: '__Host-other=other-token', origin: otherOrigin })
    await wrapped(`${otherOrigin}/api`)
    expect(fetchImpl.mock.lastCall?.[1]?.signal?.aborted).toBe(false)
  })
})
