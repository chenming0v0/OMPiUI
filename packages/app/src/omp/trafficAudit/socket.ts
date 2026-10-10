import type { PiSocket, PiSocketMessage } from '../ompSocket'
import { payloadBytes, textBodyPreview, trafficPreview } from './privacy'
import { trafficAuditStore, type TrafficHandle } from './store'

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function annotate(handle: TrafficHandle | undefined, value: unknown): void {
  if (!handle) return
  const message = object(value)
  if (!message) return
  const event = object(message.event)
  const payload = object(event?.payload)
  const inner = object(payload?.event)
  const stream = object(event?.stream)
  const kind = inner?.type ?? event?.channel ?? message.type
  trafficAuditStore.update(handle, {
    operation: typeof kind === 'string' ? kind : 'message',
    sessionId: stream?.kind === 'session' && typeof stream.id === 'string' ? stream.id : undefined,
    ...(handle.record.direction === 'sent'
      ? { requestPreview: trafficAuditStore.canPreview(handle) ? trafficPreview(value) : undefined }
      : { responsePreview: trafficAuditStore.canPreview(handle) ? trafficPreview(value) : undefined }),
  })
}

export function auditSocket(socket: PiSocket, url: string, serverUrl?: string): PiSocket {
  const started = performance.now()
  const connection = trafficAuditStore.start(
    url,
    {
      protocol: 'ws',
      direction: 'connection',
      operation: 'connect',
      status: 'pending',
      sentBytes: 0,
      receivedBytes: 0,
    },
    serverUrl,
  )
  const recordMessage = (direction: 'sent' | 'received', data: unknown) => {
    if (!trafficAuditStore.isEnabled()) return
    const bytes = payloadBytes(data)
    return trafficAuditStore.start(
      url,
      {
        protocol: 'ws',
        direction,
        operation: 'message',
        status: 'complete',
        sentBytes: direction === 'sent' ? bytes : 0,
        receivedBytes: direction === 'received' ? bytes : 0,
        connectionId: connection?.record.id,
      },
      serverUrl,
    )
  }
  const audited: PiSocket = {
    get readyState() {
      return socket.readyState
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (socket.readyState !== 1) return socket.send(data)
      socket.send(data)
      const handle = recordMessage('sent', data)
      if (handle && data.length <= 64 * 1024) {
        try {
          annotate(handle, JSON.parse(data))
        } catch {
          if (trafficAuditStore.canPreview(handle))
            trafficAuditStore.update(handle, { requestPreview: textBodyPreview(data) })
        }
      }
    },
    close(code, reason) {
      socket.close(code, reason)
    },
  }
  socket.onopen = () => {
    trafficAuditStore.update(connection, { status: 'open', headersMs: performance.now() - started })
    audited.onopen?.()
  }
  socket.onmessage = event => {
    const handle = recordMessage('received', event.data)
    const message: PiSocketMessage = { data: event.data }
    // 消费方复用已经解析的对象标注事件类型，避免审计再次解析大流式帧。
    Object.defineProperty(message, 'annotateTraffic', { value: (parsed: unknown) => annotate(handle, parsed) })
    audited.onmessage?.(message)
  }
  socket.onerror = () => {
    trafficAuditStore.update(connection, { status: 'error', error: 'WebSocketError' })
    audited.onerror?.()
  }
  socket.onclose = event => {
    trafficAuditStore.update(connection, {
      status: event.code === 1000 || event.code === 1001 || event.code === 1005 ? 'closed' : 'error',
      statusCode: event.code,
      durationMs: performance.now() - started,
    })
    audited.onclose?.(event)
  }
  return audited
}
