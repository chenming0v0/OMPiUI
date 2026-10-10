import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '../../../i18n'
import { ModelSyncStatus } from './ModelSyncStatus'

describe('icon-only model sync indicator', () => {
  beforeEach(async () => { await i18n.changeLanguage('en') })

  it.each([
    { status: 'unknown', label: 'Not synced yet', color: 'text-text-400', icon: 'lucide-circle-dashed' },
    { status: 'disconnected', label: 'Disconnected', color: 'text-danger-100', icon: 'lucide-circle-x' },
    { status: 'synced', label: 'Connected / synced', color: 'text-success-100', icon: 'lucide-circle-check' },
  ] as const)('shows $status without permanent text', ({ status, label, color, icon }) => {
    render(<ModelSyncStatus status={status} />)
    const indicator = screen.getByRole('status', { name: label })
    expect(indicator.textContent).toBe('')
    expect(indicator).toHaveAttribute('title', label)
    expect(indicator).toHaveClass('h-5', 'w-5', color)
    expect(indicator.querySelector('svg')).toHaveClass(icon)
    expect(indicator.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})
