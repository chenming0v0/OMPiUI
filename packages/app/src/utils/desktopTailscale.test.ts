import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoverDesktopTailscale, disconnectDesktopTailscale, fetchDesktopTailscale,
  refreshDesktopTailscaleRoutes, resolveDesktopTailscaleUrl, startDesktopTailscaleLogin,
} from './desktopTailscale'
import { TAILSCALE_READY_EVENT } from './tailscaleEvents'

type Backend = { url: string; token?: string } | null
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  backend: { url: 'http://127.0.0.1:8787', token: 'local-token' } as Backend,
  servers: [] as Array<{ id: string; url: string }>,
  checkHealth: vi.fn(),
}))
vi.mock('./tauri', () => ({
  isTauri: () => true, isTauriMobile: () => false, getHttpFetch: async () => mocks.fetch,
}))
vi.mock('../store/serverStore', () => ({
  serverStore: { getLocalBackend: () => mocks.backend, getServers: () => mocks.servers, checkHealth: mocks.checkHealth },
}))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const routeTo = (url: string) => mocks.fetch.mockImplementation(async () => json({ url }))
const nodeStopped = () => mocks.fetch.mockImplementation(async () => json({ code: 'INTERNAL', message: 'Tailscale is not running' }, 409))
const requested = (call = 0) => {
  const [url, init] = mocks.fetch.mock.calls[call] as [string, RequestInit]
  return { url, method: init.method, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined }
}
const ready = vi.fn()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  mocks.backend = { url: 'http://127.0.0.1:8787', token: 'local-token' }
  mocks.servers = []
  refreshDesktopTailscaleRoutes(false)
  mocks.fetch.mockReset()
  mocks.checkHealth.mockReset()
  ready.mockReset()
  window.addEventListener(TAILSCALE_READY_EVENT, ready)
})
afterEach(() => {
  window.removeEventListener(TAILSCALE_READY_EVENT, ready)
  vi.useRealTimers()
})

