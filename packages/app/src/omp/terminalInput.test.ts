import { expect, it, vi } from 'vitest'
import { sendTerminalInput } from './terminalInput'
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
