import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiCompactionItem, PiCustomMessageItem } from '../../../omp/domain/index.js'
import { PiSystemItemView } from './PiSystemItemViews'
import { TimelineEntryNavigation } from '../../chat/virtual/TimelineEntryNavigation'

const toolTheme = vi.hoisted(() => ({ descriptiveToolSteps: false }))
vi.mock('../../../hooks/useTheme', () => ({ useTheme: () => ({
  descriptiveToolSteps: toolTheme.descriptiveToolSteps, immersiveMode: false, processCollapseEnabled: false,
}) }))
beforeEach(() => { toolTheme.descriptiveToolSteps = false })

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
  it.each([false, true])('uses the selected tool style for standalone background deliveries (descriptive=%s)', descriptive => {
    toolTheme.descriptiveToolSteps = descriptive
    render(<PiSystemItemView item={{ ...message(`style-${descriptive}`, 'Supervised process preview failed with exit code 255.', {
      daemons: [{ name: 'preview', state: 'failed', exitCode: 255 }],
    }), customType: 'launch-completion', injectedRole: 'custom' }} />)
    const job = within(region('preview'))
    if (descriptive) {
      expect(job.queryByText('preview')).not.toBeInTheDocument()
      fireEvent.click(job.getAllByRole('button')[0])
    }
    const row = job.getByText('preview').closest('button')!
    fireEvent.click(row)
    expect(job.getByText(/Supervised process preview failed/)).toBeInTheDocument()
    expect(screen.queryByText('system.automaticNotice')).not.toBeInTheDocument()
  })
  it('separates the user summary from closed internal archive instructions and offers retained-history navigation', () => {
    const jump = vi.fn()
    const item: PiCompactionItem = { kind: 'compaction', entryId: 'compact', timestamp: 1000,
      rawEntry: {} as PiCompactionItem['rawEntry'], method: 'snapcompact', summary: 'Resume prior conversation. FILES / HISTORY',
      shortSummary: 'Updated sample.txt', tokensBefore: 45000, tokensAfter: 3500, firstKeptEntryId: 'kept-entry' }
    render(<TimelineEntryNavigation.Provider value={{ jump, pending: null, missing: null }}><PiSystemItemView item={item} /></TimelineEntryNavigation.Provider>)
    expect(screen.getByText('compaction.methods.snapcompact')).toBeInTheDocument()
    expect(screen.getByText('compaction.archiveHint')).toBeInTheDocument()
    expect(screen.getByText(/45[,.]?000 → 3[,.]?500 tokens/)).toBeInTheDocument()
    const archive = screen.getByText(item.summary).closest('details')!
    expect(archive.open).toBe(false)
    expect(archive.querySelector('summary')?.textContent).toBe('compaction.archiveInstructions')
    expect(screen.getByText('Updated sample.txt').closest('details')).not.toBe(archive)
    fireEvent.click(screen.getByRole('button', { name: 'compaction.jump' }))
    expect(jump).toHaveBeenCalledWith('kept-entry')
  })

  it('labels an injected user-attributed notice without turning it into user speech', () => {
    render(<PiSystemItemView item={{ ...message('injection', 'Continue the pending work'), customType: 'maintenance',
      injectedRole: 'developer', attribution: 'user' }} />)
    const toggle = screen.getByRole('button', { name: 'system.userAttributedNotice' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(screen.getByText('Continue the pending work')).toBeInTheDocument()
  })

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

  it('keeps TitleRuntime messages in a collapsed shared tool row without the delivery envelope', () => {
    render(<PiSystemItemView item={{
      kind: 'custom_message', entryId: 'agent-entry', customType: 'irc:incoming', display: true,
      timestamp: 0, rawEntry: {} as PiCustomMessageItem['rawEntry'],
      content: '<irc>Delivery instructions</irc>', injectedRole: 'custom',
      details: { id: 'irc-title', from: 'TitleRuntime', message: 'Finished review' },
    }} />)
    const agent = within(region('TitleRuntime'))
    expect(agent.getByText('system.jobLabel')).toBeInTheDocument()
    expect(agent.queryByText('Finished review')).not.toBeInTheDocument()
    expect(screen.queryByText('system.automaticNotice')).not.toBeInTheDocument()
    expand('TitleRuntime')
    expect(agent.getByText('Finished review')).toBeInTheDocument()
    expect(screen.queryByText(/Delivery instructions/)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'system.agentMessage TitleRuntime' })).not.toBeInTheDocument()
  })

  it.each([undefined, 'custom'] as const)('renders supervisor failure as a failed tool row for injectedRole=%s', injectedRole => {
    render(<PiSystemItemView item={{
      ...message(`supervised-${injectedRole ?? 'persisted'}`, 'Supervised process title-ui-preview failed with exit code 255.', {
        daemons: [{ name: 'title-ui-preview', id: 'preview-unit', state: 'failed', exitCode: 255, startedAt: 1000, exitedAt: 72000 }],
      }), customType: 'launch-completion', injectedRole,
    }} />)
    const job = within(region('title-ui-preview'))
    expect(job.getByText('system.jobLabel')).toHaveClass('text-danger-100')
    expect(job.getByText('1m 11s')).toBeInTheDocument()
    expect(screen.queryByText('system.automaticNotice')).not.toBeInTheDocument()
    expand('title-ui-preview')
    expect(job.getByText(/Supervised process title-ui-preview failed with exit code 255/)).toBeInTheDocument()
  })

  it('expands async output notifications through the shared row without starting a live execution', () => {
    render(<PiSystemItemView item={{
      ...message('notify-output', '<system-notice>Delivery</system-notice>', {
        reports: [{ id: 'preview', type: 'service', pattern: 'ready', lines: ['Server ready'], running: true, omitted: 2, stopped: true }],
      }), customType: 'async-notify', injectedRole: 'custom',
    }} />)
    const job = within(region('preview'))
    expect(job.queryByText('toolPart.running')).not.toBeInTheDocument()
    expand('preview')
    expect(job.getByText(/Server ready/)).toBeInTheDocument()
    expect(job.getByText(/2 not shown/)).toBeInTheDocument()
    expect(job.getByText(/`notify` is off/)).toBeInTheDocument()
  })

  it('keeps relayed task failures and their full-output reference readable in the shared row', () => {
    render(<PiSystemItemView item={{
      ...message('wake-relay', 'Model delivery envelope', {
        id: 'title-wake', from: 'TitleRuntime', wakeRelay: true,
        message: '<task-result id="TitleRuntime" status="failed" duration="2s">\n<error>Preview failed</error>\n<preview full-output="history://TitleRuntime">Log tail</preview>\n</task-result>',
      }), customType: 'irc:incoming', injectedRole: 'custom',
    }} />)
    const job = within(region('TitleRuntime'))
    expect(job.getByText('system.jobLabel')).toHaveClass('text-danger-100')
    expand('TitleRuntime')
    expect(job.getByText(/Log tail/)).toBeInTheDocument()
    expect(job.getByText(/Preview failed/)).toBeInTheDocument()
    expect(job.getByText(/Full output: history:\/\/TitleRuntime/)).toBeInTheDocument()
    expect(job.queryByText(/<task-result/)).not.toBeInTheDocument()
  })

  it('renders batched supervisor completions in one tool group with separate outcomes', () => {
    render(<PiSystemItemView item={{
      ...message('supervisor-batch', '', { daemons: [
        { id: 'first-service', name: 'first-preview', state: 'exited', exitCode: 0 },
        { id: 'second-service', key: 'second-preview', state: 'failed', exitCode: 255 },
      ] }), customType: 'launch-completion', injectedRole: 'custom',
    }} />)
    const group = within(region('first-preview, second-preview'))
    if (!group.queryByText('first-preview')) fireEvent.click(group.getAllByRole('button')[0])
    const first = group.getByText('first-preview').closest('button')!
    const second = group.getByText('second-preview').closest('button')!
    expect(within(first).getByText('system.jobLabel')).not.toHaveClass('text-danger-100')
    expect(within(second).getByText('system.jobLabel')).toHaveClass('text-danger-100')
    fireEvent.click(second)
    expect(second).toHaveAttribute('aria-expanded', 'true')
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(group.getByText(/second-preview failed with exit code 255/)).toBeInTheDocument()
  })

  it('keeps unrelated injected notices in their original system presentation', () => {
    render(<PiSystemItemView item={{
      ...message('ordinary-notice', 'Supervised process title-ui-preview failed with exit code 255.'),
      customType: 'maintenance', injectedRole: 'custom',
    }} />)
    expect(screen.getByRole('button', { name: 'system.automaticNotice' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('system.jobLabel')).not.toBeInTheDocument()
  })
})
