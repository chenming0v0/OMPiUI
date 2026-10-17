import { Virtualizer, defaultRangeExtractor } from '@tanstack/virtual-core'
import { describe, expect, it } from 'vitest'
import { guardVirtualizerRange, mergeVirtualRangeIndexes } from './chatAreaUtils'

describe('chat virtual range', () => {
  it('keeps measurements defined through shrinking, clearing and restoring a pinned timeline', () => {
    let pinned: number[] = []
    const options = {
      count: 50,
      getScrollElement: () => null,
      scrollToFn: () => {},
      observeElementRect: () => {},
      observeElementOffset: () => {},
      initialRect: { width: 400, height: 600 },
      estimateSize: () => 60,
      rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) =>
        mergeVirtualRangeIndexes(defaultRangeExtractor(range), range.count, pinned),
    }
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>(options)
    expect(virtualizer.getVirtualItems().length).toBeGreaterThan(0)

    pinned = [8, 48, 49]
    virtualizer.setOptions({ ...options, count: 10 })
    const trimmed = virtualizer.getVirtualItems()
    expect(trimmed.map(item => item.index)).toEqual(Array.from({ length: 10 }, (_, index) => index))
    expect(trimmed.every(item => Number.isFinite(item.start))).toBe(true)

    virtualizer.setOptions({ ...options, count: 0 })
    expect(virtualizer.getVirtualItems()).toEqual([])

    virtualizer.setOptions(options)
    const restored = virtualizer.getVirtualItems()
    expect(restored.slice(-2).map(item => item.index)).toEqual([48, 49])
    expect(restored.every(item => Number.isFinite(item.start))).toBe(true)
  })

  it('keeps DOM positions valid when a cached range still contains removed rows', () => {
    const options = {
      count: 50,
      getScrollElement: () => null,
      scrollToFn: () => {},
      observeElementRect: () => {},
      observeElementOffset: () => {},
      initialRect: { width: 400, height: 600 },
      estimateSize: () => 60,
      // Reproduce an already-extracted range retaining the two old hot rows.
      rangeExtractor: (range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [...new Set([...defaultRangeExtractor(range), 48, 49])],
    }
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>(options)
    guardVirtualizerRange(virtualizer)
    expect(virtualizer.getVirtualItems().at(-1)?.start).toBe(2940)

    virtualizer.setOptions({ ...options, count: 10 })
    // directDomUpdates reads start before ChatArea can filter missing items.
    expect(virtualizer.getVirtualItems().map(item => item.start)).toEqual(
      Array.from({ length: 10 }, (_, index) => index * 60),
    )

    virtualizer.setOptions({ ...options, count: 0 })
    expect(virtualizer.getVirtualItems()).toEqual([])
    virtualizer.setOptions(options)
    expect(virtualizer.getVirtualItems().slice(-2).map(item => [item.index, item.start])).toEqual([
      [48, 2880], [49, 2940],
    ])
  })
})
