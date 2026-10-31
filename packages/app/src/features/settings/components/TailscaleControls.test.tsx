import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TailscaleControls } from './TailscaleControls'

vi.mock('../../../components/QrCode', () => ({ QrCode: ({ text }: { text: string }) => <div data-testid="qr" data-url={text} /> }))
const url = 'https://headscale.example.com/a/device'
const props = { state: 'NeedsLogin', authUrl: url, ips: [], enabled: true, available: true, busy: false, onLogin: vi.fn(), onDisconnect: vi.fn(), onOpenAuthUrl: vi.fn() }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('Tailscale authorization controls', () => {
  it('keeps all native browser buttons disabled until opening completes', () => {
    render(<TailscaleControls {...props} authPhase="opening" />)
    expect(screen.getByText('Opening the authorization page…')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Log in to Tailscale' })).toBeDisabled()
    expect(screen.getByRole('button', { name: url })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled()
    expect(screen.queryByText(/Browser opened/)).not.toBeInTheDocument()
  })

  it('uses real user-activated links on the web', () => {
    render(<TailscaleControls {...props} authLinkMode authPhase="authReady" />)
    const link = screen.getByRole('link', { name: 'Open official authorization' })
    expect(link).toHaveAttribute('href', url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('link', { name: url })).toHaveAttribute('href', url)
    expect(screen.getByText('Authorization link ready. Open it to complete sign-in.')).toBeVisible()
    expect(screen.getByText('Sign-in authorization QR — not a server pairing code')).toBeVisible()
  })

  it.each(['Running', 'NeedsMachineAuth'])('hides sign-in links and QR after %s', state => {
    render(<TailscaleControls {...props} state={state} />)
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.queryByText(url)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Log in|authorization/ })).not.toBeInTheDocument()
  })

  it('keeps the QR hidden and puts the backup link behind an explicit disclosure in server sign-in', () => {
    render(<TailscaleControls {...props} authLinkMode authPhase="authReady" showAuthQr={false} />)
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open official authorization' })).toBeVisible()
    expect(screen.getByRole('link', { name: url })).not.toBeVisible()
    fireEvent.click(screen.getByText("Browser didn't open? Use the sign-in link"))
    expect(screen.getByRole('link', { name: url })).toHaveAttribute('href', url)
  })

  it('does not make unsafe status URLs clickable', () => {
    render(<TailscaleControls {...props} authUrl="javascript:alert(1)" authLinkMode />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument()
  })

  it('allows cancel while starting from a disabled backend', () => {
    render(<TailscaleControls {...props} enabled={false} authUrl={null} authPhase="starting" />)
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled()
  })

  it('falls back to document copy when Clipboard API is missing', async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const execCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
    const copy = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: copy })
    try {
      render(<TailscaleControls {...props} />)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy authorization link' })))
      expect(copy).toHaveBeenCalledWith('copy')
      expect(screen.getByRole('button', { name: 'Authorization link copied' })).toBeVisible()
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
      if (execCommand) Object.defineProperty(document, 'execCommand', execCommand)
      else Reflect.deleteProperty(document, 'execCommand')
    }
  })
})
