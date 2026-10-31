import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiBranchPage } from './domain/index.js'
import { piEventStream } from './eventStream'
import { refreshPiBranch } from './controllers/index.js'
import * as transport from './transport/index.js'
import { piBranchStore, piSessionStateStore } from './state/index.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function branch(revision: number, streaming = false): PiBranchPage {
  return {
    head: { sdkVersion: 'test', revision, header: null, leafId: `entry-${revision}`, entryCount: revision, epoch: 'stable' },
    items: [{ type: 'message', id: `entry-${revision}`, parentId: null, timestamp: '2026-10-12T00:00:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: revision === 1 ? 'partial' : 'completed' }] } }],
    hasMore: false, syncCursor: `sync-${revision}`,
    checkpoint: {
      position: { epoch: 'events', sequence: revision },
      ...(streaming ? { liveMessage: { id: 'live', revision: 1, phase: 'streaming',
        message: { role: 'assistant', content: [{ type: 'text', text: 'still partial' }] } } } : {}),
    },
  } as PiBranchPage
}

describe('recovery response ordering', () => {
  beforeEach(() => { vi.useFakeTimers(); piEventStream.disconnectAll() })
  afterEach(() => {
    piEventStream.disconnectAll()
    piBranchStore.clearAll()
    piSessionStateStore.clearAll()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('keeps the requested tail refresh after a transient failure of the first flight', async () => {
    piBranchStore.setData('dirty', branch(1))
    const firstResponse = deferred<PiBranchPage>()
    const read = vi.spyOn(transport, 'getPiBranchPage')
      .mockReturnValueOnce(firstResponse.promise).mockResolvedValueOnce(branch(2))
    const first = refreshPiBranch('dirty')
    const tail = refreshPiBranch('dirty')
    const settled = Promise.all([first, tail])
    firstResponse.reject(Object.assign(new Error('temporary network interruption'), { status: 503 }))
    await settled
    expect(read).toHaveBeenCalledTimes(2)
    expect(piBranchStore.getData('dirty')?.head.revision).toBe(2)
  })

  it('publishes the authoritative completed branch and state immediately on foreground return', async () => {
    const sessionId = 'foreground-readback'
    piBranchStore.setData(sessionId, branch(1, true))
    piSessionStateStore.setState(sessionId, { isIdle: false, isStreaming: true })
    const internal = piEventStream as unknown as {
      refCounts: Map<string, number>
      ensureSocket(): void
    }
    internal.refCounts.set(sessionId, 1)
    vi.spyOn(internal, 'ensureSocket').mockImplementation(() => {})
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const history = vi.spyOn(transport, 'getPiBranchPage').mockResolvedValue(branch(2))
    const state = vi.spyOn(transport, 'getPiSessionState').mockResolvedValue({ isIdle: true, isStreaming: false })
    window.dispatchEvent(new Event('pageshow'))
    expect(history).toHaveBeenCalledWith(sessionId, expect.objectContaining({ includeLiveMessage: true }), expect.any(AbortSignal))
    expect(state).toHaveBeenCalledWith(sessionId, undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(piBranchStore.getData(sessionId)?.items.at(-1)?.id).toBe('entry-2')
    expect(piBranchStore.getData(sessionId)?.checkpoint?.liveMessage?.phase).not.toBe('streaming')
    expect(piSessionStateStore.getState(sessionId)).toMatchObject({ isStreaming: false, isIdle: true })
  })

  it('follows up an invalidated history response when idle state settles first', async () => {
    piBranchStore.setData('settled', branch(1, true))
    piSessionStateStore.setState('settled', { isIdle: false, isStreaming: true })
    const firstResponse = deferred<PiBranchPage>()
    const read = vi.spyOn(transport, 'getPiBranchPage')
      .mockReturnValueOnce(firstResponse.promise).mockResolvedValue(branch(2))
    vi.spyOn(transport, 'getPiSessionState').mockResolvedValue({ isIdle: true, isStreaming: false })
    ;(piEventStream as unknown as { handleResync(key: string): void }).handleResync('session:settled')
    await vi.advanceTimersByTimeAsync(150)
    expect(piBranchStore.getData('settled')?.checkpoint?.liveMessage?.phase).toBe('persisting')
    firstResponse.resolve(branch(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls.every(([, params]) => params?.syncCursor === 'sync-1')).toBe(true)
    expect(piBranchStore.getData('settled')?.head.revision).toBe(2)
    expect(piBranchStore.getData('settled')?.items.at(-1)?.id).toBe('entry-2')
  })
})
