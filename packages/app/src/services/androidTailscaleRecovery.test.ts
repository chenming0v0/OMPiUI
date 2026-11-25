import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAndroidTailscaleRecovery } from './androidTailscaleRecovery'
import { APP_RESUMED_EVENT, TAILSCALE_READY_EVENT, TAILSCALE_STATUS_EVENT } from '../utils/tailscaleEvents'

const mocks = vi.hoisted(() => ({ status: vi.fn(), health: vi.fn() }))
vi.mock('../utils/androidTailscale', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/androidTailscale')>()),
  isAndroidTailscalePlatform: () => true,
  getAndroidTailscaleStatus: mocks.status,
}))
vi.mock('../store/serverStore', () => ({ serverStore: {
  getServers: () => [{ id: 'tailnet', url: 'http://100.101.2.3:8787' }, { id: 'lan', url: 'http://192.168.1.2:8787' }],
  checkHealth: mocks.health,
} }))

let stop: () => void
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  mocks.status.mockReset().mockResolvedValue({ enabled: true, BackendState: 'Starting' })
  mocks.health.mockReset().mockResolvedValue({ status: 'online' })
})
afterEach(() => {
  stop?.()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('phone virtual network recovery', () => {
  it('tracks connection readiness without an open settings panel and backs off after connection', async () => {
    stop = startAndroidTailscaleRecovery()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.status).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.status).toHaveBeenCalledTimes(2)
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'Running' })
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(mocks.status).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.status).toHaveBeenCalledTimes(4)
  })

  it('refreshes only saved Tailnet servers when the node becomes ready', async () => {
    stop = startAndroidTailscaleRecovery()
    window.dispatchEvent(new Event(TAILSCALE_READY_EVENT))
    expect(mocks.health).toHaveBeenCalledExactlyOnceWith('tailnet')
  })

  it('suspends background polling and refreshes immediately on native resume', async () => {
    stop = startAndroidTailscaleRecovery()
    await vi.advanceTimersByTimeAsync(0)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.status).toHaveBeenCalledTimes(1)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    window.dispatchEvent(new Event(APP_RESUMED_EVENT))
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.status).toHaveBeenCalledTimes(2)
  })

  it('accelerates recovery after enabling the node and removes listeners when stopped', async () => {
    mocks.status.mockResolvedValue({ enabled: false, BackendState: 'Stopped' })
    stop = startAndroidTailscaleRecovery()
    await vi.advanceTimersByTimeAsync(0)
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'Starting' })
    window.dispatchEvent(new CustomEvent(TAILSCALE_STATUS_EVENT, { detail: { enabled: true, BackendState: 'Starting' } }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.status).toHaveBeenCalledTimes(3)
    stop()
    window.dispatchEvent(new Event(APP_RESUMED_EVENT))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.status).toHaveBeenCalledTimes(3)
  })
})
