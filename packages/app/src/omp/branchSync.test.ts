import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PiBranchPage } from './domain/index.js'
import { mergeLatestBranchPage } from './branchMerge.js'
import { loadMorePiBranchEntries, refreshPiBranch } from './controllers/index.js'
import { piBranchStore } from './state/index.js'
import * as transport from './transport/index.js'

function page(ids: string[], syncCursor?: string): PiBranchPage {
  return {
    head: {
      sdkVersion: 'test',
      revision: ids.length,
      header: null,
      leafId: ids.at(-1) ?? null,
      entryCount: ids.length,
      epoch: `history:${ids.length}`,
    },
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
      liveMessage: {
        id: 'live',
        revision: 10,
        phase: 'streaming',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'newer thinking' }],
        },
      } as NonNullable<PiBranchPage['checkpoint']>['liveMessage'],
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

  it('does not append delta entries that overlap the loaded history', () => {
    const current = page(['a', 'b'], 'base')
    const delta = { ...page(['b', 'c', 'c'], 'next'), deltaFrom: 'base' }
    expect(mergeLatestBranchPage(current, delta).items.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('requests a delta only after the server supplies a baseline; older servers remain full-page reads', async () => {
    piBranchStore.setData('sync', page(['a']))
    const fetch = vi
      .spyOn(transport, 'getPiBranchPage')
      .mockResolvedValueOnce(page(['a', 'b'], 'base'))
      .mockResolvedValueOnce({ ...page(['c'], 'next'), deltaFrom: 'base' })
    await refreshPiBranch('sync')
    expect(fetch.mock.calls[0]?.[1]).toEqual({ limit: 100, maxBytes: 128 * 1024 })
    await refreshPiBranch('sync')
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ syncCursor: 'base', beforeId: 'a' })
    expect(piBranchStore.getData('sync')?.items.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('preserves the baseline and latest head when loading older history, then renews the correct edge', async () => {
    const current = { ...page(['c', 'd'], 'base'), hasMore: true, beforeCursor: 'before-c' }
    piBranchStore.setData('sync', current)
    vi.spyOn(transport, 'getPiBranchPage')
      .mockResolvedValueOnce({ ...page(['b']), hasMore: true, beforeCursor: 'before-b' })
      .mockResolvedValueOnce({ ...page(['e'], 'next'), deltaFrom: 'base', hasMore: true, beforeCursor: 'renewed-b' })
    await loadMorePiBranchEntries('sync')
    expect(piBranchStore.getData('sync')).toMatchObject({ syncCursor: 'base', head: current.head })
    await refreshPiBranch('sync')
    expect(transport.getPiBranchPage).toHaveBeenLastCalledWith(
      'sync',
      {
        limit: 100,
        maxBytes: 128 * 1024,
        syncCursor: 'base',
        beforeId: 'b',
      },
      undefined,
    )
    expect(piBranchStore.getData('sync')?.items.map(entry => entry.id)).toEqual(['b', 'c', 'd', 'e'])
    expect(piBranchStore.getData('sync')?.beforeCursor).toBe('renewed-b')
  })

  it('keeps the latest suffix through older pagination and repeated empty syncs', async () => {
    const ids = Array.from({ length: 400 }, (_, index) => `entry-${index}`)
    piBranchStore.setData('sync', { ...page(ids, 'base'), hasMore: true })
    const fetch = vi.spyOn(transport, 'getPiBranchPage')
      .mockResolvedValueOnce({ ...page(['older']), hasMore: true, beforeCursor: 'before-older' })
      .mockResolvedValueOnce({
        ...page([], 'base'), deltaFrom: 'base', hasMore: true, beforeCursor: 'renewed-older',
      })
      .mockResolvedValueOnce({
        ...page([], 'base'), deltaFrom: 'base', hasMore: true, beforeCursor: 'renewed-older-again',
      })
      .mockResolvedValueOnce(page(['oldest']))

    await loadMorePiBranchEntries('sync')
    const windowed = piBranchStore.getData('sync')!
    expect(windowed.items.map(item => item.id)).toEqual(['older', ...ids])
    expect(windowed.client?.historyWindowed).toBe(true)

    await refreshPiBranch('sync')
    await refreshPiBranch('sync')
    const synced = piBranchStore.getData('sync')!
    expect(synced.items).toEqual(windowed.items)
    expect(synced.client?.historyWindowed).toBe(true)
    expect(synced.hasMore).toBe(true)
    expect(synced.beforeCursor).toBe('renewed-older-again')
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ beforeId: 'older', syncCursor: 'base' })
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ beforeId: 'older', syncCursor: 'base' })

    await loadMorePiBranchEntries('sync')
    const paged = piBranchStore.getData('sync')!
    expect(paged.items.map(item => item.id)).toEqual(['oldest', 'older', ...ids])
    expect(paged.hasMore).toBe(false)
    expect(paged.syncCursor).toBe('base')
    expect(fetch.mock.calls[3]?.[1]).toMatchObject({ beforeId: 'older' })
  })

  it('keeps hydrated tool output and the latest message when older pages exceed the byte cache budget', async () => {
    const output = 'build output\n'.repeat(8 * 1024)
    const latest = page(['latest'], 'base')
    latest.hasMore = true
    piBranchStore.setData('sync', latest)
    const older = page(Array.from({ length: 90 }, (_, i) => `result-${i}`))
    older.items = older.items.map(entry => ({
      type: 'message', id: entry.id, parentId: null, timestamp: '',
      message: {
        role: 'toolResult', toolCallId: `call-${entry.id}`, toolName: 'bash',
        content: [{ type: 'text', text: output }], isError: false, timestamp: 1,
      },
    }))
    vi.spyOn(transport, 'getPiBranchPage').mockResolvedValueOnce(older)
    await loadMorePiBranchEntries('sync')
    const loaded = piBranchStore.getData('sync')!
    expect(loaded.items).toEqual([...older.items, ...latest.items])
    expect(loaded.head.leafId).toBe(loaded.items.at(-1)?.id)
    expect(loaded.hasMore).toBe(false)
  })

  it('ignores stale concurrent responses instead of appending entries twice', async () => {
    piBranchStore.setData('sync', page(['a'], 'base'))
    let resolve!: (value: PiBranchPage) => void
    vi.spyOn(transport, 'getPiBranchPage')
      .mockReturnValueOnce(
        new Promise(done => {
          resolve = done
        }),
      )
      .mockResolvedValueOnce({ ...page(['b', 'c'], 'newer'), deltaFrom: 'base' })
    const first = refreshPiBranch('sync', new AbortController().signal)
    await refreshPiBranch('sync', new AbortController().signal)
    resolve({ ...page(['b'], 'older'), deltaFrom: 'base' })
    await first
    expect(piBranchStore.getData('sync')?.items.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
    expect(piBranchStore.getData('sync')?.syncCursor).toBe('newer')
  })

  it('falls back to a full read if a delta response has an unexpected baseline', async () => {
    piBranchStore.setData('sync', page(['a'], 'base'))
    const fetch = vi
      .spyOn(transport, 'getPiBranchPage')
      .mockResolvedValueOnce({ ...page(['c'], 'next'), deltaFrom: 'different' })
      .mockResolvedValueOnce(page(['a', 'b', 'c'], 'full'))
    await refreshPiBranch('sync')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[1]).toEqual({ limit: 100, maxBytes: 128 * 1024 })
    expect(piBranchStore.getData('sync')?.items.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('merges an older page despite streaming checkpoints and keeps the newest live message', async () => {
    const current = { ...page(['c', 'd'], 'base'), hasMore: true }
    piBranchStore.setData('sync', current)
    let resolve!: (value: PiBranchPage) => void
    vi.spyOn(transport, 'getPiBranchPage').mockReturnValueOnce(new Promise(done => { resolve = done }))
    const loading = loadMorePiBranchEntries('sync')
    const checkpoint = { position: { epoch: 'events', sequence: 50 } }
    piBranchStore.setLiveCheckpoint('sync', checkpoint)
    resolve({ ...page(['a', 'b']), hasMore: false })
    await loading
    const result = piBranchStore.getData('sync')
    expect(result?.items.map(entry => entry.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(result?.checkpoint).toBe(checkpoint)
    expect(result?.head).toBe(current.head)
    expect(result?.hasMore).toBe(false)
  })

  it('preserves entries appended by a refresh while older history is loading', async () => {
    piBranchStore.setData('sync', { ...page(['c', 'd'], 'base'), hasMore: true })
    let resolve!: (value: PiBranchPage) => void
    vi.spyOn(transport, 'getPiBranchPage').mockReturnValueOnce(new Promise(done => { resolve = done }))
    const loading = loadMorePiBranchEntries('sync')
    const latest = { ...page(['c', 'd', 'e'], 'new-base'), hasMore: true }
    piBranchStore.setData('sync', latest)
    resolve(page(['a', 'b']))
    await loading
    expect(piBranchStore.getData('sync')?.items.map(entry => entry.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(piBranchStore.getData('sync')?.syncCursor).toBe('new-base')
    expect(piBranchStore.getData('sync')?.head).toBe(latest.head)
  })

  it('does not insert an old page after branch navigation', async () => {
    piBranchStore.setData('sync', { ...page(['c', 'd']), hasMore: true })
    let resolve!: (value: PiBranchPage) => void
    vi.spyOn(transport, 'getPiBranchPage').mockReturnValueOnce(new Promise(done => { resolve = done }))
    const loading = loadMorePiBranchEntries('sync')
    const navigated = page(['c', 'fork'])
    piBranchStore.setData('sync', navigated)
    resolve(page(['a', 'b']))
    await loading
    expect(piBranchStore.getData('sync')).toBe(navigated)
  })

  it('enlarges only oversized-entry pages instead of skipping history', async () => {
    piBranchStore.setData('sync', { ...page(['c']), hasMore: true })
    const fetch = vi.spyOn(transport, 'getPiBranchPage')
      .mockRejectedValueOnce({ code: 'FILE_TOO_LARGE' })
      .mockRejectedValueOnce({ code: 'FILE_TOO_LARGE' })
      .mockResolvedValueOnce(page(['b']))
    await loadMorePiBranchEntries('sync')
    expect(fetch.mock.calls.map(call => call[1].maxBytes)).toEqual([128, 256, 512].map(kb => kb * 1024))
    expect(fetch.mock.calls.every(call => call[1].beforeId === 'c')).toBe(true)
    expect(piBranchStore.getData('sync')?.items.map(entry => entry.id)).toEqual(['b', 'c'])
  })
})
