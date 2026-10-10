import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disconnectAndroidTailscale, isTailnetUrl, resolveAndroidTailscaleUrl,
} from './androidTailscale'

vi.mock('./tauri', () => ({ isTauri: () => true }))
const request = vi.fn()
beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Android' })
  request.mockReset()
  window.__ompiui_tailscale = { request }
  request.mockImplementation((id, method) => {
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('ompiui-tailscale-result', {
      detail: { id, result: method === 'route' ? 'http://127.0.0.1:49152' : { ok: true } },
    })))
  })
})
afterEach(async () => {
  await disconnectAndroidTailscale()
  delete window.__ompiui_tailscale
  vi.unstubAllGlobals()
})

describe('Android embedded Tailscale transport', () => {
  it.each([
    ['http://100.64.0.1:8787', true],
    ['http://100.127.255.255', true],
    ['https://pc.example.ts.net', true],
    ['ws://[fd7a:115c:a1e0::1]:8787', true],
    ['http://100.128.0.1', false],
    ['http://192.168.1.5:8787', false],
    ['https://public.example', false],
    ['http://127.0.0.1:8787', false],
  ])('classifies %s without capturing ordinary traffic', (input, expected) => {
    expect(isTailnetUrl(input)).toBe(expected)
  })

  it('shares a native route between HTTP and WebSocket without losing paths or tokens', async () => {
    const http = await resolveAndroidTailscaleUrl('http://100.101.2.3:8787/api/v1/host/health')
    const ws = await resolveAndroidTailscaleUrl('ws://100.101.2.3:8787/api/v1/events?token=private-token')
    expect(http).toBe('http://127.0.0.1:49152/api/v1/host/health')
    expect(ws).toBe('ws://127.0.0.1:49152/api/v1/events?token=private-token')
    expect(request.mock.calls.filter(call => call[1] === 'route')).toHaveLength(1)
    expect(JSON.parse(request.mock.calls[0][2])).toEqual({ origin: 'http://100.101.2.3:8787' })
  })

  it('keeps the remote HTTPS scheme in the native route while using a loopback socket', async () => {
    expect(await resolveAndroidTailscaleUrl('wss://pc.example.ts.net/events')).toBe('ws://127.0.0.1:49152/events')
    expect(JSON.parse(request.mock.calls[0][2]).origin).toBe('https://pc.example.ts.net')
  })

  it('bypasses the bridge for LAN and public connections and for ordinary browsers', async () => {
    expect(await resolveAndroidTailscaleUrl('http://192.168.1.2:8787/api')).toBe('http://192.168.1.2:8787/api')
    vi.stubGlobal('navigator', { userAgent: 'Desktop Browser' })
    expect(await resolveAndroidTailscaleUrl('http://100.101.2.3:8787/api')).toBe('http://100.101.2.3:8787/api')
    expect(request).not.toHaveBeenCalled()
  })

  it('recreates routes after disconnect instead of reusing a closed loopback port', async () => {
    await resolveAndroidTailscaleUrl('http://100.101.2.3:8787/api')
    await disconnectAndroidTailscale()
    await resolveAndroidTailscaleUrl('http://100.101.2.3:8787/api')
    expect(request.mock.calls.filter(call => call[1] === 'route')).toHaveLength(2)
  })

  it('evicts a failed route so a later authorized attempt can succeed', async () => {
    request.mockImplementationOnce(id => {
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('ompiui-tailscale-result', {
        detail: { id, error: 'Sign in first' },
      })))
    })
    await expect(resolveAndroidTailscaleUrl('http://100.101.2.3:8787/api')).rejects.toThrow('Sign in first')
    expect(await resolveAndroidTailscaleUrl('http://100.101.2.3:8787/api')).toContain('127.0.0.1')
    expect(request.mock.calls.filter(call => call[1] === 'route')).toHaveLength(2)
  })
})
