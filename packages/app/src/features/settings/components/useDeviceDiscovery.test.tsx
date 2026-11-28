import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDeviceDiscovery } from './useDeviceDiscovery'

const mocks = vi.hoisted(() => ({ discover: vi.fn() }))
vi.mock('../../../utils/deviceDiscovery', () => ({ discoverDevices: mocks.discover }))

const device = { marker: 'ompiui', discoveryVersion: 1, displayName: 'My computer', instanceId: 'a'.repeat(32), port: 9191,
  pairing: true, address: '192.168.1.10', network: 'lan' } as const

beforeEach(() => { mocks.discover.mockReset().mockResolvedValue([]) })

describe('useDeviceDiscovery', () => {
  it('scans only the requested network and reports what it finds', async () => {
    mocks.discover.mockResolvedValue([device])
    const { result } = renderHook(() => useDeviceDiscovery('lan', true))
    await waitFor(() => expect(result.current.devices).toEqual([device]))
    expect(mocks.discover).toHaveBeenCalledTimes(1)
    expect(mocks.discover).toHaveBeenCalledWith('lan', expect.any(AbortSignal))
    expect(result.current.loading).toBe(false)
  })

  it.each([
    ['discoveryPermissionDenied: Android NSD denied', 'discoveryPermissionDenied'],
    ['Tailscale discovery unavailable: node is stopped', 'discoveryTailscaleLogin'],
    ['Tailscale discovery requires Running state', 'discoveryTailscaleLogin'],
    ['socket closed', 'socket closed'],
  ])('reduces native failures to a code the UI can translate: %s', async (message, code) => {
    mocks.discover.mockRejectedValue(new Error(message))
    const { result } = renderHook(() => useDeviceDiscovery('tailscale', true))
    await waitFor(() => expect(result.current.error).toBe(code))
    expect(result.current.devices).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('aborts the previous scan on refresh and ignores its late answer', async () => {
    const requests: Array<{ signal: AbortSignal; resolve: (devices: typeof device[]) => void }> = []
    mocks.discover.mockImplementation((_network, signal) => new Promise(resolve => requests.push({ signal, resolve })))
    const { result } = renderHook(() => useDeviceDiscovery('lan', true))
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(result.current.loading).toBe(true)
    act(() => result.current.refresh())
    expect(requests[0].signal.aborted).toBe(true)
    expect(requests).toHaveLength(2)
    await act(async () => requests[0].resolve([device]))
    expect(result.current.devices).toEqual([])
    await act(async () => requests[1].resolve([device]))
    expect(result.current.devices).toEqual([device])
  })

  it('does not scan until enabled, and stops when it is turned off or unmounted', async () => {
    const signals: AbortSignal[] = []
    mocks.discover.mockImplementation((_network, signal) => { signals.push(signal); return new Promise(() => {}) })
    const view = renderHook(({ enabled }) => useDeviceDiscovery('tailscale', enabled), { initialProps: { enabled: false } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    expect(mocks.discover).not.toHaveBeenCalled()
    view.rerender({ enabled: true })
    await waitFor(() => expect(signals).toHaveLength(1))
    view.rerender({ enabled: false })
    expect(signals[0].aborted).toBe(true)
    view.rerender({ enabled: true })
    await waitFor(() => expect(signals).toHaveLength(2))
    view.unmount()
    expect(signals[1].aborted).toBe(true)
  })
})
