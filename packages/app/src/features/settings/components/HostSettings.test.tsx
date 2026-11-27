import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostSettings } from './HostSettings'

vi.mock('./RemoteAccessSettings', () => ({
  RemoteAccessSettings: ({ onOpenService }: { onOpenService?: () => void }) => (
    <button type="button" onClick={onOpenService}>Host channels</button>
  ),
}))

describe('HostSettings', () => {
  it('shows the host channels and forwards the Service page shortcut', () => {
    const openService = vi.fn()
    render(<HostSettings onOpenService={openService} />)
    fireEvent.click(screen.getByRole('button', { name: 'Host channels' }))
    expect(openService).toHaveBeenCalledOnce()
  })
})
