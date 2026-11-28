import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiscoveredRows } from './DiscoveredComputers'
import type { DeviceDiscovery } from './useDeviceDiscovery'

const mocks = vi.hoisted(() => ({
  redeem: vi.fn(), connect: vi.fn(), select: vi.fn(),
  servers: [] as Array<{ id: string; url: string }>, active: null as { id: string } | null,
}))
vi.mock('../../../omp/transport', () => ({ redeemDisplayCode: mocks.redeem, redeemPairCode: vi.fn() }))
vi.mock('../../../hooks', () => ({ useServerStore: () => ({ servers: mocks.servers, activeServer: mocks.active }) }))
vi.mock('./useServerConnect', () => ({ useServerConnect: () => mocks.connect, useServerSelect: () => mocks.select }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const device = { marker: 'ompiui', discoveryVersion: 1, displayName: 'Studio', instanceId: 'b'.repeat(32), port: 8787,
  pairing: true, address: '100.101.2.3', network: 'tailscale' } as const
const url = 'http://100.101.2.3:8787'
const found = (patch: Partial<DeviceDiscovery> = {}): DeviceDiscovery =>
  ({ devices: [device], loading: false, error: '', refresh: vi.fn(), ...patch })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.servers = []
  mocks.active = null
  mocks.redeem.mockReset().mockResolvedValue({ url, token: 'server-token' })
})
afterEach(cleanup)

const pick = () => {
  fireEvent.click(screen.getByRole('button', { name: /Studio/ }))
  return screen.getByRole('textbox')
}

describe('DiscoveredRows', () => {
  it('shows a found computer as one row with its address and nothing else to press', () => {
    render(<DiscoveredRows network="tailscale" discovery={found()} />)
    const row = screen.getByTestId('discovered-row')
    expect(row).toHaveTextContent('Studio')
    expect(row).toHaveTextContent(url)
    expect(row.querySelectorAll('button')).toHaveLength(1)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('pairs a computer in place with its display code', async () => {
    const paired = vi.fn()
    render(<DiscoveredRows network="tailscale" discovery={found()} onPaired={paired} />)
    const code = pick()
    expect(mocks.redeem).not.toHaveBeenCalled()
    fireEvent.change(code, { target: { value: '1234 5678' } })
    await act(async () => fireEvent.submit(code.closest('form')!))
    expect(mocks.redeem).toHaveBeenCalledWith('12345678', url, expect.any(AbortSignal))
    expect(mocks.connect).toHaveBeenCalledWith({ url, token: 'server-token' }, 'pair')
    expect(paired).toHaveBeenCalledOnce()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('rejects a malformed code without contacting the computer', async () => {
    render(<DiscoveredRows network="tailscale" discovery={found()} />)
    const code = pick()
    fireEvent.change(code, { target: { value: '1234' } })
    await act(async () => fireEvent.submit(code.closest('form')!))
    expect(screen.getByRole('alert')).toHaveTextContent('authentication.invalidCode')
    expect(mocks.redeem).not.toHaveBeenCalled()
  })

  it('keeps the code for correction when the computer refuses it', async () => {
    mocks.redeem.mockRejectedValue(new Error('pairing code expired'))
    render(<DiscoveredRows network="tailscale" discovery={found()} />)
    const code = pick()
    fireEvent.change(code, { target: { value: '12345678' } })
    await act(async () => fireEvent.submit(code.closest('form')!))
    expect(screen.getByRole('alert')).toHaveTextContent('pairing code expired')
    expect(screen.getByRole('textbox')).toHaveValue('12345678')
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('collapses the code field when the same computer is tapped again', () => {
    render(<DiscoveredRows network="tailscale" discovery={found()} />)
    pick()
    fireEvent.click(screen.getByRole('button', { name: /Studio/ }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('switches to a computer that is already saved instead of pairing it twice', () => {
    mocks.servers = [{ id: 'studio', url: `${url}/` }]
    render(<DiscoveredRows network="tailscale" discovery={found()} />)
    expect(screen.getByTestId('discovered-row')).not.toHaveAttribute('data-current')
    fireEvent.click(screen.getByRole('button', { name: /Studio/ }))
    expect(mocks.select).toHaveBeenCalledWith('studio')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('outlines the row of the server in use', () => {
    mocks.servers = [{ id: 'studio', url }]
    mocks.active = { id: 'studio' }
    render(<DiscoveredRows network="tailscale" discovery={found()} />)
    expect(screen.getByTestId('discovered-row')).toHaveAttribute('data-current')
    expect(screen.getByRole('button', { name: /Studio/ })).toHaveAttribute('aria-current', 'true')
  })

  it.each([
    ['discoveryPermissionDenied', 'authentication.discoveryPermissionDenied'],
    ['discoveryTailscaleLogin', 'authentication.discoveryTailscaleLogin'],
    ['discoverySomethingNew', 'authentication.discoveryFailed'],
    ['socket closed', 'socket closed'],
  ])('explains a failed scan: %s', (error, text) => {
    render(<DiscoveredRows network="lan" discovery={found({ devices: [], error })} />)
    expect(screen.getByRole('status')).toHaveTextContent(text)
    expect(screen.queryByText('authentication.discoveryEmpty.lan')).not.toBeInTheDocument()
  })

  it('says what to check when nothing was found, but not while still looking', () => {
    const view = render(<DiscoveredRows network="lan" discovery={found({ devices: [], loading: true })} />)
    expect(screen.queryByText('authentication.discoveryEmpty.lan')).not.toBeInTheDocument()
    view.rerender(<DiscoveredRows network="lan" discovery={found({ devices: [] })} />)
    expect(screen.getByText('authentication.discoveryEmpty.lan')).toBeInTheDocument()
  })
})
