import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDshIdentity } from '@ompiui/protocol/dsh-remote'
import { DshAppSession } from './dshRemote'

const api = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }))
vi.mock('../utils/tauri', async original => ({
  ...await original<typeof import('../utils/tauri')>(), getHttpFetch: async () => api.fetch,
}))

const hosts = Array.from({ length: 10 }, (_, index) => ({
  deviceId: `019a0000-0000-7000-8000-${String(index).padStart(12, '0')}`, role: 'host', name: `PC ${index}`,
}))
const signal = () => new AbortController().signal
const session = () => new DshAppSession(createDshIdentity(), {
  accessToken: 'access-token-0001', refreshToken: 'refresh-token-0001',
  accessTokenExpiresAt: Date.now() + 3600_000, refreshTokenExpiresAt: Date.now() + 86400_000,
})
beforeEach(() => { api.fetch.mockReset() })
afterEach(() => vi.restoreAllMocks())

describe('DS host presence', () => {
  it('queries presence even when directory online is missing or stale and preserves unknown failures', async () => {
    api.fetch.mockImplementation(async input => {
      const path = new URL(String(input)).pathname
      if (path === '/api/v1/devices') return Response.json({ items: [hosts[0], { ...hosts[1], online: true }, hosts[2]] })
      if (path.includes(hosts[0].deviceId)) return Response.json({ deviceId: hosts[0].deviceId, online: true })
      if (path.includes(hosts[1].deviceId)) return Response.json({ deviceId: hosts[1].deviceId, online: false })
      return new Response(null, { status: 503 })
    })
    expect(await session().listHosts(signal())).toEqual([
      { id: hosts[0].deviceId, name: 'PC 0', online: true },
      { id: hosts[1].deviceId, name: 'PC 1', online: false },
      { id: hosts[2].deviceId, name: 'PC 2', online: undefined },
    ])
    expect(api.fetch).toHaveBeenCalledTimes(4)
  })

  it('finishes each page with at most eight presence requests in flight and stable directory ordering', async () => {
    let active = 0
    let peak = 0
    let completed = 0
    api.fetch.mockImplementation(async input => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v1/devices') {
        if (url.searchParams.has('cursor')) {
          expect(completed).toBe(10)
          return Response.json({ items: [], nextCursor: null })
        }
        return Response.json({ items: hosts, nextCursor: 'page-2' })
      }
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      completed++
      return Response.json({ deviceId: url.pathname.split('/')[4], online: true })
    })
    const result = await session().listHosts(signal())
    expect(result.map(host => host.id)).toEqual(hosts.map(host => host.deviceId))
    expect(result.every(host => host.online)).toBe(true)
    expect(peak).toBe(8)
  })

  it('propagates expired controller credentials instead of publishing an unknown host list', async () => {
    api.fetch.mockImplementation(async input => {
      const path = new URL(String(input)).pathname
      if (path === '/api/v1/devices') return Response.json({ items: [hosts[0]] })
      return Response.json({ error: { code: 'AUTH_INVALID' } }, { status: 401 })
    })
    await expect(session().listHosts(signal())).rejects.toMatchObject({ code: 'DSH_AUTH_INVALID' })
    expect(api.fetch.mock.calls.some(([input]) => String(input).endsWith('/auth/refresh'))).toBe(true)
  })

  it('does not publish a partial directory after cancellation', async () => {
    const stop = new AbortController()
    api.fetch.mockImplementation(async input => {
      if (new URL(String(input)).pathname === '/api/v1/devices') return Response.json({ items: [hosts[0]] })
      stop.abort()
      throw new DOMException('Cancelled', 'AbortError')
    })
    await expect(session().listHosts(stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
