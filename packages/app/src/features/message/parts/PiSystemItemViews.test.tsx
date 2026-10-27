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

/** 后台任务现在走普通工具卡片：header 是组内唯一的折叠按钮。 */
function header(name: string) {
  return within(region(name)).getAllByRole('button')[0]
}

function expand(name: string) {
  const button = header(name)
  expect(button).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(button)
  expect(button).toHaveAttribute('aria-expanded', 'true')
  return button
}

describe('custom message timeline views', () => {
  it('renders one delivery with several jobs as one tool group whose rows expand separately', () => {
    render(<PiSystemItemView item={message('batch', '── Job one (task) ──\nFirst result\n── Job two (task) ──\nSecond result', {
      jobs: [{ jobId: 'one', label: 'First job' }, { jobId: 'two', label: 'Second job' }],
    })} />)
    const group = region('First job, Second job')
    if (!within(group).queryByText('First job')) fireEvent.click(within(group).getAllByRole('button')[0])
    const row = (name: string) => within(group).getByText(name).closest('button')!
    expect(row('First job')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(row('First job'))
    expect(row('First job')).toHaveAttribute('aria-expanded', 'true')
    expect(row('Second job')).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders the job as a regular tool row: label, name and duration', () => {
    render(<PiSystemItemView item={message('done', '<task-result id="watch" status="completed" duration="5m 44s">\n<output>Run finished</output>\n</task-result>')} />)
    const job = within(region('watch'))
    // 行首是统一的工具卡片名，不再是自绘的「后台任务」+ 状态徽标
    expect(job.getByText('system.jobLabel')).toBeInTheDocument()
    expect(job.getByText('watch')).toBeInTheDocument()
    expect(job.getByText('5m 44s')).toBeInTheDocument()
    expect(job.queryByText('system.jobCompleted')).not.toBeInTheDocument()
  })

  it('formats numeric durations from job metadata', () => {
    render(<PiSystemItemView item={message('timed', 'ok', { jobId: 'timed', durationMs: 71_000 })} />)
    expect(within(region('timed')).getByText(/1m/)).toBeInTheDocument()
  })

  it('marks failed jobs as failed on the shared row instead of adding a badge', () => {
    render(<PiSystemItemView item={message('failed', '<task-result id="ci" status="failed" duration="1m 11s">\n<error>Typecheck failed</error>\n<output>log tail</output>\n</task-result>')} />)
    const job = within(region('ci'))
    expect(job.getByText('system.jobLabel')).toHaveClass('text-danger-100')
    expect(job.queryByText('system.jobFailed')).not.toBeInTheDocument()
  })

  it('reveals the recorded output when expanded', () => {
    const output = 'Refreshing run status every 15 seconds.\n\n✓ Set up job\n✓ Run actions/checkout@v6'
    render(<PiSystemItemView item={message('terminal', output, { jobId: 'watch-run' })} />)
    expect(within(region('watch-run')).queryByText(/Set up job/)).not.toBeInTheDocument()
    expand('watch-run')
    expect(within(region('watch-run')).getByText(/Set up job/)).toBeInTheDocument()
  })

  it('renders structured results as json', () => {
    render(<PiSystemItemView item={message('structured', '', {
      jobId: 'structured', meta: { source: 'bash' }, schema: { data: { summary: 'Complete', files: ['a.ts'] } },
    })} />)
    expand('structured')
    expect(within(region('structured')).getByTestId('content-block')).toHaveAttribute('data-language', 'json')
  })

  it('does not invent a status badge for unknown statuses', () => {
    render(<PiSystemItemView item={message('queued', 'waiting', { jobId: 'q1', status: 'queued' })} />)
    expect(within(region('q1')).getByText('system.jobLabel')).toBeInTheDocument()
    expect(within(region('q1')).queryByText('queued')).not.toBeInTheDocument()
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