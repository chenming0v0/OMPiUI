import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openPiSocket, PI_SOCKET_CLOSED, PI_SOCKET_OPEN } from './ompSocket'
import { sendTerminalInput } from './terminalInput'

const { invokeMock, bridgeState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  bridgeState: { channel: null as { onmessage: ((event: unknown) => void) | null } | null },
}))

vi.mock('../utils/tauri', () => ({ isTauri: () => true }))
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
    bridgeState.channel = null
  })

  it('uses the Rust bridge for Android-compatible WebSocket traffic', async () => {
    invokeMock.mockResolvedValueOnce(7).mockResolvedValue(undefined)
    const socket = openPiSocket('ws://192.168.1.10:8787/api/v1/events?token=test')
    const onOpen = vi.fn()
    const onMessage = vi.fn()
    const onClose = vi.fn()
    socket.onopen = onOpen
    socket.onmessage = onMessage
    socket.onclose = onClose

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('ws_bridge_connect', expect.any(Object)))
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
