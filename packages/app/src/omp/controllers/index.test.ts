import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '@ompiui/protocol'
import * as transport from '../transport/index.js'
import { loadPiSessionData, refreshPiSessionState, refreshPiBranch } from './index.js'
import { piSessionStateStore, piBranchStore } from '../state/index.js'
import { ompSubagentStore } from '../ompSubagentStore'

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
    ompSubagentStore.clearAll()
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

  it('hydrates subagent configuration when a lifecycle event arrives before the first preview', async () => {
    const preview = deferred<Awaited<ReturnType<typeof transport.previewPiSession>>>()
    vi.spyOn(transport, 'previewPiSession').mockReturnValueOnce(preview.promise)
    const loading = loadPiSessionData('session-a')
    piSessionStateStore.patchState('session-a', { isStreaming: false, isIdle: true })
    preview.resolve({
      state: { model: { provider: 'custom', id: 'child-model' }, thinkingLevel: 'high', isStreaming: true },
      branch: { head: { sdkVersion: 'test', revision: 1, header: null, leafId: null, entryCount: 0, epoch: 'test' }, items: [], hasMore: false },
    })
    await loading
    expect(piSessionStateStore.getState('session-a')).toMatchObject({
      model: { provider: 'custom', id: 'child-model' }, thinkingLevel: 'high', isStreaming: false, isIdle: true,
    })
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

  it('reconciles subagent snapshots despite repeated bash chunks during the read', async () => {
    const pending = deferred<JsonObject>()
    vi.spyOn(transport, 'getPiSessionState').mockReturnValueOnce(pending.promise)
    const apply = vi.spyOn(ompSubagentStore, 'applySnapshot')
    piSessionStateStore.setState('session-a', {
      model: { id: 'model' }, thinkingLevel: 'high', isBashRunning: true, isIdle: false,
    })
    const reading = refreshPiSessionState('session-a')
    for (let i = 0; i < 20; i++) piSessionStateStore.patchState('session-a', { isBashRunning: true, isIdle: false })
    piSessionStateStore.patchState('session-a', { isBashRunning: false, isIdle: true })
    pending.resolve({ isBashRunning: true, isIdle: false, subagents: [], queue: [] })
    await reading
    expect(piSessionStateStore.getState('session-a')).toMatchObject({ isBashRunning: false, isIdle: true, queue: [] })
    expect(apply).toHaveBeenCalledWith('session-a', [], true)
  })

  it('keeps parallel session reads independent', async () => {
    vi.spyOn(transport, 'getPiSessionState')
      .mockResolvedValueOnce({ thinkingLevel: 'high' })
      .mockResolvedValueOnce({ thinkingLevel: 'low' })
    await Promise.all([refreshPiSessionState('session-a'), refreshPiSessionState('session-b')])
    expect(piSessionStateStore.getState('session-a')?.thinkingLevel).toBe('high')
    expect(piSessionStateStore.getState('session-b')?.thinkingLevel).toBe('low')
  })

  it('reconciles missed crash state from an empty idle snapshot or a disk-only preview', async () => {
    vi.spyOn(transport, 'getPiSessionState')
      .mockResolvedValueOnce({ isIdle: true, isStreaming: false, subagents: [] })
      .mockResolvedValueOnce({ isIdle: true, isStreaming: false, diskPreview: true })
    for (const sessionId of ['session-a', 'session-b']) {
      piSessionStateStore.setState(sessionId, { isStreaming: true, isIdle: false })
      ompSubagentStore.applyLifecycle(sessionId, { id: `child-${sessionId}`, status: 'started', detached: true })
      await refreshPiSessionState(sessionId)
      expect(piSessionStateStore.getState(sessionId)).toMatchObject({ isIdle: true, isStreaming: false })
      expect(ompSubagentStore.runsForSession(sessionId)[0]?.status).toBe('aborted')
    }
  })

  it('never uses a stale idle response that only hydrates configuration to stop newer agents', async () => {
    const old = deferred<JsonObject>()
    vi.spyOn(transport, 'getPiSessionState').mockReturnValueOnce(old.promise)
    const reading = refreshPiSessionState('session-a')
    piSessionStateStore.patchState('session-a', { isStreaming: true, isIdle: false })
    ompSubagentStore.applyLifecycle('session-a', { id: 'new-child', status: 'started', detached: true })
    old.resolve({ model: { provider: 'custom', id: 'model' }, isIdle: true, isStreaming: false, subagents: [] })
    await reading
    expect(piSessionStateStore.getState('session-a')).toMatchObject({ isIdle: false, isStreaming: true })
    expect(ompSubagentStore.runsForSession('session-a')[0]?.status).toBe('running')
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
    const second = refreshPiBranch('session-a')
    old.resolve({ ...latest, head: { ...latest.head, revision: 1 } })
    await Promise.all([first, second])
    expect(piBranchStore.getData('session-a')?.head.revision).toBe(2)
  })

  it('uses the cached sync cursor when a session preview is loaded again', async () => {
    const branch = {
      head: { sdkVersion: 'test', revision: 2, header: null, leafId: null, entryCount: 1, epoch: 'test' },
      items: [], hasMore: false, syncCursor: 'cached-sync',
    }
    piBranchStore.setData('session-a', branch)
    const preview = vi.spyOn(transport, 'previewPiSession').mockResolvedValue({ state: {}, branch })
    await loadPiSessionData('session-a')
    expect(preview).toHaveBeenCalledWith('session-a', expect.objectContaining({ syncCursor: 'cached-sync' }), undefined)
  })
})
