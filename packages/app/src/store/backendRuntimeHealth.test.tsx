import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { backendRuntimeStatus, receiveBackendRuntimeHealth, useBackendRuntimeHealth } from './backendRuntimeHealth'
import { desktopDiagnosticsStore, useDesktopDiagnostics, type DesktopServiceDiagnostics } from './desktopDiagnosticsStore'

const native: DesktopServiceDiagnostics = {
  revision: 1, phase: 'running', requestedAt: null, spawnedAt: null, completedAt: null,
  pid: 42, error: null, events: [], reachable: true, workerReady: true, ompVersion: '18.12.6',
  healthError: null, healthUrl: 'http://127.0.0.1:58113', healthCheckedAt: 100, output: [],
}

describe('shared backend runtime health', () => {
  it('updates desktop and server consumers together and ignores late probes', () => {
    desktopDiagnosticsStore.finish()
    desktopDiagnosticsStore.receive(native)
    const { result } = renderHook(() => ({
      desktop: useDesktopDiagnostics().native,
      server: useBackendRuntimeHealth(`${native.healthUrl}/`),
      remote: useBackendRuntimeHealth('https://other-server.example'),
    }))
    expect(backendRuntimeStatus(result.current.desktop)).toBe('ready')
    expect(backendRuntimeStatus(result.current.server)).toBe('ready')
    act(() => receiveBackendRuntimeHealth(native.healthUrl!, { workerReady: true, ompVersion: null }, 200))
    expect(backendRuntimeStatus(result.current.desktop)).toBe('missing')
    expect(backendRuntimeStatus(result.current.server)).toBe('missing')
    act(() => desktopDiagnosticsStore.receive(native))
    expect(backendRuntimeStatus(result.current.desktop)).toBe('missing')
    expect(backendRuntimeStatus(result.current.server)).toBe('missing')
    expect(result.current.remote).toBeNull()
    act(() => desktopDiagnosticsStore.receive({ ...native, workerReady: false, ompVersion: null, healthCheckedAt: 300 }))
    expect(backendRuntimeStatus(result.current.desktop)).toBe('worker-unready')
    expect(backendRuntimeStatus(result.current.server)).toBe('worker-unready')
    act(() => receiveBackendRuntimeHealth(native.healthUrl!, { workerReady: true, ompVersion: '18.12.7' }, 400))
    expect(result.current.desktop?.ompVersion).toBe('18.12.7')
    expect(result.current.server?.ompVersion).toBe('18.12.7')
  })

  it('does not replace native lifecycle state with a previous running snapshot', () => {
    desktopDiagnosticsStore.receive({ ...native, phase: 'stopped', reachable: false, workerReady: null, ompVersion: null })
    const { result } = renderHook(() => useDesktopDiagnostics())
    expect(result.current.native).toMatchObject({ phase: 'stopped', reachable: false, workerReady: null, ompVersion: null })
  })
})
