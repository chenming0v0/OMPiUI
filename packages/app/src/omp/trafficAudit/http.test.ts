import { beforeEach, describe, expect, it, vi } from 'vitest'
import { auditHttpRequest } from './http'
import { trafficAuditStore } from './store'

beforeEach(() => {
  trafficAuditStore.setEnabled(true)
  trafficAuditStore.setPreviews(false)
  trafficAuditStore.clear()
})

describe('HTTP traffic auditing', () => {
  it('preserves response identity, counts the exact consumed body, and never clones it', async () => {
    const body = '\uFEFF{"text":"辰林","apiKey":"private"}'
    const response = new Response(body, {
      headers: { 'content-type': 'application/json', 'content-length': '8', 'content-encoding': 'gzip' },
    })
    const clone = vi.spyOn(response, 'clone')
    const returned = await auditHttpRequest('http://remote.test/read?token=private', undefined, async () => response)
    expect(returned).toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(trafficAuditStore.getSnapshot().records[0].receivedBytes).toBeNull()
    expect(await returned.json()).toEqual({ text: '辰林', apiKey: 'private' })
    expect(clone).not.toHaveBeenCalled()
    expect(trafficAuditStore.getSnapshot().records[0]).toMatchObject({
      receivedBytes: new TextEncoder().encode(body).byteLength,
      declaredBytes: 8,
      contentEncoding: 'gzip',
      status: 'complete',
      responsePreview: undefined,
    })
  })

  it.each(['text', 'arrayBuffer', 'blob'] as const)('counts %s without changing the response body', async method => {
    const response = await auditHttpRequest(
      '/api/binary',
      { method: 'POST', body: '辰林' },
      async () => new Response('hello'),
    )
    const value = await response[method]()
    if (method === 'text') expect(value).toBe('hello')
    else if (method === 'arrayBuffer') expect(new TextDecoder().decode(value as ArrayBuffer)).toBe('hello')
    else expect((value as Blob).size).toBe(5)
    expect(trafficAuditStore.getSnapshot().records[0]).toMatchObject({ sentBytes: 6, receivedBytes: 5 })
  })

  it('captures bounded, redacted request and response previews only when opted in', async () => {
    trafficAuditStore.setPreviews(true)
    const response = await auditHttpRequest(
      '/api/models',
      {
        method: 'POST',
        body: '{"apiKey":"private","name":"test"}',
      },
      async () => new Response('{"token":"response-private","ok":true}'),
    )
    await response.json()
    const record = trafficAuditStore.getSnapshot().records[0]
    expect(record.requestPreview).toContain('"name": "test"')
    expect(record.responsePreview).toContain('"ok": true')
    expect(JSON.stringify(record)).not.toContain('private')
  })

  it('retains failed and cancelled attempts without recording sensitive error messages', async () => {
    const failure = new TypeError('network failed https://remote.test/?token=private')
    await expect(
      auditHttpRequest(
        '/api/read',
        undefined,
        async () => {
          throw failure
        },
        undefined,
        2,
      ),
    ).rejects.toBe(failure)
    await expect(
      auditHttpRequest('/api/read', undefined, async () => {
        throw new DOMException('private', 'AbortError')
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(trafficAuditStore.getSnapshot().records.map(record => record.status)).toEqual(['aborted', 'error'])
    expect(trafficAuditStore.getSnapshot().records[1].attempt).toBe(2)
    expect(JSON.stringify(trafficAuditStore.getSnapshot())).not.toContain('private')
  })

  it('distinguishes HTTP errors, empty responses and invalid JSON while preserving exceptions', async () => {
    const failed = await auditHttpRequest('/api/fail', undefined, async () => new Response('denied', { status: 403 }))
    expect(await failed.text()).toBe('denied')
    const empty = await auditHttpRequest('/api/empty', undefined, async () => new Response(null, { status: 204 }))
    expect(empty.status).toBe(204)
    expect(trafficAuditStore.getSnapshot().records[0].receivedBytes).toBe(0)
    const invalid = await auditHttpRequest('/api/invalid', undefined, async () => new Response('not json'))
    await expect(invalid.json()).rejects.toBeInstanceOf(SyntaxError)
    expect(trafficAuditStore.getSnapshot().records[0].receivedBytes).toBe(8)
    expect(trafficAuditStore.getSnapshot().records[2]).toMatchObject({
      statusCode: 403,
      status: 'error',
      receivedBytes: 6,
    })
  })

  it('does not resurrect an in-flight record after clearing, and bypasses instrumentation when paused', async () => {
    const response = await auditHttpRequest('/api/read', undefined, async () => new Response('hello'))
    trafficAuditStore.clear()
    await response.text()
    expect(trafficAuditStore.getSnapshot().totals).toEqual({})
    trafficAuditStore.setEnabled(false)
    const original = new Response('hello')
    const json = original.json
    expect(await auditHttpRequest('/api/read', undefined, async () => original)).toBe(original)
    expect(original.json).toBe(json)
  })

  it('uses the abort signal for Tauri body cancellation errors reported as strings', async () => {
    const abort = new AbortController()
    let bodyController!: ReadableStreamDefaultController
    const stream = new ReadableStream({
      start(controller) {
        bodyController = controller
      },
    })
    const response = await auditHttpRequest('/api/read', { signal: abort.signal }, async () => new Response(stream))
    const reading = response.text()
    abort.abort()
    bodyController.error('Request cancelled')
    await expect(reading).rejects.toBe('Request cancelled')
    expect(trafficAuditStore.getSnapshot().records[0]).toMatchObject({ status: 'aborted', error: 'AbortError' })
  })
})
