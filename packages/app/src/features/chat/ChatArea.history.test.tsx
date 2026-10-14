import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { PiTimelineItem } from '../../omp/domain'
import { ChatArea } from './ChatArea'

vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ isWideMode: false, processCollapseEnabled: true }),
}))
vi.mock('./chatViewport', () => ({ useChatViewportSelect: () => false }))
vi.mock('../message', () => ({
  MessageRenderer: ({ item }: { item: PiTimelineItem }) => <span>{item.entryId}</span>,
  ProcessCollapseBlock: ({ children, isActive }: { children: ReactNode; isActive: boolean }) =>
    <div data-testid="process-shell">{isActive ? children : 'collapsed'}</div>,
  assistantHasProcessContent: () => true,
  assistantHasFinalContent: () => false,
}))

function assistant(id: string): PiTimelineItem {
  return {
    kind: 'assistant_message', entryId: id, timestamp: 1,
    rawEntry: { type: 'message', id, parentId: null, timestamp: new Date(1).toISOString() },
    message: { role: 'assistant', stopReason: 'stop', timestamp: 1 },
    blocks: [{ type: 'thinking', thinking: id }],
    toolResults: {},
  } as PiTimelineItem
}

function user(id: string): PiTimelineItem {
  return {
    kind: 'user_message', entryId: id, timestamp: 0,
    rawEntry: { type: 'message', id, parentId: null, timestamp: new Date(0).toISOString() },
    message: { role: 'user', content: id, timestamp: 0 },
    blocks: [{ type: 'text', text: id }],
  } as PiTimelineItem
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.chatScrollRoot) return 600
    return parseFloat(this.style.height) || 60
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.dataset.chatScrollRoot) return this.offsetHeight
    return (parseFloat((this.firstElementChild as HTMLElement)?.style.height) || 0) + 336
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const root = this.closest<HTMLElement>('[data-chat-scroll-root]')
    const top = this.dataset.timelineKey ? (parseFloat(this.style.top) || 0) + 80 - (root?.scrollTop ?? 0) : 0
    return { top, bottom: top + this.offsetHeight, left: 0, right: 400, width: 400, height: this.offsetHeight, x: 0, y: top, toJSON: () => ({}) }
  })
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? this.scrollTop },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function scrollUp(root: HTMLElement) {
  await act(async () => { await vi.advanceTimersByTimeAsync(64) })
  fireEvent.wheel(root, { deltaY: -100 })
  root.scrollTop = 0
  fireEvent.scroll(root)
  await act(async () => {})
}

