import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverDevices, parseDiscoveredDevices } from './deviceDiscovery'
const native = vi.hoisted(() => ({ discover: vi.fn() }))
vi.mock('./androidTailscale', async original => ({
  ...await original<typeof import('./androidTailscale')>(), discoverAndroidTailscale: native.discover,
}))
const info = { marker: 'ompiui', discoveryVersion: 1, displayName: 'Computer', instanceId: 'a'.repeat(32), port: 9191, pairing: true }
const request = vi.fn()
beforeEach(() => { request.mockReset(); window.__ompiui_device_discovery = { request }; native.discover.mockReset() })
afterEach(() => { delete window.__ompiui_device_discovery; vi.useRealTimers() })

describe('device discovery adapter', () => {
  it('validates records, strips credentials, de-duplicates and preserves custom ports', () => {
    const entry = { ...info, address: '192.168.1.10', token: 'secret' }
    expect(parseDiscoveredDevices([entry, entry], 'lan')).toEqual([{ ...info, address: entry.address, network: 'lan' }])
    expect(parseDiscoveredDevices([{ ...info, address: '100.64.0.1' }], 'tailscale')).toHaveLength(1)
  })
  it.each(['127.0.0.1', '0.0.0.0', '224.0.0.1', 'bad.test', '192.168.1.10/path', '100.64.0.1', '8.8.8.8', '::1', 'fe80::1%wlan0'])('rejects invalid LAN endpoints: %s', address => {
    expect(parseDiscoveredDevices([{ ...info, address }], 'lan')).toEqual([])
  })
  it('rejects unsupported services and non-Tailnet addresses from the peer bridge', () => {
    expect(parseDiscoveredDevices([{ ...info, marker: 'other', address: '192.168.1.1' }], 'lan')).toEqual([])
    expect(parseDiscoveredDevices([{ ...info, address: '192.168.1.1' }], 'tailscale')).toEqual([])
  })
  it('uses the independent LAN bridge without touching Tailscale', async () => {
    request.mockImplementation(id => queueMicrotask(() => window.dispatchEvent(new CustomEvent('ompiui-discovery-result', {
      detail: { id, result: [{ ...info, address: '192.168.1.10' }] },
    }))))
    const devices = await discoverDevices('lan', new AbortController().signal)
    expect(devices[0].port).toBe(9191)
    expect(request).toHaveBeenCalledWith(expect.any(String), 'discover', '{}')
    expect(native.discover).not.toHaveBeenCalled()
  })
  it('cancels native discovery and ignores late results', async () => {
    const controller = new AbortController()
    const promise = discoverDevices('lan', controller.signal)
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(request.mock.calls[1][1]).toBe('cancel')
    expect(JSON.parse(request.mock.calls[1][2])).toEqual({ requestId: request.mock.calls[0][0] })
  })
  it('passes cancellation to Tailnet discovery without logging in', async () => {
    native.discover.mockResolvedValue([{ ...info, address: '100.64.0.1' }])
    const signal = new AbortController().signal
    expect(await discoverDevices('tailscale', signal)).toHaveLength(1)
    expect(native.discover).toHaveBeenCalledWith(signal)
    expect(request).not.toHaveBeenCalled()
  })
})
