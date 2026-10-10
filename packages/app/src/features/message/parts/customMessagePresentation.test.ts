import { describe, expect, it } from 'vitest'
import type { PiCustomMessageItem } from '../../../omp/domain/index.js'
import { customMessageText, readAgentMessage, readBackgroundJobs } from './customMessagePresentation'

function item(customType: string, content: string, details?: unknown): PiCustomMessageItem {
  return {
    kind: 'custom_message', entryId: 'message-1', timestamp: 0, rawEntry: {} as PiCustomMessageItem['rawEntry'],
    display: true, customType, content, details,
  }
}

describe('custom message presentation', () => {
  it('uses original agent message details without model-facing instructions', () => {
    expect(readAgentMessage(item('irc:incoming', '<irc>model instructions</irc>', {
      from: 'Reviewer', message: '**Ready**\n\nKeep the final paragraph.',
    }))).toEqual({ sender: 'Reviewer', body: '**Ready**\n\nKeep the final paragraph.' })
  })

  it('unwraps legacy agent delivery text but leaves unknown messages intact', () => {
    const footer = 'If response expected, reply via `write` (`path: "agent://Reviewer"`, `content: "…"`); may finish current step first. No one replies on your behalf.'
    expect(readAgentMessage(item('irc:incoming', `<irc>\nIncoming IRC message from agent \`Reviewer\`:\n\nDone.\n\n${footer}\n</irc>`)))
      .toEqual({ sender: 'Reviewer', body: 'Done.' })
    const unknown = item('custom', 'ordinary content')
    expect(readAgentMessage(unknown)).toBeUndefined()
    expect(readBackgroundJobs(unknown)).toBeUndefined()
    expect(customMessageText(unknown)).toBe('ordinary content')
  })

  it('keeps each batched job matched by ID even if metadata and output order differ', () => {
    const jobs = readBackgroundJobs(item('async-result',
      '── Job second (task) ──\nSecond output\n── Job first (task) ──\nFirst output',
      { jobs: [{ jobId: 'first', label: 'One' }, { jobId: 'second', label: 'Two', status: 'failed', error: 'Failed' }] },
    ))
    expect(jobs?.map(job => [job.name, job.body])).toEqual([['One', 'First output'], ['Two', 'Second output']])
    expect(jobs?.[1].errors).toEqual(['Failed'])
  })

  it('replaces a truncated preview with full structured output while preserving errors and trailing content', () => {
    const content = '<task-result id="job" status="failed" duration="2s">\n<error>Tool failed</error>\n<preview full-output="history://job">partial</preview>\n<merge-summary>\nMerge report\n</merge-summary>\n</task-result>\nImportant tail'
    const jobs = readBackgroundJobs(item('async-result', content, {
      jobs: [{ jobId: 'job', schema: { data: { summary: 'Full result', files: ['a.ts'] }, error: 'Schema error' } }],
    }))
    expect(jobs?.[0].body).toContain('"files"')
    expect(jobs?.[0].body).not.toContain('partial')
    expect(jobs?.[0].body).toContain('Merge report')
    expect(jobs?.[0].body).toContain('Important tail')
    expect(jobs?.[0].errors).toEqual(['Tool failed', 'Schema error'])
    expect(jobs?.[0].fullOutput).toBeUndefined()
  })

  it('preserves full-output locations and plain output distinct from structured data', () => {
    const preview = readBackgroundJobs(item('async-result',
      '<task-result id="job" status="completed">\n<preview full-output="history://job">partial</preview>\n</task-result>',
    ))?.[0]
    expect(preview?.fullOutput).toBe('history://job')
    const jobs = readBackgroundJobs(item('async-result', 'Independent explanation', {
      jobs: [{ jobId: 'job', schema: { data: { summary: 'Structured result' } } }],
    }))
    expect(jobs?.[0].body).toContain('Independent explanation')
    expect(jobs?.[0].body).toContain('Structured result')
  })

  it('renders structured-only results even when the custom message text is empty', () => {
    expect(readBackgroundJobs(item('Background job', '', {
      jobId: 'job', meta: { source: 'bash' }, schema: { data: { summary: 'Complete' } },
    }))?.[0]).toMatchObject({ summary: 'Complete', metadata: { source: 'bash' } })
  })
})
