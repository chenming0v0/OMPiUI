import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPiQueue,
  createPiSession,
  fetchHostHealth,
  fetchHostNetwork,
  fetchPairInvite,
  getHostTerminalWebSocketUrl,
  getOmpSubagentMessages,
  listActiveProviderFlows,
  mintPairInvite,
  promptPi,
  readHostFile,
  redeemDisplayCode,
  redeemPairCode,
  sendPiUserMessage,
  setPiExtensionEditorState,
  writeHostFile,
  waitHostCommand,
} from './index.js'
import { serverStore } from '../../store/serverStore'

const nativeFetchMock = vi.hoisted(() => vi.fn())
vi.mock('../../utils/tauri', () => ({
  isTauri: () => false,
  getHttpFetch: () => Promise.resolve(nativeFetchMock),
}))

describe('pairing redemption', () => {
  beforeEach(() => nativeFetchMock.mockReset())
  afterEach(() => { vi.restoreAllMocks(); nativeFetchMock.mockReset() })

  it.each([
    ['display code', () => redeemDisplayCode('00123456', 'https://relay.test/backend'), { code: '00123456' }],
    ['QR credential', () => redeemPairCode('once.secret', 'https://relay.test/backend'), { pair: 'once.secret' }],
  ] as const)('posts the %s to the chosen server without bearer authentication', async (_name, send, body) => {
    vi.spyOn(serverStore, 'getActiveToken').mockReturnValue('unrelated-server-token')
    const result = { url: 'https://relay.test/backend', token: 'paired-token' }
    nativeFetchMock.mockResolvedValueOnce(Response.json(result))
    await expect(send()).resolves.toEqual(result)
    expect(nativeFetchMock).toHaveBeenCalledOnce()
    const [url, init] = nativeFetchMock.mock.calls[0]
    expect(url).toBe('https://relay.test/backend/api/v1/host/pair/redeem')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual(body)
  })

  it('preserves the abort signal and does not retry rejected display codes', async () => {
    const signal = new AbortController().signal
    nativeFetchMock.mockResolvedValueOnce(new Response('invalid or expired code', { status: 400 }))
    await expect(redeemDisplayCode('50328191', 'http://remote.test', signal)).rejects.toThrow('pair redeem failed: 400 invalid or expired code')
    expect(nativeFetchMock.mock.calls[0][1].signal).toBe(signal)
    expect(nativeFetchMock).toHaveBeenCalledOnce()
  })
})

describe('getHostTerminalWebSocketUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('includes ticket and cursor query params', () => {
    vi.spyOn(serverStore, 'getActiveToken').mockReturnValue(undefined)
    const url = new URL(getHostTerminalWebSocketUrl('term-1', 'ticket-1', 42))
    expect(url.searchParams.get('ticket')).toBe('ticket-1')
    expect(url.searchParams.get('cursor')).toBe('42')
  })

  it('omits an undefined cursor to request the earliest retained output', () => {
    const url = new URL(getHostTerminalWebSocketUrl('term-1', 'ticket-1', undefined))
    expect(url.searchParams.has('cursor')).toBe(false)
  })

  it.each([-1, 0, 42, Number.MAX_SAFE_INTEGER])('preserves explicit cursor %s', cursor => {
    const url = new URL(getHostTerminalWebSocketUrl('term-1', 'ticket-1', cursor))
    expect(url.searchParams.get('cursor')).toBe(String(cursor))
  })

  it.each([-2, -1.5, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('omits invalid cursor %s', cursor => {
    const url = new URL(getHostTerminalWebSocketUrl('term-1', 'ticket-1', cursor))
    expect(url.searchParams.has('cursor')).toBe(false)
  })

  it('appends token query param when a token is configured (same-origin browser)', () => {
    vi.spyOn(serverStore, 'getActiveToken').mockReturnValue('secret-token')
    const url = new URL(getHostTerminalWebSocketUrl('term-1', 'ticket-1'))
    expect(url.searchParams.get('token')).toBe('secret-token')
  })

  it('omits token param when no token is configured', () => {
    vi.spyOn(serverStore, 'getActiveToken').mockReturnValue(undefined)
    const url = new URL(getHostTerminalWebSocketUrl('term-1', 'ticket-1'))
    expect(url.searchParams.has('token')).toBe(false)
  })
})

