// @vitest-environment node
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 相邻单测会 mock 插件或传输层；此文件始终加载真实实现，并隔离会话缓存。
vi.hoisted(() => vi.resetModules())
vi.unmock('@tauri-apps/plugin-http')
vi.unmock('@tauri-apps/api/core')
vi.unmock('./dshTunnelTransport')

interface ClientConfig {
  method: string
  url: string
  headers: [string, string][]
  data: number[] | null
  maxRedirections: number
}

interface NativeResponse {
  status: number
  statusText: string
  url: string
  headers: [string, string][]
  rid: number
}

const origin = `https://t${'a'.repeat(11)}.tun.4ba.io`
const endpoint = `${origin}/__remote/session`
const socketUrl = `${origin.replace('https:', 'wss:')}/ws`
const cookie = '__Host-remote_session=session-token'
const grant = () => ({ url: `${origin}/`, browserGrant: 'a'.repeat(43), expiresAt: Date.now() + 60_000 })
const ipc = vi.fn<Parameters<typeof mockIPC>[0]>()
const controllers: AbortController[] = []
let transport: typeof import('./dshTunnelTransport')
let nativeFetch: typeof import('@tauri-apps/plugin-http')['fetch']

function controller(): AbortController {
  const value = new AbortController()
  controllers.push(value)
  return value
}

function exchangeResponse(): NativeResponse {
  return {
    status: 303, statusText: 'See Other', url: endpoint, rid: 101,
    headers: [
      ['location', '/'],
      ['set-cookie', 'preferences=dark; Path=/'],
      ['set-cookie', `${cookie}; Secure; HttpOnly; Path=/; SameSite=Lax`],
    ],
  }
}

function businessResponse(path: string, contentType: string): NativeResponse {
  return {
    status: 200, statusText: 'OK', url: `${origin}${path}`, rid: 102,
    headers: [['content-type', contentType]],
  }
}

function stubRust(onRead: (rid: number) => void = () => {}) {
  const requests: ClientConfig[] = []
  const pendingReads = new Map<number, PromiseWithResolvers<number[]>>()
  const send = vi.fn<(rid: number) => Promise<NativeResponse>>()
    .mockRejectedValue(new Error('Unexpected fetch_send'))
  const read = vi.fn((rid: number): Promise<number[]> => {
    const pending = Promise.withResolvers<number[]>()
    pendingReads.set(rid, pending)
    onRead(rid)
    return pending.promise
  })

  ipc.mockImplementation((command, payload) => {
    const args = payload as { clientConfig: ClientConfig; rid: number }
    switch (command) {
      case 'plugin:http|fetch':
        requests.push(args.clientConfig)
        return requests.length
      case 'plugin:http|fetch_send':
        return send(args.rid)
      case 'plugin:http|fetch_read_body':
        return read(args.rid)
      case 'plugin:http|fetch_cancel':
        return undefined
      case 'plugin:http|fetch_cancel_body':
        pendingReads.get(args.rid)?.reject('Request cancelled')
        return undefined
      default:
        throw new Error(`Unexpected IPC command: ${command}`)
    }
  })
  return { requests, send, read }
}

function callsFor(command: string) {
  return ipc.mock.calls.filter(([name]) => name === `plugin:http|${command}`)
}

beforeEach(async () => {
  vi.resetModules()
  ipc.mockReset()
  vi.stubGlobal('window', {})
  // 外部 ESM 内部导入可能绕过 vi.mock(core)，使用官方入口接管真实 core.invoke 的 Rust IPC。
  mockIPC(ipc)
  transport = await import('./dshTunnelTransport')
  nativeFetch = (await import('@tauri-apps/plugin-http')).fetch
  expect(vi.isMockFunction(nativeFetch)).toBe(false)
})

afterEach(() => {
  for (const value of controllers.splice(0)) value.abort()
  clearMocks()
  vi.unstubAllGlobals()
})

