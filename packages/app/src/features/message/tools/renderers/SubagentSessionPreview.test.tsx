// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OmpSubagentRun } from '../../../../omp/ompSubagentStore'
import { SubagentSessionPreview } from './SubagentSessionPreview'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../../omp/transport/index.js', () => ({ getOmpSubagentMessages: vi.fn() }))

function run(text = 'Current reply'): OmpSubagentRun {
  return {
    id: 'preview-run',
    sessionId: 'parent',
    agent: 'scout',
    task: 'Inspect the source',
    status: 'running',
    index: 0,
    detached: false,
    startedAt: 0,
    historyLoaded: true,
    transcript: [{ kind: 'assistant', text, timestamp: 1 }],
    progress: {
      recentOutput: [text],
      recentTools: [],
      tokens: 123,
      toolCount: 10,
      requests: 1,
      cost: 0,
      durationMs: 3000,
    },
  }
}

describe('SubagentSessionPreview', () => {
  it('renders a single transcript without the extra statistics or duplicate progress output', () => {
    render(<SubagentSessionPreview run={run()} />)
    expect(screen.getAllByText('Current reply')).toHaveLength(1)
    expect(screen.queryByText(/tools|tok|scout/)).not.toBeInTheDocument()
  })

  it('shows loading skeletons only while reading history, then an unframed waiting state', () => {
    const { rerender } = render(<SubagentSessionPreview loading />)
    expect(screen.getByRole('status', { name: 'common:loading' })).toBeInTheDocument()
    expect(screen.queryByText('task.waitingForResponse')).not.toBeInTheDocument()
    rerender(<SubagentSessionPreview />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('task.waitingForResponse')).not.toHaveClass('border')
  })

  it('follows a large append when pinned but preserves position after the user scrolls up', () => {
    const { container, rerender } = render(<SubagentSessionPreview run={run()} />)
    const scroll = container.querySelector('.overflow-y-auto') as HTMLDivElement
    let height = 300
    Object.defineProperties(scroll, {
      scrollHeight: { get: () => height, configurable: true },
      clientHeight: { value: 100, configurable: true },
    })
    scroll.scrollTop = 200
    fireEvent.scroll(scroll)
    height = 1000
    rerender(<SubagentSessionPreview run={run('A much longer reply')} />)
    expect(scroll.scrollTop).toBe(1000)
    scroll.scrollTop = 100
    fireEvent.scroll(scroll)
    height = 1500
    rerender(<SubagentSessionPreview run={run('Another long update')} />)
    expect(scroll.scrollTop).toBe(100)
  })

  it('opens completed history at the top so its first message is visible', () => {
    const initial = { ...run('Initial assignment'), status: 'completed' as const, transcript: [] }
    const { container, rerender } = render(<SubagentSessionPreview run={initial} />)
    rerender(
      <SubagentSessionPreview
        run={{
          ...initial,
          transcript: [
            { kind: 'user', text: 'Initial assignment', timestamp: 0 },
            { kind: 'assistant', text: 'Completed reply', timestamp: 1 },
          ],
        }}
      />,
    )
    const scroll = container.querySelector('.overflow-y-auto') as HTMLDivElement
    Object.defineProperties(scroll, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 100, configurable: true },
    })
    rerender(
      <SubagentSessionPreview
        run={{
          ...initial,
          transcript: [
            { kind: 'user', text: 'Initial assignment', timestamp: 0 },
            { kind: 'assistant', text: 'More loaded history', timestamp: 1 },
          ],
        }}
      />,
    )
    expect(scroll.scrollTop).toBe(0)
    expect(screen.getByText('Initial assignment')).toBeInTheDocument()
  })

  it('still follows the final response when a live run completes', () => {
    const { container, rerender } = render(<SubagentSessionPreview run={run()} />)
    const scroll = container.querySelector('.overflow-y-auto') as HTMLDivElement
    Object.defineProperties(scroll, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 100, configurable: true },
    })
    rerender(<SubagentSessionPreview run={{ ...run('Final response'), status: 'completed' }} />)
    expect(scroll.scrollTop).toBe(1000)
  })
})
