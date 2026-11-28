import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@ompiui/protocol'
import type { DshAppSession } from './dshRemote'

const mocks = vi.hoisted(() => ({ native: true, fetch: vi.fn(), restore: vi.fn(), tunnel: vi.fn(), close: vi.fn() }))
vi.mock('../utils/tauri', () => ({ isTauri: () => mocks.native, isTauriMobile: () => true, getHttpFetch: async () => mocks.fetch }))
vi.mock('./dshRemote', async importOriginal => ({
  ...await importOriginal<typeof import('./dshRemote')>(), restoreDshPairedSession: mocks.restore,
}))
vi.mock('./dshTunnelTransport', () => ({ openDshTunnelTransport: mocks.tunnel }))

const origin = `https://t${'a'.repeat(11)}.tun.4ba.io`
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const ended = deferred<Record<string, never>>()
  const connection = { grant: {}, close: vi.fn(async () => { ended.resolve({}) }), closed: ended.promise }
  const connect = vi.fn().mockResolvedValue(connection)
  const invalidate = vi.fn()
  mocks.restore.mockReturnValue({ connect, invalidate } as unknown as DshAppSession)
  return { connection, connect, ended, invalidate }
}
async function coldStart() {
  const { serverStore } = await import('../store/serverStore')
  const { paneLayoutStore } = await import('../store/paneLayoutStore')
  paneLayoutStore.setFocusedSession('local-session')
  serverStore.registerRuntimeServer({ id: 'dsh:office', name: 'Office', url: origin, source: 'dsh' }, 'local')
  serverStore.setActiveServer('dsh:office')
  paneLayoutStore.setFocusedSession('ds-session')
  vi.resetModules()
  return (await import('../store/serverStore')).serverStore
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  mocks.native = true
  mocks.fetch.mockImplementation(async () => Response.json({ ok: true, service: 'ompiui-server', protocolVersion: PROTOCOL_VERSION }))
  mocks.tunnel.mockResolvedValue({ url: origin, close: mocks.close })
})
afterEach(async () => {
  await (await import('./dshServerConnection')).disconnectDshServer()
  vi.restoreAllMocks()
})

