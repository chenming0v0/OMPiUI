import { describe, expect, it, vi } from 'vitest'
import { payloadBytes, redactTrafficUrl, textBodyPreview, trafficPreview } from './privacy'
import { TrafficAuditStore } from './store'
import { trafficRanking } from './summary'

const request = {
  protocol: 'http',
  direction: 'exchange',
  operation: 'GET',
  status: 'pending',
  sentBytes: 0,
  receivedBytes: null,
} as const

describe('traffic audit storage', () => {
  it('keeps bounded records while retaining lifetime totals and updates evicted in-flight requests', () => {
    const store = new TrafficAuditStore(2)
    const first = store.start('http://remote.test/first', request)!
    store.start('http://remote.test/second', request)
    store.start('http://remote.test/third', request)
    store.update(first, { receivedBytes: 1024, status: 'complete' })

    const snapshot = store.getSnapshot()
    expect(snapshot.records.map(record => record.path)).toEqual(['/third', '/second'])
    expect(snapshot.dropped).toBe(1)
    expect(snapshot.totals['http://remote.test']).toMatchObject({ httpRequests: 3, receivedBytes: 1024 })
  })

  it('does not double-count body completion or failure updates', () => {
    const store = new TrafficAuditStore()
    const handle = store.start('/api/read', request)
    store.update(handle, { receivedBytes: 10, status: 'error' })
    store.update(handle, { receivedBytes: 10, status: 'error' })
    expect(Object.values(store.getSnapshot().totals)[0]).toMatchObject({ receivedBytes: 10, errors: 1 })
  })

  it('ignores pre-clear requests finishing after clear and keeps pause separate from clearing', () => {
    const store = new TrafficAuditStore()
    const handle = store.start('/api/read', request)
    store.clear()
    store.update(handle, { receivedBytes: 999, status: 'complete' })
    expect(store.getSnapshot().records).toHaveLength(0)
    expect(store.getSnapshot().totals).toEqual({})

    const active = store.start('/api/new', request)
    store.setEnabled(false)
    expect(store.start('/api/paused', request)).toBeUndefined()
    store.update(active, { receivedBytes: 3, status: 'complete' })
    expect(store.getSnapshot().records).toHaveLength(1)
    expect(Object.values(store.getSnapshot().totals)[0].receivedBytes).toBe(3)
  })

  it('removes previews and does not re-enable capture for old requests', () => {
    const store = new TrafficAuditStore()
    store.setPreviews(true)
    const handle = store.start('/api/new', request)
    store.update(handle, { requestPreview: 'private' })
    store.setPreviews(false)
    store.setPreviews(true)
    store.update(handle, { status: 'complete' })
    expect(store.canPreview(handle)).toBe(false)
    expect(store.getSnapshot().records[0].requestPreview).toBeUndefined()
  })

  it('batches notifications and cancels notification work without a visible subscriber', () => {
    vi.useFakeTimers()
    try {
      const store = new TrafficAuditStore()
      const listener = vi.fn()
      const unsubscribe = store.subscribe(listener)
      for (let i = 0; i < 100; i++) store.start('/api/test', request)
      expect(listener).not.toHaveBeenCalled()
      vi.advanceTimersByTime(500)
      expect(listener).toHaveBeenCalledOnce()
      store.start('/api/test', request)
      unsubscribe()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('normalizes WebSocket origins and groups session requests without exposing URL credentials', () => {
    const store = new TrafficAuditStore()
    store.start('wss://remote.test/api/v1/sessions/one/branch?token=secret', request)
    store.start('https://remote.test/api/v1/sessions/two/branch', request)
    expect(store.getSnapshot().records[1].url).not.toContain('secret')
    expect(trafficRanking(store.getSnapshot().records)).toEqual([
      { label: 'HTTP GET /api/v1/sessions/:id/branch', count: 2, bytes: 0 },
    ])
  })
})

describe('traffic payload privacy and byte measurement', () => {
  it('counts UTF-8 rather than JavaScript character length, including binary slices', () => {
    expect(payloadBytes('辰林')).toBe(6)
    const text = 'a'.repeat(65535) + '辰林😃'.repeat(10000)
    expect(payloadBytes(text)).toBe(new TextEncoder().encode(text).byteLength)
    expect(payloadBytes(new Uint8Array(new ArrayBuffer(10), 2, 3))).toBe(3)
    expect(payloadBytes(new Blob(['abc']))).toBe(3)
    expect(payloadBytes(new FormData())).toBeNull()
  })

  it('redacts URL credentials and structured nested secrets', () => {
    expect(
      redactTrafficUrl('https://user:password@remote.test/events?token=secret&ticket=123&cursor=5#secret').url,
    ).toBe('https://remote.test/events?token=%5Bredacted%5D&ticket=%5Bredacted%5D&cursor=5')
    const preview = trafficPreview({
      token: 'secret',
      providers: [{ apiKey: 'key-value', password: 'password-value', content: 'visible' }],
      url: 'ws://remote.test/?token=url-value',
    })
    expect(preview).not.toMatch(/secret|key-value|password-value|url-value/)
    expect(preview).toContain('visible')
  })

  it('omits large or invalid JSON snippets instead of leaking incomplete credential fields', () => {
    expect(textBodyPreview('{"apiKey":"private' + 'x'.repeat(100_000))).toBe('[large payload omitted]')
    expect(textBodyPreview('Bearer private')).toBe('[non-JSON payload omitted]')
    expect(trafficPreview({ message: 'x'.repeat(100_000) }).length).toBeLessThan(4200)
  })
})
