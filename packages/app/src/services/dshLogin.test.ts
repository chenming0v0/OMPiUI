import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pollDshLogin, restoreDshPairedSession } from './dshRemote'

const api = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }))
vi.mock('../utils/tauri', async original => ({
  ...await original<typeof import('../utils/tauri')>(), isTauriMobile: () => true, getHttpFetch: async () => api.fetch,
}))
beforeEach(() => {
  localStorage.clear()
  api.fetch.mockReset()
  vi.stubGlobal('__APP_VERSION__', '0.6.78')
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('DS account device authorization', () => {
  it('registers a client and restores its device credential after restart without another login', async () => {
    const complete = vi.fn()
    const requests: string[] = []
    api.fetch.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname
      requests.push(path)
      if (path.includes('/oauth/qr/')) return Response.json({ status: 'complete', token: 'account-token-0001' })
      if (path.endsWith('/register')) {
        expect(complete).toHaveBeenCalledOnce()
        expect(JSON.parse(String(init?.body)).device.role).toBe('client')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer account-token-0001')
        return Response.json({ accessToken: 'device-access-0001', refreshToken: 'device-refresh-0001',
          accessTokenExpiresAt: Date.now() + 3600_000, refreshTokenExpiresAt: Date.now() + 86400_000 })
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer device-access-0001')
      return Response.json({ items: [] })
    })
    const loggedIn = await pollDshLogin('qr-login-001', new AbortController().signal, { onComplete: complete })
    expect(typeof loggedIn).not.toBe('string')
    const restored = restoreDshPairedSession()
    expect(restored?.paired).toBe(false)
    await restored!.listHosts(new AbortController().signal)
    expect(requests).toEqual(['/api/v1/auth/oauth/qr/qr-login-001', '/api/v1/devices/register', '/api/v1/devices'])
    restored!.invalidate()
    expect(restoreDshPairedSession()).toBeNull()
  })

  it('separates transient polling failures from device registration failures', async () => {
    const complete = vi.fn()
    api.fetch.mockRejectedValueOnce(new TypeError('Network unavailable'))
    await expect(pollDshLogin('qr-login-001', new AbortController().signal, { onComplete: complete })).rejects.toBeInstanceOf(TypeError)
    expect(complete).not.toHaveBeenCalled()
    api.fetch.mockResolvedValueOnce(Response.json({ status: 'complete', token: 'account-token-0001' }))
    api.fetch.mockResolvedValueOnce(Response.json({ error: { code: 'INTERNAL' } }, { status: 503 }))
    await expect(pollDshLogin('qr-login-001', new AbortController().signal, { onComplete: complete })).rejects.toMatchObject({ status: 503 })
    expect(complete).toHaveBeenCalledOnce()
    expect(restoreDshPairedSession()).toBeNull()
  })

  it('does not persist a registration completed after login cancellation', async () => {
    const stop = new AbortController()
    api.fetch.mockResolvedValueOnce(Response.json({ status: 'complete', token: 'account-token-0001' }))
    api.fetch.mockImplementationOnce(async () => {
      stop.abort()
      return Response.json({ accessToken: 'device-access-0001', refreshToken: 'device-refresh-0001',
        accessTokenExpiresAt: Date.now() + 3600_000, refreshTokenExpiresAt: Date.now() + 86400_000 })
    })
    await expect(pollDshLogin('qr-login-001', stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(restoreDshPairedSession()).toBeNull()
  })

  it('reports unavailable storage without pretending login was saved', async () => {
    api.fetch.mockResolvedValueOnce(Response.json({ status: 'complete', token: 'account-token-0001' }))
    api.fetch.mockResolvedValueOnce(Response.json({ accessToken: 'device-access-0001', refreshToken: 'device-refresh-0001',
      accessTokenExpiresAt: Date.now() + 3600_000, refreshTokenExpiresAt: Date.now() + 86400_000 }))
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    await expect(pollDshLogin('qr-login-001', new AbortController().signal)).rejects.toMatchObject({ code: 'DSH_STORAGE_FAILED' })
    expect(restoreDshPairedSession()).toBeNull()
  })
})
