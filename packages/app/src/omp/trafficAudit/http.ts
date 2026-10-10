import { payloadBytes, textBodyPreview, trafficPreview } from './privacy'
import { trafficAuditStore, type TrafficHandle } from './store'

function recordFailure(
  handle: TrafficHandle | undefined,
  error: unknown,
  started: number,
  signal?: AbortSignal | null,
): void {
  const reason = signal?.aborted ? signal.reason : error
  const name =
    reason instanceof Error || reason instanceof DOMException
      ? reason.name
      : signal?.aborted
        ? 'AbortError'
        : 'NetworkError'
  trafficAuditStore.update(handle, {
    status: signal?.aborted || /AbortError|TimeoutError/.test(name) ? 'aborted' : 'error',
    // 错误正文可能带 URL 或凭证；只保留错误类型。
    error: name,
    durationMs: performance.now() - started,
  })
}

function observeResponse(
  response: Response,
  handle: TrafficHandle | undefined,
  started: number,
  signal?: AbortSignal | null,
): Response {
  if (!handle) return response
  trafficAuditStore.update(handle, {
    status: response.ok ? 'headers' : 'error',
    statusCode: response.status,
    headersMs: performance.now() - started,
    contentType: response.headers?.get('content-type') ?? undefined,
    contentEncoding: response.headers?.get('content-encoding') ?? undefined,
    declaredBytes: response.headers?.has('content-length') ? Number(response.headers.get('content-length')) : undefined,
  })
  if (typeof response.arrayBuffer !== 'function') return response
  const readBuffer = response.arrayBuffer.bind(response)
  const readBlob = response.blob.bind(response)
  const finish = (bytes: number, preview?: string) =>
    trafficAuditStore.update(handle, {
      receivedBytes: bytes,
      status: response.ok ? 'complete' : 'error',
      durationMs: performance.now() - started,
      responsePreview: preview,
    })
  const buffer = async () => {
    try {
      const data = await readBuffer()
      finish(data.byteLength)
      return data
    } catch (error) {
      recordFailure(handle, error, started, signal)
      throw error
    }
  }
  // 沿用原 Response 和单次正文读取，不 clone、不提前消费，也不改变请求重试语义。
  response.arrayBuffer = buffer
  response.text = async () => {
    const data = await buffer()
    const text = new TextDecoder().decode(data)
    if (trafficAuditStore.canPreview(handle)) finish(data.byteLength, textBodyPreview(text))
    return text
  }
  response.json = async () => {
    const data = await buffer()
    const value: unknown = JSON.parse(new TextDecoder().decode(data))
    if (trafficAuditStore.canPreview(handle)) finish(data.byteLength, trafficPreview(value))
    return value
  }
  response.blob = async () => {
    try {
      const data = await readBlob()
      finish(data.size)
      return data
    } catch (error) {
      recordFailure(handle, error, started, signal)
      throw error
    }
  }
  if (response.body === null) finish(0)
  return response
}

export async function auditHttpRequest(
  input: string,
  init: RequestInit | undefined,
  request: () => Promise<Response>,
  serverUrl?: string,
  attempt = 1,
): Promise<Response> {
  if (!trafficAuditStore.isEnabled()) return request()
  const started = performance.now()
  const handle = trafficAuditStore.start(
    input,
    {
      protocol: 'http',
      direction: 'exchange',
      operation: (init?.method ?? 'GET').toUpperCase(),
      status: 'pending',
      sentBytes: payloadBytes(init?.body),
      receivedBytes: null,
      attempt,
    },
    serverUrl,
  )
  if (trafficAuditStore.canPreview(handle) && typeof init?.body === 'string') {
    trafficAuditStore.update(handle, { requestPreview: textBodyPreview(init.body) })
  }
  try {
    return observeResponse(await request(), handle, started, init?.signal)
  } catch (error) {
    recordFailure(handle, error, started, init?.signal)
    throw error
  }
}
