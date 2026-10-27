import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PiCustomMessageItem } from '../../../omp/domain/index.js'
import { PiSystemItemView } from './PiSystemItemViews'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string; path?: string }) => {
      const value = values?.name ?? values?.path
      return `${key}${value ? ` ${value}` : ''}`
    },
  }),
}))

vi.mock('../../../components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}))

vi.mock('../../../components/ContentBlock', () => ({
  ContentBlock: ({ label, content, variant, language }: { label: string; content?: string; variant?: string; language?: string }) => (
    <div data-testid="content-block" data-variant={variant ?? 'default'} data-language={language ?? ''}>
      <span>{label}</span>
      <pre data-testid="content-block-content">{content}</pre>
    </div>
  ),
}))

function message(entryId: string, content: string, details?: unknown): PiCustomMessageItem {
  return {
    kind: 'custom_message', entryId, customType: 'async-result', content, display: true,
    timestamp: 0, rawEntry: {} as PiCustomMessageItem['rawEntry'], details,
  }
}

function region(name: string) {
  return screen.getByRole('region', { name: `system.backgroundJob ${name}` })
}

function expand(name: string) {
  const header = within(region(name)).getByRole('button')
  expect(header).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(header)
  expect(header).toHaveAttribute('aria-expanded', 'true')
  return header
}

describe('custom message timeline views', () => {
  it('keeps batched job results separately expandable', () => {
    render(<PiSystemItemView item={message('batch', '── Job one (task) ──\nFirst result\n── Job two (task) ──\nSecond result', {
      jobs: [{ jobId: 'one', label: 'First job' }, { jobId: 'two', label: 'Second job' }],
    })} />)
    const first = within(region('First job')).getByRole('button')
    const second = within(region('Second job')).getByRole('button')
    expect(first).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'true')
    expect(second).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows completed jobs with a localized success badge and duration', () => {
    render(<PiSystemItemView item={message('done', '<task-result id="watch" status="completed" duration="5m 44s">\n<output>Run finished</output>\n</task-result>')} />)
    const job = within(region('watch'))
    const badge = job.getByText('system.jobCompleted')
    expect(badge).toHaveClass('text-success-100')
    expect(job.getByText('5m 44s')).toBeInTheDocument()
    expect(job.queryByText('completed')).not.toBeInTheDocument()
  })

  it('formats numeric durations from job metadata', () => {
    render(<PiSystemItemView item={message('timed', 'ok', { jobId: 'timed', durationMs: 71_000 })} />)
    expect(within(region('timed')).getByText(/1m/)).toBeInTheDocument()
  })

  it('keeps errors visible while collapsed and shows them in full when expanded', () => {
    render(<PiSystemItemView item={message('failed', '<task-result id="ci" status="failed" duration="1m 11s">\n<error>Typecheck failed\nsecond line</error>\n<output>log tail</output>\n</task-result>')} />)
    const job = within(region('ci'))
    expect(job.getByText('system.jobFailed')).toHaveClass('text-danger-100')
    expect(job.queryByText('failed')).not.toBeInTheDocument()
    const preview = job.getByText(/Typecheck failed/)
    expect(preview).toHaveClass('text-danger-100')
    expect(job.queryByText('log tail')).not.toBeInTheDocument()
    expect(job.queryByText('system.jobResult')).not.toBeInTheDocument()
    expand('ci')
    expect(job.getByText('system.jobError').parentElement).toHaveAttribute('data-variant', 'error')
    expect(job.getByText(/second line/)).toBeInTheDocument()
    expect(job.getByText('log tail')).toBeInTheDocument()
  })

  it('treats errors on a non-failed status as failures without rewriting the status', () => {
    render(<PiSystemItemView item={message('err', 'output', { jobId: 'err', status: 'completed', error: 'Schema mismatch' })} />)
    const job = within(region('err'))
    expect(job.getByText('system.jobCompleted')).toBeInTheDocument()
    expect(job.getByText('Schema mismatch')).toHaveClass('text-danger-100')
  })

  it('collapses multi-paragraph summaries to one line until expanded', () => {
    render(<PiSystemItemView item={message('summary', 'Refreshing every 15 seconds.\n\nRun 123 completed', { jobId: 'summary' })} />)
    const job = within(region('summary'))
    const preview = job.getByText('Refreshing every 15 seconds.')
    expect(preview).toHaveClass('truncate')
    expect(job.queryByText(/Run 123 completed/)).not.toBeInTheDocument()
    expand('summary')
    expect(job.queryByText('Refreshing every 15 seconds.')).not.toBeInTheDocument()
    expect(job.getByText(/Run 123 completed/)).toBeInTheDocument()
  })

  it('renders multi-line terminal output as a plain content block with line breaks intact', () => {
    const output = 'Refreshing run status every 15 seconds.\n\n✓ Set up job\n✓ Run actions/checkout@v6\n  ✓ Install deps'
    render(<PiSystemItemView item={message('terminal', output, { jobId: 'watch-run' })} />)
    expand('watch-run')
    const job = within(region('watch-run'))
    expect(job.queryByTestId('markdown')).not.toBeInTheDocument()
    expect(job.getByTestId('content-block')).toHaveAttribute('data-language', '')
    expect(job.getByText('system.jobResult')).toBeInTheDocument()
    expect(job.getByTestId('content-block-content').textContent).toBe(output)
    expect(job.getByTestId('content-block-content').textContent).toContain('\n✓ Run actions/checkout@v6\n')
  })

  it('keeps real gh run watch output with bullet-like lines as plain text', () => {
    const output = 'Refreshing run status every 15 seconds. Press Ctrl+C to quit.\n\n* dev CI chenming0v0/OMPiUI#404 · 40275127725\nTriggered via pull_request about 3 minutes ago\n\nJOBS\n✓ lint in 53s (ID 121416151615)\n  ✓ Set up job\n  ✓ Run npm run lint'
    render(<PiSystemItemView item={message('gh-watch', output, { jobId: 'gh-watch' })} />)
    expand('gh-watch')
    const job = within(region('gh-watch'))
    expect(job.queryByTestId('markdown')).not.toBeInTheDocument()
    expect(job.getByTestId('content-block')).toHaveAttribute('data-language', '')
    expect(job.getByTestId('content-block-content').textContent).toBe(output)
  })

  it.each([
    ['plain-list', '- item\n- item2'],
    ['lone-heading', '# comment'],
  ])('keeps %s output as plain text', (id, output) => {
    render(<PiSystemItemView item={message(id, output, { jobId: id })} />)
    expand(id)
    const job = within(region(id))
    expect(job.queryByTestId('markdown')).not.toBeInTheDocument()
    expect(job.getByTestId('content-block-content').textContent).toBe(output)
  })

  it.each([
    ['fenced', 'Run this:\n\n```sh\nnpm test\n```'],
    ['table', '| file | status |\n| --- | --- |\n| a.ts | ok |'],
  ])('renders %s markdown with the markdown renderer', (id, report) => {
    render(<PiSystemItemView item={message(id, report, { jobId: id })} />)
    expand(id)
    const job = within(region(id))
    expect(job.getByTestId('markdown').textContent).toBe(report)
    expect(job.queryByTestId('content-block')).not.toBeInTheDocument()
  })

  it('keeps markdown results on the markdown renderer', () => {
    const report = '## Review\n\n- First finding\n- Second finding'
    render(<PiSystemItemView item={message('markdown', report, { jobId: 'review' })} />)
    expand('review')
    const job = within(region('review'))
    expect(job.getByTestId('markdown').textContent).toBe(report)
    expect(job.queryByTestId('content-block')).not.toBeInTheDocument()
  })

  it('renders structured results as code and metadata under details', () => {
    render(<PiSystemItemView item={message('structured', '', {
      jobId: 'structured', meta: { source: 'bash' }, schema: { data: { summary: 'Complete', files: ['a.ts'] } },
    })} />)
    expect(within(region('structured')).getByText('Complete')).toBeInTheDocument()
    expand('structured')
    const job = within(region('structured'))
    expect(job.getByText('system.jobResult').parentElement).toHaveAttribute('data-language', 'json')
    expect(job.getByText('system.jobDetails')).toBeInTheDocument()
  })

  it('shows the full-output location as secondary information', () => {
    render(<PiSystemItemView item={message('preview', '<task-result id="long" status="completed">\n<preview full-output="history://long">partial</preview>\n</task-result>')} />)
    expect(within(region('long')).queryByText('system.jobFullOutput history://long')).not.toBeInTheDocument()
    expand('long')
    expect(within(region('long')).getByText('system.jobFullOutput history://long')).toBeInTheDocument()
  })

  it('falls back to the raw value for unknown statuses', () => {
    render(<PiSystemItemView item={message('queued', 'waiting', { jobId: 'q1', status: 'queued' })} />)
    expect(within(region('q1')).getByText('queued')).toBeInTheDocument()
    expect(within(region('q1')).queryByText('system.jobCompleted')).not.toBeInTheDocument()
  })

  it('renders agent message bodies without the delivery envelope', () => {
    render(<PiSystemItemView item={{
      kind: 'custom_message', entryId: 'agent-entry', customType: 'irc:incoming', display: true,
      timestamp: 0, rawEntry: {} as PiCustomMessageItem['rawEntry'],
      content: '<irc>Delivery instructions</irc>', details: { from: 'Reviewer', message: 'Finished review' },
    }} />)
    const agent = within(screen.getByRole('region', { name: 'system.agentMessage Reviewer' }))
    expect(agent.getByText('system.agentMessageFrom Reviewer')).toBeInTheDocument()
    expect(agent.getByText('Finished review')).toBeInTheDocument()
    expect(screen.queryByText(/Delivery instructions/)).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'system.agentMessage Reviewer' }).querySelector('.rounded-md.border')).toBeNull()
  })
})
