import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { DshHostPairingCard, DshHostPairingStart } from './DshHostPairingCard'
import type { DshHost, DshHostPairing } from './useDshHost'

vi.mock('../../../components/QrCode', () => ({ QrCode: ({ text }: { text: string }) => <div data-testid="qr" data-text={text} /> }))

const manage = vi.fn(async () => true)
const host = { busy: false, manage } as unknown as DshHost
const pairing = (patch: Partial<DshHostPairing>): DshHostPairing => ({
  state: 'created', expiresAt: Date.now() + 120_000, fingerprint: 'aaaa bbbb', retry: false, ...patch,
})

beforeEach(async () => {
  await i18n.changeLanguage('en')
  manage.mockClear()
})

describe('DS remote host pairing', () => {
  it('starts by showing a QR code on request', () => {
    render(<DshHostPairingStart host={host} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show QR code' }))
    expect(manage).toHaveBeenCalledWith('pair')
  })

  it('shows the code to scan together with this computer’s fingerprint', () => {
    render(<DshHostPairingCard host={host} pairing={pairing({ qr: 'https://dsh.r2049.cn/pair#v1.ticket' })} />)
    expect(screen.getByTestId('qr')).toHaveAttribute('data-text', 'https://dsh.r2049.cn/pair#v1.ticket')
    expect(screen.getByTestId('dsh-pair-fingerprint')).toHaveTextContent('aaaa bbbb')
    expect(screen.getByText(/Expires in \d:\d\d/)).toBeInTheDocument()
    // 二维码只有三分钟，旁边就能换一个。
    fireEvent.click(screen.getByRole('button', { name: 'New code' }))
    expect(manage).toHaveBeenCalledWith('pair')
  })

  it('lets a claimed pairing be cancelled before any code is typed', () => {
    render(<DshHostPairingCard host={host} pairing={pairing({ state: 'claimed', phone: { name: 'Pixel', fingerprint: 'cccc' } })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(manage).toHaveBeenCalledWith('pair-cancel')
  })

  it('takes the phone’s 8 digits here and submits them once', () => {
    render(<DshHostPairingCard host={host} pairing={pairing({ state: 'claimed', phone: { name: 'Pixel', fingerprint: 'cccc' } })} />)
    expect(screen.getByText(/Pixel scanned this code/)).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Confirm pairing' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '0012 34x56' } })
    expect(screen.getByLabelText('Verification code')).toHaveValue('00123456')
    fireEvent.click(confirm)
    expect(manage).toHaveBeenCalledWith('pair-confirm', '00123456')
  })

  it('only offers to resend an unanswered submission unchanged', () => {
    render(<DshHostPairingCard host={host} pairing={pairing({ state: 'claimed', retry: true })} />)
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }))
    expect(manage).toHaveBeenCalledWith('pair-confirm')
  })

  it('ends on a wrong code and offers a new QR code', () => {
    render(<DshHostPairingCard host={host} pairing={pairing({ state: 'failed', failure: 'verification_failed' })} />)
    expect(screen.getByText(/That code was wrong/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New code' }))
    expect(manage).toHaveBeenCalledWith('pair')
  })

  it('confirms a finished pairing by the phone’s name', () => {
    render(<DshHostPairingCard host={host} pairing={pairing({ state: 'completed', phone: { name: 'Pixel', fingerprint: 'cccc' } })} />)
    expect(screen.getByText('Paired with Pixel')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pair another' }))
    expect(manage).toHaveBeenCalledWith('pair')
  })
})
