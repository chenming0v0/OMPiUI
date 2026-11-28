import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@ompiui/protocol'
import { type DshAppSession } from './dshRemote'
import { connectDshServer, disconnectDshServer } from './dshServerConnection'
import { serverStore, exportServerSettingsBackup } from '../store/serverStore'
import { dshControllerStore } from '../store/dshControllerStore'
import { getApiBase, getPiAuthToken, piFetch } from '../omp/httpClient'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), tunnel: vi.fn(), closeTunnel: vi.fn() }))
vi.mock('../utils/tauri', () => ({ isTauri: () => true, isTauriMobile: () => true, getHttpFetch: async () => mocks.fetch }))
vi.mock('./dshTunnelTransport', () => ({ openDshTunnelTransport: mocks.tunnel }))

const origin = `https://t${'a'.repeat(11)}.tun.4ba.io`
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const ended = deferred<Record<string, never>>()
  const connection = { grant: { url: `${origin}/`, browserGrant: 'a'.repeat(43), expiresAt: Date.now() + 30_000 },
    close: vi.fn(async () => { ended.resolve({}) }), closed: ended.promise }
  const connect = vi.fn().mockResolvedValue(connection)
  const session = { connect } as unknown as DshAppSession
  dshControllerStore.update({ session })
  return { session, connect, connection, ended }
}
const select = (id: string) => { serverStore.setActiveServer(id) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetch.mockImplementation(async () => Response.json({ ok: true, service: 'ompiui-server', protocolVersion: PROTOCOL_VERSION }))
  mocks.tunnel.mockResolvedValue({ url: origin, close: mocks.closeTunnel })
  serverStore.setActiveServer('local')
  dshControllerStore.update({ session: null, hosts: [], connection: null, authError: null })
})
afterEach(async () => {
  await disconnectDshServer()
  for (const server of serverStore.getStoredServers()) if (!server.isDefault) serverStore.removeServer(server.id)
  vi.unstubAllEnvs()
})

describe('DS connection as the current frontend server', () => {
  it('selects the tunnel for normal API traffic and preserves all saved backends', async () => {
    const old = serverStore.addServer({ name: 'Existing', url: 'https://existing.example', token: 'saved-token' })
    select(old.id)
    const saved = serverStore.getStoredServers()
    const f = fixture()
    vi.stubEnv('VITE_OMPIUI_TOKEN', 'build-time-token')
    await connectDshServer(f.session, 'office', 'Office', select)
    expect(getApiBase()).toBe(origin)
    expect(getPiAuthToken()).toBeUndefined()
    expect(serverStore.getActiveServer()).toMatchObject({ id: 'dsh:office', name: 'Office', source: 'dsh' })
    expect(dshControllerStore.get().connection?.phase).toBe('connected')
    expect(serverStore.getStoredServers()).toEqual(saved)
    expect(JSON.stringify(exportServerSettingsBackup())).not.toContain(origin)
    expect(localStorage.getItem('ompiui-active-server')).toBe(old.id)
    await piFetch(`${getApiBase()}/api/v1/sessions`)
    const [, init] = mocks.fetch.mock.calls.at(-1)!
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    select(old.id)
    await vi.waitFor(() => expect(f.connection.close).toHaveBeenCalledOnce())
    expect(mocks.closeTunnel).toHaveBeenCalledOnce()
    expect(serverStore.getActiveServer()?.token).toBe('saved-token')
    expect(serverStore.getServers().some(server => server.source === 'dsh')).toBe(false)
  })

  it('keeps the original server selected when the tunnel only serves a page but API authorization fails', async () => {
    const f = fixture()
    mocks.fetch.mockResolvedValue(Response.json({ error: 'unauthorized' }, { status: 401 }))
    await expect(connectDshServer(f.session, 'office', 'Office', select)).rejects.toMatchObject({ code: 'HOST_UPDATE_REQUIRED' })
    expect(serverStore.getActiveServerId()).toBe('local')
    expect(serverStore.getServers().some(server => server.source === 'dsh')).toBe(false)
    expect(f.connection.close).toHaveBeenCalledOnce()
  })

  it('does not take over the current server after a pending connection is canceled', async () => {
    const f = fixture()
    const pending = deferred<typeof f.connection>()
    f.connect.mockReturnValueOnce(pending.promise)
    const connecting = connectDshServer(f.session, 'office', 'Office', select)
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce())
    const other = serverStore.addServer({ name: 'Other', url: 'https://other.example' })
    select(other.id)
    pending.resolve(f.connection)
    await connecting
    expect(serverStore.getActiveServerId()).toBe(other.id)
    expect(mocks.tunnel).not.toHaveBeenCalled()
    expect(f.connection.close).toHaveBeenCalledOnce()
  })

  it('removes the temporary server and restores the previous choice when its lease ends', async () => {
    const f = fixture()
    await connectDshServer(f.session, 'office', 'Office', select)
    f.ended.resolve({})
    await vi.waitFor(() => expect(serverStore.getActiveServerId()).toBe('local'))
    expect(dshControllerStore.get().connection?.phase).toBe('ended')
    expect(mocks.closeTunnel).toHaveBeenCalledOnce()
  })
})
