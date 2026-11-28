import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostNetworkInfo, PairInviteInfo, TunnelStatus } from '@ompiui/protocol'
import { serviceStore } from '../../../store/serviceStore'
import { RemoteAccessSettings } from './RemoteAccessSettings'
import i18n from '../../../i18n'

const mocks = vi.hoisted(() => ({
  generation: 1,
  desktop: false,
  activeServer: undefined as { id: string; name: string; url: string; isDefault?: boolean } | undefined,
  network: vi.fn(),
  mint: vi.fn(),
  poll: vi.fn(),
  tunnel: vi.fn(),
  tailscale: vi.fn(),
  openLogin: vi.fn(),
  login: vi.fn(), disconnect: vi.fn(),
  get: vi.fn(),
}))
vi.mock('../../../hooks', () => ({
  useServerStore: () => ({ activeServerGeneration: mocks.generation, activeServer: mocks.activeServer }),
}))
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
// DS 远程的本机状态来自桌面壳，这里只关心它在通道条上占一格。
vi.mock('./useDshHost', () => ({
  useDshHost: () => ({ status: undefined, unreachable: false, unreadable: false, state: 'unregistered', tone: 'off', busy: false, failure: null, manage: vi.fn() }),
}))
vi.mock('./DshHostPanel', () => ({ DshHostPanel: () => <div>DS host panel</div> }))
// 中转表单读写本机服务的启动环境，这里只关心它什么时候出现。
vi.mock('./RelaySettings', () => ({
  RelaySettings: ({ onCancel }: { onCancel?: () => void }) => (
    <div>Relay form{onCancel && <button type="button" onClick={onCancel}>Keep current relay</button>}</div>
  ),
}))
// Observe the exact payload given to the QR encoder, not its SVG internals.
vi.mock('../../../components/QrCode', () => ({ QrCode: ({ text }: { text: string }) => <div data-testid="qr" data-url={text} /> }))

type Network = HostNetworkInfo
const network = (address = '192.168.50.10', port = 9191): Network => ({
  interfaces: [{ name: 'Ethernet', address, tailscale: false }], port, host: '0.0.0.0',
})
const invite = (id = 'first'): PairInviteInfo => ({ id, pair: `${id}.secret`, code: '12345678', expiresAt: Date.now() + 600_000, redeemed: false })
const disabledTunnel: TunnelStatus = { enabled: false, state: 'disabled', publicUrl: null, relayUrl: null, tunnelId: null, lastError: null, reconnectAttempts: 0 }
const channel = (name: string) => screen.getByRole('button', { name })

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
  mocks.activeServer = undefined
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

it('lists each way in as a channel and shows the pairing ticket for the selected one', async () => {
  render(<RemoteAccessSettings />)
  expect(channel('LAN')).toHaveAttribute('aria-pressed', 'true')
  expect(channel('Tailscale')).toHaveAttribute('aria-pressed', 'false')
  expect(channel('Self-hosted relay')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'DS remote' })).not.toBeInTheDocument()
  expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://192.168.50.10:9191/?pair=first.secret')
  expect(screen.getByTestId('pair-code')).toHaveTextContent('12345678')
  expect(screen.getByTestId('pair-address')).toHaveTextContent('http://192.168.50.10:9191')
  // 通道名下面那一行是实时状态：局域网显示对方要连的地址，中转显示还没配置。
  expect(channel('LAN')).toHaveAttribute('aria-description', '192.168.50.10')
  expect(channel('Self-hosted relay')).toHaveAttribute('aria-description', 'Not set up')
})

it('offers DS remote as a channel on desktop only', async () => {
  mocks.desktop = true
  render(<RemoteAccessSettings />)
  expect(channel('DS remote')).toHaveAttribute('aria-description', 'Not bound')
  fireEvent.click(channel('DS remote'))
  expect(screen.getByText('DS host panel')).toBeInTheDocument()
  expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
})

