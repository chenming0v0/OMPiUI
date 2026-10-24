import { afterEach, expect, it, vi } from 'vitest'
import { piEventStream } from './eventStream'
import * as controllers from './controllers/index.js'
import { liveToolOutputStore } from './liveToolOutput'
import { ompSubagentStore } from './ompSubagentStore'
import { piBranchStore, piSessionStateStore } from './state/index.js'
import { getToolExecutionStatus, type PiAssistantMessageItem, type PiBranchPage } from './domain/index.js'
import { selectPiTimelineItemsCached } from './selectors/timelineCache'
import { mergeLatestBranchPage } from './branchMerge'

afterEach(() => {
  piEventStream.disconnectAll()
  ompSubagentStore.clearAll()
  liveToolOutputStore.delete('traffic-tool')
  piBranchStore.clearAll()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('appends bash deltas without per-frame state reads and refreshes at the settled boundary', async () => {
  vi.useFakeTimers()
  const state = vi.spyOn(controllers, 'refreshPiSessionState').mockResolvedValue()
  vi.spyOn(controllers, 'refreshPiBranch').mockResolvedValue()
  const patch = vi.spyOn(piSessionStateStore, 'patchState')
  const emit = (event: unknown) => (piEventStream as unknown as { handlePiEvent(id: string, payload: unknown): void })
    .handlePiEvent('bash-session', { event, meta: { epoch: 'events', sequence: 1 } })
  for (let index = 0; index < 34; index++) {
    emit({ type: 'bash_execution_update', id: 'bash-output', delta: 'line\n' })
    await vi.advanceTimersByTimeAsync(300)
  }
  expect(state).not.toHaveBeenCalled()
  expect(patch).toHaveBeenLastCalledWith('bash-session', { isBashRunning: true, isIdle: false })
  emit({ type: 'agent_settled' })
  await vi.advanceTimersByTimeAsync(200)
  expect(state).toHaveBeenCalledOnce()
})

it('configuration updates do not mark bash as running', () => {
  const patch = vi.spyOn(piSessionStateStore, 'patchState')
  ;(piEventStream as unknown as { handlePiEvent(id: string, payload: unknown): void })
    .handlePiEvent('config-session', { event: { type: 'config_update', thinkingLevel: 'high' }, meta: { epoch: 'events', sequence: 1 } })
  expect(patch).toHaveBeenCalledWith('config-session', { thinkingLevel: 'high' })
  expect(patch).not.toHaveBeenCalledWith('config-session', expect.objectContaining({ isBashRunning: true }))
})

it('updates live tool output without polling state on every frame, then refreshes on completion', async () => {
  vi.useFakeTimers()
  const state = vi.spyOn(controllers, 'refreshPiSessionState').mockResolvedValue()
  const branch = vi.spyOn(controllers, 'refreshPiBranch').mockResolvedValue()
  const output = vi.spyOn(liveToolOutputStore, 'set')
  const emit = (event: unknown) => (piEventStream as unknown as { handlePiEvent(id: string, payload: unknown): void })
    .handlePiEvent('traffic-session', { event, meta: { epoch: 'events', sequence: 1 } })
  for (let i = 0; i < 34; i++) {
    emit({ type: 'tool_execution_update', toolCallId: 'traffic-tool', toolName: 'task', partialResult: { content: [{ type: 'text', text: `running ${i}` }] } })
    await vi.advanceTimersByTimeAsync(300)
  }
  expect(output).toHaveBeenCalledTimes(34)
  expect(output).toHaveBeenLastCalledWith('traffic-tool', 'traffic-session', 'running 33')
  expect(state).not.toHaveBeenCalled()
  expect(branch).not.toHaveBeenCalled()
  emit({ type: 'tool_execution_end', toolCallId: 'traffic-tool', toolName: 'task', result: { content: [{ type: 'text', text: 'complete result' }] } })
  await vi.advanceTimersByTimeAsync(200)
  expect(state).toHaveBeenCalledOnce()
  expect(branch).toHaveBeenCalledOnce()
})

it('restores projected progress from a reconnect state snapshot', () => {
  ompSubagentStore.applySnapshot('traffic-session', [{ id: 'child', parentToolCallId: 'traffic-tool', status: 'completed',
    agent: 'reviewer', task: 'verify', sessionFile: 'child.jsonl', index: 1, detached: false,
    progress: { id: 'child', status: 'completed', tokens: 99, requests: 2, durationMs: 200, recentTools: [], recentOutput: ['done'] } }])
  expect(ompSubagentStore.getRunsForToolCall('traffic-tool', 'traffic-session')[0]).toMatchObject({
    id: 'child', status: 'completed', sessionFile: 'child.jsonl', progress: { tokens: 99, recentOutput: ['done'] },
  })
})

it('projects queued/start/update/end transitions immediately and retains evidence during branch refresh', () => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  vi.spyOn(controllers, 'refreshPiBranch').mockResolvedValue()
  vi.spyOn(controllers, 'refreshPiSessionState').mockResolvedValue()
  const calls = ['bash', 'todo', 'read', 'write'].map(name => ({ type: 'toolCall' as const, id: `${name}-batch`, name, arguments: {} }))
  const page: PiBranchPage = {
    items: [{ type: 'message', id: 'assistant-batch', parentId: null, timestamp: new Date(1_000).toISOString(),
      message: { role: 'assistant', content: calls, timestamp: 1_000 } } as PiBranchPage['items'][number]],
    head: { sdkVersion: '18', revision: 1, header: null, leafId: 'assistant-batch', entryCount: 1, epoch: 'history' },
    checkpoint: { position: { epoch: 'events', sequence: 1 } }, hasMore: false,
  }
  piBranchStore.setData('batch-session', page)
  const readExecutions = () => {
    const item = selectPiTimelineItemsCached('batch-session', piBranchStore.getData('batch-session'))[0] as PiAssistantMessageItem
    return calls.map(call => ({ ...item.toolExecutions?.[call.id], call, result: item.toolResults[call.id] }))
  }
  const emit = (event: unknown) => (piEventStream as unknown as { handlePiEvent(id: string, payload: unknown): void })
    .handlePiEvent('batch-session', { event, meta: { epoch: 'events', sequence: 2 } })
  expect(readExecutions().map(getToolExecutionStatus)).toEqual(['pending', 'pending', 'pending', 'pending'])
  emit({ type: 'tool_execution_start', toolCallId: calls[0].id, toolName: 'bash', args: {} })
  expect(readExecutions().map(getToolExecutionStatus)).toEqual(['running', 'pending', 'pending', 'pending'])
  expect(readExecutions()[0].startedAt).toBe(10_000)
  piBranchStore.setData('batch-session', mergeLatestBranchPage(piBranchStore.getData('batch-session'), page))
  expect(readExecutions()[0].startedAt).toBe(10_000)
  emit({ type: 'tool_execution_update', toolCallId: calls[1].id, toolName: 'todo', args: {}, partialResult: { content: [] } })
  expect(readExecutions().map(getToolExecutionStatus)).toEqual(['running', 'running', 'pending', 'pending'])
  expect(readExecutions()[1].startedAt).toBeUndefined()
  emit({ type: 'tool_execution_end', toolCallId: calls[0].id, toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'done' }] } })
  expect(readExecutions().map(getToolExecutionStatus)).toEqual(['completed', 'running', 'pending', 'pending'])
  expect(readExecutions()[0].result?.content).toEqual([{ type: 'text', text: 'done' }])
  emit({ type: 'tool_execution_start', toolCallId: calls[0].id, toolName: 'bash', args: {} })
  expect(getToolExecutionStatus(readExecutions()[0])).toBe('completed')
})
