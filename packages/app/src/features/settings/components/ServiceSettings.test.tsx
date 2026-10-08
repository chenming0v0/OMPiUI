import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TunnelStatus } from '@ompiui/protocol'
import { serviceStore } from '../../../store/serviceStore'
import { ServiceSettings } from './ServiceSettings'

const mocks = vi.hoisted(() => ({
  desktop: false,
  mobile: false,
  generation: 1,
  serverUrl: 'https://backend.example.test',
  tunnel: vi.fn(),
  shells: vi.fn(),
  refresh: vi.fn(),
  start: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
  storageSet: vi.fn(),
}))

vi.mock('../../../utils/tauri', () => ({ isTauri: () => mocks.desktop, isTauriMobile: () => mocks.mobile }))
vi.mock('../../../hooks', () => ({
  useServerStore: () => ({ activeServerGeneration: mocks.generation, activeServer: { url: mocks.serverUrl } }),
}))
vi.mock('../../../utils', () => ({ serverStorage: { get: () => null, set: mocks.storageSet, remove: vi.fn() } }))
vi.mock('../../../omp/transport/index.js', () => ({ fetchHostTunnel: mocks.tunnel, listHostShells: mocks.shells }))
vi.mock('../../../services/desktopService', () => ({
  refreshDesktopServiceStatus: mocks.refresh,
  startDesktopService: mocks.start,
  restartDesktopService: mocks.restart,
  stopDesktopService: mocks.stop,
}))
// Pairing and its real backend actions have their own component regressions.
vi.mock('./RemoteAccessSettings', () => ({ RemoteAccessSettings: () => null }))

