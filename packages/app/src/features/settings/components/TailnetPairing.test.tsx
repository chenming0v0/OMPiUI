import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TailnetPairing } from './TailnetPairing'

const mocks = vi.hoisted(() => ({
  discover: vi.fn(), redeem: vi.fn(), connect: vi.fn(), servers: [] as Array<{ url: string }>,
}))
vi.mock('../../../utils/deviceDiscovery', async original => ({
  ...await original<typeof import('../../../utils/deviceDiscovery')>(),
  discoverDevices: mocks.discover, supportsDeviceDiscovery: () => true,
}))
vi.mock('../../../omp/transport', () => ({ redeemDisplayCode: mocks.redeem, redeemPairCode: vi.fn() }))
vi.mock('../../../hooks', () => ({ useServerStore: () => ({ servers: mocks.servers }) }))
vi.mock('./useServerConnect', () => ({ useServerConnect: () => mocks.connect }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const device = { marker: 'ompiui', discoveryVersion: 1, displayName: 'Studio', instanceId: 'b'.repeat(32), port: 8787,
  pairing: true, address: '100.101.2.3', network: 'tailscale' } as const
const url = 'http://100.101.2.3:8787'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.servers = []
  mocks.discover.mockReset().mockResolvedValue([device])
  mocks.redeem.mockReset().mockResolvedValue({ url, token: 'server-token' })
})
afterEach(cleanup)

const pick = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Studio/ }))
  return screen.getByRole('textbox')
}

describe('TailnetPairing', () => {
  it('pairs a tailnet computer in place with its display code', async () => {
    const paired = vi.fn()
    render(<TailnetPairing onPaired={paired} />)
    const code = await pick()
    expect(mocks.discover).toHaveBeenCalledTimes(1)
    expect(mocks.discover).toHaveBeenCalledWith('tailscale', expect.any(AbortSignal))
    expect(mocks.redeem).not.toHaveBeenCalled()
    fireEvent.change(code, { target: { value: '1234 5678' } })
    await act(async () => fireEvent.submit(code.closest('form')!))
    expect(mocks.redeem).toHaveBeenCalledWith('12345678', url, expect.any(AbortSignal))
    expect(mocks.connect).toHaveBeenCalledWith({ url, token: 'server-token' }, 'pair')
    expect(paired).toHaveBeenCalledOnce()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('rejects a malformed code without contacting the computer', async () => {
    render(<TailnetPairing />)
    const code = await pick()
    fireEvent.change(code, { target: { value: '1234' } })
    await act(async () => fireEvent.submit(code.closest('form')!))
    expect(screen.getByRole('alert')).toHaveTextContent('authentication.invalidCode')
    expect(mocks.redeem).not.toHaveBeenCalled()
  })

  it('keeps the code for correction when the computer refuses it', async () => {
    mocks.redeem.mockRejectedValue(new Error('pairing code expired'))
    render(<TailnetPairing />)
    const code = await pick()
    fireEvent.change(code, { target: { value: '12345678' } })
    await act(async () => fireEvent.submit(code.closest('form')!))
    expect(screen.getByRole('alert')).toHaveTextContent('pairing code expired')
    expect(screen.getByRole('textbox')).toHaveValue('12345678')
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('collapses the code field when the same computer is tapped again', async () => {
    render(<TailnetPairing />)
    await pick()
    fireEvent.click(screen.getByRole('button', { name: /Studio/ }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('marks a computer that is already saved instead of pairing it twice', async () => {
    mocks.servers = [{ url }]
    render(<TailnetPairing />)
    expect(await screen.findByText('controller.alreadyConnected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Studio/ })).not.toBeInTheDocument()
  })
})
