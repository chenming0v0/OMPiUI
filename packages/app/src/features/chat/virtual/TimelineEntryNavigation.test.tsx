import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTimelineEntryNavigation } from './TimelineEntryNavigation'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('loads older history until the retained entry can be scrolled into view', async () => {
  const loadMore = vi.fn()
  const scroll = vi.fn()
  const { result, rerender } = renderHook(props => useTimelineEntryNavigation({ ...props, loadMore, scroll }), {
    initialProps: { indexes: new Map<string, number>(), hasMore: true, loading: false, failed: false },
  })
  act(() => result.current.jump('kept'))
  await act(() => vi.advanceTimersByTimeAsync(20))
  expect(loadMore).toHaveBeenCalledTimes(1)
  expect(scroll).not.toHaveBeenCalled()
  rerender({ indexes: new Map([['kept', 3]]), hasMore: true, loading: false, failed: false })
  await act(() => vi.advanceTimersByTimeAsync(20))
  expect(scroll).toHaveBeenCalledWith(3)
  expect(result.current.pending).toBeNull()
})

it('reports missing entries after history is exhausted without repeating requests', async () => {
  const loadMore = vi.fn()
  const { result } = renderHook(() => useTimelineEntryNavigation({ indexes: new Map(), hasMore: false, loading: false, failed: false, loadMore, scroll: vi.fn() }))
  act(() => result.current.jump('missing'))
  await act(() => vi.advanceTimersByTimeAsync(20))
  expect(result.current.missing).toBe('missing')
  expect(loadMore).not.toHaveBeenCalled()
})
