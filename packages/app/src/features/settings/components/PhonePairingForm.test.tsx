import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PhonePairingForm } from './PhonePairingForm'

const mocks = vi.hoisted(() => ({
  redeem: vi.fn(), redeemCode: vi.fn(), scan: vi.fn(), addServer: vi.fn(), setActiveServer: vi.fn(),
  checkHealth: vi.fn(), clearSession: vi.fn(), navigateHome: vi.fn(),
}))
vi.mock('../../../omp/transport', () => ({ redeemPairCode: mocks.redeem, redeemDisplayCode: mocks.redeemCode }))
vi.mock('../../../utils/qrScanner', () => ({ scanPairingQr: mocks.scan }))
vi.mock('../../../utils/sessionLifecycle', () => ({ clearSessionRuntimeState: mocks.clearSession }))
vi.mock('../../../hooks', () => ({
  useServerStore: () => mocks,
  useRouter: () => ({ sessionId: 'session-1', navigateHome: mocks.navigateHome }),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.redeem.mockReset().mockResolvedValue({ url: 'http://remote.test', token: 'server-token' })
  mocks.redeemCode.mockReset().mockResolvedValue({ url: 'http://remote.test', token: 'server-token' })
  mocks.scan.mockReset()
  mocks.addServer.mockReturnValue({ id: 'paired-server' })
})

const input = () => screen.getByLabelText('authentication.pairingInfo')
const submit = async () => {
  await act(async () => fireEvent.submit(input().closest('form')!))
}

describe('PhonePairingForm', () => {
  it.each(['50328191', '5032 8191', '5032-8191', '0012 3456'])('redeems a display code with an explicit address: %s', async value => {
    const completed = vi.fn()
    render(<PhonePairingForm onPaired={completed} />)
    fireEvent.change(input(), { target: { value } })
    const address = screen.getByLabelText('authentication.serverAddress')
    expect(address).toHaveValue('')
    fireEvent.change(address, { target: { value: ' http://100.82.171.116:8787/ ' } })
    expect(mocks.redeemCode).not.toHaveBeenCalled()
    await submit()
    expect(mocks.redeemCode).toHaveBeenCalledWith(value.replace(/[\s-]/g, ''), 'http://100.82.171.116:8787', expect.any(AbortSignal))
    expect(mocks.redeem).not.toHaveBeenCalled()
    expect(mocks.addServer).toHaveBeenCalledWith({ name: 'remote.test', url: 'http://remote.test', token: 'server-token' })
    expect(mocks.clearSession).toHaveBeenCalledWith('session-1')
    expect(mocks.setActiveServer).toHaveBeenCalledWith('paired-server')
    expect(mocks.navigateHome).toHaveBeenCalledOnce()
    expect(mocks.checkHealth).toHaveBeenCalledWith('paired-server')
    expect(completed).toHaveBeenCalledOnce()
    expect(input()).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent('authentication.connected')
  })

  it('asks for the computer address without attempting a request to localhost', async () => {
    render(<PhonePairingForm />)
    fireEvent.change(input(), { target: { value: '5032 8191' } })
    await submit()
    expect(screen.getByRole('alert')).toHaveTextContent('authentication.addressRequired')
    expect(input()).toHaveValue('5032 8191')
    expect(mocks.redeemCode).not.toHaveBeenCalled()
    expect(mocks.addServer).not.toHaveBeenCalled()
  })

  it.each(['100.82.171.116:8787', 'file:///tmp', 'http://user:pass@remote.test', 'http://remote.test/?pair=once.secret'])('rejects an invalid code destination: %s', async value => {
    render(<PhonePairingForm />)
    fireEvent.change(input(), { target: { value: '50328191' } })
    fireEvent.change(screen.getByLabelText('authentication.serverAddress'), { target: { value } })
    await submit()
    expect(screen.getByRole('alert')).toHaveTextContent('authentication.invalidAddress')
    expect(mocks.redeemCode).not.toHaveBeenCalled()
  })

  it.each(['5032819', '503281911', '5032a8191'])('does not submit an invalid display code: %s', async value => {
    render(<PhonePairingForm />)
    fireEvent.change(input(), { target: { value } })
    await submit()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(mocks.redeemCode).not.toHaveBeenCalled()
    expect(mocks.redeem).not.toHaveBeenCalled()
  })

  it('shows the address field while typing and does not auto-redeem a pasted code', async () => {
    render(<PhonePairingForm />)
    fireEvent.change(input(), { target: { value: '5032' } })
    expect(screen.getByLabelText('authentication.serverAddress')).toBeInTheDocument()
    fireEvent.change(input(), { target: { value: '' } })
    await act(async () => fireEvent.paste(input(), { clipboardData: { getData: () => '5032 8191' } }))
    expect(input()).toHaveValue('5032 8191')
    expect(mocks.redeemCode).not.toHaveBeenCalled()
    expect(mocks.redeem).not.toHaveBeenCalled()
  })

  it('preserves the code and address on a failed redemption, without retrying', async () => {
    mocks.redeemCode.mockRejectedValue(new Error('pairing code expired'))
    render(<PhonePairingForm />)
    fireEvent.change(input(), { target: { value: '5032 8191' } })
    const address = screen.getByLabelText('authentication.serverAddress')
    fireEvent.change(address, { target: { value: 'https://relay.test/backend/' } })
    await submit()
    expect(screen.getByRole('alert')).toHaveTextContent('pairing code expired')
    expect(mocks.redeemCode).toHaveBeenCalledOnce()
    expect(mocks.redeemCode).toHaveBeenCalledWith('50328191', 'https://relay.test/backend', expect.any(AbortSignal))
    expect(input()).toHaveValue('5032 8191')
    expect(address).toHaveValue('https://relay.test/backend/')
    expect(address).toBeEnabled()
    expect(mocks.addServer).not.toHaveBeenCalled()
  })

  it('locks both fields and prevents duplicate display-code redemption', async () => {
    let complete!: (value: { url: string; token: string }) => void
    mocks.redeemCode.mockReturnValue(new Promise(resolve => { complete = resolve }))
    render(<PhonePairingForm />)
    fireEvent.change(input(), { target: { value: '50328191' } })
    const address = screen.getByLabelText('authentication.serverAddress')
    fireEvent.change(address, { target: { value: 'http://remote.test' } })
    fireEvent.submit(input().closest('form')!)
    fireEvent.submit(input().closest('form')!)
    expect(input()).toBeDisabled()
    expect(address).toBeDisabled()
    expect(mocks.redeemCode).toHaveBeenCalledOnce()
    await act(async () => complete({ url: 'http://remote.test', token: 'server-token' }))
    expect(mocks.addServer).toHaveBeenCalledOnce()
  })

  it('still connects automatically when pasting a full link', async () => {
    render(<PhonePairingForm />)
    await act(async () => fireEvent.paste(input(), { clipboardData: { getData: () => 'http://remote.test/?pair=once.secret' } }))
    expect(mocks.redeem).toHaveBeenCalledWith('once.secret', 'http://remote.test', expect.any(AbortSignal))
    expect(mocks.redeemCode).not.toHaveBeenCalled()
    expect(mocks.addServer).toHaveBeenCalledOnce()
  })

  it('parses desktop status text and connects directly without a second form', async () => {
    render(<PhonePairingForm />)
    fireEvent.change(input(), { target: { value: '等待手机连接 · http://remote.test/?pair=once.secret' } })
    expect(screen.getByText('http://remote.test')).toBeInTheDocument()
    await submit()
    expect(mocks.redeem).toHaveBeenCalledWith('once.secret', 'http://remote.test', expect.any(AbortSignal))
    expect(mocks.addServer).toHaveBeenCalledWith({ name: 'remote.test', url: 'http://remote.test', token: 'server-token' })
    expect(mocks.clearSession).toHaveBeenCalledWith('session-1')
    expect(mocks.setActiveServer).toHaveBeenCalledWith('paired-server')
    expect(mocks.navigateHome).toHaveBeenCalledOnce()
    expect(mocks.checkHealth).toHaveBeenCalledWith('paired-server')
    expect(input()).toHaveValue('')
    expect(screen.getByRole('status')).toHaveTextContent('authentication.connected')
  })

  it('scans and redeems through the same connection flow', async () => {
    mocks.scan.mockResolvedValue('http://remote.test/?pair=scanned.secret')
    render(<PhonePairingForm />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authentication.scan' })))
    expect(mocks.scan).toHaveBeenCalledWith('authentication.scanPrompt')
    expect(mocks.redeem).toHaveBeenCalledWith('scanned.secret', 'http://remote.test', expect.any(AbortSignal))
    expect(mocks.setActiveServer).toHaveBeenCalledWith('paired-server')
  })

  it('keeps manual input when scanning is cancelled', async () => {
    mocks.scan.mockResolvedValue(null)
    render(<PhonePairingForm />)
    fireEvent.change(input(), { target: { value: 'http://remote.test/?pair=once.secret' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authentication.scan' })))
    expect(input()).toHaveValue('http://remote.test/?pair=once.secret')
    expect(mocks.redeem).not.toHaveBeenCalled()
    expect(mocks.addServer).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps paste available when camera permission is denied', async () => {
    mocks.scan.mockRejectedValue(new Error('scanPermissionDenied'))
    render(<PhonePairingForm />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authentication.scan' })))
    expect(screen.getByRole('alert')).toHaveTextContent('authentication.scanPermissionDenied')
    expect(input()).toBeEnabled()
    expect(mocks.addServer).not.toHaveBeenCalled()
  })

  it('rejects an unrelated QR code without opening it or adding a server', async () => {
    mocks.scan.mockResolvedValue('https://unrelated.test')
    render(<PhonePairingForm />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authentication.scan' })))
    expect(screen.getByRole('alert')).toHaveTextContent('authentication.invalidLink')
    expect(mocks.redeem).not.toHaveBeenCalled()
    expect(mocks.addServer).not.toHaveBeenCalled()
  })

  it('retains expired input for correction and does not save unauthenticated connections', async () => {
    mocks.redeem.mockRejectedValue(new Error('pairing code expired'))
    render(<PhonePairingForm />)
    fireEvent.change(input(), { target: { value: 'http://remote.test/?pair=expired.secret' } })
    await submit()
    expect(screen.getByRole('alert')).toHaveTextContent('pairing code expired')
    expect(input()).toHaveValue('http://remote.test/?pair=expired.secret')
    expect(input()).toBeEnabled()
    expect(mocks.addServer).not.toHaveBeenCalled()
  })

  it('prevents duplicate submissions while a one-time code is being redeemed', async () => {
    let complete!: (value: { url: string; token: string }) => void
    mocks.redeem.mockReturnValue(new Promise(resolve => { complete = resolve }))
    render(<PhonePairingForm />)
    fireEvent.change(input(), { target: { value: 'http://remote.test/?pair=once.secret' } })
    fireEvent.submit(input().closest('form')!)
    fireEvent.submit(input().closest('form')!)
    expect(input()).toBeDisabled()
    expect(mocks.redeem).toHaveBeenCalledOnce()
    await act(async () => complete({ url: 'http://remote.test', token: 'server-token' }))
    expect(mocks.addServer).toHaveBeenCalledOnce()
  })

  it('imports existing connection share links without redeeming a one-time code', async () => {
    render(<PhonePairingForm />)
    fireEvent.change(input(), {
      target: { value: 'ompiui://connect?url=http%3A%2F%2Fremote.test&token=share-token' },
    })
    await submit()
    expect(mocks.redeem).not.toHaveBeenCalled()
    expect(mocks.addServer).toHaveBeenCalledWith({ name: 'remote.test', url: 'http://remote.test', token: 'share-token' })
    expect(mocks.setActiveServer).toHaveBeenCalledWith('paired-server')
  })
})