describe('ChatArea history pagination', () => {
  it('prefetches near the top during touch inertia before foreground pagination is needed', async () => {
    const items = Array.from({ length: 50 }, (_, index) => assistant(`prefetch-inertia-${index}`))
    const prefetch = vi.fn()
    const loadMore = vi.fn()
    const view = render(<ChatArea items={items} sessionId="prefetch-inertia-dom" loadState="loaded"
      hasMoreHistory onLoadMore={loadMore} onPrefetchHistory={prefetch} />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!
    await act(async () => { await vi.advanceTimersByTimeAsync(64) })
    expect(prefetch).toHaveBeenCalledWith('fast', expect.any(AbortSignal))
    prefetch.mockClear()
    fireEvent.touchStart(root, { touches: [{ clientY: 100 }] })
    root.scrollTop = 1400
    fireEvent.scroll(root)
    await act(async () => {})
    expect(prefetch).not.toHaveBeenCalled()
    fireEvent.touchEnd(root, { touches: [] })
    root.scrollTop = 900
    fireEvent.scroll(root)
    await act(async () => {})
    expect(prefetch).toHaveBeenCalled()
    expect(loadMore).not.toHaveBeenCalled()
  })

  it('loads history on the first touch scroll reaching the top without a wheel event', async () => {
    const items = Array.from({ length: 25 }, (_, index) => assistant(`first-touch-${index}`))
    const pending = deferred()
    const loadMore = vi.fn(() => pending.promise)
    const view = render(<ChatArea items={items} sessionId="first-touch-dom" loadState="loaded" hasMoreHistory onLoadMore={loadMore} />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!
    await act(async () => { await vi.advanceTimersByTimeAsync(64) })
    fireEvent.touchStart(root, { touches: [{ clientY: 100 }] })
    root.scrollTop = 0
    fireEvent.scroll(root)
    await act(async () => {})
    expect(loadMore).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(); await vi.advanceTimersByTimeAsync(350) })
  })

  it('keeps the loading indicator outside scroll geometry and preserves rows after finding their user', async () => {
    const items = Array.from({ length: 25 }, (_, index) => assistant(`history-${index}`))
    const pending = deferred()
    const loadMore = vi.fn(() => pending.promise)
    const props = { items, sessionId: 'prepend-dom', loadState: 'loaded' as const, hasMoreHistory: true, historyStartId: 'history-0', onLoadMore: loadMore }
    const view = render(<ChatArea {...props} />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!
    await scrollUp(root)
    const row = root.querySelector<HTMLElement>('[data-timeline-key="history-0"]')!
    expect(row).not.toBeNull()
    expect(loadMore).toHaveBeenCalledTimes(1)
    expect(root.contains(screen.getByRole('status'))).toBe(false)
    const top = row.getBoundingClientRect().top
    view.rerender(<ChatArea {...props} items={[user('older-user'), ...items]} historyStartId="older-user" hasMoreHistory={false} />)
    await act(async () => { pending.resolve(); await vi.advanceTimersByTimeAsync(350) })
    expect(root.querySelector('[data-timeline-key="history-0"]')).toBe(row)
    expect(row.getBoundingClientRect().top).toBe(top)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByTestId('process-shell')).not.toBeInTheDocument()
  })

  it('continues at the top after a raw-only page and stops when the request made no progress', async () => {
    const items = Array.from({ length: 25 }, (_, index) => assistant(`raw-${index}`))
    const first = deferred()
    const second = deferred()
    const loadMore = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const props = { items, sessionId: 'raw-page-dom', loadState: 'loaded' as const, hasMoreHistory: true, historyStartId: 'raw-0', onLoadMore: loadMore }
    const view = render(<ChatArea {...props} />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!
    await scrollUp(root)
    view.rerender(<ChatArea {...props} historyStartId="older-tool-result" />)
    await act(async () => { first.resolve(); await vi.advanceTimersByTimeAsync(32) })
    expect(loadMore).toHaveBeenCalledTimes(2)
    await act(async () => { second.resolve(); await vi.advanceTimersByTimeAsync(1000) })
    expect(loadMore).toHaveBeenCalledTimes(2)
  })

  it('does not let the prepend anchor cancel a touch scroll while history is loading', async () => {
    const items = Array.from({ length: 25 }, (_, index) => assistant(`touch-${index}`))
    const pending = deferred()
    const loadMore = vi.fn(() => pending.promise)
    const props = {
      items,
      sessionId: 'touch-anchor-dom',
      loadState: 'loaded' as const,
      hasMoreHistory: true,
      historyStartId: 'touch-0',
      onLoadMore: loadMore,
    }
    const view = render(<ChatArea {...props} />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!

    await scrollUp(root)
    expect(loadMore).toHaveBeenCalledTimes(1)

    fireEvent.touchStart(root)
    root.scrollTop = 80
    fireEvent.scroll(root)
    await act(async () => { await vi.advanceTimersByTimeAsync(64) })
    expect(root.scrollTop).toBe(80)

    const row = root.querySelector<HTMLElement>('[data-timeline-key="touch-0"]')!
    const top = row.getBoundingClientRect().top
    view.rerender(<ChatArea {...props} items={[user('older-touch'), ...items]} historyStartId="older-touch" hasMoreHistory={false} />)
    await act(async () => { pending.resolve(); await vi.advanceTimersByTimeAsync(350) })
    expect(row.getBoundingClientRect().top).toBe(top)
  })

  it('does not cancel inertia from the same touch gesture after history arrives', async () => {
    const items = Array.from({ length: 40 }, (_, index) => assistant(`inertia-${index}`))
    const pending = deferred()
    const props = {
      items, sessionId: 'touch-inertia-dom', loadState: 'loaded' as const,
      hasMoreHistory: true, historyStartId: 'inertia-0', onLoadMore: vi.fn(() => pending.promise),
    }
    const view = render(<ChatArea {...props} />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!
    await scrollUp(root)
    view.rerender(<ChatArea {...props} items={[...Array.from({ length: 10 }, (_, index) => assistant(`older-inertia-${index}`)), ...items]} historyStartId="older-inertia-0" hasMoreHistory={false} />)
    await act(async () => { pending.resolve(); await vi.advanceTimersByTimeAsync(32) })
    const before = root.scrollTop
    expect(before).toBeGreaterThan(240)
    for (let frame = 0; frame < 12; frame++) {
      root.scrollTop -= 20
      fireEvent.scroll(root)
      await act(async () => { await vi.advanceTimersByTimeAsync(16) })
    }
    expect(root.scrollTop).toBe(before - 240)
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    expect(root.scrollTop).toBe(before - 240)
  })

  it('loads another history page when inertia reaches the top after touchend', async () => {
    const items = Array.from({ length: 40 }, (_, index) => assistant(`inertia-pages-${index}`))
    const first = deferred()
    const second = deferred()
    const loadMore = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const props = {
      items, sessionId: 'inertia-pages-dom', loadState: 'loaded' as const,
      hasMoreHistory: true, historyStartId: 'inertia-pages-0', onLoadMore: loadMore,
    }
    const view = render(<ChatArea {...props} />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!
    await act(async () => { await vi.advanceTimersByTimeAsync(64) })
    fireEvent.touchStart(root, { touches: [{ clientY: 100 }] })
    root.scrollTop = 0
    fireEvent.scroll(root)
    await act(async () => {})
    expect(loadMore).toHaveBeenCalledTimes(1)
    fireEvent.touchEnd(root, { touches: [] })

    const olderItems = Array.from({ length: 10 }, (_, index) => assistant(`inertia-page-older-${index}`))
    const nextItems = [...olderItems, ...items]
    view.rerender(<ChatArea {...props} items={nextItems} historyStartId="inertia-page-older-0" />)
    await act(async () => { first.resolve(); await vi.advanceTimersByTimeAsync(32) })
    expect(root.scrollTop).toBeGreaterThan(200)
    expect(loadMore).toHaveBeenCalledTimes(1)

    // 松手后仅产生 scroll，不再产生 touchstart、touchmove 或 wheel。
    while (root.scrollTop >= 200) {
      root.scrollTop = Math.max(0, root.scrollTop - 100)
      fireEvent.scroll(root)
      await act(async () => { await vi.advanceTimersByTimeAsync(16) })
    }
    expect(loadMore).toHaveBeenCalledTimes(2)
    root.scrollTop = 0
    fireEvent.scroll(root)
    await act(async () => { await vi.advanceTimersByTimeAsync(32) })
    expect(loadMore).toHaveBeenCalledTimes(2)
    view.rerender(<ChatArea {...props} items={nextItems} historyStartId="inertia-page-older-0" hasMoreHistory={false} />)
    await act(async () => { second.resolve(); await vi.advanceTimersByTimeAsync(64) })
    expect(loadMore).toHaveBeenCalledTimes(2)
  })

  it('continues pagination if inertia reached the top while the previous page was still loading', async () => {
    const items = Array.from({ length: 40 }, (_, index) => assistant(`pending-inertia-${index}`))
    const first = deferred()
    const second = deferred()
    const loadMore = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const props = {
      items, sessionId: 'pending-inertia-dom', loadState: 'loaded' as const,
      hasMoreHistory: true, historyStartId: 'pending-inertia-0', onLoadMore: loadMore,
    }
    const view = render(<ChatArea {...props} />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!
    await act(async () => { await vi.advanceTimersByTimeAsync(64) })
    fireEvent.touchStart(root, { touches: [{ clientY: 100 }] })
    root.scrollTop = 150
    fireEvent.scroll(root)
    await act(async () => {})
    expect(loadMore).toHaveBeenCalledTimes(1)
    fireEvent.touchEnd(root, { touches: [] })
    root.scrollTop = 0
    fireEvent.scroll(root)
    await act(async () => { await vi.advanceTimersByTimeAsync(32) })
    expect(loadMore).toHaveBeenCalledTimes(1)

    const nextItems = [assistant('pending-inertia-older'), ...items]
    view.rerender(<ChatArea {...props} items={nextItems} historyStartId="pending-inertia-older" />)
    await act(async () => { first.resolve(); await vi.advanceTimersByTimeAsync(32) })
    expect(loadMore).toHaveBeenCalledTimes(2)
    view.rerender(<ChatArea {...props} items={nextItems} historyStartId="pending-inertia-older" hasMoreHistory={false} />)
    await act(async () => { second.resolve(); await vi.advanceTimersByTimeAsync(64) })
    expect(loadMore).toHaveBeenCalledTimes(2)
  })

  it('does not cancel touch movement when the scroll event arrives after the anchor frame', async () => {
    const items = Array.from({ length: 40 }, (_, index) => assistant(`late-scroll-${index}`))
    const pending = deferred()
    const props = {
      items, sessionId: 'late-scroll-dom', loadState: 'loaded' as const,
      hasMoreHistory: true, historyStartId: 'late-scroll-0', onLoadMore: vi.fn(() => pending.promise),
    }
    const view = render(<ChatArea {...props} />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!
    await scrollUp(root)
    root.scrollTop = 100
    fireEvent.scroll(root)
    view.rerender(<ChatArea {...props} hasMoreHistory={false} />)
    await act(async () => { pending.resolve(); await vi.advanceTimersByTimeAsync(32) })
    const before = root.scrollTop
    root.scrollTop -= 20
    await act(async () => { await vi.advanceTimersByTimeAsync(16) })
    expect(root.scrollTop).toBe(before - 20)
    fireEvent.scroll(root)
  })

  it('shows a retry action after a network failure instead of silently ending the loader', async () => {
    const items = Array.from({ length: 25 }, (_, index) => assistant(`retry-${index}`))
    const pending = deferred()
    const loadMore = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockReturnValueOnce(pending.promise)
    const view = render(<ChatArea items={items} sessionId="retry-page-dom" loadState="loaded" hasMoreHistory onLoadMore={loadMore} />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!
    await scrollUp(root)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(loadMore).toHaveBeenCalledTimes(1)
    const retry = screen.getByRole('button', { name: /Retry loading history|重新加载历史记录/ })
    expect(root.contains(retry)).toBe(false)
    fireEvent.click(retry)
    await act(async () => {})
    expect(loadMore).toHaveBeenCalledTimes(2)
    await act(async () => { pending.resolve(); await vi.advanceTimersByTimeAsync(350) })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
