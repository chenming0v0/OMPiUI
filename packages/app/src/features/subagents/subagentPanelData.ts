import { isJsonObject } from '@ompiui/protocol'
import type { PiTimelineItem, PiToolExecution } from '../../omp/domain/index.js'
import type { OmpSubagentRun } from '../../omp/ompSubagentStore'
import { deriveTaskOutcome, getTaskExecutionOutcome, type TaskOutcome } from '../../omp/taskOutcome'
import { readAgentMessage, readBackgroundJobs } from '../message/parts/customMessagePresentation'
import { extractTaskProgress, findAsyncTaskResult, getTaskToolView, indexAsyncTaskResults } from '../message/tools/taskToolData'
import { buildPersistedSubagentRun, deriveChildSessionFile, extractPersistedResults } from '../message/tools/renderers/persistedSubagentRun'

export interface SubagentPanelEntry {
  key: string
  id: string
  title: string
  toolCallId?: string
  index: number
  run?: OmpSubagentRun
  live: boolean
  outcome: TaskOutcome
  output?: string
  reports?: { id: string; body: string }[]
}

/** 复用主时间线的调用/结果配对；异步派发回执不充当子代理完成证据。 */
export function collectSubagentPanelEntries(sessionId: string, items: PiTimelineItem[], liveRuns: OmpSubagentRun[], parentFile?: string): SubagentPanelEntry[] {
  const entries: SubagentPanelEntry[] = []
  const deliveries = indexAsyncTaskResults(items.flatMap(item => 'rawEntry' in item && item.rawEntry ? [item.rawEntry] : []))
  const displayDeliveries = new Map<string, string>()
  for (const item of items) {
    if (item.kind !== 'custom_message' || item.customType !== 'async-result') continue
    for (const job of readBackgroundJobs(item) ?? []) {
      displayDeliveries.set(`${item.timestamp}:${job.id}`, [job.body, ...job.errors, job.fullOutput ? `Full output: ${job.fullOutput}` : ''].filter(Boolean).join('\n\n'))
    }
  }
  const executions: PiToolExecution[] = items.flatMap(item => item.kind === 'tool_result' ? [item.execution]
    : item.kind === 'assistant_message' ? item.blocks.flatMap(call => call.type === 'toolCall'
      ? [{ ...item.toolExecutions?.[call.id], call, result: item.toolResults[call.id] ?? item.toolExecutions?.[call.id]?.result }] : []) : [])
  const matched = new Set<OmpSubagentRun>()
  for (const raw of executions) {
    const view = getTaskToolView(raw)
    if (!view || view.argumentsState === 'invalid') continue
    const execution = view.execution
    const args = execution.call.arguments
    const inputs = Array.isArray(args.tasks) ? args.tasks.filter(isJsonObject) : [args]
    const details = isJsonObject(execution.result?.details) ? execution.result.details : undefined
    const results = extractPersistedResults(details)
    const progress = extractTaskProgress(details)
    const indices = new Set([...inputs.map((_, index) => index), ...results.map((result, index) => result.index ?? index)])
    for (const index of indices) {
      const input = inputs[index] ?? {}
      const result = results.find((result, position) => (result.index ?? position) === index)
      const id = typeof input.name === 'string' ? input.name : result?.id ?? progress.find(item => item.index === index)?.id ?? `#${index + 1}`
      const liveRun = liveRuns.find(run => run.parentToolCallId === execution.call.id && (run.id === id || run.index === index))
      if (liveRun) matched.add(liveRun)
      const delivery = findAsyncTaskResult(deliveries, id, execution.result?.timestamp)
      const deliveredOutput = delivery ? displayDeliveries.get(`${delivery.timestamp}:${id}`) ?? delivery.output : undefined
      const evidence = result ?? (delivery ? { ...delivery.details, id, output: delivery.output } : undefined)
      const outcome = getTaskExecutionOutcome(execution, { slotIndex: index, liveRun, result: evidence })
      const persisted = { ...input, ...evidence, id, index, status: outcome.executionStatus }
      const started = Boolean(evidence || execution.startedAt !== undefined || execution.isRunning || outcome.executionStatus === 'running')
      const base = started ? buildPersistedSubagentRun(execution.call.id, persisted, deriveChildSessionFile(persisted, parentFile), sessionId) : undefined
      entries.push({ key: `${execution.call.id}:${index}`, id, index, toolCallId: execution.call.id, live: Boolean(liveRun),
        title: typeof input.description === 'string' ? input.description : result?.description ?? liveRun?.description ?? '',
        run: liveRun ?? base, outcome, output: liveRun?.isFollowUp ? undefined : [result?.output, result?.stdout, result?.stderr, result?.error, result?.mergeError, deliveredOutput].filter(Boolean).join('\n') })
    }
  }
  for (const run of liveRuns) {
    if (matched.has(run)) continue
    entries.push({ key: `live:${run.id}`, id: run.id, title: run.description ?? '', index: run.index,
      toolCallId: run.parentToolCallId, run, live: true,
      outcome: getTaskExecutionOutcome({ call: { type: 'toolCall', id: run.parentToolCallId ?? run.id, name: 'task', arguments: {} } }, { liveRun: run }) })
  }
  for (const item of items) {
    if (item.kind !== 'custom_message' || item.customType !== 'irc:incoming') continue
    const report = readAgentMessage(item)
    if (!report) continue
    let entry = entries.findLast(entry => entry.id === report.sender)
    if (!entry) {
      entry = { key: `agent:${report.sender}`, id: report.sender, title: '', index: 0, live: false, outcome: deriveTaskOutcome() }
      entries.push(entry)
    }
    const body = readBackgroundJobs(item)?.[0]?.body ?? report.body
    entry.reports ??= []
    entry.reports.push({ id: item.entryId, body })
  }
  return entries.sort((a, b) => Number(b.outcome.presentationStatus === 'running') - Number(a.outcome.presentationStatus === 'running'))
}
