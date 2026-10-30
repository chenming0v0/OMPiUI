import { isJsonObject } from '@ompiui/protocol'
import type { PiToolExecution } from './domain/index.js'

export type TaskExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'unknown'
export type TaskPresentationStatus = 'pending' | 'running' | 'completed' | 'error' | 'unknown'
export type TaskMergeStatus = 'unconfirmed' | 'failed'
export type TaskRootMergeStatus = TaskMergeStatus | 'confirmed' | 'skipped'

export interface TaskOutcome {
  executionStatus: TaskExecutionStatus
  /** No native overall-merge contract exists yet. Root application is not overall success. */
  mergeStatus: TaskMergeStatus
  rootMergeStatus: TaskRootMergeStatus
  presentationStatus: TaskPresentationStatus
}

function mergeFailed(evidence: Record<string, unknown> | undefined): boolean {
  return Boolean(evidence?.mergeError) || evidence?.changesApplied === false || evidence?.mergeStatus === 'failed'
}

function executionStatus(evidence: Record<string, unknown> | undefined): TaskExecutionStatus {
  if (evidence?.aborted === true || ['aborted', 'cancelled', 'killed'].includes(String(evidence?.status))) return 'aborted'
  if (evidence?.error) return 'failed'
  if (typeof evidence?.exitCode === 'number') return evidence.exitCode === 0 ? 'completed' : 'failed'
  switch (evidence?.status) {
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'started':
    case 'running': return 'running'
    case 'pending': return 'pending'
    default: return 'unknown'
  }
}

/** Pure UI projection of structured native evidence only. Never read status from output text. */
export function deriveTaskOutcome(evidence?: unknown, root?: unknown): TaskOutcome {
  const record = isJsonObject(evidence) ? evidence : undefined
  const rootRecord = root === undefined ? record : isJsonObject(root) ? root : undefined
  const execution = executionStatus(record)
  const mergeStatus: TaskMergeStatus = mergeFailed(record) ? 'failed' : 'unconfirmed'
  const rootMergeStatus: TaskRootMergeStatus = mergeFailed(rootRecord) ? 'failed'
    : rootRecord?.changesApplied === true ? 'confirmed'
      : rootRecord?.changesApplied === null ? 'skipped' : 'unconfirmed'
  return {
    executionStatus: execution,
    mergeStatus,
    rootMergeStatus,
    presentationStatus: execution === 'failed' || execution === 'aborted' || mergeStatus === 'failed' ? 'error'
      : execution === 'completed' ? 'unknown' : execution,
  }
}

/** Native task and the existing xd://task envelope; other tools retain their own semantics. */
export function isTaskExecution(execution: PiToolExecution): boolean {
  return execution.call.name.toLowerCase() === 'task' ||
    (execution.call.name === 'write' && execution.call.arguments?.path === 'xd://task')
}

export function taskResultDetails(execution: PiToolExecution): Record<string, unknown> | undefined {
  const details = isJsonObject(execution.result?.details) ? execution.result.details : undefined
  const xdev = isJsonObject(details?.xdev) && details.xdev.tool === 'task' ? details.xdev : undefined
  return xdev && isJsonObject(xdev.inner) ? xdev.inner : details
}

export function taskResultAt(details: Record<string, unknown> | undefined, index: number): Record<string, unknown> | undefined {
  if (!Array.isArray(details?.results)) return undefined
  return details.results.find((result, position) => isJsonObject(result) && (typeof result.index === 'number' ? result.index : position) === index)
}

