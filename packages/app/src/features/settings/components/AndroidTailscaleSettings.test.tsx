import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AndroidTailscaleSettings } from './AndroidTailscaleSettings'

const mocks = vi.hoisted(() => ({
  status: vi.fn(), login: vi.fn(), disconnect: vi.fn(), redeem: vi.fn(), open: vi.fn(),
  add: vi.fn(), select: vi.fn(), check: vi.fn(), checkAll: vi.fn(),
  copyDiagnostics: vi.fn(), exportDiagnostics: vi.fn(),
  discovering: vi.fn(), refreshDiscovery: vi.fn(),
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
    addServer: mocks.add, setActiveServer: mocks.select, checkHealth: mocks.check, checkAllHealth: mocks.checkAll,
  },
}))
vi.mock('../../../utils/tailscaleLogin', async importOriginal => ({
  ...await importOriginal<typeof import('../../../utils/tailscaleLogin')>(), openTailscaleLogin: mocks.open,
}))
vi.mock('../../../components/QrCode', () => ({ QrCode: () => <div data-testid="auth-qr" /> }))
// 连上之后列出的电脑由发现组件负责，这里只关心登录这一段。
vi.mock('./useDeviceDiscovery', () => ({
  useDeviceDiscovery: (_network: string, enabled: boolean) => {
    mocks.discovering(enabled)
    return { devices: [], loading: false, error: '', refresh: mocks.refreshDiscovery }
  },
}))
vi.mock('./DiscoveredComputers', () => ({ DiscoveredRows: () => <div>Tailnet computers</div> }))
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

