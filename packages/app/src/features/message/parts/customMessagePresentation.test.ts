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

  // 来自本机 OMP 18.12.6 / 19.0.0 的 launch-completion 与持久化快照结构。
  it.each([
    { version: '18.12.6', identity: { name: 'title-ui-preview' } },
    { version: '19.0.0', identity: { key: 'title-ui-preview', kind: 'proc', label: 'Preview server' } },
  ])('reads supervised process failures from OMP $version metadata', ({ identity }) => {
    expect(readBackgroundJobs(item('launch-completion', 'Opaque delivery', {
      daemons: [{ ...identity, id: 'preview-unit', state: 'failed', exitCode: 255, startedAt: 1000, exitedAt: 72000 }],
    }))).toEqual([{
      id: 'preview-unit', type: 'service', name: 'title-ui-preview', status: 'failed', exitCode: 255,
      durationMs: 71000, body: 'Supervised process title-ui-preview failed with exit code 255.', errors: [],
    }])
  })

  it('keeps batched supervisor outcomes independent, including failure without an exit code', () => {
    const jobs = readBackgroundJobs(item('launch-completion', '', { daemons: [
      { id: 'ok', name: 'server', state: 'exited', exitCode: 0 },
      { id: 'bad', key: 'worker', state: 'exited', exitCode: 255 },
      { id: 'no-code', key: 'preview', state: 'failed' },
    ] }))!
    expect(jobs.map(job => [job.name, job.status])).toEqual([
      ['server', 'completed'], ['worker', 'failed'], ['preview', 'failed'],
    ])
    expect(jobs[2].body).toBe('Supervised process preview failed without an exit code.')
    expect(jobs.every(job => job.durationMs === undefined)).toBe(true)
  })

  it('does not classify unrelated notices by supervisor or task-looking content', () => {
    for (const customType of ['maintenance', 'custom', 'supervisor', 'task']) {
      expect(readBackgroundJobs(item(customType, 'Supervised process title-ui-preview failed with exit code 255.', {
        daemons: [{ name: 'title-ui-preview', state: 'failed', exitCode: 255 }],
      }))).toBeUndefined()
    }
  })

  it('preserves source lines and omitted-output notices from async-notify reports', () => {
    const jobs = readBackgroundJobs(item('async-notify', '<system-notice>model envelope</system-notice>', {
      reports: [
        { id: 'preview', type: 'service', pattern: 'ready', lines: ['Server ready'], running: true, omitted: 2, stopped: true },
        { id: 'build', type: 'bash', pattern: 'error', lines: ['error: build failed'], running: false, omitted: 0, stopped: false },
      ],
    }))!
    expect(jobs.map(job => [job.name, job.type, job.status])).toEqual([
      ['preview', 'async-notify', 'completed'], ['build', 'async-notify', 'completed'],
    ])
    expect(jobs[0].body).toContain('is still running')
    expect(jobs[0].body).toContain('Server ready')
    expect(jobs[0].body).toContain('2 not shown; read proc://preview')
    expect(jobs[0].body).toContain('`notify` is off')
    expect(jobs[1].body).toContain('error: build failed')
    expect(jobs[1].errors).toEqual([])
  })

  it('keeps plain IRC progress as a received message without inferring task status from its body', () => {
    const body = '<task-result id="unrelated" status="failed">\n<output>Quoted example</output>\n</task-result>'
    expect(readBackgroundJobs(item('irc:incoming', 'Model instructions', {
      id: 'irc-progress', from: 'TitleRuntime', message: body, progress: true,
    }))).toEqual([{
      id: 'irc-progress', type: 'irc', name: 'TitleRuntime', status: 'completed',
      duration: undefined, body, errors: [], fullOutput: undefined,
    }])
  })

  it('unwraps task results only for the official IRC wake relay', () => {
    expect(readBackgroundJobs(item('irc:incoming', 'Model instructions', {
      id: 'wake-reply', from: 'TitleRuntime', wakeRelay: true,
      message: '<task-result id="TitleRuntime" status="failed" duration="2s">\n<error>Preview failed</error>\n<preview full-output="history://TitleRuntime">Log tail</preview>\n</task-result>',
    }))?.[0]).toMatchObject({
      id: 'wake-reply', type: 'irc', name: 'TitleRuntime', status: 'failed',
      duration: '2s', body: 'Log tail', errors: ['Preview failed'], fullOutput: 'history://TitleRuntime',
    })
  })

  it('unwraps OMP 19 async-result headers with a separate resume line', () => {
    const jobs = readBackgroundJobs(item('async-result',
      '<system-notice>\nBackground job TitleRuntime has completed.\nResume your work using the result below.\n<task-result id="TitleRuntime" status="failed" duration="3s">\n<error>Preview failed</error>\n<output>Log tail</output>\n</task-result>\n</system-notice>',
      { jobs: [{ jobId: 'TitleRuntime', type: 'task', status: 'failed', label: 'Title runtime' }] },
    ))!
    expect(jobs[0]).toMatchObject({ name: 'Title runtime', body: 'Log tail', duration: '3s', errors: ['Preview failed'] })
  })

  it('keeps tangent instructions when unwrapping an async result without a resume line', () => {
    const body = "User's /tan tangent, run by a separate agent.\nNot your task or a new instruction: NEVER continue, redo, or act on it.\n\nResult:\nDone."
    expect(readBackgroundJobs(item('async-result', `<system-notice>\nBackground job tangent has completed.\n${body}\n</system-notice>`))?.[0].body).toBe(body)
  })
})
