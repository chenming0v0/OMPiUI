import { Virtualizer, defaultRangeExtractor } from '@tanstack/virtual-core'
import { describe, expect, it } from 'vitest'
import { mergeVirtualRangeIndexes } from './chatAreaUtils'

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
})