describe('phone independent Tailscale enrollment', () => {
  it('stays folded with its status on the group header, and opens to a plain sign-in without an authorization QR', async () => {
    render(<AndroidTailscaleSettings />)
    const group = screen.getByRole('button', { name: /Tailscale/ })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(group).toHaveTextContent('Signed out'))
    fireEvent.click(group)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    expect(screen.queryByTestId('auth-qr')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open official authorization' })).toHaveClass('w-full')
    expect(screen.getByText('Sign-in problems? View diagnostics').closest('details')).not.toHaveAttribute('open')
  })

  it('lists tailnet computers once connected and signs out from the group header', async () => {
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'Running', TailscaleIPs: ['100.101.2.4'] })
    mocks.disconnect.mockResolvedValue(undefined)
    render(<AndroidTailscaleSettings defaultOpen />)
    expect(await screen.findByText('Tailnet computers')).toBeVisible()
    expect(screen.getByRole('button', { name: /^Tailscale/ })).toHaveTextContent('Connected')
    // 没连上之前不去找电脑。
    expect(mocks.discovering).toHaveBeenCalledWith(false)
    expect(mocks.discovering).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('button', { name: 'Log in to Tailscale' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(mocks.refreshDiscovery).toHaveBeenCalledOnce()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign out' })))
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })

  it('says a previous sign-in is being restored and offers only to cancel it', async () => {
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'Starting' })
    mocks.disconnect.mockResolvedValue(undefined)
    render(<AndroidTailscaleSettings defaultOpen />)
    expect(await screen.findByText('Restoring the virtual network connection…')).toBeVisible()
    expect(screen.getByRole('button', { name: /^Tailscale/ })).toHaveTextContent('Restoring')
    expect(screen.queryByRole('button', { name: /Log in|Reconnect/ })).not.toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })

  it('cancels a pending login immediately on disconnect', async () => {
    const login = deferred<{ enabled: boolean; BackendState: string; AuthURL: string }>()
    const disconnect = deferred<void>()
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin' })
    mocks.login.mockReturnValueOnce(login.promise)
    mocks.disconnect.mockReturnValueOnce(disconnect.promise)
    render(<AndroidTailscaleSettings defaultOpen />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await act(async () => login.resolve({ enabled: true, BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/stale' }))
    expect(mocks.open).not.toHaveBeenCalled()
    expect(screen.queryByText('https://login.tailscale.com/a/stale')).not.toBeInTheDocument()
    mocks.status.mockResolvedValue({ enabled: false, BackendState: 'Stopped' })
    await act(async () => disconnect.resolve())
    expect(screen.getByRole('button', { name: 'Log in to Tailscale' })).toBeEnabled()
  })

  it('does not accept a pre-login background response after sign-in', async () => {
    vi.useFakeTimers()
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin' })
    await act(async () => { render(<AndroidTailscaleSettings defaultOpen />) })
    const stale = deferred<{ enabled: boolean; BackendState: string; AuthURL: string }>()
    mocks.status.mockReturnValueOnce(stale.promise)
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    await act(async () => stale.resolve({ enabled: true, BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/stale' }))
    expect(screen.getByText('https://login.tailscale.com/a/phone')).toBeInTheDocument()
    expect(screen.queryByText('https://login.tailscale.com/a/stale')).not.toBeInTheDocument()
    expect(mocks.open).toHaveBeenCalledOnce()
  })

  it('rotates and clears links using authoritative status and hides them during approval', async () => {
    vi.useFakeTimers()
    await act(async () => { render(<AndroidTailscaleSettings defaultOpen />) })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin', AuthURL: 'https://headscale.example.com/a/new' })
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(screen.getByText('https://headscale.example.com/a/new')).toBeInTheDocument()
    expect(screen.queryByText('https://login.tailscale.com/a/phone')).not.toBeInTheDocument()
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin', AuthURL: null })
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(screen.queryByText('https://headscale.example.com/a/new')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in to Tailscale' })).toBeEnabled()
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsMachineAuth', AuthURL: 'https://headscale.example.com/a/stale' })
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(screen.getByText('Waiting for Tailnet device approval')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /authorization|Log in/ })).not.toBeInTheDocument()
  })

  it('clears disconnect errors on retry and reopen', async () => {
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin' })
    mocks.disconnect.mockRejectedValue(new Error('disconnect failed'))
    render(<AndroidTailscaleSettings defaultOpen />)
    await act(async () => {})
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })))
    expect(screen.getByRole('alert')).toHaveTextContent('disconnect failed')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })))
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/phone' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open official authorization' })))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears status errors after a successful login result', async () => {
    vi.useFakeTimers()
    await act(async () => { render(<AndroidTailscaleSettings defaultOpen />) })
    mocks.status.mockRejectedValue(new Error('status unavailable'))
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(screen.getByRole('alert')).toHaveTextContent('status unavailable')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('refreshes server health even when disconnect status reaches the approval terminal state', async () => {
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin' })
    mocks.disconnect.mockResolvedValue(undefined)
    render(<AndroidTailscaleSettings defaultOpen />)
    await act(async () => {})
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsMachineAuth' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })))
    expect(mocks.checkAll).toHaveBeenCalledOnce()
  })

  it('copies diagnostics while the core is unavailable without starting it', async () => {
    mocks.status.mockRejectedValue(new Error('core unavailable'))
    render(<AndroidTailscaleSettings defaultOpen />)
    const button = await screen.findByRole('button', { name: 'Copy login diagnostics' })
    await act(async () => fireEvent.click(button))
    expect(mocks.copyDiagnostics).toHaveBeenCalledOnce()
    expect(await screen.findByText('Diagnostics copied. Paste them to share.')).toBeVisible()
    expect(mocks.login).not.toHaveBeenCalled()
  })
  it('exports diagnostics independently of login and pairing', async () => {
    render(<AndroidTailscaleSettings defaultOpen />)
    await act(async () => {})
    fireEvent.click(screen.getByText('Sign-in problems? View diagnostics'))
    const button = await screen.findByRole('button', { name: 'Export login diagnostics' })
    await act(async () => fireEvent.click(button))
    expect(mocks.exportDiagnostics).toHaveBeenCalledOnce()
    expect(mocks.login).not.toHaveBeenCalled()
    expect(mocks.redeem).not.toHaveBeenCalled()
  })
  it('shows that automatic restore is paused after an interrupted startup', async () => {
    mocks.status.mockResolvedValue({ enabled: false, BackendState: 'Stopped', startupInterrupted: true })
    render(<AndroidTailscaleSettings defaultOpen />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Automatic recovery is paused')
    expect(screen.getByRole('button', { name: 'Copy login diagnostics' })).toBeEnabled()
  })
  it('opens official phone authorization without needing a reachable computer backend', async () => {
    render(<AndroidTailscaleSettings defaultOpen />)
    const button = await screen.findByRole('button', { name: 'Log in to Tailscale' })
    await waitFor(() => expect(button).toBeEnabled())
    await act(async () => fireEvent.click(button))
    expect(mocks.login).toHaveBeenCalledOnce()
    expect(mocks.open).toHaveBeenCalledWith('https://login.tailscale.com/a/phone')
    expect(mocks.redeem).not.toHaveBeenCalled()
  })

  it('shows browser errors without losing the login button', async () => {
    mocks.open.mockRejectedValue(new Error('No browser is available'))
    render(<AndroidTailscaleSettings defaultOpen />)
    const button = await screen.findByRole('button', { name: 'Log in to Tailscale' })
    await waitFor(() => expect(button).toBeEnabled())
    await act(async () => fireEvent.click(button))
    expect(await screen.findByRole('alert')).toHaveTextContent('No browser is available')
    expect(button).toBeEnabled()
  })

  it('has no server connection form or navigation button for an authenticated phone', async () => {
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'Running', TailscaleIPs: ['100.101.2.4'] })
    render(<AndroidTailscaleSettings defaultOpen />)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Add server connection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('stays on authentication after login so pairing input and scanning remain available', async () => {
    vi.useFakeTimers()
    render(<AndroidTailscaleSettings defaultOpen />)
    await act(async () => {})
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    expect(mocks.open).toHaveBeenCalled()
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsMachineAuth' })
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    mocks.status.mockResolvedValue({ enabled: true, BackendState: 'Running', TailscaleIPs: ['100.101.2.4'] })
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    await act(async () => vi.advanceTimersByTimeAsync(3_000))
    expect(screen.queryByRole('button', { name: 'Add server connection' })).not.toBeInTheDocument()
  })

  it('does not redirect when login immediately restores an authenticated identity', async () => {
    mocks.login.mockResolvedValue({ enabled: true, BackendState: 'Running' })
    render(<AndroidTailscaleSettings defaultOpen />)
    const button = await screen.findByRole('button', { name: 'Log in to Tailscale' })
    await waitFor(() => expect(button).toBeEnabled())
    await act(async () => fireEvent.click(button))
    expect(screen.queryByRole('button', { name: 'Add server connection' })).not.toBeInTheDocument()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('keeps a visible waiting state until the authorization link arrives', async () => {
    vi.useFakeTimers()
    try {
      mocks.login.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin' })
      render(<AndroidTailscaleSettings defaultOpen />)
      await act(async () => {})
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
      expect(screen.getByText('Sign-in started, fetching the authorization link…')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Log in to Tailscale' })).toBeDisabled()
      mocks.status.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/phone' })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(mocks.open).toHaveBeenCalledWith('https://login.tailscale.com/a/phone')
      expect(screen.getByText('Browser opened, complete authorization in the popped-up page…')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open official authorization' })).toBeEnabled()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('shows a timeout error and lets the user retry instead of silently reverting', async () => {
    vi.useFakeTimers()
    try {
      mocks.login.mockResolvedValue({ enabled: true, BackendState: 'NeedsLogin' })
      render(<AndroidTailscaleSettings defaultOpen />)
      await act(async () => {})
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
      expect(screen.getByRole('alert')).toHaveTextContent('No authorization link within 30 seconds')
      expect(screen.getByRole('button', { name: 'Log in to Tailscale' })).toBeEnabled()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })
})
