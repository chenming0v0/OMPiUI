import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PiCustomMessageItem } from '../../../omp/domain/index.js'
import { PiSystemItemView } from './PiSystemItemViews'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => `${key}${values?.name ? ` ${values.name}` : ''}`,
  }),
}))

vi.mock('../../../components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))

function job(content: string): PiCustomMessageItem {
  return {
    kind: 'custom_message', entryId: 'job-entry', customType: 'async-result', content, display: true,
    timestamp: 0, rawEntry: {} as PiCustomMessageItem['rawEntry'],
    details: { jobs: [{ jobId: 'one', label: 'First job' }, { jobId: 'two', label: 'Second job' }] },
  }
}

describe('custom message timeline views', () => {
  it('keeps batched job results separately expandable', () => {
    render(<PiSystemItemView item={job('── Job one (task) ──\nFirst result\n── Job two (task) ──\nSecond result')} />)
    expect(screen.getByRole('region', { name: 'system.backgroundJob First job' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'system.backgroundJob Second job' })).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'system.jobResult' })
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(buttons[0])
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'true')
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders agent message bodies without the delivery envelope', () => {
    render(<PiSystemItemView item={{
      kind: 'custom_message', entryId: 'agent-entry', customType: 'irc:incoming', display: true,
      timestamp: 0, rawEntry: {} as PiCustomMessageItem['rawEntry'],
      content: '<irc>Delivery instructions</irc>', details: { from: 'Reviewer', message: 'Finished review' },
    }} />)
    expect(screen.getByText('Finished review')).toBeInTheDocument()
    expect(screen.queryByText(/Delivery instructions/)).not.toBeInTheDocument()
  })
})
