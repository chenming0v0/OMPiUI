import { describe, it, expect, vi } from 'vitest'
import { ToolInteractionInput, parseToolInteractionFrame } from './toolInteraction'
import { PI_SOCKET_OPEN, type PiSocket } from './ompSocket'

function socket() {
  const frames: Record<string, unknown>[] = []
  const value = { readyState: PI_SOCKET_OPEN, send: (text: string) => frames.push(JSON.parse(text)), close: vi.fn() } as unknown as PiSocket
  return { value, frames }
}
const lease = (input: ToolInteractionInput, sequence = 0) => ({ writerId: input.writerId, writerEpoch: 'epoch', lastAcceptedSequence: sequence, expiresAt: Date.now() + 60000 })

describe('tool PTY input controller', () => {
  it('requires explicit ownership and resumes accepted input without repeating it', () => {
    const input = new ToolInteractionInput(), first = socket()
    input.connect(first.value)
    expect(input.enqueue('not authorized')).toBe('closed')
    expect(first.frames).toHaveLength(0)
    input.claim(); input.lease(lease(input))
    input.enqueue('确认中文'); input.enqueue('\r')
    expect(first.frames.filter(frame => frame.type === 'input')).toHaveLength(1)
    input.disconnect()
    const second = socket(); input.connect(second.value)
    expect(second.frames[0]).toMatchObject({ type: 'claim', writerEpoch: 'epoch' })
    input.lease(lease(input, 1))
    expect(second.frames.filter(frame => frame.type === 'input')).toEqual([{ type: 'input', sequence: 2, data: '\r' }])
    input.acknowledge(2, 2)
    expect(input.pendingBytes).toBe(0)
    input.close()
  })

  it('retries an unaccepted sequence only after authoritative resume confirmation', () => {
    const input = new ToolInteractionInput(), first = socket()
    input.connect(first.value); input.claim(); input.lease(lease(input)); input.enqueue('answer')
    input.disconnect()
    const second = socket(); input.connect(second.value)
    expect(second.frames.some(frame => frame.type === 'input')).toBe(false)
    input.lease(lease(input, 0))
    expect(second.frames.at(-1)).toEqual({ type: 'input', sequence: 1, data: 'answer' })
    input.close()
  })

  it('never migrates pending input to a different writer epoch', () => {
    const input = new ToolInteractionInput(), ws = socket()
    input.connect(ws.value); input.claim(); input.lease(lease(input)); input.enqueue('unknown')
    input.disconnect(); input.connect(socket().value)
    input.lease({ ...lease(input), writerEpoch: 'new' })
    expect(input.state).toBe('paused'); expect(input.pendingBytes).toBeGreaterThan(0)
    input.close()
  })

  it('does not cancel or release a command when a view disconnects', () => {
    const input = new ToolInteractionInput(), ws = socket()
    input.connect(ws.value); input.claim(); input.lease(lease(input)); input.disconnect()
    expect(ws.frames.some(frame => frame.type === 'cancel' || frame.type === 'release')).toBe(false)
    input.close()
  })

  it('recovers an expired empty lease only on explicit claim and bounds paste', () => {
    const input = new ToolInteractionInput(), ws = socket()
    input.connect(ws.value); input.claim(); input.lease(lease(input)); input.pause(); input.claim()
    expect(ws.frames.at(-1)).not.toHaveProperty('writerEpoch')
    input.lease(lease(input)); expect(input.enqueue('界'.repeat(400000))).toBe('full')
    input.close()
  })
})

describe('tool stream validation', () => {
  it('rejects malformed output and input acknowledgements', () => {
    expect(parseToolInteractionFrame({ type: 'input_ack', sequence: -1, lastAcceptedSequence: 1 })).toBeUndefined()
    expect(parseToolInteractionFrame({ type: 'output', fromCursor: 3, cursor: 2, data: '', reset: false })).toBeUndefined()
    expect(parseToolInteractionFrame({ type: 'hello', descriptor: { pty: true } })).toBeUndefined()
  })
})
