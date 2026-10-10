import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AndroidTailscaleSettings } from './AndroidTailscaleSettings'

const mocks = vi.hoisted(() => ({
  status: vi.fn(), login: vi.fn(), disconnect: vi.fn(), redeem: vi.fn(), open: vi.fn(),
  add: vi.fn(), select: vi.fn(), check: vi.fn(),
  copyDiagnostics: vi.fn(), exportDiagnostics: vi.fn(),
}))
vi.mock('../../../utils/androidTailscale', () => ({
  isAndroidTailscalePlatform: () => true,
  getAndroidTailscaleStatus: mocks.status,
  loginAndroidTailscale: mocks.login,
  disconnectAndroidTailscale: mocks.disconnect,
  copyAndroidTailscaleDiagnostics: mocks.copyDiagnostics,
  exportAndroidTailscaleDiagnostics: mocks.exportDiagnostics,
}))
vi.mock('../../../omp/transport', () => ({ redeemPairCode: mocks.redeem }))
vi.mock('../../../store/serverStore', () => ({
  serverStore: {
    addServer: mocks.add, setActiveServer: mocks.select, checkHealth: mocks.check, checkAllHealth: vi.fn(),
  },
}))
vi.mock('../../../utils/tailscaleLogin', () => ({ openTailscaleLogin: mocks.open }))
vi.mock('../../../components/QrCode', () => ({ QrCode: () => <div /> }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.status.mockResolvedValue({ enabled: false, BackendState: 'Stopped', TailscaleIPs: [] })
  mocks.login.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/phone' })
  mocks.add.mockReturnValue({ id: 'paired-phone' })
  mocks.check.mockResolvedValue({ status: 'online' })
  mocks.redeem.mockResolvedValue({ url: 'http://100.101.2.3:8787', token: 'server-token' })
  mocks.open.mockResolvedValue(undefined)
  mocks.copyDiagnostics.mockResolvedValue(undefined)
  mocks.exportDiagnostics.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('phone independent Tailscale enrollment', () => {
  it('copies diagnostics while the core is unavailable without starting it', async () => {
    mocks.status.mockRejectedValue(new Error('core unavailable'))
    render(<AndroidTailscaleSettings />)
    const button = await screen.findByRole('button', { name: 'Copy login diagnostics' })
    await act(async () => fireEvent.click(button))
    expect(mocks.copyDiagnostics).toHaveBeenCalledOnce()
    expect(await screen.findByText('Diagnostics copied. Paste them to share.')).toBeVisible()
    expect(mocks.login).not.toHaveBeenCalled()
  })
  it('exports diagnostics independently of login and pairing', async () => {
    render(<AndroidTailscaleSettings />)
    const button = await screen.findByRole('button', { name: 'Export login diagnostics' })
    await act(async () => fireEvent.click(button))
    expect(mocks.exportDiagnostics).toHaveBeenCalledOnce()
    expect(mocks.login).not.toHaveBeenCalled()
    expect(mocks.redeem).not.toHaveBeenCalled()
  })
  it('shows that automatic restore is paused after an interrupted startup', async () => {
    mocks.status.mockResolvedValue({ enabled: false, BackendState: 'Stopped', startupInterrupted: true })
    render(<AndroidTailscaleSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Automatic recovery is paused')
    expect(screen.getByRole('button', { name: 'Copy login diagnostics' })).toBeEnabled()
  })
  it('opens official phone authorization without needing a reachable computer backend', async () => {
    render(<AndroidTailscaleSettings />)
    const button = await screen.findByRole('button', { name: 'Log in to Tailscale' })
    await waitFor(() => expect(button).toBeEnabled())
    await act(async () => fireEvent.click(button))
    expect(mocks.login).toHaveBeenCalledOnce()
    expect(mocks.open).toHaveBeenCalledWith('https://login.tailscale.com/a/phone')
    expect(mocks.redeem).not.toHaveBeenCalled()
  })

  it('shows browser errors without losing the login button', async () => {
    mocks.open.mockRejectedValue(new Error('No browser is available'))
    render(<AndroidTailscaleSettings />)
    const button = await screen.findByRole('button', { name: 'Log in to Tailscale' })
    await waitFor(() => expect(button).toBeEnabled())
    await act(async () => fireEvent.click(button))
    expect(await screen.findByRole('alert')).toHaveTextContent('No browser is available')
    expect(button).toBeEnabled()
  })

  it('has no server connection form and does not redirect a phone that is already authenticated', async () => {
    const completed = vi.fn()
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'Running', TailscaleIPs: ['100.101.2.4'] })
    render(<AndroidTailscaleSettings onAuthenticated={completed} />)
    expect(await screen.findByRole('button', { name: 'Add server connection' })).toBeEnabled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(completed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add server connection' }))
    expect(completed).toHaveBeenCalledOnce()
  })

  it('redirects only after the requested login reaches Running, not when the browser opens or approval is pending', async () => {
    vi.useFakeTimers()
    const completed = vi.fn()
    render(<AndroidTailscaleSettings onAuthenticated={completed} />)
    await act(async () => {})
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    expect(mocks.open).toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsMachineAuth' })
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(completed).not.toHaveBeenCalled()
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'Running', TailscaleIPs: ['100.101.2.4'] })
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(completed).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(completed).toHaveBeenCalledOnce()
  })

  it('redirects when login immediately restores an authenticated identity', async () => {
    const completed = vi.fn()
    mocks.login.mockResolvedValue({ enabled: true, BackendState: 'Running' })
    render(<AndroidTailscaleSettings onAuthenticated={completed} />)
    const button = await screen.findByRole('button', { name: 'Log in to Tailscale' })
    await waitFor(() => expect(button).toBeEnabled())
    await act(async () => fireEvent.click(button))
    expect(completed).toHaveBeenCalledOnce()
    expect(mocks.open).not.toHaveBeenCalled()
  })
})