describe('remote Tailscale sign-in', () => {
  beforeEach(() => {
    mocks.get.mockReturnValue('tailscale')
    mocks.tailscale.mockReset().mockResolvedValue(signInStatus)
    mocks.login.mockReset().mockResolvedValue({ ok: true, authUrl })
    mocks.disconnect.mockReset().mockResolvedValue(undefined)
  })

  it('asks for server sign-in before any pairing code and never shows an authorization QR', async () => {
    mocks.tailscale.mockResolvedValue({ ...signInStatus, authUrl })
    render(<RemoteAccessSettings />)
    expect(await screen.findByRole('link', { name: 'Open official authorization' })).toHaveAttribute('href', authUrl)
    expect(screen.getByRole('heading', { name: 'Awaiting sign-in' })).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pair-ticket')).not.toBeInTheDocument()
    expect(screen.queryByText(/expires in/)).not.toBeInTheDocument()
  })

  it('shows only a pairing QR once the server connects', async () => {
    mocks.tailscale.mockResolvedValue({ ...signInStatus, backendState: 'Running', ips: ['100.101.2.3'], url: 'http://100.101.2.3:9292' })
    render(<RemoteAccessSettings />)
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://100.101.2.3:9292/?pair=first.secret')
    expect(screen.getAllByTestId('qr')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Copy full pairing info' })).toBeEnabled()
    expect(screen.getByTestId('pair-address')).toHaveTextContent('http://100.101.2.3:9292')
    expect(screen.getByTestId('pair-code')).toHaveTextContent('12345678')
    expect(screen.queryByRole('button', { name: 'Log in to Tailscale' })).not.toBeInTheDocument()
    expect(channel('Tailscale')).toHaveAttribute('aria-description', '100.101.2.3')
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
    expect(screen.getByText('The pairing code expired')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New code' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(mocks.poll).toHaveBeenCalledTimes(1)
  })
})

describe('RemoteAccessSettings authoritative addresses', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.50.99'])('blocks a LAN QR when the listener does not serve the selected adapter: %s', async host => {
    mocks.network.mockResolvedValue({ ...network(), host })
    render(<RemoteAccessSettings />)
    expect(await screen.findByText(`Listening on ${host}`)).toBeInTheDocument()
    const localOnly = host !== '192.168.50.99'
    expect(screen.getByRole('heading', { name: localOnly ? 'Only local connections are accepted right now' : 'QR code unavailable' })).toBeInTheDocument()
    expect(channel('LAN')).toHaveAttribute('aria-description', localOnly ? 'This computer only' : 'Unavailable')
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
    await screen.findByText('Listening on 127.0.0.1')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://192.168.50.10:9191/?pair=first.secret')
    expect(screen.queryByText('Listening on 127.0.0.1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy full pairing info' })).toBeEnabled()
  })

  it('jumps to the Service page from the desktop when only local connections are accepted', async () => {
    mocks.desktop = true
    mocks.network.mockResolvedValue({ ...network(), host: '127.0.0.1' })
    const openService = vi.fn()
    render(<RemoteAccessSettings onOpenService={openService} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change on the Service page' }))
    expect(openService).toHaveBeenCalledOnce()
  })

  it('offers no Service page shortcut in the browser, where the listener is changed on the backend', async () => {
    mocks.network.mockResolvedValue({ ...network(), host: '127.0.0.1' })
    render(<RemoteAccessSettings onOpenService={vi.fn()} />)
    await screen.findByText('Listening on 127.0.0.1')
    expect(screen.queryByRole('button', { name: 'Change on the Service page' })).not.toBeInTheDocument()
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
    expect(screen.getByText('现在只接受本机连接')).toBeInTheDocument()
    expect(screen.getByText('监听地址是 127.0.0.1')).toBeInTheDocument()
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
    // 地址已经在通道栏和票据上，下面那一行只留断开。
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled()
    expect(screen.queryByText('Tailscale connected · 100.101.2.3')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install Tailscale' })).not.toBeInTheDocument()
  })

  it.each([null, 'https://login.tailscale.com/a/test'])('does not render a login or pairing QR while awaiting authorization: %s', async authUrl => {
    mocks.get.mockReturnValue('tailscale')
    mocks.tailscale.mockResolvedValue({
      mode: 'embedded', installed: true, enabled: true, backendState: 'NeedsLogin',
      ips: [], url: null, authUrl, lastError: null,
    })
    render(<RemoteAccessSettings />)
    // 还没开始登录时只有一句状态和一个按钮；拿到授权链接后才多出进度说明。
    expect(await screen.findByRole('heading', { name: authUrl ? 'Awaiting sign-in' : 'Signed out' })).toBeInTheDocument()
    if (authUrl) expect(screen.getByText('Authorization link ready. Open it to complete sign-in.')).toBeInTheDocument()
    else expect(screen.queryByText('Sign-in authorization required')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pair-ticket')).not.toBeInTheDocument()
    expect(screen.queryByText(/expires in/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy full pairing info' })).not.toBeInTheDocument()
    if (authUrl) {
      // 浏览器授权保留直接链接，不与配对二维码混用。
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
      // 登录时只提供浏览器授权入口；二维码只在连上之后用于配对。
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
      expect(screen.queryByRole('heading', { name: 'Awaiting sign-in' })).not.toBeInTheDocument()
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
    expect(screen.getByTestId('pair-address')).toHaveTextContent('http://192.168.50.10:9191')
    expect(screen.queryByText(/7777/)).not.toBeInTheDocument()
  })

  it.each([undefined, 0, -1, 65536, 1.5, NaN])('never invents a QR port for a missing/invalid server port: %s', async port => {
    mocks.network.mockResolvedValue({ interfaces: network().interfaces, port })
    render(<RemoteAccessSettings />)
    expect(await screen.findByText(/The server did not report a listening port/)).toBeInTheDocument()
    expect(screen.getByText('QR code unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy full pairing info' })).not.toBeInTheDocument()
    expect(screen.queryByText(/8787|7777/)).not.toBeInTheDocument()
  })

  it('shows an explicit unavailable state for older servers without either endpoint', async () => {
    mocks.network.mockRejectedValue(new Error('404'))
    mocks.mint.mockRejectedValue(new Error('404'))
    render(<RemoteAccessSettings />)
    expect(await screen.findByText('QR code unavailable')).toBeInTheDocument()
    expect(screen.getByText(/The server did not report a listening port/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Network adapter' })).toBeDisabled()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
  })

  it('lets the user ask for a new code when the reachable server could not mint one', async () => {
    mocks.mint.mockRejectedValueOnce(new Error('503'))
    render(<RemoteAccessSettings />)
    expect(await screen.findByText('QR code unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New code' }))
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://192.168.50.10:9191/?pair=first.secret')
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
    expect(channel('Self-hosted relay')).toHaveAttribute('aria-description', 'Connected')
    mocks.generation++
    mocks.tunnel.mockResolvedValue(disabledTunnel)
    mocks.mint.mockResolvedValue(invite('second'))
    view.rerender(<RemoteAccessSettings />)
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'No self-hosted relay yet' })).toBeInTheDocument()
    expect(screen.getByText('Configure the relay on the computer running the backend.')).toBeInTheDocument()
    expect(screen.queryByText('Relay form')).not.toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
  })

  it('does not claim an unreachable relay status means it is unconfigured', async () => {
    mocks.get.mockReturnValue('relay')
    mocks.tunnel.mockRejectedValue(new Error('offline'))
    render(<RemoteAccessSettings />)
    expect(await screen.findByText(/Server status unavailable/)).toBeInTheDocument()
    expect(screen.queryByText(/No self-hosted relay yet/)).not.toBeInTheDocument()
    expect(channel('Self-hosted relay')).toHaveAttribute('aria-description', 'Unavailable')
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
  })

  it('says the relay is offline instead of showing a code nobody can use', async () => {
    mocks.get.mockReturnValue('relay')
    mocks.tunnel.mockResolvedValue({ ...disabledTunnel, enabled: true, state: 'connecting' })
    render(<RemoteAccessSettings />)
    expect(await screen.findByRole('heading', { name: 'The relay is not connected' })).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
  })

  it('puts the relay form in this channel on the desktop that runs the backend', async () => {
    mocks.desktop = true
    mocks.activeServer = { id: 'local', name: 'Local', url: 'http://127.0.0.1:8787', isDefault: true }
    mocks.get.mockReturnValue('relay')
    const openService = vi.fn()
    render(<RemoteAccessSettings onOpenService={openService} />)
    expect(await screen.findByText('Relay form')).toBeInTheDocument()
    // 还没配置过，没有可以退回去的旧配置。
    expect(screen.queryByRole('button', { name: 'Keep current relay' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change on the Service page' })).not.toBeInTheDocument()
  })

  it('keeps the relay form away while a remote server is being configured', async () => {
    mocks.desktop = true
    mocks.activeServer = { id: 'remote', name: 'Office', url: 'http://office.test:8787' }
    mocks.get.mockReturnValue('relay')
    render(<RemoteAccessSettings />)
    expect(await screen.findByRole('heading', { name: 'No self-hosted relay yet' })).toBeInTheDocument()
    expect(screen.queryByText('Relay form')).not.toBeInTheDocument()
  })

  it('lets a connected relay be changed in place and backed out of', async () => {
    mocks.desktop = true
    mocks.activeServer = { id: 'local', name: 'Local', url: 'http://127.0.0.1:8787', isDefault: true }
    mocks.get.mockReturnValue('relay')
    mocks.tunnel.mockResolvedValue({ ...disabledTunnel, enabled: true, state: 'connected', publicUrl: 'https://relay.test/backend', relayUrl: 'wss://relay.test' })
    render(<RemoteAccessSettings />)
    await screen.findByTestId('qr')
    expect(screen.getByText('wss://relay.test')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByText('Relay form')).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep current relay' }))
    expect(screen.getByTestId('qr')).toBeInTheDocument()
  })

  it('names the server being configured only when it is not this computer', async () => {
    mocks.activeServer = { id: 'local', name: 'Local', url: 'http://127.0.0.1:8787', isDefault: true }
    const view = render(<RemoteAccessSettings />)
    await screen.findByTestId('qr')
    expect(screen.queryByText('Configuring remote server')).not.toBeInTheDocument()
    mocks.activeServer = { id: 'remote', name: 'Office', url: 'http://office.test:8787' }
    view.rerender(<RemoteAccessSettings />)
    expect(screen.getByText('Configuring remote server')).toBeInTheDocument()
    expect(screen.getByText('Office')).toBeInTheDocument()
  })

  it('uses Chinese text for pairing details, missing ports and unavailable QR codes', async () => {
    await i18n.changeLanguage('zh-CN')
    mocks.network.mockResolvedValue({ interfaces: [] })
    const { container } = render(<RemoteAccessSettings />)
    expect(await screen.findByText('二维码暂不可用')).toBeInTheDocument()
    expect(screen.getByText('暂无可用的网络地址')).toBeInTheDocument()
    expect(screen.getByText('服务器没有报告监听端口。')).toBeInTheDocument()
    expect(channel('虚拟组网')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/Let other devices|Reported by the current|The server did not report|QR code unavailable|No network address/)
    fireEvent.click(channel('自建中转'))
    expect(await screen.findByText('还没有配置自建中转')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/No self-hosted relay|Configure the relay/)
  })

  it.each(['expired', 'redeemed'])('does not offer a QR or copy action for an %s invite', async state => {
    mocks.mint.mockResolvedValue({
      ...invite(),
      expiresAt: state === 'expired' ? Date.now() - 1000 : Date.now() + 600_000,
      redeemed: state === 'redeemed',
    })
    render(<RemoteAccessSettings />)
    expect(await screen.findByText(state === 'redeemed' ? 'Paired — the other device is connected' : 'The pairing code expired')).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy full pairing info' })).not.toBeInTheDocument()
  })
})
