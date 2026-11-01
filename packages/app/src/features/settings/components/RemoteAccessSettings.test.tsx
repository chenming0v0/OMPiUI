import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostNetworkInfo, PairInviteInfo, TunnelStatus } from '@ompiui/protocol'
import { serviceStore } from '../../../store/serviceStore'
import { RemoteAccessSettings } from './RemoteAccessSettings'
import i18n from '../../../i18n'

const mocks = vi.hoisted(() => ({
  generation: 1,
  desktop: false,
  network: vi.fn(),
  mint: vi.fn(),
  poll: vi.fn(),
  tunnel: vi.fn(),
  tailscale: vi.fn(),
  openLogin: vi.fn(),
  login: vi.fn(), disconnect: vi.fn(),
  get: vi.fn(),
}))
vi.mock('../../../hooks', () => ({ useServerStore: () => ({ activeServerGeneration: mocks.generation }) }))
vi.mock('../../../utils/tauri', () => ({ isTauri: () => mocks.desktop, isTauriMobile: () => false }))
vi.mock('../../../utils', () => ({ serverStorage: { get: mocks.get, set: vi.fn() } }))
vi.mock('../../../utils/tailscaleLogin', async importOriginal => ({
  ...await importOriginal<typeof import('../../../utils/tailscaleLogin')>(), openTailscaleLogin: mocks.openLogin,
}))
vi.mock('../../../omp/transport/index.js', () => ({
  fetchHostNetwork: mocks.network,
  mintPairInvite: mocks.mint,
  fetchPairInvite: mocks.poll,
  fetchHostTunnel: mocks.tunnel,
  fetchTailscale: mocks.tailscale,
  startTailscaleInstall: vi.fn(),
  startTailscaleLogin: mocks.login,
  disconnectTailscale: mocks.disconnect,
}))
// Observe the exact payload given to the QR encoder, not its SVG internals.
vi.mock('../../../components/QrCode', () => ({ QrCode: ({ text }: { text: string }) => <div data-testid="qr" data-url={text} /> }))

type Network = HostNetworkInfo
const network = (address = '192.168.50.10', port = 9191): Network => ({
  interfaces: [{ name: 'Ethernet', address, tailscale: false }], port, host: '0.0.0.0',
})
const invite = (id = 'first'): PairInviteInfo => ({ id, pair: `${id}.secret`, code: '12345678', expiresAt: Date.now() + 600_000, redeemed: false })
const disabledTunnel: TunnelStatus = { enabled: false, state: 'disabled', publicUrl: null, relayUrl: null, tunnelId: null, lastError: null, reconnectAttempts: 0 }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.clearAllMocks()
  mocks.generation = 1
  mocks.desktop = false
  mocks.get.mockReturnValue(null)
  mocks.network.mockReset().mockResolvedValue(network())
  mocks.mint.mockReset().mockResolvedValue(invite())
  mocks.poll.mockResolvedValue(invite())
  mocks.tunnel.mockReset().mockResolvedValue(disabledTunnel)
  mocks.tailscale.mockRejectedValue(new Error('unsupported'))
  mocks.openLogin.mockResolvedValue(undefined)
  serviceStore.setEnvVars([{ key: 'OMPIUI_PORT', value: '7777' }])
})

afterEach(async () => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); await i18n.changeLanguage('en') })

const signInStatus = { mode: 'embedded', installed: true, enabled: true, backendState: 'NeedsLogin', ips: [], url: null, authUrl: null, lastError: null }
const authUrl = 'https://headscale.example.com/a/device'