/** Per-child evidence beats aggregate failure; a reused live generation ignores the old parent result. */
export function getTaskExecutionOutcome(execution: PiToolExecution, options: {
  slotIndex?: number
  liveRun?: unknown
  result?: unknown
  runtimeStopped?: boolean
  hasLiveRuns?: boolean
} = {}): TaskOutcome {
  const details = taskResultDetails(execution)
  if (execution.awaitingSnapshot) return deriveTaskOutcome({ status: 'unknown' }, details)
  const live = isJsonObject(options.liveRun) ? options.liveRun : undefined
  const slotResult = options.result ?? (options.slotIndex !== undefined ? taskResultAt(details, options.slotIndex) : undefined)
  if (live?.isFollowUp) return deriveTaskOutcome(live)
  if (slotResult || live) {
    const evidence = isJsonObject(slotResult) && live ? { ...slotResult,
      ...(live.mergeError ? { mergeError: live.mergeError } : {}),
      ...(live.mergeStatus === 'failed' ? { mergeStatus: 'failed' } : {}),
      ...(live.changesApplied !== undefined ? { changesApplied: live.changesApplied } : {}) } : slotResult ?? live
    const outcome = deriveTaskOutcome(evidence, details)
    if (live && !slotResult && (live.status === 'pending' || live.status === 'running') && options.runtimeStopped && !live.detached) {
      return deriveTaskOutcome({ status: 'unknown', mergeStatus: outcome.mergeStatus }, details)
    }
    return outcome
  }
  const results = Array.isArray(details?.results) ? details.results.filter(isJsonObject) : []
  if (options.slotIndex === undefined && results.length) {
    const outcomes = results.map(result => deriveTaskOutcome(result, details))
    const args = execution.call.arguments
    const taskCount = Array.isArray(args?.tasks) ? args.tasks.length : results.length
    const status: TaskExecutionStatus = outcomes.some(outcome => outcome.executionStatus === 'failed') ? 'failed'
      : outcomes.some(outcome => outcome.executionStatus === 'aborted') ? 'aborted'
        : results.length >= taskCount && outcomes.every(outcome => outcome.executionStatus === 'completed') ? 'completed'
          : outcomes.some(outcome => outcome.executionStatus === 'running') ? 'running' : 'unknown'
    return deriveTaskOutcome({ status, ...(outcomes.some(outcome => outcome.mergeStatus === 'failed') || mergeFailed(details) ? { mergeStatus: 'failed' } : {}) }, details)
  }
  // A missing terminal frame is uncertainty, not a proven execution failure. Keep the diagnostic on execution.
  if (execution.interruption === 'unknown' && !execution.result) return deriveTaskOutcome({ status: 'unknown' }, details)
  // Only a rejected dispatch without any child evidence can attribute the outer failure to a slot.
  if (execution.error || (execution.result?.isError && !results.length)) {
    if (!execution.error && mergeFailed(details) && !details?.error) return deriveTaskOutcome(details, details)
    return deriveTaskOutcome({ error: execution.error || details?.error || 'Task dispatch failed', ...(mergeFailed(details) ? { mergeStatus: 'failed' } : {}) }, details)
  }
  const taskCount = Array.isArray(execution.call.arguments?.tasks) ? execution.call.arguments.tasks.length : 1
  if (options.slotIndex !== undefined && !results.length && taskCount <= 1 && execution.result && !isJsonObject(details?.async)) {
    return deriveTaskOutcome(details, details)
  }
  if (options.slotIndex === undefined && execution.result && !isJsonObject(details?.async)) {
    // Root execution fields can prove execution, never overall merge success.
    return deriveTaskOutcome(details, details)
  }
  if (execution.result || execution.completedAt !== undefined) {
    return deriveTaskOutcome({ status: isJsonObject(details?.async) && !options.runtimeStopped ? 'running' : 'unknown',
      ...(options.slotIndex === undefined && mergeFailed(details) ? { mergeStatus: 'failed' } : {}) }, details)
  }
  if (options.runtimeStopped && (execution.isRunning || execution.startedAt !== undefined)) return deriveTaskOutcome({ aborted: true })
  return deriveTaskOutcome({ status: options.slotIndex !== undefined && options.hasLiveRuns ? 'pending'
    : (execution.isRunning ?? execution.startedAt !== undefined) ? 'running' : 'pending' })
}
