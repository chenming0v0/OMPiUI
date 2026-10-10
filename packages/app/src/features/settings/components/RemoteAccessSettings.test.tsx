import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanInterfaceInfo, PairInviteInfo, TunnelStatus } from '@ompiui/protocol'
import { serviceStore } from '../../../store/serviceStore'
import { RemoteAccessSettings } from './RemoteAccessSettings'

const mocks = vi.hoisted(() => ({
  generation: 1,
  network: vi.fn(),
  mint: vi.fn(),
  poll: vi.fn(),
  tunnel: vi.fn(),
  tailscale: vi.fn(),
  openLogin: vi.fn(),
  get: vi.fn(),
}))
vi.mock('../../../hooks', () => ({ useServerStore: () => ({ activeServerGeneration: mocks.generation }) }))
vi.mock('../../../utils', () => ({ serverStorage: { get: mocks.get, set: vi.fn() } }))
vi.mock('../../../utils/tailscaleLogin', () => ({ openTailscaleLogin: mocks.openLogin }))
vi.mock('../../../omp/transport/index.js', () => ({
  fetchHostNetwork: mocks.network,
  mintPairInvite: mocks.mint,
  fetchPairInvite: mocks.poll,
  fetchHostTunnel: mocks.tunnel,
  fetchTailscale: mocks.tailscale,
  startTailscaleInstall: vi.fn(),
  startTailscaleLogin: vi.fn(),
  disconnectTailscale: vi.fn(),
}))
// Observe the exact payload given to the QR encoder, not its SVG internals.
vi.mock('../../../components/QrCode', () => ({ QrCode: ({ text }: { text: string }) => <div data-testid="qr" data-url={text} /> }))

type Network = { interfaces: LanInterfaceInfo[]; port?: number }
const network = (address = '192.168.50.10', port = 9191): Network => ({
  interfaces: [{ name: 'Ethernet', address, tailscale: false }], port,
})
const invite = (id = 'first'): PairInviteInfo => ({ id, pair: `${id}.secret`, code: '12345678', expiresAt: Date.now() + 600_000, redeemed: false })
const disabledTunnel: TunnelStatus = { enabled: false, state: 'disabled', publicUrl: null, relayUrl: null, tunnelId: null, lastError: null, reconnectAttempts: 0 }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.generation = 1
  mocks.get.mockReturnValue(null)
  mocks.network.mockReset().mockResolvedValue(network())
  mocks.mint.mockReset().mockResolvedValue(invite())
  mocks.poll.mockResolvedValue(invite())
  mocks.tunnel.mockReset().mockResolvedValue(disabledTunnel)
  mocks.tailscale.mockRejectedValue(new Error('unsupported'))
  mocks.openLogin.mockResolvedValue(undefined)
  serviceStore.setEnvVars([{ key: 'OMPIUI_PORT', value: '7777' }])
})

afterEach(() => { cleanup() })

describe('RemoteAccessSettings authoritative addresses', () => {
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
    expect(await screen.findByText('Connecting / awaiting sign-in')).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.getAllByText('Complete Tailscale sign-in first')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Copy full pairing info' })).toBeDisabled()
    if (authUrl) {
      fireEvent.click(screen.getByRole('button', { name: 'Open official authorization' }))
      await waitFor(() => expect(mocks.openLogin).toHaveBeenCalledWith(authUrl))
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
      expect(screen.getByText('Connecting / awaiting sign-in')).toBeInTheDocument()
      expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
      mocks.tailscale.mockResolvedValue({
        mode: 'embedded', installed: true, enabled: true, backendState: 'Running',
        ips: ['100.101.2.3'], url: 'http://100.101.2.3:9292', authUrl: null, lastError: null,
      })
      fireEvent.click(screen.getByRole('button', { name: 'Open official authorization' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(screen.getAllByTestId('qr')).toHaveLength(1)
      expect(screen.getByTestId('qr')).toHaveAttribute('data-url', 'http://100.101.2.3:9292/?pair=first.secret')
      expect(screen.queryByText('Complete Tailscale sign-in first')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Open official authorization' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Copy full pairing info' })).toBeEnabled()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it('uses the backend non-default port even when local desktop settings differ', async () => {
    render(<RemoteAccessSettings />)
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-url', 'http://192.168.50.10:9191/?pair=first.secret')
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
    expect(screen.getByRole('button', { name: 'Copy full pairing info' })).toBeDisabled()
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

  it.each(['expired', 'redeemed'])('does not offer a QR or copy action for an %s invite', async state => {
    mocks.mint.mockResolvedValue({
      ...invite(),
      expiresAt: state === 'expired' ? Date.now() - 1000 : Date.now() + 600_000,
      redeemed: state === 'redeemed',
    })
    render(<RemoteAccessSettings />)
    expect(await screen.findByText('QR code unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy full pairing info' })).toBeDisabled()
  })
})
