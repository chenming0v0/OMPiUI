import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '@ompiui/protocol'
import * as transport from '../transport/index.js'
import { loadPiSessionData, refreshPiSessionState, refreshPiBranch } from './index.js'
import { piSessionStateStore, piBranchStore } from '../state/index.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('session state response ordering', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    piSessionStateStore.clearAll()
    piBranchStore.clear('session-a')
  })

  it('does not let an older state read overwrite newer model, thinking and idle state', async () => {
    const old = deferred<JsonObject>()
    vi.spyOn(transport, 'getPiSessionState')
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ model: { provider: 'new', id: 'correct' }, thinkingLevel: 'xhigh', isStreaming: false })
    const first = refreshPiSessionState('session-a')
    await refreshPiSessionState('session-a')
    old.resolve({ model: { provider: 'old', id: 'wrong' }, thinkingLevel: 'low', isStreaming: true })
    await first
    expect(piSessionStateStore.getState('session-a')).toMatchObject({
      model: { provider: 'new', id: 'correct' }, thinkingLevel: 'xhigh', isStreaming: false,
    })
  })

  it('does not let a slow preview overwrite a newer runtime state on switching back', async () => {
    const preview = deferred<Awaited<ReturnType<typeof transport.previewPiSession>>>()
    vi.spyOn(transport, 'previewPiSession').mockReturnValueOnce(preview.promise)
    vi.spyOn(transport, 'getPiSessionState').mockResolvedValueOnce({
      model: { provider: 'new', id: 'correct' }, thinkingLevel: 'high', isStreaming: false,
    })
    const loading = loadPiSessionData('session-a')
    await refreshPiSessionState('session-a')
    preview.resolve({
      state: { model: null, thinkingLevel: 'off', isStreaming: true },
      branch: { head: { sdkVersion: 'test', revision: 1, header: null, leafId: null, entryCount: 0, epoch: 'test' }, items: [], hasMore: false },
    })
    await loading
    expect(piSessionStateStore.getState('session-a')).toMatchObject({
      model: { provider: 'new', id: 'correct' }, thinkingLevel: 'high', isStreaming: false,
    })
    expect(piBranchStore.getData('session-a')).not.toBeNull()
  })

  it('does not resurrect streaming when a stale read finishes after a settled event', async () => {
    const old = deferred<JsonObject>()
    vi.spyOn(transport, 'getPiSessionState').mockReturnValueOnce(old.promise)
    piSessionStateStore.setState('session-a', { isStreaming: true })
    const reading = refreshPiSessionState('session-a')
    piSessionStateStore.patchState('session-a', { isStreaming: false, isIdle: true })
    old.resolve({ isStreaming: true, isIdle: false })
    await reading
    expect(piSessionStateStore.getState('session-a')).toMatchObject({ isStreaming: false, isIdle: true })
  })

  it('keeps parallel session reads independent', async () => {
    vi.spyOn(transport, 'getPiSessionState')
      .mockResolvedValueOnce({ thinkingLevel: 'high' })
      .mockResolvedValueOnce({ thinkingLevel: 'low' })
    await Promise.all([refreshPiSessionState('session-a'), refreshPiSessionState('session-b')])
    expect(piSessionStateStore.getState('session-a')?.thinkingLevel).toBe('high')
    expect(piSessionStateStore.getState('session-b')?.thinkingLevel).toBe('low')
  })

  it('does not let a slow preview replace newer branch data or its live message', async () => {
    const preview = deferred<Awaited<ReturnType<typeof transport.previewPiSession>>>()
    vi.spyOn(transport, 'previewPiSession').mockReturnValueOnce(preview.promise)
    const loading = loadPiSessionData('session-a')
    const latest = {
      head: { sdkVersion: 'test', revision: 2, header: null, leafId: null, entryCount: 0, epoch: 'test' },
      items: [], hasMore: false,
    }
    piBranchStore.setData('session-a', latest)
    preview.resolve({
      state: { isStreaming: false },
      branch: { ...latest, head: { ...latest.head, revision: 1 } },
    })
    await loading
    expect(piBranchStore.getData('session-a')).toBe(latest)
  })

  it('does not let an older branch refresh replace a newer response', async () => {
    const old = deferred<Awaited<ReturnType<typeof transport.getPiBranchPage>>>()
    const latest = {
      head: { sdkVersion: 'test', revision: 2, header: null, leafId: null, entryCount: 0, epoch: 'test' },
      items: [], hasMore: false,
    }
    vi.spyOn(transport, 'getPiBranchPage').mockReturnValueOnce(old.promise).mockResolvedValueOnce(latest)
    const first = refreshPiBranch('session-a')
    await refreshPiBranch('session-a')
    old.resolve({ ...latest, head: { ...latest.head, revision: 1 } })
    await first
    expect(piBranchStore.getData('session-a')?.head.revision).toBe(2)
  })
})
