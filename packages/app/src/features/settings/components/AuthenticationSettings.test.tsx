import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthenticationSettings } from './AuthenticationSettings'

const platform = vi.hoisted(() => ({ android: false }))
vi.mock('../../../utils/androidTailscale', () => ({
  isAndroidTailscalePlatform: () => platform.android,
}))
vi.mock('./AndroidTailscaleSettings', () => ({
  AndroidTailscaleSettings: () => <div>Phone authentication</div>,
}))
vi.mock('./RemoteAccessSettings', () => ({
  RemoteAccessSettings: () => <div>Desktop pairing</div>,
}))
vi.mock('./RelaySettings', () => ({ RelaySettings: () => <div>Relay configuration</div> }))
vi.mock('./PhonePairingForm', () => ({
  PhonePairingForm: ({ onPaired }: { onPaired?: () => void }) => (
    <button type="button" onClick={onPaired}>Phone pairing input and scanner</button>
  ),
}))

beforeEach(() => { platform.android = false })

describe('AuthenticationSettings', () => {
  it('keeps backend pairing on its own desktop page', () => {
    render(<AuthenticationSettings />)
    expect(screen.getByText('Desktop pairing')).toBeInTheDocument()
    expect(screen.getByText('Relay configuration')).toBeInTheDocument()
    expect(screen.queryByText('Phone authentication')).not.toBeInTheDocument()
    expect(screen.queryByText('Phone pairing input and scanner')).not.toBeInTheDocument()
  })

  it('shows Android pairing without mounting backend controls and forwards pairing success', () => {
    platform.android = true
    const completed = vi.fn()
    render(<AuthenticationSettings onPaired={completed} />)
    expect(screen.getByRole('heading', { name: 'Authentication' })).toBeInTheDocument()
    expect(screen.queryByText('Desktop pairing')).not.toBeInTheDocument()
    expect(screen.queryByText('Relay configuration')).not.toBeInTheDocument()
    expect(screen.getByText('Phone pairing input and scanner')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Phone pairing input and scanner' }))
    expect(completed).toHaveBeenCalledOnce()
  })
})
