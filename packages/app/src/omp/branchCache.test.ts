import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { branchCacheKey, cachePiBranch, flushPiBranchCache, loadCachedPiBranch, removeCachedPiBranch } from './branchCache'
import { getToolExecutionStatus, type PiBranchPage } from './domain'
import { selectPiTimelineItems } from './selectors'
import { mergeLatestBranchPage } from './branchMerge'
import { serverStore } from '../store/serverStore'
import { piBranchStore, piSessionStateStore } from './state'
import { loadPiSessionData } from './controllers'
import * as transport from './transport'

const page = (text = 'cached'): PiBranchPage => ({
  head: { sdkVersion: 'test', revision: 1, header: null, leafId: 'one', entryCount: 1, epoch: 'history' },
  items: [{ type: 'message', id: 'one', parentId: null, timestamp: '2026-10-30T12:00:00Z', message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } }],
  checkpoint: { position: { epoch: 'events', sequence: 1 } }, syncCursor: 'cursor', hasMore: false,
})

beforeEach(() => {
  // One database per test module, writes persist independently of in-memory stores.
  if (typeof indexedDB === 'undefined') vi.stubGlobal('indexedDB', new IDBFactory())
})
afterEach(async () => {
  vi.restoreAllMocks()
  piBranchStore.clearAll()
  piSessionStateStore.clearAll()
  await removeCachedPiBranch('cache-session')
})

describe('persistent branch cache', () => {
  it('keeps a bounded latest page and its matching replay/sync cursors after memory is gone', async () => {
    cachePiBranch('cache-session', page())
    await flushPiBranchCache()
    piBranchStore.clearAll()
    expect(await loadCachedPiBranch('cache-session')).toEqual(page())
  })

  it('renders cached history before a slow preview, then calibrates via the saved sync cursor', async () => {
    cachePiBranch('cache-session', page())
    await flushPiBranchCache()
    let resolve!: (value: Awaited<ReturnType<typeof transport.previewPiSession>>) => void
    const response = new Promise<Awaited<ReturnType<typeof transport.previewPiSession>>>(done => { resolve = done })
    const preview = vi.spyOn(transport, 'previewPiSession').mockReturnValue(response)
    const loading = loadPiSessionData('cache-session')
    await vi.waitFor(() => expect(piBranchStore.getData('cache-session')).toEqual(page()))
    expect(piSessionStateStore.getState('cache-session')).toBeNull()
    expect(preview).toHaveBeenCalledWith('cache-session', expect.objectContaining({ syncCursor: 'cursor', beforeId: 'one' }), undefined)
    resolve({ state: { isStreaming: false, isIdle: true }, branch: page('fresh') })
    await loading
    expect(piBranchStore.getData('cache-session')?.items).toEqual(page('fresh').items)
  })

  it('does not overwrite a newer branch arriving during hydration', async () => {
    cachePiBranch('cache-session', page())
    await flushPiBranchCache()
    const preview = vi.spyOn(transport, 'previewPiSession').mockResolvedValue({ state: { isIdle: true }, branch: page('latest') })
    const loading = loadPiSessionData('cache-session')
    piBranchStore.setData('cache-session', page('newer event'))
    await loading
    expect(piBranchStore.getData('cache-session')?.items).toEqual(page('newer event').items)
    expect(preview).toHaveBeenCalled()
  })

  it('does not restore cached streaming as runtime authority', async () => {
    const user = page().items[0]
    if (user.type !== 'message') throw new Error('Expected message fixture')
    const live: PiBranchPage = { ...page(), checkpoint: { position: { epoch: 'events', sequence: 2 }, liveMessage: { id: 'live', revision: 1, phase: 'streaming', message: user.message } } }
    cachePiBranch('cache-session', live)
    await flushPiBranchCache()
    const loaded = await loadCachedPiBranch('cache-session')
    expect(loaded?.checkpoint?.position).toEqual(live.checkpoint?.position)
    expect(loaded?.checkpoint?.liveMessage?.phase).toBe('persisting')
  })

  it('shows cached in-progress tools as unknown and lets native evidence restore running', async () => {
    const call = { type: 'toolCall' as const, id: 'tool-one', name: 'read', arguments: { path: 'file.ts' } }
    const cached: PiBranchPage = { ...page(), items: [{ type: 'message', id: 'assistant', parentId: null, timestamp: '2026-10-30T12:00:00Z', message: { role: 'assistant', api: 'openai-completions', provider: 'mock', model: 'mock', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', content: [call], timestamp: 1 } }], client: { toolExecutions: { 'tool-one': { call, isRunning: true, startedAt: 1 } } } }
    cachePiBranch('cache-session', cached)
    await flushPiBranchCache()
    const loaded = (await loadCachedPiBranch('cache-session'))!
    const timeline = selectPiTimelineItems(loaded)
    const item = timeline.find(item => item.kind === 'assistant_message')!
    if (item.kind !== 'assistant_message') throw new Error('Expected assistant')
    expect(getToolExecutionStatus({ ...item.toolExecutions!['tool-one'], call })).toBe('unknown')
    const fresh = mergeLatestBranchPage(loaded, { ...cached, deltaFrom: loaded.syncCursor })
    expect(fresh.client?.toolExecutions?.['tool-one'].awaitingSnapshot).toBeUndefined()
    piBranchStore.setData('cache-session', loaded)
    piBranchStore.patchToolExecution('cache-session', 'tool-one', { isRunning: true })
    expect(piBranchStore.getData('cache-session')?.client?.toolExecutions?.['tool-one'].awaitingSnapshot).toBeUndefined()
  })

  it('isolates endpoints and credentials without writing raw tokens into keys', () => {
    const original = serverStore.getActiveServerId()
    const server = serverStore.addServer({ name: 'cache test', url: 'http://cache-a.example', token: 'secret-a' })
    const id = server.id
    serverStore.setActiveServer(id)
    const first = branchCacheKey('same-id')
    serverStore.updateServer(id, { token: 'secret-b' })
    const second = branchCacheKey('same-id')
    serverStore.updateServer(id, { url: 'http://cache-b.example' })
    expect(branchCacheKey('same-id')).not.toBe(second)
    expect(first).not.toBe(second)
    expect(first).not.toContain('secret-a')
    serverStore.setActiveServer(original)
    serverStore.removeServer(id)
  })

  it('caps saved pagination while leaving native history untouched', async () => {
    const original = page()
    const items = Array.from({ length: 450 }, (_, index) => ({ ...original.items[0], id: `entry-${index}` }))
    cachePiBranch('cache-session', { ...original, items, client: { historyWindowed: true } })
    await flushPiBranchCache()
    const loaded = await loadCachedPiBranch('cache-session')
    expect(loaded?.items).toHaveLength(400)
    expect(loaded?.items[0].id).toBe('entry-50')
    expect(loaded?.hasMore).toBe(true)
    expect(items).toHaveLength(450)
  })

  it('evicts old records at the cache record limit', async () => {
    for (let index = 0; index < 18; index++) cachePiBranch(`evict-${index}`, page())
    await flushPiBranchCache()
    expect(await loadCachedPiBranch('evict-0')).toBeUndefined()
    expect(await loadCachedPiBranch('evict-17')).toEqual(page())
    for (let index = 0; index < 18; index++) await removeCachedPiBranch(`evict-${index}`)
  })
})
