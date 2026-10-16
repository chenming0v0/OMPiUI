import { afterEach, expect, it, vi } from 'vitest'
import { MAX_PENDING_TERMINAL_INPUT_BYTES, sendTerminalInput, TerminalInputQueue } from './terminalInput'
import { PI_SOCKET_OPEN, type PiSocket } from './ompSocket'

it('splits large pastes by encoded JSON bytes without losing input or unicode', () => {
  for (const text of ['x'.repeat(300000), '\0\n\t"\\'.repeat(40000), '正文😀'.repeat(40000)]) {
    const send = vi.fn()
    sendTerminalInput({ readyState: PI_SOCKET_OPEN, send } as unknown as PiSocket, text)
    const frames = send.mock.calls.map(([data]) => data as string)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.map(data => JSON.parse(data).data).join('')).toBe(text)
    for (const frame of frames) expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(64 * 1024)
  }
})

afterEach(() => {
  vi.useRealTimers()
})

it('shapes consecutive control-character pastes within the real server wire budget', async () => {
  const { RateBudget } = await vi.importActual<{
    RateBudget: new (burst: number, rate: number) => unknown
  }>('../../../server/src/rate-budget.ts')
  const { WebSocketIngressBudget } = await vi.importActual<{
    WebSocketIngressBudget: new (frames: unknown, bytes: unknown) => { allow(bytes: number): boolean }
  }>('../../../server/src/ws-ingress-budget.ts')
  vi.useFakeTimers()
  const ingress = new WebSocketIngressBudget(
    new RateBudget(4096, 2048), new RateBudget(32 * 1024 * 1024, 16 * 1024 * 1024),
  )
  const input = new TerminalInputQueue()
  let sentBytes = 0
  let received = ''
  const socket = {
    readyState: PI_SOCKET_OPEN,
    close: vi.fn(),
    send(data: string) {
      expect(ingress.allow(new TextEncoder().encode(data).byteLength)).toBe(true)
      const frame = JSON.parse(data)
      sentBytes += new TextEncoder().encode(data).byteLength
      received += frame.data
      input.acknowledge(socket, { type: 'input_ack', inputId: frame.inputId, accepted: true })
    },
  } as unknown as PiSocket
  input.connect(socket, true)
  const paste = '\x1b'.repeat(MAX_PENDING_TERMINAL_INPUT_BYTES)
  for (let index = 0; index < 2; index++) {
    expect(input.enqueue(paste)).toBe('queued')
    for (let frames = 0; input.pendingBytes && frames < 1000; frames++) vi.advanceTimersToNextTimer()
    expect(input.pendingBytes).toBe(0)
  }
  expect(sentBytes).toBeGreaterThan(12 * 1024 * 1024)
  expect(received).toBe(paste + paste)
  expect(input.state).toBe('ready')
  expect(socket.close).not.toHaveBeenCalled()
  input.dispose()
})

it('accepts or refuses a whole paste, retries only explicit rejection, and releases acknowledged bytes', () => {
  vi.useFakeTimers()
  const send = vi.fn()
  const close = vi.fn()
  const socket = { readyState: PI_SOCKET_OPEN, send, close } as unknown as PiSocket
  const input = new TerminalInputQueue()
  input.connect(socket, true)
  expect(input.enqueue('first')).toBe('queued')
  expect(input.enqueue('x'.repeat(MAX_PENDING_TERMINAL_INPUT_BYTES))).toBe('full')
  expect(input.pendingText).toBe('first')
  const frame = JSON.parse(send.mock.calls[0][0])
  input.acknowledge(socket, { type: 'input_ack', inputId: frame.inputId, accepted: false, retryAfterMs: 50 })
  expect(input.pendingBytes).toBe(5)
  vi.advanceTimersByTime(50)
  expect(send).toHaveBeenCalledTimes(2)
  expect(JSON.parse(send.mock.calls[1][0])).toEqual(frame)
  input.acknowledge(socket, { type: 'input_ack', inputId: frame.inputId, accepted: true })
  expect(input.pendingBytes).toBe(0)
  expect(input.pendingText).toBe('')
  expect(close).not.toHaveBeenCalled()
  input.dispose()
})

it('holds unconfirmed input after a disconnect instead of automatically replaying it', () => {
  vi.useFakeTimers()
  const send = vi.fn()
  const socket = { readyState: PI_SOCKET_OPEN, send, close: vi.fn() } as unknown as PiSocket
  const replacement = { readyState: PI_SOCKET_OPEN, send, close: vi.fn() } as unknown as PiSocket
  const input = new TerminalInputQueue()
  input.connect(socket, true)
  expect(input.enqueue('maybe executed')).toBe('queued')
  input.disconnect(socket)
  input.connect(replacement, true)
  vi.advanceTimersByTime(20_000)
  expect(input.state).toBe('interrupted')
  expect(input.pendingText).toBe('maybe executed')
  expect(send).toHaveBeenCalledTimes(1)
  expect(input.enqueue('another')).toBe('interrupted')
  input.discardInterruptedInput()
  expect(input.state).toBe('ready')
  expect(input.pendingBytes).toBe(0)
  input.dispose()
})
