import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PiBranchPage } from './domain'
import { HistoryPagePrefetch, historyPagePrefetch } from './historyPagePrefetch'
import { loadMorePiBranchEntries, prefetchPiBranchEntries } from './controllers'
import { piBranchStore } from './state'
import * as transport from './transport'

function page(ids: string[], hasMore = false): PiBranchPage {
  return {
    head: { sdkVersion: 'test', revision: 1, header: null, leafId: ids.at(-1) ?? null, entryCount: ids.length, epoch: 'prefetch' },
    items: ids.map(id => ({ type: 'model_change', id, parentId: null, timestamp: '', provider: 'p', modelId: 'm' })),
    hasMore,
  }
}

function deferred() {
  let resolve!: (page: PiBranchPage) => void
  const promise = new Promise<PiBranchPage>(done => { resolve = done })
  return { resolve, promise }
}

afterEach(() => {
  historyPagePrefetch.clear()
  piBranchStore.clearAll()
  vi.restoreAllMocks()
})

describe('history page prefetch', () => {
  it('buffers two pages without changing the visible branch and consumes both without another request', async () => {
    const current = page(['c', 'd'], true)
    piBranchStore.setData('prefetch', current)
    const fetch = vi.spyOn(transport, 'getPiBranchPage')
      .mockResolvedValueOnce(page(['b'], true))
      .mockResolvedValueOnce(page(['a']))

    await prefetchPiBranchEntries('prefetch')
    expect(fetch.mock.calls.map(call => call[1].beforeId)).toEqual(['c', 'b'])
    expect(fetch.mock.calls.every(call => call[1].maxBytes === 128 * 1024)).toBe(true)
    expect(piBranchStore.getData('prefetch')).toBe(current)

    await loadMorePiBranchEntries('prefetch')
    expect(piBranchStore.getData('prefetch')?.items.map(entry => entry.id)).toEqual(['b', 'c', 'd'])
    await loadMorePiBranchEntries('prefetch')
    expect(piBranchStore.getData('prefetch')?.items.map(entry => entry.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('shares an in-flight prefetch with the foreground history load', async () => {
    piBranchStore.setData('shared', page(['b'], true))
    const pending = deferred()
    const fetch = vi.spyOn(transport, 'getPiBranchPage').mockReturnValue(pending.promise)
    const background = prefetchPiBranchEntries('shared')
    const foreground = loadMorePiBranchEntries('shared')
    expect(fetch).toHaveBeenCalledTimes(1)
    pending.resolve(page(['a']))
    await background
    await foreground
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(piBranchStore.getData('shared')?.items.map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('does not follow an old prefetch after branch navigation', async () => {
    piBranchStore.setData('navigate', page(['old'], true))
    const pending = deferred()
    const fetch = vi.spyOn(transport, 'getPiBranchPage').mockReturnValue(pending.promise)
    const background = prefetchPiBranchEntries('navigate')
    const navigated = page(['different-branch'], true)
    piBranchStore.setData('navigate', navigated)
    pending.resolve(page(['older'], true))
    await background
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(piBranchStore.getData('navigate')).toBe(navigated)
  })

  it('retries foreground loading after a failed prefetch', async () => {
    piBranchStore.setData('retry-prefetch', page(['b'], true))
    const fetch = vi.spyOn(transport, 'getPiBranchPage')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(page(['a']))
    await prefetchPiBranchEntries('retry-prefetch')
    expect(piBranchStore.getData('retry-prefetch')?.items[0].id).toBe('b')
    await loadMorePiBranchEntries('retry-prefetch')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(piBranchStore.getData('retry-prefetch')?.items.map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('does not reuse a page for another server generation or a replaced native entry', async () => {
    const cache = new HistoryPagePrefetch()
    const anchor = page(['b']).items[0]
    const read = vi.fn().mockResolvedValue(page(['a']))
    await cache.prefetch('session', 1, anchor, read)
    await cache.take('session', 2, anchor, read)
    await cache.take('session', 1, { ...anchor }, read)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('does not repeat network reads for repeated warmups of the same two boundaries', async () => {
    piBranchStore.setData('repeated', page(['c'], true))
    const fetch = vi.spyOn(transport, 'getPiBranchPage')
      .mockResolvedValueOnce(page(['b'], true))
      .mockResolvedValueOnce(page(['a']))
    await prefetchPiBranchEntries('repeated')
    await prefetchPiBranchEntries('repeated')
    await prefetchPiBranchEntries('repeated')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('extends the cached chain one page per idle step and stops at 16 buffered pages', async () => {
    const current = page(['entry-100'], true)
    piBranchStore.setData('idle-chain', current)
    const fetch = vi.spyOn(transport, 'getPiBranchPage').mockImplementation(async (_session, params) =>
      page([`entry-${Number(params.beforeId!.slice(6)) - 1}`], true),
    )
    expect(await prefetchPiBranchEntries('idle-chain', 'fast')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await prefetchPiBranchEntries('idle-chain', 'idle')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(3)
    for (let step = 0; step < 20; step++) await prefetchPiBranchEntries('idle-chain', 'idle')
    expect(fetch).toHaveBeenCalledTimes(16)
    expect(piBranchStore.getData('idle-chain')).toBe(current)
    await loadMorePiBranchEntries('idle-chain')
    expect(fetch).toHaveBeenCalledTimes(16)
    await prefetchPiBranchEntries('idle-chain', 'idle')
    expect(fetch).toHaveBeenCalledTimes(17)
  })

  it('stops the next page after its view cancels without aborting a shared foreground request', async () => {
    piBranchStore.setData('cancel-prefetch', page(['c'], true))
    const pending = deferred()
    const fetch = vi.spyOn(transport, 'getPiBranchPage').mockReturnValue(pending.promise)
    const controller = new AbortController()
    const background = prefetchPiBranchEntries('cancel-prefetch', 'fast', controller.signal)
    const foreground = loadMorePiBranchEntries('cancel-prefetch')
    controller.abort()
    pending.resolve(page(['b'], true))
    await background
    await foreground
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(piBranchStore.getData('cancel-prefetch')?.items.map(entry => entry.id)).toEqual(['b', 'c'])
  })

  it('pauses at the byte budget and makes room again after a cached page is consumed', async () => {
    const cache = new HistoryPagePrefetch()
    const anchors = page(['a', 'b', 'c']).items
    const large = page(['large'])
    large.items[0] = { ...large.items[0], type: 'model_change', provider: 'p', modelId: 'x'.repeat(3 * 1024 * 1024) }
    const read = vi.fn().mockResolvedValue(large)
    await cache.prefetch('budget', 1, anchors[0], read)
    await cache.prefetch('budget', 1, anchors[1], read)
    await cache.prefetch('budget', 1, anchors[2], read)
    expect(cache.canPrefetch('budget', 1)).toBe(false)
    expect(cache.peek('budget', 1, anchors[2])).toBeUndefined()
    await cache.take('budget', 1, anchors[0], read)
    expect(cache.canPrefetch('budget', 1)).toBe(true)
    expect(cache.canPrefetch('other-session', 1)).toBe(true)
    expect(read).toHaveBeenCalledTimes(3)
  })
})
