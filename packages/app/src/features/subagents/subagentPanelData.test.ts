import { describe, expect, it } from 'vitest'
import { selectPiTimelineItems } from '../../omp/selectors'
import type { PiBranchPage, PiTimelineItem } from '../../omp/domain'
import type { OmpSubagentRun } from '../../omp/ompSubagentStore'
import { collectSubagentPanelEntries } from './subagentPanelData'
import { xdTaskAsyncCall, xdTaskAsyncDelivery, xdTaskAsyncResult } from '../message/tools/__fixtures__/xdTaskAsyncDispatch'

function asyncTimeline(): PiTimelineItem[] {
  return selectPiTimelineItems({ items: [
    { type: 'message', id: 'call', timestamp: '2026-10-25T16:32:46Z', message: { role: 'assistant', content: [xdTaskAsyncCall] } },
    { type: 'message', id: 'receipt', timestamp: '2026-10-25T16:32:47Z', message: xdTaskAsyncResult },
    xdTaskAsyncDelivery,
  ] } as unknown as PiBranchPage)
}

describe('subagent sidebar catalog', () => {
  it('restores dispatched agents and delivered completion with their own transcript paths', () => {
    const entries = collectSubagentPanelEntries('parent', asyncTimeline(), [], 'C:/sessions/parent.jsonl')
    expect(entries.map(entry => entry.id)).toEqual(['ReviewNativeIntegration', 'ReviewGuiGitIntegration'])
    expect(entries.map(entry => entry.outcome.presentationStatus)).toEqual(['running', 'completed'])
    expect(entries[0].run?.sessionFile).toBe('C:/sessions/parent/ReviewNativeIntegration.jsonl')
    expect(entries[1].output).toContain('## Findings')
    expect(entries[1].output).not.toContain('Retry345Review')
    expect(entries[1].output).not.toContain('<system-notice>')
    expect(entries.every(entry => !entry.live)).toBe(true)
  })

  it('keeps an observed run visible without a parent call', () => {
    const run: OmpSubagentRun = { id: 'Scout', sessionId: 'parent', agent: 'scout', task: 'Inspect files',
      status: 'running', index: 0, detached: true, transcript: [], startedAt: 1 }
    const entries = collectSubagentPanelEntries('parent', [], [run])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'Scout', live: true, outcome: { presentationStatus: 'running' } })
    expect(entries[0].run).toBe(run)
  })

  it('shows incoming agent reports even when the task call is outside the loaded history', () => {
    const item = { kind: 'custom_message', entryId: 'report', customType: 'irc:incoming', timestamp: 1, display: true,
      content: '<irc>internal envelope</irc>', details: { from: 'TitleRuntime', message: 'Working on title loading' } } as PiTimelineItem
    const entries = collectSubagentPanelEntries('parent', [item], [])
    expect(entries).toMatchObject([{ id: 'TitleRuntime', reports: [{ body: 'Working on title loading' }], outcome: { executionStatus: 'unknown' } }])
  })

  it('uses a matching live generation without duplicating the historical task', () => {
    const run: OmpSubagentRun = { id: 'ReviewNativeIntegration', sessionId: 'parent', parentToolCallId: xdTaskAsyncCall.id,
      agent: 'scout', task: 'Current task', status: 'running', index: 0, detached: true, transcript: [], startedAt: 1 }
    const entries = collectSubagentPanelEntries('parent', asyncTimeline(), [run])
    expect(entries).toHaveLength(2)
    expect(entries[0].run).toBe(run)
  })
})
