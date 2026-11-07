import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiTimelineItem, PiToolExecution } from '../../omp/domain'
import { extensionUiStore } from '../../omp/extensionUiStore'
import { ToolPartView } from '../message/parts/ToolPartView'
import { ChatArea } from './ChatArea'
import { useInlineAskRequests } from './InlineAskRequests'
import { InlineAskRequestsContext } from './nativeAskContext'
import type { NativeAskRequest } from './nativeAskMatching'
import i18n from '../../i18n'

vi.mock('../../hooks', () => ({
  usePresence: () => ({ shouldRender: true, ref: () => undefined }),
  useDelayedRender: (show: boolean) => show,
  useDisclosureScrollLock: () => ({ rootRef: () => undefined, headerRef: () => undefined, withScrollLock: (action: () => void) => action() }),
  useCompositorExpand: (open: boolean) => ({ contentRef: { current: null }, layoutOpen: open, keepMounted: open, panelClassName: '' }),
}))
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ isWideMode: false, processCollapseEnabled: false, immersiveMode: false }) }))
vi.mock('./chatViewport', () => ({ useChatViewportSelect: () => false }))
vi.mock('../message', () => ({
  MessageRenderer: ({ item }: { item: PiTimelineItem }) => item.kind === 'tool_result'
    ? <ToolPartView execution={item.execution} partKey="ask-height" defaultExpanded />
    : <span>{item.entryId}</span>,
  ProcessCollapseBlock: () => null,
  assistantHasProcessContent: () => false,
  assistantHasFinalContent: () => false,
}))

const request: NativeAskRequest = {
  kind: 'ask', sessionId: 'ask-height-session', workerGeneration: 'worker-1', requestId: 'ask-height', title: 'Ask', createdAt: '2026-11-07T10:00:00Z',
  questions: [{ id: 'mode', question: 'Choose a mode', options: [{ label: 'Plan' }, { label: 'Build', preview: 'Selected preview' }] }],
}
const execution: PiToolExecution = { call: { type: 'toolCall', id: 'ask-height-call', name: 'ask', arguments: { questions: request.questions } }, isRunning: true }
const items: PiTimelineItem[] = [
  { kind: 'tool_result', entryId: 'ask-height-row', timestamp: 1, execution },
  {
    kind: 'user_message', entryId: 'following-row', timestamp: 2,
    rawEntry: { type: 'message', id: 'following-row', parentId: null, timestamp: new Date(2).toISOString(), message: { role: 'user', content: 'Next message', timestamp: 2 } },
    message: { role: 'user', content: 'Next message', timestamp: 2 }, blocks: [{ type: 'text', text: 'Next message' }],
  },
]

function Harness() {
  const ask = useInlineAskRequests(request.sessionId, items)
  return <InlineAskRequestsContext.Provider value={ask.value}>
    <ChatArea items={items} sessionId={request.sessionId} loadState="loaded" bottomPadding={180} />
    {ask.dialogs}
  </InlineAskRequestsContext.Provider>
}

beforeEach(async () => {
  extensionUiStore.reset()
  await i18n.changeLanguage('en')
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.chatScrollRoot) return 600
    if (this.dataset.timelineKey) {
      if (this.querySelector('textarea')) return 900
      if (this.querySelector('[role="dialog"] pre')) return 840
      return this.querySelector('[role="dialog"]') ? 760 : 60
    }
    return parseFloat(this.style.height) || 60
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.dataset.chatScrollRoot) return this.offsetHeight
    return (parseFloat((this.firstElementChild as HTMLElement)?.style.height) || 0) + 80 + 228
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

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('inline ask virtual row sizing', () => {
  it('reserves the full row and composer clearance on portal insertion before any answer is clicked', () => {
    const view = render(<Harness />)
    const root = view.container.querySelector<HTMLElement>('[data-chat-scroll-root]')!
    const sizer = root.firstElementChild as HTMLElement
    const following = root.querySelector<HTMLElement>('[data-timeline-key="following-row"]')!
    expect(sizer.style.height).toBe('120px')

    // 不派发 ResizeObserver 通知，复现 Portal 插入后行组件没有重新渲染的路径。
    act(() => { extensionUiStore.requestOpened(request) })
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
    expect(sizer.style.height).toBe('820px')
    expect(following.style.top).toBe('760px')
    expect((root.lastElementChild as HTMLElement).style.height).toBe('228px')
    expect(root.scrollHeight).toBe(1128)

    fireEvent.click(screen.getByRole('button', { name: 'Build' }))
    expect(sizer.style.height).toBe('900px')
    expect(following.style.top).toBe('840px')
    fireEvent.click(screen.getByRole('button', { name: 'Other (type your own)' }))
    expect(sizer.style.height).toBe('960px')
    expect(following.style.top).toBe('900px')
  })
})