describe('DS tunnel real plugin-http JavaScript → IPC contract', () => {
  it('serializes the exchange and uses exposed Set-Cookie values for business requests', async () => {
    const rust = stubRust()
    rust.send.mockResolvedValueOnce(exchangeResponse())
      .mockResolvedValueOnce(businessResponse('/api/status', 'application/json'))
    const ticket = grant()
    const session = await transport.openDshTunnelTransport(ticket, controller().signal)

    expect(session.url).toBe(ticket.url)
    expect(rust.requests).toHaveLength(1)
    expect(rust.requests[0]).toMatchObject({
      method: 'POST', url: endpoint, maxRedirections: 0,
      data: Array.from(new TextEncoder().encode(`browserGrant=${ticket.browserGrant}`)),
    })
    const exchangeHeaders = new Headers(rust.requests[0].headers)
    expect(exchangeHeaders.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    expect(exchangeHeaders.get('Origin')).toBe(origin)
    expect(exchangeHeaders.get('Referer')).toBe(ticket.url)
    expect(exchangeHeaders.has('Cookie')).toBe(false)
    expect(exchangeHeaders.has('Authorization')).toBe(false)
    expect(transport.getDshTunnelSocketAuth(socketUrl)).toEqual({ cookie, origin })
    expect(callsFor('fetch_cancel_body')).toEqual([['plugin:http|fetch_cancel_body', { rid: 101 }]])

    // 插件按最后一个字节区分数据块（0）和 EOF（1），响应与流均由真实插件构造。
    rust.read.mockResolvedValueOnce([...new TextEncoder().encode('{"ok":true}'), 0])
      .mockResolvedValueOnce([1])
    const headers = new Headers({
      Authorization: 'Bearer local-secret', Cookie: 'stale=secret',
      Origin: 'https://tauri.localhost', Accept: 'application/json',
    })
    const response = await transport.withDshTunnelFetch(nativeFetch)(`${origin}/api/status`, { headers })
    expect(await response.json()).toEqual({ ok: true })
    expect(rust.requests).toHaveLength(2)
    expect(rust.requests[1]).toMatchObject({
      method: 'GET', url: `${origin}/api/status`, data: null, maxRedirections: 0,
    })
    const businessHeaders = new Headers(rust.requests[1].headers)
    expect(businessHeaders.get('Cookie')).toBe(cookie)
    expect(businessHeaders.get('Origin')).toBe(origin)
    expect(businessHeaders.get('Accept')).toBe('application/json')
    expect(businessHeaders.has('Authorization')).toBe(false)
    expect(headers.get('Authorization')).toBe('Bearer local-secret')
    expect(callsFor('fetch_send')).toEqual([
      ['plugin:http|fetch_send', { rid: 1 }],
      ['plugin:http|fetch_send', { rid: 2 }],
    ])
  })

  it('cancels an already returned native stream on close and blocks stale requests', async () => {
    const readStarted = Promise.withResolvers<void>()
    const rust = stubRust(rid => { if (rid === 102) readStarted.resolve() })
    rust.send.mockResolvedValueOnce(exchangeResponse())
      .mockResolvedValueOnce(businessResponse('/api/events', 'text/event-stream'))
    const session = await transport.openDshTunnelTransport(grant(), controller().signal)
    const wrapped = transport.withDshTunnelFetch(nativeFetch)
    const response = await wrapped(`${origin}/api/events`)
    const reader = response.body!.getReader()
    // 已返回的插件流直接以字符串报错，不是 DOMException 或 Error 实例。
    const reading = expect(reader.read()).rejects.toBe('Request cancelled')
    await readStarted.promise

    session.close()
    session.close()
    await reading
    reader.releaseLock()
    expect(callsFor('fetch_cancel')).toEqual([['plugin:http|fetch_cancel', { rid: 2 }]])
    expect(callsFor('fetch_cancel_body')).toEqual([
      ['plugin:http|fetch_cancel_body', { rid: 101 }],
      ['plugin:http|fetch_cancel_body', { rid: 102 }],
    ])
    expect(transport.getDshTunnelSocketAuth(socketUrl)).toBeUndefined()
    await expect(wrapped(`${origin}/api/events`, { headers: { Cookie: cookie } }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(rust.requests).toHaveLength(2)
  })

  it('discards a late native 303 after cancellation and releases its body', async () => {
    const rust = stubRust()
    const sendStarted = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<NativeResponse>()
    rust.send.mockImplementationOnce(() => {
      sendStarted.resolve()
      return pending.promise
    })
    const lifetime = controller()
    const reason = new DOMException('Connection switched', 'AbortError')
    const opening = transport.openDshTunnelTransport(grant(), lifetime.signal)
    const rejected = expect(opening).rejects.toBe(reason)
    await sendStarted.promise
    lifetime.abort(reason)
    expect(callsFor('fetch_cancel')).toEqual([['plugin:http|fetch_cancel', { rid: 1 }]])

    // 模拟取消与响应头到达的竞态，让真实插件继续构造晚到的 303 Response。
    pending.resolve(exchangeResponse())
    await rejected
    expect(callsFor('fetch_cancel_body')).toEqual([['plugin:http|fetch_cancel_body', { rid: 101 }]])
    expect(transport.getDshTunnelSocketAuth(socketUrl)).toBeUndefined()
    expect(rust.requests).toHaveLength(1)
    expect(callsFor('fetch_send')).toEqual([['plugin:http|fetch_send', { rid: 1 }]])
  })
})
