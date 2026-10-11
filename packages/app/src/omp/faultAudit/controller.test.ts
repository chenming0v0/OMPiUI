import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ fetch: vi.fn(), onServerChange: vi.fn(), generation: 1 }))
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
  let stop: (() => void) | undefined
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    localStorage.clear()
    network.fetch.mockReset()
    network.onServerChange.mockReturnValue(() => {})
    network.generation = 1
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
    await vi.advanceTimersByTimeAsync(5000)
    expect(faultAuditStore.getSnapshot().saved?.report.complete).toBe(true)
    expect(faultAuditStore.getSnapshot().saved?.report.content).toContain('recovered backend timeline')
  })
})