describe('desktop Tailnet routes', () => {
  it('maps HTTP and WebSocket requests onto the loopback route opened by the local backend node', async () => {
    routeTo('http://127.0.0.1:45001')
    expect(await resolveDesktopTailscaleUrl('http://100.101.2.3:8787/api/v1/host/health?probe=1'))
      .toBe('http://127.0.0.1:45001/api/v1/host/health?probe=1')
    expect(await resolveDesktopTailscaleUrl('ws://100.101.2.3:8787/api/v1/events?token=private-token'))
      .toBe('ws://127.0.0.1:45001/api/v1/events?token=private-token')
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(requested()).toEqual({
      url: 'http://127.0.0.1:8787/api/v1/host/tailscale/route', method: 'POST',
      headers: { authorization: 'Bearer local-token', 'content-type': 'application/json' },
      body: { origin: 'http://100.101.2.3:8787' },
    })

    expect(await resolveDesktopTailscaleUrl('wss://pc.example.ts.net/events')).toBe('ws://127.0.0.1:45001/events')
    expect(requested(1).body).toEqual({ origin: 'https://pc.example.ts.net' })
  })

  it('leaves the address untouched while the node is not running, so a system Tailscale client keeps working', async () => {
    const address = 'http://100.101.2.3:8787/api/v1/host/health'
    nodeStopped()
    expect(await resolveDesktopTailscaleUrl(address)).toBe(address)

    refreshDesktopTailscaleRoutes(false)
    mocks.fetch.mockRejectedValue(new TypeError('error sending request'))
    expect(await resolveDesktopTailscaleUrl(address)).toBe(address)

    refreshDesktopTailscaleRoutes(false)
    mocks.fetch.mockReset()
    mocks.backend = null
    expect(await resolveDesktopTailscaleUrl(address)).toBe(address)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  })

  it('re-checks a stopped node after a second and wakes waiting connections once it is running', async () => {
    const address = 'http://100.101.2.3:8787/api'
    nodeStopped()
    expect(await resolveDesktopTailscaleUrl(address)).toBe(address)
    routeTo('http://127.0.0.1:45001')
    vi.setSystemTime(Date.now() + 900)
    expect(await resolveDesktopTailscaleUrl(address)).toBe(address)
    expect(mocks.fetch).toHaveBeenCalledOnce()

    vi.setSystemTime(Date.now() + 200)
    expect(await resolveDesktopTailscaleUrl(address)).toBe('http://127.0.0.1:45001/api')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(ready).toHaveBeenCalledOnce()
  })

  it('confirms a route again after five seconds, replacing the port of a restarted node', async () => {
    routeTo('http://127.0.0.1:45001')
    expect(await resolveDesktopTailscaleUrl('http://100.101.2.3:8787/api')).toBe('http://127.0.0.1:45001/api')
    routeTo('http://127.0.0.1:45002')
    vi.setSystemTime(Date.now() + 4_900)
    expect(await resolveDesktopTailscaleUrl('http://100.101.2.3:8787/api')).toBe('http://127.0.0.1:45001/api')
    vi.setSystemTime(Date.now() + 200)
    expect(await resolveDesktopTailscaleUrl('http://100.101.2.3:8787/api')).toBe('http://127.0.0.1:45002/api')
    // 首次就成功和续期都不算恢复，不重复唤醒连接。
    expect(ready).not.toHaveBeenCalled()
  })

  it('drops routes and re-probes saved Tailnet servers when the node signs in or out', async () => {
    mocks.servers = [{ id: 'local', url: 'http://127.0.0.1:8787' }, { id: 'desk', url: 'http://100.101.2.3:8787' }]
    routeTo('http://127.0.0.1:45001')
    await resolveDesktopTailscaleUrl('http://100.101.2.3:8787/api')

    refreshDesktopTailscaleRoutes(true)
    expect(ready).toHaveBeenCalledOnce()
    expect(mocks.checkHealth.mock.calls).toEqual([['desk']])
    await resolveDesktopTailscaleUrl('http://100.101.2.3:8787/api')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)

    refreshDesktopTailscaleRoutes(false)
    expect(ready).toHaveBeenCalledOnce()
    expect(mocks.checkHealth).toHaveBeenCalledTimes(2)
  })
})

describe('desktop Tailnet node management', () => {
  it('always talks to the backend on this computer with its own token', async () => {
    mocks.fetch.mockImplementation(async () => json({ backendState: 'Running', ok: true, authUrl: null }))
    await fetchDesktopTailscale()
    await startDesktopTailscaleLogin()
    await disconnectDesktopTailscale()
    expect([0, 1, 2].map(call => [requested(call).method, requested(call).url])).toEqual([
      ['GET', 'http://127.0.0.1:8787/api/v1/host/tailscale'],
      ['POST', 'http://127.0.0.1:8787/api/v1/host/tailscale/login'],
      ['POST', 'http://127.0.0.1:8787/api/v1/host/tailscale/disconnect'],
    ])
    expect(requested(0).headers.authorization).toBe('Bearer local-token')
  })

  it('returns discovered computers and surfaces the sign-in requirement in the form the settings page recognizes', async () => {
    const device = { marker: 'ompiui', discoveryVersion: 1, displayName: 'Desk', instanceId: 'b'.repeat(32), port: 8787, pairing: true, address: '100.101.2.9' }
    mocks.fetch.mockImplementation(async () => json({ devices: [device] }))
    expect(await discoverDesktopTailscale(new AbortController().signal)).toEqual([device])
    expect(requested().url).toBe('http://127.0.0.1:8787/api/v1/host/tailscale/discover')

    mocks.fetch.mockImplementation(async () => json({
      code: 'INTERNAL', message: 'Tailscale discovery requires Running state (current: NeedsLogin); start or sign in first',
    }, 409))
    await expect(discoverDesktopTailscale(new AbortController().signal)).rejects.toThrow(/^Tailscale discovery requires Running state/)
  })

  it('reports a missing local backend instead of reaching for the selected server', async () => {
    mocks.backend = null
    await expect(fetchDesktopTailscale()).rejects.toThrow('The local OMPiUI backend is unavailable')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