describe('remote Tailscale sign-in', () => {
  beforeEach(() => {
    mocks.get.mockReturnValue('tailscale')
    mocks.tailscale.mockReset().mockResolvedValue(signInStatus)
    mocks.login.mockReset().mockResolvedValue({ ok: true, authUrl })
    mocks.disconnect.mockReset().mockResolvedValue(undefined)
  })

  it('separates server sign-in from phone pairing and never shows an authorization QR', async () => {
    mocks.tailscale.mockResolvedValue({ ...signInStatus, authUrl })
    render(<RemoteAccessSettings />)
    const networkSetup = screen.getByTestId('remote-network-setup')
    const phonePairing = screen.getByTestId('remote-device-pairing')
    expect(await within(networkSetup).findByRole('heading', { name: 'Server sign-in' })).toBeInTheDocument()
    expect(within(networkSetup).getByRole('link', { name: 'Open official authorization' })).toHaveAttribute('href', authUrl)
    expect(within(networkSetup).queryByTestId('qr')).not.toBeInTheDocument()
    expect(within(phonePairing).getByRole('heading', { name: 'Connect your phone' })).toBeInTheDocument()
    expect(within(phonePairing).queryByRole('link')).not.toBeInTheDocument()
    expect(within(phonePairing).queryByTestId('qr')).not.toBeInTheDocument()
    expect(within(phonePairing).queryByText(/1234 5678|expires in/)).not.toBeInTheDocument()
  })

  it('shows only a phone pairing QR once the server connects', async () => {
    mocks.tailscale.mockResolvedValue({ ...signInStatus, backendState: 'Running', ips: ['100.101.2.3'], url: 'http://100.101.2.3:9292' })
    render(<RemoteAccessSettings />)
    expect(await within(screen.getByTestId('remote-device-pairing')).findByTestId('qr')).toHaveAttribute('data-url', 'http://100.101.2.3:9292/?pair=first.secret')
    expect(within(screen.getByTestId('remote-network-setup')).queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('qr')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Copy full pairing info' })).toBeEnabled()
    expect(within(screen.getByTestId('remote-device-pairing')).getByText('Server address: http://100.101.2.3:9292')).toBeInTheDocument()
    expect(within(screen.getByTestId('remote-device-pairing')).getByText('Pairing code: 1234 5678')).toBeInTheDocument()
  })

  it('opens a URL-bearing POST without waiting for another GET', async () => {
    mocks.desktop = true
    await act(async () => { render(<RemoteAccessSettings />) })
    mocks.tailscale.mockRejectedValue(new Error('GET failed'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    expect(mocks.openLogin).toHaveBeenCalledWith(authUrl)
    expect(mocks.tailscale).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.getByText(authUrl)).toBeInTheDocument()
  })

  it('offers a direct web authorization link without claiming a browser was opened', async () => {
    mocks.openLogin.mockResolvedValue('manual')
    await act(async () => { render(<RemoteAccessSettings />) })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    expect(screen.getByRole('link', { name: 'Open official authorization' })).toHaveAttribute('href', authUrl)
    fireEvent.click(screen.getByText("Browser didn't open? Use the sign-in link"))
    expect(screen.getByRole('link', { name: authUrl })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText('Authorization link ready. Open it to complete sign-in.')).toBeInTheDocument()
    expect(screen.queryByText(/Browser opened/)).not.toBeInTheDocument()
  })

  it('fetches status only as fallback when POST has no authorization URL', async () => {
    mocks.desktop = true
    mocks.login.mockResolvedValue({ ok: true })
    await act(async () => { render(<RemoteAccessSettings />) })
    mocks.tailscale.mockResolvedValue({ ...signInStatus, authUrl })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    expect(mocks.tailscale).toHaveBeenCalledTimes(2)
    expect(mocks.openLogin).toHaveBeenCalledWith(authUrl)
  })

  it('ignores pending POST and status responses after a server switch', async () => {
    mocks.desktop = true
    const oldLogin = deferred<{ ok: boolean; authUrl: string }>()
    const view = render(<RemoteAccessSettings />)
    await act(async () => {})
    mocks.login.mockReturnValueOnce(oldLogin.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' }))
    mocks.generation++
    view.rerender(<RemoteAccessSettings />)
    await act(async () => {})
    await act(async () => oldLogin.resolve({ ok: true, authUrl }))
    expect(mocks.openLogin).not.toHaveBeenCalled()
    expect(screen.queryByText(authUrl)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in to Tailscale' })).toBeEnabled()
  })

  it('cancels login before awaiting disconnect and does not reopen a stale URL', async () => {
    mocks.desktop = true
    const oldLogin = deferred<{ ok: boolean; authUrl: string }>()
    const disconnect = deferred<void>()
    mocks.login.mockReturnValueOnce(oldLogin.promise)
    mocks.disconnect.mockReturnValueOnce(disconnect.promise)
    await act(async () => { render(<RemoteAccessSettings />) })
    fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await act(async () => oldLogin.resolve({ ok: true, authUrl }))
    expect(mocks.openLogin).not.toHaveBeenCalled()
    expect(screen.queryByText(authUrl)).not.toBeInTheDocument()
    mocks.tailscale.mockResolvedValue({ ...signInStatus, enabled: false, backendState: 'Stopped' })
    await act(async () => disconnect.resolve())
    expect(screen.getByRole('button', { name: 'Log in to Tailscale' })).toBeEnabled()
  })

  it('preserves a usable POST URL during GET failure and clears action errors on retry', async () => {
    mocks.desktop = true
    vi.useFakeTimers()
    await act(async () => { render(<RemoteAccessSettings />) })
    mocks.disconnect.mockRejectedValue(new Error('disconnect failed'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })))
    expect(screen.getByRole('alert')).toHaveTextContent('disconnect failed')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    mocks.tailscale.mockRejectedValue(new Error('GET failed'))
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(screen.getByRole('alert')).toHaveTextContent('GET failed')
    expect(screen.getByRole('button', { name: 'Open official authorization' })).toBeEnabled()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.getByText(authUrl)).toBeInTheDocument()
  })

  it('replaces and clears cached POST URLs with authoritative status', async () => {
    vi.useFakeTimers()
    await act(async () => { render(<RemoteAccessSettings />) })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log in to Tailscale' })))
    const rotated = 'https://headscale.example.com/a/rotated'
    mocks.tailscale.mockResolvedValue({ ...signInStatus, authUrl: rotated })
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Browser didn't open? Use the sign-in link"))
    expect(screen.getByRole('link', { name: rotated })).toHaveAttribute('href', rotated)
    expect(screen.queryByText(authUrl)).not.toBeInTheDocument()
    mocks.tailscale.mockResolvedValue(signInStatus)
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in to Tailscale' })).toBeEnabled()
  })
})

describe('pairing invitation polling', () => {
  it('pauses while hidden, resumes once, and stops permanently after redemption', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await act(async () => { render(<RemoteAccessSettings />) })
    visibility.mockReturnValue('hidden')
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(mocks.poll).not.toHaveBeenCalled()
    mocks.poll.mockResolvedValue({ ...invite(), redeemed: true })
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(mocks.poll).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(mocks.poll).toHaveBeenCalledTimes(1)
  })

  it('never polls an expired invite and restarts only after a new invite is minted', async () => {
    vi.useFakeTimers()
    mocks.mint.mockResolvedValueOnce({ ...invite(), expiresAt: Date.now() + 2000 })
    await act(async () => { render(<RemoteAccessSettings />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
    expect(mocks.poll).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New code' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(mocks.poll).toHaveBeenCalledTimes(1)
  })
})

describe('RemoteAccessSettings authoritative addresses', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.50.99'])('blocks a LAN QR when the listener does not serve the selected adapter: %s', async host => {
    mocks.network.mockResolvedValue({ ...network(), host })
    render(<RemoteAccessSettings />)
    expect(await screen.findByText('QR code unavailable')).toBeInTheDocument()
    expect(screen.getAllByText(/not the selected LAN adapter/)).toHaveLength(1)
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy full pairing info' })).not.toBeInTheDocument()
    expect(serviceStore.envVarsRecord).not.toHaveProperty('OMPIUI_HOST')
  })

  it.each(['0.0.0.0', '::', '192.168.50.10', '::ffff:192.168.50.10'])('allows a LAN QR for a matching listener: %s', async host => {
    mocks.network.mockResolvedValue({ ...network(), host })
    render(<RemoteAccessSettings />)
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://192.168.50.10:9191/?pair=first.secret')
  })

  it('does not assume older servers without a listener address allow LAN access', async () => {
    mocks.network.mockResolvedValue({ ...network(), host: undefined })
    render(<RemoteAccessSettings />)
    expect(await screen.findByText('QR code unavailable')).toBeInTheDocument()
    expect(screen.getAllByText(/did not report its listening address/)).toHaveLength(1)
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
  })

  it('refreshes the listener after LAN access is enabled on the server', async () => {
    mocks.network.mockResolvedValueOnce({ ...network(), host: '127.0.0.1' })
    render(<RemoteAccessSettings />)
    await screen.findByText('QR code unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://192.168.50.10:9191/?pair=first.secret')
    expect(screen.queryByText(/not the selected LAN adapter/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy full pairing info' })).toBeEnabled()
  })

  it('blocks an adapter that does not match a specific listener after selection changes', async () => {
    mocks.network.mockResolvedValue({
      ...network(), host: '192.168.50.10',
      interfaces: [
        ...network().interfaces,
        { name: 'Other adapter', address: '172.31.48.1', tailscale: false },
      ],
    })
    render(<RemoteAccessSettings />)
    await screen.findByTestId('qr')
    fireEvent.change(screen.getByRole('combobox', { name: 'Network adapter' }), { target: { value: '172.31.48.1' } })
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy full pairing info' })).not.toBeInTheDocument()
  })

  it('renders Chinese adapter names and the loopback listener warning', async () => {
    await i18n.changeLanguage('zh-CN')
    mocks.network.mockResolvedValue({
      ...network(), host: '127.0.0.1',
      interfaces: [{ name: '以太网', address: '192.168.50.10', tailscale: false }],
    })
    render(<RemoteAccessSettings />)
    expect(await screen.findByRole('option', { name: '以太网 · 192.168.50.10' })).toBeInTheDocument()
    expect(screen.getAllByText(/未开放所选网卡的局域网访问/)).toHaveLength(1)
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
  })

  it('uses the embedded Tailnet listener rather than a system network adapter', async () => {
    mocks.get.mockReturnValue('tailscale')
    mocks.network.mockResolvedValue({ interfaces: [] })
    mocks.tailscale.mockResolvedValue({
      mode: 'embedded', installed: true, enabled: true, supported: true, reachable: true,
      backendState: 'Running', ips: ['100.101.2.3'], url: 'http://100.101.2.3:9292',
      authUrl: null, lastError: null,
    })
    render(<RemoteAccessSettings />)
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://100.101.2.3:9292/?pair=first.secret')
    expect(screen.getByText('Tailscale connected · 100.101.2.3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install Tailscale' })).not.toBeInTheDocument()
  })

  it.each([null, 'https://login.tailscale.com/a/test'])('does not render a login or pairing QR while awaiting authorization: %s', async authUrl => {
    mocks.get.mockReturnValue('tailscale')
    mocks.tailscale.mockResolvedValue({
      mode: 'embedded', installed: true, enabled: true, backendState: 'NeedsLogin',
      ips: [], url: null, authUrl, lastError: null,
    })
    render(<RemoteAccessSettings />)
    expect(await screen.findByText(authUrl ? 'Authorization link ready. Open it to complete sign-in.' : 'Connecting / awaiting sign-in')).toBeInTheDocument()
    expect(screen.getByText("Sign in to Tailscale above first. Your phone's pairing code will appear here once the server connects.")).toBeInTheDocument()
    expect(screen.queryByText(/Cannot scan\?/)).not.toBeInTheDocument()
    expect(screen.queryByText(/expires in/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy full pairing info' })).not.toBeInTheDocument()
    if (authUrl) {
      // 浏览器授权保留直接链接，不与手机配对二维码混用。
      expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
      expect(screen.getByText(authUrl)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Open official authorization' })).toHaveAttribute('href', authUrl)
      expect(mocks.openLogin).not.toHaveBeenCalled()
    } else {
      expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    }
  })

  it('replaces the sign-in prompt with the pairing QR after Tailscale connects', async () => {
    mocks.get.mockReturnValue('tailscale')
    mocks.tailscale.mockResolvedValue({
      mode: 'embedded', installed: true, enabled: true, backendState: 'NeedsLogin',
      ips: [], url: null, authUrl: 'https://login.tailscale.com/a/test', lastError: null,
    })
    vi.useFakeTimers()
    try {
      await act(async () => { render(<RemoteAccessSettings />) })
      expect(screen.getByText('Authorization link ready. Open it to complete sign-in.')).toBeInTheDocument()
      // 登录区域只提供浏览器授权入口；二维码仅用于服务器连接后的手机配对。
      expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
      expect(screen.getByText('https://login.tailscale.com/a/test')).toBeInTheDocument()
      mocks.tailscale.mockResolvedValue({
        mode: 'embedded', installed: true, enabled: true, backendState: 'Running',
        ips: ['100.101.2.3'], url: 'http://100.101.2.3:9292', authUrl: null, lastError: null,
      })
      expect(screen.getByRole('link', { name: 'Open official authorization' })).toHaveAttribute('href', 'https://login.tailscale.com/a/test')
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(screen.getAllByTestId('qr')).toHaveLength(1)
      expect(screen.getByTestId('qr')).toHaveAttribute('data-url', 'http://100.101.2.3:9292/?pair=first.secret')
      expect(screen.queryByText(/Sign in to Tailscale above first/)).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Open official authorization' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Copy full pairing info' })).toBeEnabled()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('uses the backend non-default port even when local desktop settings differ', async () => {
    render(<RemoteAccessSettings />)
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://192.168.50.10:9191/?pair=first.secret')
    expect(screen.getByText('Server address: http://192.168.50.10:9191')).toBeInTheDocument()
    expect(screen.getByLabelText('Listen port')).toHaveTextContent('9191')
    expect(screen.getByLabelText('Listen port').tagName).not.toBe('INPUT')
    expect(screen.queryByText(/change it in Network listening below/)).not.toBeInTheDocument()
  })

  it.each([undefined, 0, -1, 65536, 1.5, NaN])('never invents a QR port for a missing/invalid server port: %s', async port => {
    mocks.network.mockResolvedValue({ interfaces: network().interfaces, port })
    render(<RemoteAccessSettings />)
    expect(await screen.findByText(/The server did not report a listening port/)).toBeInTheDocument()
    expect(screen.getByText('QR code unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy full pairing info' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Listen port')).toHaveTextContent('—')
    expect(screen.queryByText(/8787|7777/)).not.toBeInTheDocument()
  })

  it('shows an explicit unavailable state for older servers without either endpoint', async () => {
    mocks.network.mockRejectedValue(new Error('404'))
    mocks.mint.mockRejectedValue(new Error('404'))
    render(<RemoteAccessSettings />)
    expect(await screen.findByText('QR code unavailable')).toBeInTheDocument()
    expect(screen.getByText(/The server did not report a listening port/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New code' })).toBeEnabled()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
  })

  it('refreshes network data instead of only refreshing the countdown', async () => {
    const next = deferred<Network>()
    render(<RemoteAccessSettings />)
    await screen.findByTestId('qr')
    mocks.network.mockReturnValueOnce(next.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(mocks.network).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    await act(async () => next.resolve(network('192.168.60.11', 9292)))
    expect(screen.getByTestId('qr')).toHaveAttribute('data-url', 'http://192.168.60.11:9292/?pair=first.secret')
  })

  it('clears old network immediately on server switch, before the new network response', async () => {
    const nextNetwork = deferred<Network>()
    const view = render(<RemoteAccessSettings />)
    await screen.findByTestId('qr')
    mocks.network.mockReturnValueOnce(nextNetwork.promise)
    mocks.mint.mockResolvedValue(invite('second'))
    mocks.generation++
    view.rerender(<RemoteAccessSettings />)
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    await waitFor(() => expect(mocks.mint).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    await act(async () => nextNetwork.resolve(network('10.0.0.20', 9393)))
    expect(screen.getByTestId('qr')).toHaveAttribute('data-url', 'http://10.0.0.20:9393/?pair=second.secret')
  })

  it('ignores a previous server network response arriving after the new server', async () => {
    const oldNetwork = deferred<Network>()
    mocks.network.mockReturnValueOnce(oldNetwork.promise)
    const view = render(<RemoteAccessSettings />)
    mocks.generation++
    mocks.network.mockResolvedValue(network('10.0.0.20', 9393))
    mocks.mint.mockResolvedValue(invite('second'))
    view.rerender(<RemoteAccessSettings />)
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://10.0.0.20:9393/?pair=second.secret')
    await act(async () => oldNetwork.resolve(network()))
    expect(screen.getByTestId('qr')).toHaveAttribute('data-url', 'http://10.0.0.20:9393/?pair=second.secret')
  })

  it('ignores a reminted invite from the old server after switching', async () => {
    const oldInvite = deferred<PairInviteInfo>()
    const view = render(<RemoteAccessSettings />)
    await screen.findByTestId('qr')
    mocks.mint.mockReturnValueOnce(oldInvite.promise)
    fireEvent.click(screen.getByRole('button', { name: 'New code' }))
    mocks.generation++
    mocks.mint.mockResolvedValue(invite('second'))
    mocks.network.mockResolvedValue(network('10.0.0.20', 9393))
    view.rerender(<RemoteAccessSettings />)
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://10.0.0.20:9393/?pair=second.secret')
    await act(async () => oldInvite.resolve(invite('old-remint')))
    expect(screen.getByTestId('qr')).toHaveAttribute('data-url', 'http://10.0.0.20:9393/?pair=second.secret')
  })

  it('keeps relay QR usable without a network port and clears it when the server changes', async () => {
    mocks.get.mockReturnValue('relay')
    mocks.network.mockResolvedValue({ interfaces: [] })
    mocks.tunnel.mockResolvedValue({ ...disabledTunnel, enabled: true, state: 'connected', publicUrl: 'https://relay.test/backend/' })
    const view = render(<RemoteAccessSettings />)
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'https://relay.test/backend/?pair=first.secret')
    mocks.generation++
    mocks.tunnel.mockResolvedValue(disabledTunnel)
    mocks.mint.mockResolvedValue(invite('second'))
    view.rerender(<RemoteAccessSettings />)
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(await screen.findByText(/No relay configured on this backend/)).toBeInTheDocument()
    expect(screen.queryByText(/fill in Tunnel below/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
  })

  it('does not claim an unreachable relay status means it is unconfigured', async () => {
    mocks.get.mockReturnValue('relay')
    mocks.tunnel.mockRejectedValue(new Error('offline'))
    render(<RemoteAccessSettings />)
    expect(await screen.findByText(/Server status unavailable/)).toBeInTheDocument()
    expect(screen.queryByText(/No relay configured/)).not.toBeInTheDocument()
    expect(screen.getByText('QR code unavailable')).toBeInTheDocument()
  })

  it('directs desktop relay setup to the form on the Authentication page', async () => {
    mocks.desktop = true
    mocks.get.mockReturnValue('relay')
    render(<RemoteAccessSettings />)
    expect(await screen.findByText(/Fill in Tunnel below/)).toBeInTheDocument()
    expect(screen.queryByText(/Configure it on the server or in OMPiUI Admin/)).not.toBeInTheDocument()
  })

  it('uses Chinese text for pairing details, missing ports and unavailable QR codes', async () => {
    await i18n.changeLanguage('zh-CN')
    mocks.network.mockResolvedValue({ interfaces: [] })
    const { container } = render(<RemoteAccessSettings />)
    expect(await screen.findByText('二维码暂不可用')).toBeInTheDocument()
    expect(screen.getByText('暂无可用的网络地址')).toBeInTheDocument()
    expect(screen.getByText('由当前服务器提供，不是本机的监听配置。')).toBeInTheDocument()
    expect(screen.getByText(/服务器未提供监听端口/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '虚拟组网' })).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/Pair another device|Reported by the current|The server did not report|QR code unavailable|No network address/)
    fireEvent.click(screen.getByRole('button', { name: '自建中转' }))
    expect(await screen.findByText(/当前服务器未配置自建中转/)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/No relay configured|Configure it on the server/)
  })

  it.each(['expired', 'redeemed'])('does not offer a QR or copy action for an %s invite', async state => {
    mocks.mint.mockResolvedValue({
      ...invite(),
      expiresAt: state === 'expired' ? Date.now() - 1000 : Date.now() + 600_000,
      redeemed: state === 'redeemed',
    })
    render(<RemoteAccessSettings />)
    expect(await screen.findByText(state === 'redeemed' ? 'Approved — phone connected' : 'QR code unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy full pairing info' })).not.toBeInTheDocument()
  })
})
