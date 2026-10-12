import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ fetch: vi.fn(), onServerChange: vi.fn(), generation: 1 }))
const refresh = vi.hoisted(() => ({ state: vi.fn(), branch: vi.fn() }))
vi.mock('../controllers/index.js', () => ({ refreshPiSessionState: refresh.state, refreshPiBranch: refresh.branch }))
vi.mock('../httpClient', () => ({ getApiBase: () => '', piFetch: network.fetch }))
vi.mock('../../store/serverStore', () => ({
  serverStore: {
    getActiveServer: () => ({ id: 'server-a' }), getActiveServerGeneration: () => network.generation,
    onServerChange: network.onServerChange,
  },
}))
vi.mock('./storage', () => ({
  readSavedFault: () => undefined, readFullSavedFault: () => Promise.resolve(undefined), saveFault: vi.fn(),
}))

describe('fault audit integration', () => {
  it('elects one health probe leader across tabs and hands over on cleanup', async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'locks')
    type Waiter = { grant: () => void; signal?: AbortSignal }
    const queue: Waiter[] = []
    let held = false
    const drain = () => {
      if (held) return
      const next = queue.shift()
      if (next) { held = true; next.grant() }
    }
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: (_name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>) =>
        new Promise<void>((resolve, reject) => {
          const waiter: Waiter = { signal: options.signal, grant: () => {
            options.signal?.removeEventListener('abort', abort)
            void callback().then(resolve, reject).finally(() => { held = false; drain() })
          } }
          const abort = () => {
            const index = queue.indexOf(waiter)
            if (index >= 0) queue.splice(index, 1)
            reject(new DOMException('Aborted', 'AbortError'))
          }
          options.signal?.addEventListener('abort', abort, { once: true })
          queue.push(waiter)
          drain()
        }),
    } })
    network.fetch.mockImplementation(() => Promise.resolve(Response.json({ runId: 'leader-run', version: 'test', faults: [] })))
    const first = await import('./controller')
    const stopFirst = first.startFaultAudit()
    let stopSecond: (() => void) | undefined
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(network.fetch).toHaveBeenCalledTimes(1)
      vi.resetModules()
      const second = await import('./controller')
      stopSecond = second.startFaultAudit()
      await vi.advanceTimersByTimeAsync(5000)
      expect(network.fetch).toHaveBeenCalledTimes(2)
      stopFirst()
      await vi.advanceTimersByTimeAsync(0)
      expect(network.fetch).toHaveBeenCalledTimes(3)
    } finally {
      stopFirst()
      stopSecond?.()
      if (previous) Object.defineProperty(navigator, 'locks', previous)
      else Reflect.deleteProperty(navigator, 'locks')
    }
  })
  it('backs off failed health probes instead of repeating every five seconds', async () => {
    network.fetch.mockRejectedValue(new TypeError('offline backend'))
    const { startFaultAudit } = await import('./controller')
    stop = startFaultAudit()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(network.fetch.mock.calls.filter(([url]) => String(url).endsWith('/diagnostics/status')).length).toBeLessThanOrEqual(5)
  })
  let stop: (() => void) | undefined
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    localStorage.clear()
    network.fetch.mockReset()
    network.onServerChange.mockReturnValue(() => {})
    network.generation = 1
    refresh.state.mockReset().mockResolvedValue(undefined)
    refresh.branch.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers() })

  it('collects a crash report without uploading anything to mclo.gs', async () => {
    network.fetch.mockResolvedValue(new Response(JSON.stringify({ content: 'backend timeline', complete: true, files: 4, unavailable: [] })))
    const { reportRuntimeCrash } = await import('./controller')
    const { faultAuditStore } = await import('./store')
    reportRuntimeCrash('session-crashed')
    await vi.waitFor(() => expect(faultAuditStore.getSnapshot().collecting).toBe(false))
    expect(faultAuditStore.getSnapshot().saved?.report.content).toContain('backend timeline')
    expect(faultAuditStore.getSnapshot().saved?.report.complete).toBe(true)
    expect(network.fetch).toHaveBeenCalledWith('/api/v1/host/diagnostics/report', expect.objectContaining({ retry: false }))
    expect(network.fetch.mock.calls.every(([url]) => !String(url).includes('mclo.gs'))).toBe(true)
  })

  it('treats a healthy legacy backend as connected instead of reporting the audit endpoint 404', async () => {
    network.fetch.mockImplementation((url: string) => Promise.resolve(url.endsWith('/diagnostics/status')
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify({ service: 'ompiui-server', processId: 123 }))))
    const { startFaultAudit } = await import('./controller')
    const { faultAuditStore } = await import('./store')
    stop = startFaultAudit()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(faultAuditStore.getSnapshot().saved).toBeUndefined()
    expect(network.fetch.mock.calls.some(([url]) => String(url).endsWith('/host/health'))).toBe(true)
  })

  it('refreshes authoritative state and history when polling finds a crash missed by the socket', async () => {
    const notice = { id: 'missed-crash', kind: 'runtime_crashed', time: new Date().toISOString(), sessionId: 'session-mobile' }
    network.fetch.mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
      url.endsWith('/diagnostics/status')
        ? { runId: 'run-a', version: 'test', faults: [notice], activeSessionIds: [] }
        : { content: 'crash metadata', complete: true, files: 1, unavailable: [] },
    ))))
    const { startFaultAudit } = await import('./controller')
    stop = startFaultAudit()
    await vi.advanceTimersByTimeAsync(5000)
    expect(refresh.state).toHaveBeenCalledWith('session-mobile')
    expect(refresh.branch).toHaveBeenCalledWith('session-mobile')
    expect(refresh.state).toHaveBeenCalledTimes(1)
  })

  it('does not apply a late fault refresh to a different server', async () => {
    network.fetch.mockResolvedValue(new Response(JSON.stringify({ content: '', complete: true, files: 0, unavailable: [] })))
    const { reportRuntimeCrash } = await import('./controller')
    reportRuntimeCrash('old-server-session')
    network.generation += 1
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh.state).not.toHaveBeenCalled()
    expect(refresh.branch).not.toHaveBeenCalled()
  })

  it('keeps an offline client report and fills it after the same server reconnects', async () => {
    let online = false
    network.fetch.mockImplementation((url: string) => online
      ? Promise.resolve(new Response(JSON.stringify(url.endsWith('/diagnostics/report')
        ? { content: 'recovered backend timeline', complete: true, files: 5, unavailable: [] }
        : { runId: 'run-reconnected', version: 'test', faults: [] })))
      : Promise.reject(new TypeError('network failed with PRIVATE_RAW_ERROR')))
    const { startFaultAudit } = await import('./controller')
    const { faultAuditStore } = await import('./store')
    stop = startFaultAudit()
    await vi.advanceTimersByTimeAsync(55_000)
    expect(faultAuditStore.getSnapshot().saved?.notice.kind).toBe('connection_lost')
    expect(faultAuditStore.getSnapshot().saved?.report.unavailable).toContain('server_unreachable')
    expect(faultAuditStore.getSnapshot().saved?.report.content).not.toContain('PRIVATE_RAW_ERROR')
    online = true
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(faultAuditStore.getSnapshot().saved?.report.complete).toBe(true)
    expect(faultAuditStore.getSnapshot().saved?.report.content).toContain('recovered backend timeline')
  })
})
