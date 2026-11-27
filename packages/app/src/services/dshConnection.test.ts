import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DSH_CONTROL_LIMIT, DSH_RELAY_LIMIT, DshNoise, createDshIdentity, dshFrame, parseDshFrame, type DshFrame,
} from '@ompiui/protocol/dsh-remote'
import { DshAppSession } from './dshRemote'
import { exportDshDiagnostics } from './dshConnectionDiagnostics'

const native = vi.hoisted(() => ({
  invoke: vi.fn(), fetch: vi.fn<typeof fetch>(),
  channel: undefined as { onmessage: (event: unknown) => void } | undefined,
}))
vi.mock('../utils/tauri', async original => ({
  ...await original<typeof import('../utils/tauri')>(),
  isTauri: () => true, isTauriMobile: () => true, getHttpFetch: async () => native.fetch,
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: native.invoke,
  Channel: class { onmessage = (_event: unknown) => {}; constructor() { native.channel = this } },
}))

const tokens = () => ({
  accessToken: 'client-device-access-0001', refreshToken: 'client-device-refresh-0001',
  accessTokenExpiresAt: Date.now() + 3600_000, refreshTokenExpiresAt: Date.now() + 86400_000,
})

beforeEach(() => {
  native.invoke.mockReset()
  native.fetch.mockReset()
  native.channel = undefined
  vi.stubGlobal('__APP_VERSION__', '0.6.78')
  // 在 Tauri 中误用 WebView WebSocket 会直接令本测试失败。
  vi.stubGlobal('WebSocket', vi.fn(function () { throw new Error('Unexpected WebView socket') }))
})
afterEach(() => vi.unstubAllGlobals())

function fixture(mode: 'ready' | 'origin-rejected' | 'auth-frame' = 'ready') {
  const client = createDshIdentity()
  const host = createDshIdentity()
  const connectionId = crypto.randomUUID()
  const hostNoise = new DshNoise(host, client.identityKey, connectionId, host.deviceId, client.deviceId)
  const frames: DshFrame[] = []
  const grant = { url: 'https://tabcdefghjkmn.tun.4ba.io/', browserGrant: 'a'.repeat(43), expiresAt: Date.now() + 60_000 }
  let sequence = 0
  const emit = (frame: DshFrame) => queueMicrotask(() => native.channel?.onmessage({ type: 'message', sequence: ++sequence, data: JSON.stringify(frame) }))
  const reply = (type: string, payload: Record<string, unknown>) => emit(dshFrame(type, payload))
  native.fetch.mockImplementation(async input => {
    if (new URL(String(input)).pathname.endsWith('/auth/refresh')) {
      return Response.json({ error: { code: 'AUTH_INVALID' } }, { status: 401 })
    }
    return Response.json({ ...host, role: 'host', membershipId: crypto.randomUUID() })
  })
  native.invoke.mockImplementation(async (command: string, args: { data: string; url: string }) => {
    if (command === 'ws_bridge_connect') {
      expect(args.url).toBe('wss://dsh.r2049.cn/ws/v1/connect')
      queueMicrotask(() => native.channel?.onmessage({ type: 'open' }))
      return 71
    }
    if (command === 'ws_bridge_close') {
      queueMicrotask(() => native.channel?.onmessage({ type: 'close', code: 1000, reason: '' }))
      return
    }
    if (command !== 'ws_bridge_send') return
    const frame = parseDshFrame(args.data)
    frames.push(frame)
    if (frame.type === 'hello') {
      expect(frame.payload).toMatchObject({ role: 'client', deviceId: client.deviceId, accessToken: tokens().accessToken, protocols: [1] })
      if (mode === 'origin-rejected') {
        queueMicrotask(() => native.channel?.onmessage({ type: 'close', code: 4010, reason: 'origin not allowed' }))
      } else if (mode === 'auth-frame') {
        reply('error', { code: 'AUTH_INVALID', retryable: false })
      } else {
        reply('hello.ack', { protocol: 1, maxControlFrameBytes: DSH_CONTROL_LIMIT, maxRelayFrameBytes: DSH_RELAY_LIMIT, capabilities: ['transport.relay'] })
      }
    } else if (frame.type === 'connect.request') {
      expect(frame.payload.hostDeviceId).toBe(host.deviceId)
      reply('connect.accepted', { connectionId })
    } else if (frame.type === 'secure.handshake') {
      hostNoise.read(frame.payload.data)
      reply('secure.handshake', { connectionId, targetDeviceId: client.deviceId, step: 2, data: hostNoise.write() })
    } else if (frame.type === 'relay') {
      const request = parseDshFrame(hostNoise.receive(frame.payload.counter, frame.payload.ciphertext))
      const result = request.payload.method === 'harness.transport.describe'
        ? { capabilities: ['dsh.web.v1', 'ompiui.web.v1'] }
        : request.payload.method === 'dsh.web.open' ? grant : {}
      reply('relay', { connectionId, targetDeviceId: client.deviceId,
        ...hostNoise.send(dshFrame('rpc.response', { requestId: request.id, result })) })
    }
  })
  return { session: new DshAppSession(client, tokens()), host, frames, grant }
}

describe('DS connection through the native bridge', () => {
  it('completes hello, Noise and web grant exchange and closes the lease through native IPC', async () => {
    const f = fixture()
    const connection = await f.session.connect(f.host.deviceId, new AbortController().signal)
    expect(connection.grant).toEqual(f.grant)
    expect(f.frames.map(frame => frame.type).slice(0, 4)).toEqual(['hello', 'connect.request', 'transport.selected', 'secure.handshake'])
    expect(exportDshDiagnostics()).toContain('"transport":"native"')
    expect(exportDshDiagnostics()).toContain('connect.hello.ack')
    expect(exportDshDiagnostics()).toContain('connect.handshake.complete')
    await connection.close()
    await connection.closed
    expect(native.invoke).toHaveBeenCalledWith('ws_bridge_close', expect.objectContaining({ id: 71 }))
    expect(native.fetch).toHaveBeenCalledTimes(1)
  })

  it('preserves 4010 rejection and does not refresh credentials or request a host before hello.ack', async () => {
    const f = fixture('origin-rejected')
    await expect(f.session.connect(f.host.deviceId, new AbortController().signal)).rejects.toMatchObject({ code: 'DSH_UNREACHABLE' })
    expect(f.frames.map(frame => frame.type)).toEqual(['hello'])
    expect(native.fetch).toHaveBeenCalledTimes(1)
    expect(exportDshDiagnostics()).toContain('"closeCode":4010')
    expect(exportDshDiagnostics()).toContain('"closeReason":"ORIGIN_NOT_ALLOWED"')
  })

  it('refreshes only after an explicit authentication error and records the rejected hello code', async () => {
    const f = fixture('auth-frame')
    await expect(f.session.connect(f.host.deviceId, new AbortController().signal)).rejects.toMatchObject({ code: 'DSH_AUTH_INVALID' })
    expect(native.fetch.mock.calls.some(([input]) => String(input).endsWith('/auth/refresh'))).toBe(true)
    expect(exportDshDiagnostics()).toContain('"frameCode":"AUTH_INVALID"')
    expect(f.frames.map(frame => frame.type)).toEqual(['hello'])
  })
})
