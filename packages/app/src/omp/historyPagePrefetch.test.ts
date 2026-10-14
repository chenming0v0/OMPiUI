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
  return Promise.withResolvers<PiBranchPage>()
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

    await loadMorePiBranchEntries('prefetch', new AbortController().signal)
    expect(piBranchStore.getData('prefetch')?.items.map(entry => entry.id)).toEqual(['b', 'c', 'd'])
    await loadMorePiBranchEntries('prefetch')
    expect(piBranchStore.getData('prefetch')?.items.map(entry => entry.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('shares an in-flight prefetch with the foreground history load (signal=%s)', async withSignal => {
    piBranchStore.setData('shared', page(['b'], true))
    const pending = deferred()
    const fetch = vi.spyOn(transport, 'getPiBranchPage').mockReturnValue(pending.promise)
    const background = prefetchPiBranchEntries('shared')
    const foreground = loadMorePiBranchEntries('shared', withSignal ? new AbortController().signal : undefined)
    expect(fetch).toHaveBeenCalledTimes(1)
    pending.resolve(page(['a']))
    await background
    await foreground
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(piBranchStore.getData('shared')?.items.map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('cancels abandoned prefetch reads on navigation before oversized-entry retries', async () => {
    piBranchStore.setData('navigate', page(['old'], true))
    const pending = deferred()
    const fetch = vi.spyOn(transport, 'getPiBranchPage').mockReturnValue(pending.promise)
    const background = prefetchPiBranchEntries('navigate')
    const navigated = page(['different-branch'], true)
    piBranchStore.setData('navigate', navigated)
    expect(fetch.mock.calls[0]?.[2]?.aborted).toBe(true)
    pending.reject(Object.assign(new Error('Oversized entry'), { code: 'FILE_TOO_LARGE' }))
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
    const foreground = loadMorePiBranchEntries('cancel-prefetch', new AbortController().signal)
    controller.abort()
    expect(fetch.mock.calls[0]?.[2]?.aborted).toBe(false)
    pending.resolve(page(['b'], true))
    await background
    await foreground
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(piBranchStore.getData('cancel-prefetch')?.items.map(entry => entry.id)).toEqual(['b', 'c'])
  })

  it('cancels a foreground consumer independently and keeps its prefetch available without a second read', async () => {
    const current = page(['c'], true)
    piBranchStore.setData('cancel-foreground', current)
    const pending = deferred()
    const fetch = vi.spyOn(transport, 'getPiBranchPage').mockReturnValue(pending.promise)
    const background = prefetchPiBranchEntries('cancel-foreground')
    const controller = new AbortController()
    const foreground = loadMorePiBranchEntries('cancel-foreground', controller.signal).catch(error => error)
    controller.abort()
    expect(await foreground).toBe(controller.signal.reason)
    expect(fetch.mock.calls[0]?.[2]?.aborted).toBe(false)
    pending.resolve(page(['b']))
    await background
    expect(piBranchStore.getData('cancel-foreground')).toBe(current)
    await loadMorePiBranchEntries('cancel-foreground', new AbortController().signal)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(piBranchStore.getData('cancel-foreground')?.items.map(entry => entry.id)).toEqual(['b', 'c'])
  })

  it('aborts the logical page and its byte-budget retries only after the last consumer cancels', async () => {
    const current = page(['b'], true)
    piBranchStore.setData('cancel-all', current)
    const pending = deferred()
    const fetch = vi.spyOn(transport, 'getPiBranchPage')
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(page(['a']))
    const backgroundController = new AbortController()
    const foregroundController = new AbortController()
    const background = prefetchPiBranchEntries('cancel-all', 'fast', backgroundController.signal)
    const foreground = loadMorePiBranchEntries('cancel-all', foregroundController.signal).catch(error => error)
    backgroundController.abort()
    expect(fetch.mock.calls[0]?.[2]?.aborted).toBe(false)
    foregroundController.abort()
    expect(fetch.mock.calls[0]?.[2]?.aborted).toBe(true)
    pending.reject(Object.assign(new Error('Oversized entry'), { code: 'FILE_TOO_LARGE' }))
    await background
    expect(await foreground).toBe(foregroundController.signal.reason)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(piBranchStore.getData('cancel-all')).toBe(current)
    await loadMorePiBranchEntries('cancel-all')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(piBranchStore.getData('cancel-all')?.items.map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('does not start cancelled consumers or let them evict another view', async () => {
    const pending = deferred()
    const fetch = vi.spyOn(transport, 'getPiBranchPage').mockReturnValue(pending.promise)
    piBranchStore.setData('retained', page(['b'], true))
    const retained = prefetchPiBranchEntries('retained')
    const cancelled = new AbortController()
    cancelled.abort()
    for (const sessionId of ['cancelled-a', 'cancelled-b']) {
      piBranchStore.setData(sessionId, page(['c'], true))
      expect(await prefetchPiBranchEntries(sessionId, 'fast', cancelled.signal)).toBe(false)
      await expect(loadMorePiBranchEntries(sessionId, cancelled.signal)).rejects.toBe(cancelled.signal.reason)
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[2]?.aborted).toBe(false)
    pending.resolve(page(['a']))
    await retained
    await loadMorePiBranchEntries('retained')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(piBranchStore.getData('retained')?.items.map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it.each(['clear', 'lru', 'replace'] as const)('releases the last in-flight prefetch on %s', async release => {
    const cache = new HistoryPagePrefetch()
    const anchor = page(['b']).items[0]
    const pending = deferred()
    const read = vi.fn((_signal: AbortSignal) => pending.promise)
    const background = cache.prefetch('session', 1, anchor, read).catch(error => error)
    if (release === 'clear') cache.clear()
    else if (release === 'lru') {
      cache.canPrefetch('other-a', 1)
      cache.canPrefetch('other-b', 1)
    } else cache.has('session', 1, { ...anchor })
    expect(read.mock.calls[0]?.[0].aborted).toBe(true)
    expect(await background).toMatchObject({ name: 'AbortError' })
    pending.resolve(page(['stale']))
    cache.clear()
  })

  it('evicts only background interest while foreground consumers continue sharing the displaced flight', async () => {
    const cache = new HistoryPagePrefetch()
    const anchor = page(['b']).items[0]
    const pending = deferred()
    const read = vi.fn((_signal: AbortSignal) => pending.promise)
    const background = cache.prefetch('session', 1, anchor, read).catch(error => error)
    const foreground = cache.take('session', 1, anchor, read, new AbortController().signal)
    cache.canPrefetch('other-a', 1)
    cache.canPrefetch('other-b', 1)
    expect(await background).toMatchObject({ name: 'AbortError' })
    expect(read.mock.calls[0]?.[0].aborted).toBe(false)
    const joined = cache.take('session', 1, anchor, read)
    expect(read).toHaveBeenCalledTimes(1)
    pending.resolve(page(['a']))
    const [first, second] = await Promise.all([foreground, joined])
    expect(first.items.map(entry => entry.id)).toEqual(['a'])
    expect(second).toBe(first)
    cache.clear()
  })

  it('clears every displaced foreground flight even if a replacement reuses the same native entry id', async () => {
    const cache = new HistoryPagePrefetch()
    const anchor = page(['b']).items[0]
    const pending = deferred()
    const read = vi.fn((_signal: AbortSignal) => pending.promise)
    const original = cache.take('session', 1, anchor, read).catch(error => error)
    const replacement = cache.take('session', 1, { ...anchor }, read).catch(error => error)
    cache.clear()
    expect(read.mock.calls.map(([signal]) => signal.aborted)).toEqual([true, true])
    expect(await original).toMatchObject({ name: 'AbortError' })
    expect(await replacement).toMatchObject({ name: 'AbortError' })
    pending.resolve(page(['stale']))
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
    expect(cache.has('budget', 1, anchors[2])).toBe(false)
    await cache.take('budget', 1, anchors[0], read)
    expect(cache.canPrefetch('budget', 1)).toBe(true)
    expect(cache.canPrefetch('other-session', 1)).toBe(true)
    expect(read).toHaveBeenCalledTimes(3)
  })
})
