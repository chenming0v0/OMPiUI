import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiSocket } from '../ompSocket'
import { auditSocket } from './socket'
import { trafficAuditStore } from './store'

function fakeSocket(): PiSocket {
  return { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null, send: vi.fn(), close: vi.fn() }
}

beforeEach(() => {
  trafficAuditStore.setEnabled(true)
  trafficAuditStore.setPreviews(false)
  trafficAuditStore.clear()
})

describe('WebSocket traffic auditing', () => {
  it('forwards lifecycle, send and close without changing the underlying connection', () => {
    const underlying = fakeSocket()
    const socket = auditSocket(underlying, 'ws://remote.test/events?token=private')
    socket.onopen = vi.fn()
    socket.onclose = vi.fn()
    underlying.onopen?.()
    socket.send('{"type":"ping"}')
    socket.close(1000, 'done')
    underlying.onclose?.({ code: 1000 })
    expect(underlying.send).toHaveBeenCalledWith('{"type":"ping"}')
    expect(underlying.close).toHaveBeenCalledWith(1000, 'done')
    expect(socket.onopen).toHaveBeenCalledOnce()
    expect(socket.onclose).toHaveBeenCalledWith({ code: 1000 })
    expect(trafficAuditStore.getSnapshot().records[0]).toMatchObject({
      direction: 'sent',
      operation: 'ping',
      sentBytes: 15,
    })
    expect(trafficAuditStore.getSnapshot().records[1]).toMatchObject({ status: 'closed', statusCode: 1000 })
    expect(JSON.stringify(trafficAuditStore.getSnapshot())).not.toContain('private')
  })

  it('counts the whole frame including repeated full messages and reuses parsed metadata', () => {
    trafficAuditStore.setPreviews(true)
    const underlying = fakeSocket()
    const socket = auditSocket(underlying, 'ws://remote.test/events')
    const message = {
      channel: 'event',
      event: {
        channel: 'pi.event',
        stream: { kind: 'session', id: 'session-1' },
        payload: {
          event: {
            type: 'message_update',
            message: { content: [{ type: 'text', text: '辰林' }] },
            assistantMessageEvent: { partial: { content: [{ type: 'text', text: '辰林' }] } },
          },
        },
      },
    }
    const raw = JSON.stringify(message)
    const listener = vi.fn()
    socket.onmessage = event => {
      event.annotateTraffic?.(message)
      listener(event)
    }
    underlying.onmessage?.({ data: raw })
    expect(listener).toHaveBeenCalledWith({ data: raw })
    expect(trafficAuditStore.getSnapshot().records[0]).toMatchObject({
      direction: 'received',
      receivedBytes: new TextEncoder().encode(raw).byteLength,
      operation: 'message_update',
      sessionId: 'session-1',
    })
    expect(trafficAuditStore.getSnapshot().records[0].responsePreview).toContain('assistantMessageEvent')
    expect(trafficAuditStore.getSnapshot().records[0].responsePreview).toContain('"text": "辰林"')
  })

  it('does not count unsent closed-socket messages, and resumes capture on an existing socket', () => {
    const underlying = fakeSocket()
    const socket = auditSocket(underlying, 'ws://remote.test/events')
    Object.defineProperty(underlying, 'readyState', { configurable: true, value: 3 })
    socket.send('not-sent')
    expect(trafficAuditStore.getSnapshot().records).toHaveLength(1)
    Object.defineProperty(underlying, 'readyState', { configurable: true, value: 1 })
    trafficAuditStore.setEnabled(false)
    underlying.onmessage?.({ data: 'paused' })
    expect(trafficAuditStore.getSnapshot().records).toHaveLength(1)
    trafficAuditStore.setEnabled(true)
    underlying.onmessage?.({ data: '辰林' })
    expect(trafficAuditStore.getSnapshot().records[0].receivedBytes).toBe(6)
  })

  it('does not classify a normal close without a status frame as a connection failure', () => {
    const underlying = fakeSocket()
    auditSocket(underlying, 'ws://remote.test/events')
    underlying.onclose?.({ code: 1005 })
    expect(trafficAuditStore.getSnapshot().records[0].status).toBe('closed')
    expect(trafficAuditStore.getSnapshot().totals['http://remote.test'].errors).toBe(0)
  })
})
