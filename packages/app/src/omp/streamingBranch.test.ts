import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiBranchPage } from './domain/index.js'
import { piEventStream } from './eventStream'
import { loadPiSessionData, refreshPiBranch } from './controllers/index.js'
import * as transport from './transport/index.js'
import { piBranchStore, piSessionStateStore } from './state/index.js'
import { selectPiTimelineItems } from './selectors/index.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function branch(completed = false): PiBranchPage {
  return {
    head: {
      sdkVersion: 'test', revision: completed ? 2 : 1, header: null,
      leafId: completed ? 'result' : 'call', entryCount: completed ? 2 : 1, epoch: completed ? 'history:2' : 'history:1',
    },
    items: [
      {
        type: 'message', id: 'call', parentId: null, timestamp: '2026-10-11T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'eval-call', name: 'eval', arguments: { code: 'print(200)' } }],
        },
      },
      ...(completed ? [{
        type: 'message', id: 'result', parentId: 'call', timestamp: '2026-10-11T00:00:20Z',
        message: {
          role: 'toolResult', toolCallId: 'eval-call', toolName: 'eval',
          content: [{ type: 'text', text: 'shutdown HTTP 200' }], isError: false,
        },
      }] : []),
    ],
    hasMore: false,
    checkpoint: { position: { epoch: 'events', sequence: 2 } },
  } as PiBranchPage
}

function event(type: string, sequence: number, fields: Record<string, unknown>) {
  ;(piEventStream as unknown as { handlePiEvent: (sessionId: string, payload: unknown) => void })
    .handlePiEvent('session-stream', {
      event: { type, ...fields },
      meta: { epoch: 'events', sequence, liveMessage: { id: 'thinking', revision: sequence } },
    })
}

function thinking(sequence: number, text: string) {
  event('message_update', sequence, {
    message: { role: 'assistant', timestamp: Date.parse('2026-10-11T00:00:21Z'), content: [{ type: 'thinking', thinking: text }] },
  })
}

describe('tool completion during assistant streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    piBranchStore.setData('session-stream', branch())
  })

  afterEach(() => {
    piEventStream.disconnectAll()
    piBranchStore.clearAll()
    piSessionStateStore.clearAll()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('merges a delayed tool result while preserving newer thinking deltas', async () => {
    const response = deferred<PiBranchPage>()
    vi.spyOn(transport, 'getPiBranchPage').mockReturnValueOnce(response.promise)
    event('tool_execution_end', 2, { toolCallId: 'eval-call', toolName: 'eval', result: { content: [{ type: 'text', text: 'shutdown HTTP 200' }] } })
    await vi.advanceTimersByTimeAsync(150)
    thinking(4, 'The process did not exit within 15s.')

    const latest = branch(true)
    latest.checkpoint!.liveMessage = {
      id: 'thinking', revision: 3, phase: 'streaming',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'The process' }] },
    } as NonNullable<PiBranchPage['checkpoint']>['liveMessage']
    response.resolve(latest)
    await vi.advanceTimersByTimeAsync(0)

    const data = piBranchStore.getData('session-stream')!
    const owner = selectPiTimelineItems(data).find(item => item.kind === 'assistant_message' && item.entryId === 'call')
    expect(owner?.kind === 'assistant_message' && owner.toolResults['eval-call']).toMatchObject({
      content: [{ type: 'text', text: 'shutdown HTTP 200' }],
    })
    expect(data.checkpoint?.liveMessage?.message).toMatchObject({
      content: [{ type: 'thinking', thinking: 'The process did not exit within 15s.' }],
    })
    expect(data.checkpoint?.position).toEqual({ epoch: 'events', sequence: 4 })
  })

  it('hydrates a reconnect preview without discarding tool results or newer thinking', async () => {
    const response = deferred<Awaited<ReturnType<typeof transport.previewPiSession>>>()
    vi.spyOn(transport, 'previewPiSession').mockReturnValueOnce(response.promise)
    const loading = loadPiSessionData('session-stream')
    thinking(4, 'Already continuing.')
    response.resolve({ state: { isStreaming: true }, branch: branch(true) })
    await loading

    const data = piBranchStore.getData('session-stream')!
    expect(data.items.map(item => item.id)).toEqual(['call', 'result'])
    expect(data.checkpoint?.liveMessage?.message).toMatchObject({
      content: [{ type: 'thinking', thinking: 'Already continuing.' }],
    })
  })

  it('still discards a delayed branch response after the session store is cleared', async () => {
    const response = deferred<PiBranchPage>()
    vi.spyOn(transport, 'getPiBranchPage').mockReturnValueOnce(response.promise)
    const refreshing = refreshPiBranch('session-stream')
    thinking(4, 'Already continuing.')
    piBranchStore.clear('session-stream')
    response.resolve(branch(true))
    await refreshing
    expect(piBranchStore.getData('session-stream')).toBeNull()
  })
})
