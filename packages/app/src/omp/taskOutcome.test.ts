import { describe, expect, it } from 'vitest'
import type { PiToolExecution } from './domain/index.js'
import { getToolExecutionStatus } from './domain/index.js'
import { deriveTaskOutcome, getTaskExecutionOutcome } from './taskOutcome'
import { buildPersistedSubagentRun } from '../features/message/tools/renderers/persistedSubagentRun'

function task(details?: unknown, isError = false): PiToolExecution {
  return { call: { type: 'toolCall', id: 'task-call', name: 'task', arguments: { tasks: [{ name: 'A' }, { name: 'B' }] } },
    result: { role: 'toolResult', toolCallId: 'task-call', toolName: 'task', content: [{ type: 'text', text: 'completed <merge-summary>success</merge-summary>' }], timestamp: 2, isError, details } }
}

describe('structured task outcomes', () => {
  it.each([
    [undefined, 'unconfirmed', 'unconfirmed'],
    [false, 'failed', 'failed'],
    [true, 'unconfirmed', 'confirmed'],
    [null, 'unconfirmed', 'skipped'],
  ] as const)('separates execution, overall merge and root changesApplied=%s', (changesApplied, mergeStatus, rootMergeStatus) => {
    const evidence = { exitCode: 0, ...(changesApplied !== undefined ? { changesApplied } : {}) }
    expect(deriveTaskOutcome(evidence)).toEqual({ executionStatus: 'completed', mergeStatus, rootMergeStatus,
      presentationStatus: changesApplied === false ? 'error' : 'unknown' })
    expect(buildPersistedSubagentRun('call', { id: 'A', ...evidence }, 'C:/sessions/A.jsonl', 'parent')).toMatchObject({ status: 'completed', mergeStatus })
  })

  it('keeps exit0 execution completed while explicit merge failure is red', () => {
    expect(deriveTaskOutcome({ exitCode: 0, mergeError: 'Conflict' })).toMatchObject({ executionStatus: 'completed', mergeStatus: 'failed', presentationStatus: 'error' })
    expect(deriveTaskOutcome({ mergeError: 'Conflict' })).toMatchObject({ executionStatus: 'unknown', mergeStatus: 'failed', presentationStatus: 'error' })
  })

  it('does not infer execution or merge success from empty/missing details or output text', () => {
    expect(deriveTaskOutcome({})).toMatchObject({ executionStatus: 'unknown', mergeStatus: 'unconfirmed' })
    expect(getToolExecutionStatus(task())).toBe('unknown')
    expect(buildPersistedSubagentRun('call', { id: 'A' }, undefined, 'parent')).toMatchObject({ status: 'unknown', mergeStatus: 'unconfirmed' })
  })

  it('only confirms the explicit root layer, never a child or overall merge', () => {
    expect(deriveTaskOutcome({ exitCode: 0, changesApplied: true }, {})).toMatchObject({ mergeStatus: 'unconfirmed', rootMergeStatus: 'unconfirmed', presentationStatus: 'unknown' })
    expect(deriveTaskOutcome({ exitCode: 0 }, { changesApplied: null })).toMatchObject({ rootMergeStatus: 'skipped', presentationStatus: 'unknown' })
  })

  it('uses own evidence for mixed batches and leaves absent children unknown', () => {
    const execution = task({ results: [{ index: 0, id: 'A', exitCode: 0 }, { index: 1, id: 'B', exitCode: 0, changesApplied: false }] }, true)
    expect(getTaskExecutionOutcome(execution).presentationStatus).toBe('error')
    expect(getTaskExecutionOutcome(execution, { slotIndex: 0 })).toMatchObject({ executionStatus: 'completed', presentationStatus: 'unknown' })
    expect(getTaskExecutionOutcome(execution, { slotIndex: 1 })).toMatchObject({ executionStatus: 'completed', presentationStatus: 'error' })
    expect(getTaskExecutionOutcome(execution, { slotIndex: 2 })).toMatchObject({ executionStatus: 'unknown', presentationStatus: 'unknown' })
  })

  it('a root failure does not reclassify a successful sibling as execution failed', () => {
    const execution = task({ changesApplied: false, results: [{ index: 0, id: 'A', exitCode: 0 }] })
    expect(getTaskExecutionOutcome(execution).presentationStatus).toBe('error')
    expect(getTaskExecutionOutcome(execution, { slotIndex: 0 })).toMatchObject({ executionStatus: 'completed', mergeStatus: 'unconfirmed', rootMergeStatus: 'failed', presentationStatus: 'unknown' })
  })

  it('does not use a dispatch receipt or timestamp to prove child completion', () => {
    expect(getTaskExecutionOutcome(task({ async: { state: 'running' }, results: [] }), { slotIndex: 0 })).toMatchObject({ executionStatus: 'running', mergeStatus: 'unconfirmed' })
    expect(getTaskExecutionOutcome(task({ results: [] }), { slotIndex: 0 }).executionStatus).toBe('unknown')
    expect(getTaskExecutionOutcome({ call: task().call, completedAt: 2 }, { slotIndex: 0 }).executionStatus).toBe('unknown')
  })

  it('keeps unknown interruption diagnostic without treating it as proven execution failure', () => {
    const execution: PiToolExecution = { call: task().call, startedAt: 1, endedAt: 2,
      interruption: 'unknown', error: 'Runtime ended without a terminal result' }
    expect(getTaskExecutionOutcome(execution, { runtimeStopped: true })).toMatchObject({ executionStatus: 'unknown', presentationStatus: 'unknown', mergeStatus: 'unconfirmed' })
    expect(getTaskExecutionOutcome(execution, { slotIndex: 0, runtimeStopped: true }).executionStatus).toBe('unknown')
    expect(getToolExecutionStatus(execution)).toBe('unknown')
    expect(execution.error).toBe('Runtime ended without a terminal result')
    expect(getTaskExecutionOutcome(execution, { slotIndex: 0, result: { exitCode: 0 } })).toMatchObject({ executionStatus: 'completed', presentationStatus: 'unknown' })
    expect(getTaskExecutionOutcome(execution, { slotIndex: 1, result: { exitCode: 1 } })).toMatchObject({ executionStatus: 'failed', presentationStatus: 'error' })
  })

  it('ignores the previous parent result and failure for a follow-up generation', () => {
    const execution = task({ changesApplied: false, results: [{ id: 'A', exitCode: 1, error: 'Old failure' }] }, true)
    expect(getTaskExecutionOutcome(execution, { slotIndex: 0, liveRun: { isFollowUp: true, status: 'running' }, runtimeStopped: true })).toMatchObject({ executionStatus: 'running', mergeStatus: 'unconfirmed', presentationStatus: 'running' })
    expect(getTaskExecutionOutcome(execution, { slotIndex: 0, liveRun: { isFollowUp: true, status: 'completed' } })).toMatchObject({ executionStatus: 'completed', mergeStatus: 'unconfirmed', presentationStatus: 'unknown' })
  })

  it('preserves non-task tool status semantics', () => {
    const execution = task({ mergeError: 'Conflict' })
    execution.call.name = 'eval'
    expect(getToolExecutionStatus(execution)).toBe('error')
    execution.result!.details = undefined
    expect(getToolExecutionStatus(execution)).toBe('completed')
  })
})