describe('transport retry and response contracts', () => {
  it.each([
    ['prompt', () => promptPi('slash-session', { text: '/native-dialog' })],
    ['composer', () => sendPiUserMessage('slash-session', { text: '/native-dialog', deliverAs: 'followUp' })],
  ] as const)('keeps %s slash acceptance pending through a native dialog', async (_name, send) => {
    // Native AbortSignal.timeout uses platform timers; bind it to this suite's fake clock.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(delay => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), delay)
      return controller.signal
    })
    const { promise, resolve: accept, reject } = Promise.withResolvers<Response>()
    nativeFetchMock.mockImplementation((_url: string, init: RequestInit) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      return promise
    })
    let state = 'pending'
    const request = send().then(() => { state = 'accepted' }, () => { state = 'rejected' })
    await vi.advanceTimersByTimeAsync(21_000)
    expect(state).toBe('pending')
    expect(nativeFetchMock.mock.calls[0][1].signal.aborted).toBe(false)
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
    accept(Response.json({ data: null }))
    await request
    expect(state).toBe('accepted')
  })

  it('preserves a native slash rejection without retrying or reporting acceptance', async () => {
    nativeFetchMock.mockResolvedValueOnce(Response.json({ error: { message: 'Native command rejected' } }, { status: 500 }))
    await expect(sendPiUserMessage('slash-session', { text: '/native-reject' })).rejects.toThrow('Native command rejected')
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
  })
  it.each(['headers', 'body'])('applies the command deadline while waiting for %s', async phase => {
    nativeFetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal!
      if (phase === 'headers') return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      const body = new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
      })
      return Promise.resolve(new Response(body))
    })
    const failed = expect(waitHostCommand(`deadline-${phase}`, undefined, 50)).rejects.toThrow('Command timed out')
    await vi.advanceTimersByTimeAsync(50)
    await failed
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a shared host read for remaining callers and cancels it after the last caller leaves', async () => {
    const requests: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = []
    nativeFetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const signal = init.signal!
      requests.push({ signal, resolve })
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))

    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = readHostFile('/workspace', 'same.txt', firstController.signal)
    const second = readHostFile('/workspace', 'same.txt', secondController.signal)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests[0]!.signal.aborted).toBe(false)
    requests[0]!.resolve(Response.json({ data: { content: 'still needed' } }))
    await expect(second).resolves.toEqual({ content: 'still needed' })

    const abandonedController = new AbortController()
    const abandoned = readHostFile('/workspace', 'same.txt', abandonedController.signal)
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    abandonedController.abort()
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests[1]!.signal.aborted).toBe(true)

    const replacement = readHostFile('/workspace', 'same.txt')
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    requests[2]!.resolve(Response.json({ data: { content: 'fresh' } }))
    await expect(replacement).resolves.toEqual({ content: 'fresh' })
  })

  it('coalesces slow editor uploads into the latest pending text and rejects over-limit mirrors locally', async () => {
    let resolve!: (response: Response) => void
    nativeFetchMock.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
      .mockResolvedValueOnce(Response.json({ data: null }))
    const first = setPiExtensionEditorState('slow-draft', 'first')
    await vi.waitFor(() => expect(nativeFetchMock).toHaveBeenCalledTimes(1))
    for (let i = 0; i < 100; i++) void setPiExtensionEditorState('slow-draft', `latest-${i}`)
    resolve(Response.json({ data: null }))
    await first
    expect(nativeFetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(nativeFetchMock.mock.calls[1][1].body).text).toBe('latest-99')
    await setPiExtensionEditorState('slow-draft', 'latest-99')
    await setPiExtensionEditorState('large-draft', 'x'.repeat(256 * 1024 + 1))
    expect(nativeFetchMock).toHaveBeenCalledTimes(2)
  })
  it('assembles transcript pages even when a JSONL message spans pages', async () => {
    const line = JSON.stringify({ type: 'message', message: { role: 'assistant', content: '正文😀'.repeat(1000) } })
    nativeFetchMock.mockResolvedValueOnce(Response.json({ data: {
      transcript: line.slice(0, 101), fromByte: 0, nextByte: 101, hasMore: true,
    } })).mockResolvedValueOnce(Response.json({ data: {
      transcript: line.slice(101), fromByte: 101, nextByte: 5000, hasMore: false,
    } }))
    const result = await getOmpSubagentMessages('s', { sessionFile: 'child.jsonl' })
    expect(result).toMatchObject({ messages: [{ role: 'assistant', content: '正文😀'.repeat(1000) }] })
    expect(JSON.parse(nativeFetchMock.mock.calls[1][1].body).fromByte).toBe(101)
  })

  beforeEach(() => {
    vi.useFakeTimers()
    nativeFetchMock.mockReset()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    nativeFetchMock.mockReset()
  })

  it.each([
    ['session creation', () => createPiSession('/workspace')],
    ['prompt', () => promptPi('session-1', { text: 'once' })],
    ['file write', () => writeHostFile('/workspace', 'file.txt', 'once')],
    ['pair invite minting', () => mintPairInvite()],
  ] as const)('commits %s only once when the response is lost', async (_name, send) => {
    let committed = 0
    const error = new TypeError('Failed to fetch after commit')
    nativeFetchMock.mockImplementation(async () => {
      committed += 1
      throw error
    })
    const result = expect(send()).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(2_000)
    await result
    expect(committed).toBe(1)
    expect(nativeFetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['health', () => fetchHostHealth()],
    ['existing pair invite', () => fetchPairInvite('existing-id')],
  ] as const)('retries a safe %s read', async (_name, read) => {
    nativeFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(Response.json({ ok: true }))
    const request = read()
    await vi.advanceTimersByTimeAsync(300)
    expect(await request).toEqual({ ok: true })
    expect(nativeFetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([{ interfaces: [], port: 9876 }, { interfaces: [] }])('preserves the optional authoritative network port: %j', async snapshot => {
    nativeFetchMock.mockResolvedValueOnce(Response.json(snapshot))
    const result = await fetchHostNetwork()
    expect(result).toEqual(snapshot)
    expect(result.port).toBe('port' in snapshot ? snapshot.port : undefined)
  })

  it('preserves generic active-auth JSON including pending prompts', async () => {
    const snapshot = [{ flowId: 'flow-1', providerId: 'provider-1', prompts: [{ promptId: 'prompt-1', message: 'Code?' }] }]
    nativeFetchMock.mockResolvedValueOnce(Response.json({ data: snapshot }))
    expect(await listActiveProviderFlows()).toEqual(snapshot)
  })

  it('preserves queue entries and images in the authoritative clear snapshot', async () => {
    const image = { type: 'image', data: 'encoded-image', mimeType: 'image/png' }
    const snapshot = {
      steering: ['steer'],
      followUp: ['follow up'],
      steeringEntries: [{ text: 'steer', images: [image] }],
      followUpEntries: [{ text: 'follow up', images: [image] }],
    }
    nativeFetchMock.mockResolvedValueOnce(Response.json({ data: snapshot }))
    expect(await clearPiQueue('session-1')).toEqual(snapshot)
  })
})
