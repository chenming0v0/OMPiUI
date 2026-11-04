import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopTray } from './useDesktopTray'
import i18n from '../i18n'

const mocks = vi.hoisted(() => ({
  desktop: true, mobile: false,
  envVars: [{ key: 'OMPIUI_PORT', value: '8787' }],
  read: vi.fn(), applyStart: vi.fn(), setRunning: vi.fn(), setStartedByUs: vi.fn(),
  report: vi.fn(), listen: vi.fn(), notify: vi.fn(),
}))
vi.mock('../utils/tauri', () => ({ isTauri: () => mocks.desktop, isTauriMobile: () => mocks.mobile }))
vi.mock('../utils', () => ({ uiErrorHandler: mocks.report }))
vi.mock('../store/notificationStore', () => ({ notificationStore: { push: mocks.notify } }))
vi.mock('../store/serviceStore', () => ({
  useServiceStore: () => ({ envVars: mocks.envVars }),
  serviceStore: { setRunning: mocks.setRunning, setStartedByUs: mocks.setStartedByUs },
}))
vi.mock('../services/desktopService', () => ({
  getDesktopTraySettings: mocks.read,
  applyDesktopServiceStart: mocks.applyStart,
  redactBackgroundError: (error: string) => error.replace('test-secret', '***'),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))

const events = new Map<string, (event: { payload: unknown }) => void>()
const stops: ReturnType<typeof vi.fn>[] = []
beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.clearAllMocks()
  events.clear()
  stops.length = 0
  mocks.desktop = true
  mocks.mobile = false
  mocks.read.mockResolvedValue({ supported: true, closeToTray: false })
  mocks.listen.mockImplementation(async (name: string, handle) => {
    events.set(name, handle)
    const stop = vi.fn()
    stops.push(stop)
    return stop
  })
})
afterEach(cleanup)

describe('desktop tray native synchronization', () => {
  it('receives native start/stop events without issuing another start, and redacts errors', async () => {
    renderHook(() => useDesktopTray())
    await waitFor(() => expect(events.size).toBe(3))
    const result = { url: 'http://127.0.0.1:8787', token: 'test-secret', started: true, startedByUs: true }
    act(() => events.get('desktop-service-started')!({ payload: result }))
    expect(mocks.applyStart).toHaveBeenCalledWith(result)
    act(() => events.get('desktop-service-stopped')!({ payload: null }))
    expect(mocks.setRunning).toHaveBeenCalledWith(false)
    expect(mocks.setStartedByUs).toHaveBeenCalledWith(false)
    act(() => events.get('desktop-service-error')!({ payload: 'failed token=test-secret' }))
    expect(mocks.report).toHaveBeenCalledWith('desktop tray', 'failed token=***')
    expect(mocks.notify).toHaveBeenCalledWith('error', 'System tray operation failed', 'failed token=***', '')
  })

  it('syncs menu language and environment read-only and removes listeners at unmount', async () => {
    const view = renderHook(() => useDesktopTray())
    await waitFor(() => expect(mocks.read).toHaveBeenCalledWith('en'))
    mocks.read.mockClear()
    mocks.envVars = [{ key: 'OMPIUI_PORT', value: '9191' }]
    view.rerender()
    await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
    view.unmount()
    expect(stops).toHaveLength(3)
    stops.forEach(stop => expect(stop).toHaveBeenCalledOnce())
  })

  it.each(['browser', 'mobile'])('does not call desktop APIs in %s', async platform => {
    mocks.desktop = platform === 'mobile'
    mocks.mobile = platform === 'mobile'
    const view = renderHook(() => useDesktopTray())
    await act(async () => {})
    expect(mocks.listen).not.toHaveBeenCalled()
    view.unmount()
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
