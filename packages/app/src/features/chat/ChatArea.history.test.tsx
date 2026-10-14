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
    await act(async () => { first.resolve(); await vi.advanceTimersByTimeAsync(350) })
    expect(loadMore).toHaveBeenCalledTimes(2)
    await act(async () => { second.resolve(); await vi.advanceTimersByTimeAsync(1000) })
    expect(loadMore).toHaveBeenCalledTimes(2)
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
