import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPiSocket, openPlatformSocket, PI_SOCKET_CLOSED, PI_SOCKET_OPEN } from './ompSocket'
import { sendTerminalInput } from './terminalInput'

const { invokeMock, isTauriMock, getDshTunnelSocketAuthMock, bridgeState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
  getDshTunnelSocketAuthMock: vi.fn<(url: string) => { cookie: string; origin: string } | undefined>(),
  bridgeState: { channel: null as { onmessage: ((event: unknown) => void) | null } | null },
}))

vi.mock('../utils/tauri', () => ({ isTauri: isTauriMock }))
vi.mock('../services/dshTunnelTransport', () => ({ getDshTunnelSocketAuth: getDshTunnelSocketAuthMock }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null

    constructor() {
      bridgeState.channel = this
    }
  },
}))

describe('PiSocket Tauri bridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReturnValue(true)
    getDshTunnelSocketAuthMock.mockReset()
    bridgeState.channel = null
  })
  afterEach(() => vi.unstubAllGlobals())

  it('uses the Rust bridge for Android-compatible WebSocket traffic', async () => {
    invokeMock.mockResolvedValueOnce(7).mockResolvedValue(undefined)
    const socket = openPiSocket('ws://192.168.1.10:8787/api/v1/events?token=test')
    const onOpen = vi.fn()
    const onMessage = vi.fn()
    const onClose = vi.fn()
    socket.onopen = onOpen
    socket.onmessage = onMessage
    socket.onclose = onClose

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('ws_bridge_connect', {
      url: 'ws://192.168.1.10:8787/api/v1/events?token=test',
      onEvent: bridgeState.channel,
    }))
    expect(invokeMock.mock.calls[0]?.[1]).not.toHaveProperty('tunnelAuth')
    bridgeState.channel?.onmessage?.({ type: 'open' })
    expect(socket.readyState).toBe(PI_SOCKET_OPEN)
    expect(onOpen).toHaveBeenCalledOnce()

    socket.send('hello')
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('ws_bridge_send', { id: 7, data: 'hello' }))
    onMessage.mockImplementationOnce(() => {
      expect(invokeMock).not.toHaveBeenCalledWith('ws_bridge_ack', expect.any(Object))
    })
    bridgeState.channel?.onmessage?.({ type: 'message', sequence: 1, data: 'reply' })
    expect(onMessage).toHaveBeenCalledWith({ data: 'reply' })
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('ws_bridge_ack', { id: 7, sequence: 1 }))

    bridgeState.channel?.onmessage?.({ type: 'close', code: 1000, reason: 'done' })
    expect(socket.readyState).toBe(PI_SOCKET_CLOSED)
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: 'done' })
  })

  it('passes the current DS tunnel cookie and origin to native app sockets on each connection', async () => {
    invokeMock.mockResolvedValueOnce(9).mockResolvedValueOnce(10).mockResolvedValue(undefined)
    const url = 'wss://tabcdefghijk.tun.4ba.io/api/v1/events?token=test'
    const auth = { cookie: '__Host-dsh_session=first', origin: 'https://tabcdefghijk.tun.4ba.io' }
    const refreshedAuth = { ...auth, cookie: '__Host-dsh_session=refreshed' }
    getDshTunnelSocketAuthMock.mockReturnValueOnce(auth).mockReturnValueOnce(refreshedAuth)

    const firstSocket = openPiSocket(url)
    await vi.waitFor(() => expect(invokeMock).toHaveBeenNthCalledWith(1, 'ws_bridge_connect', {
      url,
      onEvent: bridgeState.channel,
      tunnelAuth: auth,
    }))
    const secondSocket = openPiSocket(url)
    await vi.waitFor(() => expect(invokeMock).toHaveBeenNthCalledWith(2, 'ws_bridge_connect', {
      url,
      onEvent: bridgeState.channel,
      tunnelAuth: refreshedAuth,
    }))
    expect(getDshTunnelSocketAuthMock).toHaveBeenNthCalledWith(1, url)
    expect(getDshTunnelSocketAuthMock).toHaveBeenNthCalledWith(2, url)
    firstSocket.close()
    secondSocket.close()
  })

  it('keeps DS control connections free of tunnel auth even when a tunnel cookie is available', async () => {
    invokeMock.mockResolvedValueOnce(11).mockResolvedValue(undefined)
    getDshTunnelSocketAuthMock.mockReturnValue({
      cookie: '__Host-dsh_session=private',
      origin: 'https://tabcdefghijk.tun.4ba.io',
    })

    const socket = openPlatformSocket('wss://dsh.r2049.cn/ws/v1/connect')
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('ws_bridge_connect', {
      url: 'wss://dsh.r2049.cn/ws/v1/connect',
      onEvent: bridgeState.channel,
    }))
    expect(getDshTunnelSocketAuthMock).not.toHaveBeenCalled()
    expect(invokeMock.mock.calls[0]?.[1]).not.toHaveProperty('tunnelAuth')
    socket.close()
  })

  it('uses the browser WebSocket without reading native tunnel auth outside Tauri', () => {
    isTauriMock.mockReturnValue(false)
    const browserSocket = { readyState: PI_SOCKET_OPEN, close: vi.fn(), send: vi.fn() }
    const WebSocketMock = vi.fn(function () { return browserSocket })
    vi.stubGlobal('WebSocket', WebSocketMock)
    const url = 'wss://tabcdefghijk.tun.4ba.io/api/v1/events'

    const socket = openPiSocket(url)
    expect(WebSocketMock).toHaveBeenCalledWith(url)
    expect(getDshTunnelSocketAuthMock).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
    socket.close()
    expect(browserSocket.close).toHaveBeenCalledOnce()
  })

  it('serializes queued sends so a large paste survives bridge backpressure in order', async () => {
    const sent: string[] = []
    let release: (() => void) | undefined
    invokeMock.mockImplementation((command: string, args: { data: string }) => {
      if (command === 'ws_bridge_connect') return Promise.resolve(8)
      if (command === 'ws_bridge_send') {
        sent.push(args.data)
        return new Promise<void>(resolve => { release = resolve })
      }
      return Promise.resolve()
    })
    const socket = openPiSocket('ws://127.0.0.1:8787/api/v1/host/terminals/test/stream')
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('ws_bridge_connect', expect.any(Object)))
    bridgeState.channel?.onmessage?.({ type: 'open' })
    const text = 'x'.repeat(5 * 1024 * 1024)
    sendTerminalInput(socket, text)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(socket.readyState).toBe(PI_SOCKET_OPEN)
    const frameCount = Math.ceil(text.length / (64 * 1024 - 128))
    for (let index = 1; index < frameCount; index++) {
      release?.()
      await vi.waitFor(() => expect(sent).toHaveLength(index + 1), { interval: 1 })
    }
    release?.()
    expect(sent.map(data => JSON.parse(data).data).join('')).toBe(text)
    expect(socket.readyState).toBe(PI_SOCKET_OPEN)
    socket.close()
  })
})
