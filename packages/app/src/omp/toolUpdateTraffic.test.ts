import { afterEach, expect, it, vi } from 'vitest'
import { piEventStream } from './eventStream'
import * as controllers from './controllers/index.js'
import { liveToolOutputStore } from './liveToolOutput'
import { ompSubagentStore } from './ompSubagentStore'

afterEach(() => {
  piEventStream.disconnectAll()
  ompSubagentStore.clearAll()
  liveToolOutputStore.delete('traffic-tool')
  vi.restoreAllMocks()
  vi.useRealTimers()
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
