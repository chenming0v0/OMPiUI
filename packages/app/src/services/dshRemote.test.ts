import { describe, expect, it, vi } from 'vitest'
import { DSH_REMOTE_ORIGIN, createDshIdentity, dshPairingProof, dshPairingQr, parseDshPairingSession } from '@ompiui/protocol/dsh-remote'
import { DshApiError, resolveDshPairing, restoreDshPairedSession, selectDshHosts } from './dshRemote'
import { closeDshRemoteViewer, openDshRemoteViewer, watchDshRemoteViewer } from '../utils/dshRemoteViewer'

const native = vi.hoisted(() => ({
  window: 'main',
  mobile: false,
  fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  invoke: vi.fn(async (_command: string, _args: unknown) => undefined),
  listeners: new Map<string, (event: { payload: { handoffId: string; reason?: string } }) => void>(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('../utils/tauri', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/tauri')>(), isTauriMobile: () => native.mobile,
  getHttpFetch: async () => native.fetch,
}))
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
const labels = { title: 'Desk PC', close: 'Close' }

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
    const canceled = openDshRemoteViewer(host, grant, stop.signal, labels)
    stop.abort()
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    await openDshRemoteViewer(client, grant, new AbortController().signal, labels)
    await closeDshRemoteViewer(host)
    expect(native.invoke.mock.calls).toEqual([
      ['dsh_remote_viewer_open', { handoffId: client, grant }],
      ['dsh_remote_viewer_close', { handoffId: host }],
    ])
  })

  it('opens the remote page inside the Android app instead of the system browser', async () => {
    native.invoke.mockClear()
    native.mobile = true
    const agent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 15) wv')
    const viewer = { open: vi.fn(), close: vi.fn() }
    window.__ompiui_dsh_viewer = viewer
    const closed = vi.fn()
    const delivered = vi.fn()
    const unlisten = await watchDshRemoteViewer(host, { closed, delivered })
    try {
      const grant = { url: 'https://tabcdefghjkm.tun.4ba.io/', browserGrant: 'a'.repeat(43), expiresAt: Date.now() + 30_000 }
      await openDshRemoteViewer(host, grant, new AbortController().signal, labels)
      expect(JSON.parse(viewer.open.mock.calls[0][1])).toEqual({ ...grant, title: 'Desk PC', closeLabel: 'Close' })
      const emit = (detail: unknown) => window.dispatchEvent(new CustomEvent('ompiui-dsh-viewer', { detail }))
      emit({ id: client, type: 'closed', reason: 'closed' })
      emit({ id: host, type: 'delivered' })
      expect(delivered).toHaveBeenCalledOnce()
      expect(closed).not.toHaveBeenCalled()
      emit({ id: host, type: 'closed', reason: 'unavailable' })
      expect(closed).toHaveBeenCalledWith('unavailable')
      await closeDshRemoteViewer(host)
      expect(viewer.close).toHaveBeenCalledWith(host)
      expect(native.invoke).not.toHaveBeenCalled()
    } finally {
      unlisten()
      delete window.__ompiui_dsh_viewer
      agent.mockRestore()
      native.mobile = false
    }
  })
})

describe('DS Harness Remote phone pairing', () => {
  const sessionId = '019a0000-0000-7000-8000-000000000001'
  const root = `/api/v1/device-pairing/sessions/${sessionId}`
  const tokens = {
    accessToken: 'access-token-0001', accessTokenExpiresAt: Date.now() + 3_600_000,
    refreshToken: 'refresh-token-0001', refreshTokenExpiresAt: Date.now() + 86_400_000,
  }

  it('scans a computer, shows its code and keeps the pairing after it is confirmed there', async () => {
    localStorage.clear()
    vi.stubGlobal('__APP_VERSION__', 'test')
    const server = createDshIdentity()
    const computer = createDshIdentity()
    const host = { deviceId: computer.deviceId, name: 'Desk PC', role: 'host', platform: 'win32', identityKey: computer.identityKey }
    const created = { v: 1, sessionId, expiresAt: Date.now() + 180_000, serverPublicKey: server.identityKey, scanSecret: createDshIdentity().identityKey, host }
    let phone: Record<string, unknown> | undefined
    let state = 'claimed'
    const paths: string[] = []
    native.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const body = String(init?.body ?? '')
      expect(url.origin).toBe(DSH_REMOTE_ORIGIN)
      paths.push(url.pathname)
      if (url.pathname === '/api/v1/device-pairing/resolve') {
        expect(JSON.parse(body)).toEqual({ ticket: created.scanSecret })
        return Response.json(created)
      }
      // 每一步都要带上这台手机自己的私钥签出来的证明。
      phone ??= JSON.parse(body).device
      expect(new Headers(init?.headers).get('x-dsh-pairing-proof'))
        .toBe(dshPairingProof(server.privateKey, String(phone?.identityKey), sessionId, 'mobile', url.pathname, body))
      if (url.pathname === `${root}/claim`) {
        expect(JSON.parse(body).scanSecret).toBe(created.scanSecret)
        expect(phone).toMatchObject({ role: 'client' })
        expect(phone).not.toHaveProperty('privateKey')
        return Response.json({ state: 'claimed', verificationCode: '00123456', expiresAt: created.expiresAt })
      }
      expect(url.pathname).toBe(`${root}/mobile/status`)
      return Response.json({
        v: 1, sessionId, state, failureReason: null, host, mobile: phone,
        credentials: state === 'completed' ? { device: phone, tokens } : null,
      })
    }) as typeof fetch

    const signal = new AbortController().signal
    const pairing = await resolveDshPairing(dshPairingQr(parseDshPairingSession(created), true), signal)
    expect(pairing.computer.name).toBe('Desk PC')
    expect(paths).toEqual(['/api/v1/device-pairing/resolve'])
    expect(await pairing.claim(signal)).toBe('00123456')
    expect(await pairing.poll(signal)).toEqual({ state: 'claimed', failureReason: null })
    expect(restoreDshPairedSession()).toBeNull()

    state = 'completed'
    const done = await pairing.poll(signal)
    expect(done.paired?.paired).toBe(true)
    // 重开 App 后还能接回来，而且配对结束后不会再去取消它。
    expect(restoreDshPairedSession()?.paired).toBe(true)
    await pairing.cancel()
    expect(paths.at(-1)).toBe(`${root}/mobile/status`)
    done.paired?.invalidate()
    expect(restoreDshPairedSession()).toBeNull()
  })

  it('refuses a code that is not a DS remote pairing code', async () => {
    await expect(resolveDshPairing('https://example.com/pair#v1.abc', new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({ code: 'PAIRING_SCAN_INVALID' }))
    expect(new DshApiError('PAIRING_SCAN_INVALID', 0)).toBeInstanceOf(Error)
  })
})
