import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { abortInFlightPiRequests, getApiBase, piFetch } from './httpClient'
import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'
import { trafficAuditStore } from './trafficAudit/store'

const mocks = vi.hoisted(() => ({ isTauri: false }))

const nativeFetchMock = vi.hoisted(() => vi.fn())

vi.mock('../utils/tauri', () => ({
  isTauri: () => mocks.isTauri,
  getHttpFetch: () => Promise.resolve(nativeFetchMock),
}))

const restoreOriginalLocalServer = () => {
  const original = serverStore.getStoredServers().find(server => server.id === LOCAL_SERVER_ID)
  if (original) serverStore.updateServer(LOCAL_SERVER_ID, { url: original.url, token: original.token })
}

describe('Tauri HTTP transport', () => {
  const original = serverStore.getStoredServers().find(server => server.id === LOCAL_SERVER_ID)

  beforeEach(() => {
    mocks.isTauri = true
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    nativeFetchMock.mockReset()
    if (original) serverStore.updateServer(LOCAL_SERVER_ID, { url: original.url, token: original.token })
  })

  it('uses the selected desktop server instead of a build-time VITE_OMPIUI_API', () => {
    vi.stubEnv('VITE_OMPIUI_API', 'https://build-time.invalid')
    serverStore.updateServer(LOCAL_SERVER_ID, { url: 'https://settings.example.test' })

    expect(getApiBase()).toBe('https://settings.example.test')
  })

  it('uses plugin-http with the selected server Bearer token on Android', async () => {
    serverStore.updateServer(LOCAL_SERVER_ID, {
      url: 'http://192.168.1.10:8787',
      token: 'mobile-token',
    })
    nativeFetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))

    await piFetch(`${getApiBase()}/api/v1/host/health`)

    expect(nativeFetchMock).toHaveBeenCalledWith(
      'http://192.168.1.10:8787/api/v1/host/health',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    const headers = nativeFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer mobile-token')
  })
})

describe('browser HTTP transport', () => {
  beforeEach(() => {
    mocks.isTauri = false
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    restoreOriginalLocalServer()
    serverStore.setActiveServer(LOCAL_SERVER_ID)
  })

  it('keeps same-origin for the untouched default local server', () => {
    serverStore.updateServer(LOCAL_SERVER_ID, { url: 'http://127.0.0.1:8787' })

    expect(getApiBase()).toBe('')
  })

  it('directs an edited default local server at its saved address', () => {
    serverStore.updateServer(LOCAL_SERVER_ID, { url: 'http://192.168.1.5:8787' })

    expect(getApiBase()).toBe('http://192.168.1.5:8787')
  })

  it('follows a selected remote server instead of the build-time endpoint', () => {
    const remote = serverStore.addServer({ name: 'Remote', url: 'http://remote.test' })
    serverStore.setActiveServer(remote.id)

    expect(getApiBase()).toBe('http://remote.test')
  })
})

describe('HTTP network retry safety', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    nativeFetchMock.mockReset()
    trafficAuditStore.setEnabled(true)
    trafficAuditStore.clear()
  })

  afterEach(() => {
    abortInFlightPiRequests()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    nativeFetchMock.mockReset()
  })

  it.each(['POST', 'post', 'PUT', 'PATCH', 'DELETE'])('does not replay %s after commit then connection loss', async method => {
    let committed = 0
    const lostResponse = new TypeError('Failed to fetch')
    nativeFetchMock.mockImplementation(async () => {
      committed += 1
      throw lostResponse
    })

    // Even an explicit retry flag cannot authorize replaying a write.
    const result = expect(piFetch('/write', { method, body: '{}', retry: true })).rejects.toBe(lostResponse)
    await vi.advanceTimersByTimeAsync(2_000)
    await result
    expect(committed).toBe(1)
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 'GET', 'get', 'HEAD'])('retries safe reads with method %s using bounded backoff', async method => {
    const response = new Response('{}')
    nativeFetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(response)

    const request = piFetch('/read', { method })
    await vi.advanceTimersByTimeAsync(0)
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(nativeFetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(900)
    expect(await request).toBe(response)
    expect(nativeFetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops after the safe-read retry budget', async () => {
    const error = new TypeError('Failed to fetch')
    nativeFetchMock.mockRejectedValue(error)
    const result = expect(piFetch('/read')).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(2_000)
    await result
    expect(nativeFetchMock).toHaveBeenCalledTimes(3)
  })

  it('audits every retry as a separate request with the final consumed response size', async () => {
    nativeFetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
    const request = piFetch('/api/read')
    await vi.advanceTimersByTimeAsync(1_200)
    const response = await request
    expect(await response.json()).toEqual({ ok: true })
    expect(trafficAuditStore.getSnapshot().records.map(record => [record.attempt, record.status]))
      .toEqual([[3, 'complete'], [2, 'error'], [1, 'error']])
    expect(trafficAuditStore.getSnapshot().records[0].receivedBytes).toBe(11)
  })

  it('lets a side-effectful GET opt out without forwarding the retry option to fetch', async () => {
    const error = new TypeError('Failed to fetch')
    nativeFetchMock.mockRejectedValue(error)
    await expect(piFetch('/mint', { retry: false })).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
    expect(nativeFetchMock.mock.calls[0]?.[1]).not.toHaveProperty('retry')
  })

  it.each([401, 403, 500, 503])('does not retry HTTP %s responses', async status => {
    const response = new Response('error', { status })
    nativeFetchMock.mockResolvedValue(response)
    expect(await piFetch('/read')).toBe(response)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    new Error('invalid request'),
    new DOMException('cancelled', 'AbortError'),
    new DOMException('timed out', 'TimeoutError'),
  ])('does not retry non-network failures: $name', async error => {
    nativeFetchMock.mockRejectedValue(error)
    await expect(piFetch('/read')).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
  })

  it('never sends an already-aborted request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(piFetch('/read', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(nativeFetchMock).not.toHaveBeenCalled()
  })

  it.each(['caller', 'server-switch', 'timeout'])('cancels retry backoff without replay on %s', async source => {
    const controller = new AbortController()
    if (source === 'timeout') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    nativeFetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const request = piFetch('/read', { signal: controller.signal })
    const result = expect(request).rejects.toMatchObject({ name: source === 'timeout' ? 'TimeoutError' : 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    if (source === 'server-switch') abortInFlightPiRequests()
    else if (source === 'timeout') controller.abort(new DOMException('timed out', 'TimeoutError'))
    else controller.abort()

    // Cancellation settles without waiting for the next retry timer.
    await result
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry when aborting an in-flight fetch produces a network error', async () => {
    const controller = new AbortController()
    nativeFetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new TypeError('network cancelled')), { once: true })
    }))
    const result = expect(piFetch('/read', { signal: controller.signal })).rejects.toThrow('network cancelled')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await result
    await vi.advanceTimersByTimeAsync(2_000)
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
  })
})
