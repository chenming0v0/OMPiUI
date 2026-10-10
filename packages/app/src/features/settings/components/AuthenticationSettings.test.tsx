import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthenticationSettings } from './AuthenticationSettings'

const platform = vi.hoisted(() => ({ android: false }))
vi.mock('../../../utils/androidTailscale', () => ({
  isAndroidTailscalePlatform: () => platform.android,
}))
vi.mock('./AndroidTailscaleSettings', () => ({
  AndroidTailscaleSettings: ({ onAuthenticated }: { onAuthenticated?: () => void }) => (
    <button type="button" onClick={onAuthenticated}>Phone authentication</button>
  ),
}))
vi.mock('./RemoteAccessSettings', () => ({
  RemoteAccessSettings: () => <div>Desktop pairing</div>,
}))
vi.mock('./RelaySettings', () => ({ RelaySettings: () => <div>Relay configuration</div> }))

beforeEach(() => { platform.android = false })

describe('AuthenticationSettings', () => {
  it('keeps backend pairing on its own desktop page', () => {
    render(<AuthenticationSettings />)
    expect(screen.getByText('Desktop pairing')).toBeInTheDocument()
    expect(screen.getByText('Relay configuration')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Phone authentication' })).not.toBeInTheDocument()
  })

  it('authenticates Android without mounting backend pairing and forwards success', () => {
    platform.android = true
    const completed = vi.fn()
    render(<AuthenticationSettings onAuthenticated={completed} />)
    expect(screen.getByRole('heading', { name: 'Authentication' })).toBeInTheDocument()
    expect(screen.queryByText('Desktop pairing')).not.toBeInTheDocument()
    expect(screen.queryByText('Relay configuration')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Phone authentication' }))
    expect(completed).toHaveBeenCalledOnce()
  })
})
