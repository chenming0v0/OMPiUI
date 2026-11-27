import { describe, expect, it, vi } from 'vitest'
import { selectDshHosts } from './dshRemote'
import { closeDshRemoteViewer, openDshRemoteViewer, watchDshRemoteViewer } from '../utils/dshRemoteViewer'

const native = vi.hoisted(() => ({
  window: 'main',
  invoke: vi.fn(async (_command: string, _args: unknown) => undefined),
  listeners: new Map<string, (event: { payload: { handoffId: string; reason?: string } }) => void>(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => {
    const window = native.window
    return {
      listen: async (event: string, callback: (event: { payload: { handoffId: string; reason?: string } }) => void) => {
        const key = `${window}/${event}`
        native.listeners.set(key, callback)
        return () => { native.listeners.delete(key) }
      },
    }
  },
}))

const client = '3f2a6c1e-8b4d-4f7a-9c2e-1d5b7a9c0e11'
const host = '7c1d3e5f-2a4b-4c6d-8e0f-1a3b5c7d9e22'

describe('DS Harness Remote host selection', () => {
  it('keeps only work computers that are not this device', () => {
    const hosts = selectDshHosts([
      { deviceId: host, name: 'Desk PC', role: 'host', online: true },
      { deviceId: client, name: 'This phone', role: 'client', online: true },
      { deviceId: 'aa11bb22-cc33-dd44-ee55-ff6677889900', name: 'Other phone', role: 'client' },
    ], client)
    expect(hosts).toEqual([{ id: host, name: 'Desk PC', online: true }])
  })

  it('excludes both local identities and role-less entries without guessing online state', () => {
    const localHost = 'aa11bb22-cc33-dd44-ee55-ff6677889900'
    const hosts = selectDshHosts([
      { deviceId: host, name: 'Desk PC', role: 'host' },
      { deviceId: localHost, name: 'This computer (host)', role: 'host', online: true },
      { deviceId: client, name: 'This computer (controller)', role: 'client', online: true },
      { deviceId: 'ba11bb22-cc33-dd44-ee55-ff6677889900', name: 'Unknown role', online: true },
    ], client, localHost.toUpperCase())
    expect(hosts).toEqual([{ id: host, name: 'Desk PC', online: undefined }])
  })

  it('never returns this device even when it is reported as a host', () => {
    expect(selectDshHosts([{ deviceId: client, name: 'This PC', role: 'host' }], client)).toEqual([])
  })

  it('rejects a host entry without a usable name', () => {
    expect(() => selectDshHosts([{ deviceId: host, role: 'host' }], client)).toThrow(/host/)
    expect(() => selectDshHosts([{ deviceId: host, name: '  ', role: 'host' }], client)).toThrow(/host/)
  })
})

describe('DS Harness Remote native handoff', () => {
  it('scopes close events to the owning window and current handoff', async () => {
    const first = vi.fn()
    const second = vi.fn()
    native.window = 'main'
    const unlistenFirst = await watchDshRemoteViewer(host, { closed: first, delivered: vi.fn() })
    native.window = 'win-2'
    const unlistenSecond = await watchDshRemoteViewer(client, { closed: second, delivered: vi.fn() })
    try {
      const emit = (window: string, handoffId: string) => native.listeners.get(`${window}/dsh-remote-viewer-closed`)
        ?.({ payload: { handoffId, reason: 'closed' } })
      emit('main', host)
      emit('win-2', host)
      expect(first).toHaveBeenCalledOnce()
      expect(second).not.toHaveBeenCalled()
      emit('win-2', client)
      expect(second).toHaveBeenCalledWith('closed')
    } finally { unlistenFirst(); unlistenSecond() }
  })

  it('tags stale close commands and does not open a canceled queued handoff', async () => {
    native.invoke.mockClear()
    const stop = new AbortController()
    const grant = { url: 'https://tabcdefghjkm.tun.4ba.io/', browserGrant: 'a'.repeat(43), expiresAt: Date.now() + 30_000 }
    const canceled = openDshRemoteViewer(host, grant, stop.signal)
    stop.abort()
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    await openDshRemoteViewer(client, grant, new AbortController().signal)
    await closeDshRemoteViewer(host)
    expect(native.invoke.mock.calls).toEqual([
      ['dsh_remote_viewer_open', { handoffId: client, grant }],
      ['dsh_remote_viewer_close', { handoffId: host }],
    ])
  })
})
