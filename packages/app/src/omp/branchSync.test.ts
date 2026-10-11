import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PiBranchPage } from './domain/index.js'
import { mergeLatestBranchPage } from './branchMerge.js'
import { loadMorePiBranchEntries, refreshPiBranch } from './controllers/index.js'
import { piBranchStore } from './state/index.js'
import * as transport from './transport/index.js'

function page(ids: string[], syncCursor?: string): PiBranchPage {
  return {
    head: { sdkVersion: 'test', revision: ids.length, header: null, leafId: ids.at(-1) ?? null, entryCount: ids.length, epoch: `history:${ids.length}` },
    items: ids.map(id => ({ type: 'model_change', id, parentId: null, timestamp: '', provider: 'p', modelId: 'm' })),
    hasMore: false,
    syncCursor,
    checkpoint: { position: { epoch: 'events', sequence: 1 } },
  }
}

afterEach(() => {
  piBranchStore.clearAll()
  vi.restoreAllMocks()
})

describe('branch sync over HTTP', () => {
  it('appends a matching delta across history epochs and preserves loaded older pages and newer thinking', () => {
    const current = page(['old', 'a', 'b'], 'base')
    current.checkpoint = {
      position: { epoch: 'events', sequence: 10 },
      liveMessage: { id: 'live', revision: 10, phase: 'streaming', message: {
        role: 'assistant', content: [{ type: 'thinking', thinking: 'newer thinking' }],
      } } as NonNullable<PiBranchPage['checkpoint']>['liveMessage'],
    }
    const delta = { ...page(['c'], 'next'), deltaFrom: 'base', beforeCursor: 'renewed', hasMore: true }
    const result = mergeLatestBranchPage(current, delta)
    expect(result.items.map(entry => entry.id)).toEqual(['old', 'a', 'b', 'c'])
    expect(result.checkpoint).toBe(current.checkpoint)
    expect(result.beforeCursor).toBe('renewed')
    expect(result.syncCursor).toBe('next')
    expect(result.deltaFrom).toBeUndefined()
  })

  it('accepts empty deltas and full replacements after navigation or server restart', () => {
    const current = page(['a', 'b'], 'base')
    const empty = { ...page([], 'base'), head: current.head, deltaFrom: 'base' }
    expect(mergeLatestBranchPage(current, empty).items).toEqual(current.items)
    const replacement = page(['fork'], 'new-process')
    expect(mergeLatestBranchPage(current, replacement)).toBe(replacement)
    expect(mergeLatestBranchPage(current, { ...empty, deltaFrom: 'wrong' })).toBe(current)
  })

  it('requests a delta only after the server supplies a baseline; older servers remain full-page reads', async () => {
    piBranchStore.setData('sync', page(['a']))
    const fetch = vi.spyOn(transport, 'getPiBranchPage')
      .mockResolvedValueOnce(page(['a', 'b'], 'base'))
      .mockResolvedValueOnce({ ...page(['c'], 'next'), deltaFrom: 'base' })
    await refreshPiBranch('sync')
    expect(fetch.mock.calls[0]?.[1]).toEqual({ limit: 100, maxBytes: 2 * 1024 * 1024 })
    await refreshPiBranch('sync')
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ syncCursor: 'base', beforeId: 'a' })
    expect(piBranchStore.getData('sync')?.items.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('preserves the baseline and latest head when loading older history, then renews the correct edge', async () => {
    const current = { ...page(['c', 'd'], 'base'), hasMore: true, beforeCursor: 'before-c' }
    piBranchStore.setData('sync', current)
    vi.spyOn(transport, 'getPiBranchPage').mockResolvedValueOnce({ ...page(['b']), hasMore: true, beforeCursor: 'before-b' })
      .mockResolvedValueOnce({ ...page(['e'], 'next'), deltaFrom: 'base', hasMore: true, beforeCursor: 'renewed-b' })
    await loadMorePiBranchEntries('sync')
    expect(piBranchStore.getData('sync')).toMatchObject({ syncCursor: 'base', head: current.head })
    await refreshPiBranch('sync')
    expect(transport.getPiBranchPage).toHaveBeenLastCalledWith('sync', {
      limit: 100, maxBytes: 2 * 1024 * 1024, syncCursor: 'base', beforeId: 'b',
    }, undefined)
    expect(piBranchStore.getData('sync')?.items.map(entry => entry.id)).toEqual(['b', 'c', 'd', 'e'])
    expect(piBranchStore.getData('sync')?.beforeCursor).toBe('renewed-b')
  })

  it('ignores stale concurrent responses instead of appending entries twice', async () => {
    piBranchStore.setData('sync', page(['a'], 'base'))
    let resolve!: (value: PiBranchPage) => void
    vi.spyOn(transport, 'getPiBranchPage')
      .mockReturnValueOnce(new Promise(done => { resolve = done }))
      .mockResolvedValueOnce({ ...page(['b', 'c'], 'newer'), deltaFrom: 'base' })
    const first = refreshPiBranch('sync')
    await refreshPiBranch('sync')
    resolve({ ...page(['b'], 'older'), deltaFrom: 'base' })
    await first
    expect(piBranchStore.getData('sync')?.items.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
    expect(piBranchStore.getData('sync')?.syncCursor).toBe('newer')
  })

  it('falls back to a full read if a delta response has an unexpected baseline', async () => {
    piBranchStore.setData('sync', page(['a'], 'base'))
    const fetch = vi.spyOn(transport, 'getPiBranchPage')
      .mockResolvedValueOnce({ ...page(['c'], 'next'), deltaFrom: 'different' })
      .mockResolvedValueOnce(page(['a', 'b', 'c'], 'full'))
    await refreshPiBranch('sync')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[1]).toEqual({ limit: 100, maxBytes: 2 * 1024 * 1024 })
    expect(piBranchStore.getData('sync')?.items.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
  })
})
