import { describe, expect, it } from 'vitest'
import type { PiAssistantMessageItem, PiCustomMessageItem } from '../../../omp/domain/index.js'
import { buildVisibleTimelineEntries } from '../../chat/chatAreaVisibility'
import { backgroundJobExecutions } from './backgroundJobExecution'

function delivery(entryId: string, customType: string, content: string, details?: unknown): PiCustomMessageItem {
  return {
    kind: 'custom_message', entryId, customType, content, details, display: true,
    injectedRole: 'custom', timestamp: 1000, rawEntry: {} as PiCustomMessageItem['rawEntry'],
  }
}

function supervisor(entryId = 'supervisor'): PiCustomMessageItem {
  return delivery(entryId, 'launch-completion', 'Supervised process title-ui-preview failed with exit code 255.', {
    daemons: [{ id: 'preview-unit', key: 'title-ui-preview', state: 'failed', exitCode: 255, startedAt: 1000, exitedAt: 72000 }],
  })
}

function assistant(entryId: string, blocks: PiAssistantMessageItem['blocks']): PiAssistantMessageItem {
  return {
    kind: 'assistant_message', entryId, blocks, timestamp: 1000, toolResults: {},
    rawEntry: {} as PiAssistantMessageItem['rawEntry'],
    message: {
      role: 'assistant', content: blocks, api: 'anthropic-messages', provider: 'anthropic', model: 'model',
      stopReason: 'toolUse', timestamp: 1000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  }
}

const call = (id: string) => ({ type: 'toolCall' as const, id, name: 'read', arguments: { path: 'README.md' } })

describe('background delivery executions', () => {
  it('uses the generic shared tool renderer and preserves supervisor failure and duration', () => {
    const execution = backgroundJobExecutions(supervisor())![0]
    expect(execution).toMatchObject({
      backgroundJob: true, startedAt: 0, completedAt: 71000,
      call: { id: 'job:supervisor:preview-unit:0', name: 'job', arguments: { description: 'title-ui-preview', kind: 'service' } },
      result: { isError: true, details: { exit: 255 }, timestamp: 71000 },
    })
    expect(execution.result?.content).toEqual([{ type: 'text', text: 'Supervised process title-ui-preview failed with exit code 255.' }])
  })

  it('caches by entry reference and gives repeat deliveries independent execution ids', () => {
    const item = supervisor()
    const executions = backgroundJobExecutions(item)!
    expect(backgroundJobExecutions(item)).toBe(executions)
    expect(backgroundJobExecutions(supervisor('next-exit'))![0].call.id).not.toBe(executions[0].call.id)
    expect(backgroundJobExecutions({ ...item, display: false })).toBeUndefined()
  })

  it('preserves failure and full-output references for relayed task results', () => {
    const execution = backgroundJobExecutions(delivery('relay', 'irc:incoming', 'Model envelope', {
      id: 'wake-title', from: 'TitleRuntime', wakeRelay: true,
      message: '<task-result id="TitleRuntime" status="failed" duration="2s">\n<error>Preview failed</error>\n<preview full-output="history://TitleRuntime">Log tail</preview>\n</task-result>',
    }))![0]
    expect(execution.call).toMatchObject({ name: 'job', arguments: { description: 'TitleRuntime', kind: 'irc' } })
    expect(execution.result).toMatchObject({
      isError: true, details: { fullOutputPath: 'history://TitleRuntime', truncated: true },
      content: [{ type: 'text', text: 'Log tail\n\nPreview failed\n\nFull output: history://TitleRuntime' }],
    })
    expect(execution.completedAt).toBe(2000)
  })

  it('preserves async task output metadata on the generic result', () => {
    const meta = { truncation: { truncated: true, artifactId: 'task-log' } }
    const execution = backgroundJobExecutions(delivery('task', 'async-result', 'Log tail', {
      jobs: [{ jobId: 'TitleRuntime', type: 'task', status: 'completed', meta }],
    }))![0]
    expect(execution.call.name).toBe('job')
    expect(execution.result?.details).toEqual({ meta })
  })

  it('treats IRC progress and async notify as delivered snapshots without starting permanent running rows', () => {
    const messages = [
      delivery('progress', 'irc:incoming', '', { id: 'progress', from: 'TitleRuntime', message: 'Still working', progress: true }),
      delivery('notify', 'async-notify', '', {
        reports: [{ id: 'preview', type: 'service', pattern: 'ready', lines: ['Server ready'], running: true, omitted: 0, stopped: false }],
      }),
    ]
    for (const item of messages) {
      const execution = backgroundJobExecutions(item)![0]
      expect(execution.call.name).toBe('job')
      expect(execution.isRunning).toBeUndefined()
      expect(execution.startedAt).toBeUndefined()
      expect(execution.result?.isError).toBe(false)
    }
  })

  it('joins supervisor, IRC and async task deliveries into the adjacent tool chain with stable identity', () => {
    const first = assistant('first', [call('read-first')])
    const last = { ...assistant('last', [call('read-last')]), isStreaming: true }
    const sources = [first, supervisor(), delivery('irc', 'irc:incoming', 'Model envelope', {
      id: 'title-reply', from: 'TitleRuntime', message: 'Finished review',
    }), delivery('task', 'async-result', 'Task output', { jobs: [{ jobId: 'TitleRuntime', type: 'task', status: 'completed' }] }), last]
    const entries = buildVisibleTimelineEntries(sources)
    expect(entries.map(entry => entry.sourceIds)).toEqual([['first', 'supervisor', 'irc', 'task', 'last']])
    const merged = entries[0].item as PiAssistantMessageItem
    expect(merged.blocks).toHaveLength(5)
    expect(merged.message).toBe(last.message)
    expect(merged.isStreaming).toBe(true)
    expect(merged.toolResults['job:supervisor:preview-unit:0'].isError).toBe(true)
    expect(merged.toolResults['job:irc:title-reply:0'].content).toEqual([{ type: 'text', text: 'Finished review' }])
    expect(merged.toolExecutions?.['job:irc:title-reply:0'].backgroundJob).toBe(true)
    expect(buildVisibleTimelineEntries([...sources])[0].item).toBe(merged)
  })

  it('keeps deliveries after prose separate and respects explicit merge boundaries', () => {
    const notice = supervisor()
    const prose = assistant('prose', [{ type: 'text', text: 'Status update' }])
    const tools = assistant('tools', [call('read')])
    expect(buildVisibleTimelineEntries([prose, notice, tools]).map(entry => entry.sourceIds))
      .toEqual([['prose'], ['supervisor'], ['tools']])
    expect(buildVisibleTimelineEntries([tools, notice], new Set(['supervisor'])).map(entry => entry.sourceIds))
      .toEqual([['tools'], ['supervisor']])
  })
})