const connected: TunnelStatus = {
  enabled: true,
  state: 'connected',
  relayUrl: 'wss://actual-relay.example.test',
  tunnelId: 'actual-tunnel',
  publicUrl: 'https://actual-public.example.test',
  lastError: null,
  reconnectAttempts: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.desktop = false
  mocks.mobile = false
  mocks.generation = 1
  mocks.serverUrl = 'https://backend.example.test'
  mocks.tunnel.mockReset().mockResolvedValue(connected)
  mocks.shells.mockResolvedValue({ shells: [{ name: 'bash', path: '/bin/bash', acceptable: true }] })
  const status = { running: false, startedByUs: false, environment: {} }
  mocks.refresh.mockResolvedValue(status)
  mocks.start.mockResolvedValue({ status })
  mocks.restart.mockResolvedValue({ status })
  mocks.stop.mockResolvedValue(status)
  serviceStore.setEnvVars([
    { key: 'OMPIUI_PORT', value: '7777' },
    { key: 'OMPIUI_TUNNEL_URL', value: 'wss://local-only.example.test' },
    { key: 'OMPIUI_TUNNEL_KEY', value: 'local-only-key' },
  ])
  serviceStore.setRunning(false)
  serviceStore.setStartedByUs(false)
  serviceStore.setStarting(false)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ServiceSettings ownership of configuration', () => {
  it.each(['browser', 'mobile'])('%s shows actual remote status without no-op configuration forms', async platform => {
    mocks.desktop = platform === 'mobile'
    mocks.mobile = platform === 'mobile'
    const saved = localStorage.getItem('ompiui-service-env-vars')
    const write = vi.spyOn(serviceStore, 'setEnvVars')
    const { container } = render(<ServiceSettings />)

    expect(await screen.findByText(connected.publicUrl!)).toBeInTheDocument()
    expect(screen.getByText(connected.relayUrl!)).toBeInTheDocument()
    expect(screen.getByText(mocks.serverUrl)).toBeInTheDocument()
    expect(screen.getByText('Remote configuration is read-only here.')).toBeInTheDocument()
    expect(screen.getByText(/open it separately and sign in with its own credentials/)).toBeInTheDocument()
    expect(screen.queryByText('wss://local-only.example.test')).not.toBeInTheDocument()
    expect(container.querySelectorAll('input, textarea')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /save|restart|^start$|^stop$/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/fill in Tunnel below|change it in Network listening below/i)).not.toBeInTheDocument()
    expect(write).not.toHaveBeenCalled()
    expect(localStorage.getItem('ompiui-service-env-vars')).toBe(saved)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()

    expect(screen.getByText(/Saved on this device, separately for each server/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Terminal shell' }))
    fireEvent.click(await screen.findByRole('option', { name: 'bash' }))
    expect(mocks.storageSet).toHaveBeenCalledWith('ompiui-terminal-shell', '/bin/bash')
  })

  it('preserves editable desktop environment and start/restart controls, labeled as local', async () => {
    mocks.desktop = true
    render(<ServiceSettings />)
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
    expect(screen.getByText('Local desktop service')).toBeInTheDocument()
    expect(screen.getByText(/They do not change the connected remote server/)).toBeInTheDocument()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Listen port' }), { target: { value: '9191' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Relay URL' }), { target: { value: 'wss://desktop-relay.test' } })
    fireEvent.change(screen.getByLabelText('Access key'), { target: { value: 'desktop-key' } })
    expect(serviceStore.envVarsRecord).toMatchObject({
      OMPIUI_PORT: '9191',
      OMPIUI_TUNNEL_URL: 'wss://desktop-relay.test',
      OMPIUI_TUNNEL_KEY: 'desktop-key',
    })
    expect(screen.getByText(connected.publicUrl!)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^start$/i }))
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: /restart/i }))
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledOnce())
  })

  it('preserves stopping the service owned by the desktop app', async () => {
    mocks.desktop = true
    serviceStore.setRunning(true)
    serviceStore.setStartedByUs(true)
    render(<ServiceSettings />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^stop$/i })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /^stop$/i }))
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce())
  })

  it('does not turn an unavailable status into a disabled tunnel', async () => {
    mocks.tunnel.mockRejectedValue(new Error('offline'))
    render(<ServiceSettings />)
    expect(await screen.findByText(/Server status unavailable/)).toBeInTheDocument()
    expect(screen.queryByText(/Disabled: the service has no tunnel configured/)).not.toBeInTheDocument()
  })

  it('shows disabled and reconnecting/error status from the backend', async () => {
    mocks.tunnel.mockResolvedValue({ ...connected, enabled: false, state: 'disabled' })
    const view = render(<ServiceSettings />)
    expect(await screen.findByText('Disabled: the service has no tunnel configured')).toBeInTheDocument()
    mocks.tunnel.mockResolvedValue({ ...connected, state: 'reconnecting', lastError: 'Relay rejected credentials', reconnectAttempts: 3 })
    mocks.generation++
    view.rerender(<ServiceSettings />)
    expect(await screen.findByText('Relay rejected credentials')).toBeInTheDocument()
    expect(screen.getByText(/reconnecting \(attempt 3\)/)).toBeInTheDocument()
  })

  it('drops the previous backend status immediately and ignores its late response', async () => {
    let resolveOld!: (value: TunnelStatus) => void
    mocks.tunnel.mockReturnValueOnce(new Promise<TunnelStatus>(resolve => { resolveOld = resolve }))
    const view = render(<ServiceSettings />)
    mocks.generation++
    mocks.serverUrl = 'https://next-backend.test'
    mocks.tunnel.mockResolvedValue({ ...connected, publicUrl: 'https://next-public.test' })
    view.rerender(<ServiceSettings />)
    expect(screen.getByText('Loading server status…')).toBeInTheDocument()
    expect(await screen.findByText('https://next-public.test')).toBeInTheDocument()
    await act(async () => resolveOld(connected))
    expect(screen.queryByText(connected.publicUrl!)).not.toBeInTheDocument()
  })

  it('does not display a loaded previous backend status while the new backend is pending', async () => {
    const view = render(<ServiceSettings />)
    await screen.findByText(connected.publicUrl!)
    mocks.generation++
    mocks.tunnel.mockReturnValue(new Promise<TunnelStatus>(() => {}))
    view.rerender(<ServiceSettings />)
    expect(screen.queryByText(connected.publicUrl!)).not.toBeInTheDocument()
    expect(screen.getByText('Loading server status…')).toBeInTheDocument()
  })
})