describe('native DS cold-start restoration', () => {
  it('restores the stable selection and route, blocks traffic until the new lease, then uses that lease', async () => {
    const store = await coldStart()
    const f = fixture()
    const { getApiBase, piFetch } = await import('../omp/httpClient')
    const { openPiSocket } = await import('../omp/ompSocket')
    const { restorePaneRoute } = await import('../store/restorePaneRoute')
    restorePaneRoute()
    expect(store.getActiveServerId()).toBe('dsh:office')
    expect(window.location.hash).toBe('#/session/ds-session')
    expect(getApiBase()).toBe('dsh://pending')
    await expect(piFetch(`${getApiBase()}/api/v1/sessions`)).rejects.toThrow('not connected')
    const socket = openPiSocket(`${getApiBase()}/api/v1/events`)
    const closed = vi.fn()
    socket.onclose = closed
    await Promise.resolve()
    expect(closed).toHaveBeenCalledWith({ code: 1006 })
    expect(mocks.fetch).not.toHaveBeenCalled()
    const change = vi.fn()
    store.onServerChange(change)
    await (await import('./dshServerConnection')).restoreDshServer()
    expect(f.connect).toHaveBeenCalledWith('office', expect.any(AbortSignal), expect.any(String))
    expect(getApiBase()).toBe(origin)
    expect(window.location.hash).toBe('#/session/ds-session')
    expect((await import('../store/paneLayoutStore')).paneLayoutStore.getFocusedSessionId()).toBe('ds-session')
    expect(change).toHaveBeenCalledWith('dsh:office', 'server-config-updated')
    await piFetch(`${getApiBase()}/api/v1/sessions`)
    expect(mocks.fetch.mock.calls.at(-1)?.[0]).toBe(`${origin}/api/v1/sessions`)
    expect(localStorage.getItem('ompiui-dsh-server-selection')).not.toContain(origin)
    expect(localStorage.getItem('ompiui-servers')).not.toContain(origin)
  })

  it('inherits the DS choice after a full app restart without session storage', async () => {
    await coldStart()
    sessionStorage.clear()
    vi.resetModules()
    const store = (await import('../store/serverStore')).serverStore
    expect(store.getActiveServerId()).toBe('dsh:office')
    expect(store.getActiveBaseUrl()).toBe('dsh://pending')
  })

  it('keeps a failed restored target selected and allows retry without connecting to the saved local backend', async () => {
    const store = await coldStart()
    const f = fixture()
    f.connect.mockRejectedValueOnce(new Error('offline'))
    const service = await import('./dshServerConnection')
    await service.restoreDshServer()
    expect(store.getActiveServerId()).toBe('dsh:office')
    expect(store.getActiveBaseUrl()).toBe('dsh://pending')
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect((await import('../store/dshControllerStore')).dshControllerStore.get().connection).toMatchObject({ phase: 'ended', error: 'LEASE_FAILED' })
    await service.restoreDshServer()
    expect(store.getActiveBaseUrl()).toBe(origin)
  })

  it('cancels restoration when the user switches servers, even when the old response arrives later', async () => {
    const store = await coldStart()
    const f = fixture()
    const pending = deferred<typeof f.connection>()
    f.connect.mockReturnValueOnce(pending.promise)
    const service = await import('./dshServerConnection')
    const restoring = service.restoreDshServer()
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce())
    store.setActiveServer('local')
    pending.resolve(f.connection)
    await restoring
    expect(store.getActiveServerId()).toBe('local')
    expect(f.connection.close).toHaveBeenCalledOnce()
    expect(mocks.tunnel).not.toHaveBeenCalled()
    expect(localStorage.getItem('ompiui-dsh-server-selection')).toBe('null')
  })

  it.each(['exchange', 'health'])('preserves the restored selection when control closes during %s', async stage => {
    const store = await coldStart()
    const f = fixture()
    const pendingTunnel = deferred<{ url: string; close(): void }>()
    const pendingHealth = deferred<Response>()
    if (stage === 'exchange') mocks.tunnel.mockReturnValueOnce(pendingTunnel.promise)
    else mocks.fetch.mockReturnValueOnce(pendingHealth.promise)
    const restoring = (await import('./dshServerConnection')).restoreDshServer()
    await vi.waitFor(() => expect(stage === 'exchange' ? mocks.tunnel : mocks.fetch).toHaveBeenCalledOnce())
    f.ended.resolve({})
    await vi.waitFor(() => expect((mocks.close.mock.calls.length > 0) || f.connection.close.mock.calls.length > 0).toBe(true))
    pendingTunnel.resolve({ url: origin, close: mocks.close })
    pendingHealth.resolve(Response.json({ ok: true, service: 'ompiui-server', protocolVersion: PROTOCOL_VERSION }))
    await restoring
    expect(store.getActiveServerId()).toBe('dsh:office')
    expect(store.getActiveBaseUrl()).toBe('dsh://pending')
    expect(localStorage.getItem('ompiui-dsh-server-selection')).toContain('dsh:office')
    expect((await import('../store/dshControllerStore')).dshControllerStore.get().connection?.phase).toBe('ended')
  })

  it('clears invalid credentials while retaining the restored computer and route', async () => {
    const store = await coldStart()
    const f = fixture()
    const { DshApiError } = await import('./dshRemote')
    f.connect.mockRejectedValueOnce(new DshApiError('DSH_AUTH_INVALID', 401))
    await (await import('./dshServerConnection')).restoreDshServer()
    expect(f.invalidate).toHaveBeenCalledOnce()
    expect(store.getActiveServerId()).toBe('dsh:office')
    expect(store.getActiveBaseUrl()).toBe('dsh://pending')
    expect((await import('../store/dshControllerStore')).dshControllerStore.get()).toMatchObject({ session: null, authError: 'DSH_AUTH_INVALID' })
  })

  it('honors an explicit startup server selection before restoration begins', async () => {
    const store = await coldStart()
    fixture()
    store.setActiveServer('local', 'window')
    await (await import('./dshServerConnection')).restoreDshServer()
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(store.getActiveServerId()).toBe('local')
  })

  it('uses the existing ordinary backend in the static browser', async () => {
    await coldStart()
    mocks.native = false
    vi.resetModules()
    const store = (await import('../store/serverStore')).serverStore
    await (await import('./dshServerConnection')).restoreDshServer()
    expect(store.getActiveServerId()).toBe('local')
    expect(mocks.restore).not.toHaveBeenCalled()
  })
})
