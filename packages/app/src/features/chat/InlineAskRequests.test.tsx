import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiAssistantMessageItem, PiTimelineItem, PiToolExecution } from '../../omp/domain'
import { extensionUiStore } from '../../omp/extensionUiStore'
import { keybindingStore } from '../../store/keybindingStore'
import { setUiDisclosureState } from '../../utils/uiDisclosureState'
import { ExtensionsPanel } from '../../components/ExtensionsPanel'
import { ToolPartView } from '../message/parts/ToolPartView'
import { ExtensionUiDialogHost } from './ExtensionUiDialogHost'
import { InlineAskRequestsContext, useInlineAskRequests } from './InlineAskRequests'
import { matchNativeAskRequests, type NativeAskRequest } from './nativeAskMatching'
import i18n from '../../i18n'

const { respondPiExtensionUi } = vi.hoisted(() => ({ respondPiExtensionUi: vi.fn() }))
vi.mock('../../omp/controllers/index.js', () => ({ respondPiExtensionUi }))
vi.mock('../../hooks', () => ({
  usePresence: () => ({ shouldRender: true, ref: () => undefined }),
  useDelayedRender: (show: boolean) => show,
  useDisclosureScrollLock: () => ({ rootRef: () => undefined, headerRef: () => undefined, withScrollLock: (action: () => void) => action() }),
  useCompositorExpand: (open: boolean) => ({ contentRef: { current: null }, layoutOpen: open, keepMounted: open, panelClassName: '' }),
}))
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ immersiveMode: false }) }))
vi.mock('./chatViewport', () => ({ useChatViewport: () => ({ presentation: { isCompact: false } }) }))

const request: NativeAskRequest = {
  kind: 'ask', sessionId: 'ask-session', workerGeneration: 'worker-1', requestId: 'ask-1', title: 'Ask', createdAt: '2026-11-07T10:00:00Z',
  questions: [{ id: 'mode', question: 'Choose a mode', options: [{ label: 'Plan' }, { label: 'Build', description: 'Make the change', preview: 'Selected preview' }], recommended: 1 }],
}
const execution: PiToolExecution = { call: { type: 'toolCall', id: 'ask-call', name: 'ask', arguments: { questions: request.questions } }, isRunning: true }
const items: PiTimelineItem[] = [{ kind: 'tool_result', entryId: 'ask-start', timestamp: 1, execution }]

function Harness({ showTool = true, sessionId = request.sessionId, timeline = items, duplicate = false, layout = 'compact' }: {
  showTool?: boolean; sessionId?: string; timeline?: PiTimelineItem[]; duplicate?: boolean; layout?: 'compact' | 'descriptive' | 'timeline'
}) {
  const ask = useInlineAskRequests(sessionId, timeline)
  const tool = timeline[0]?.kind === 'tool_result' ? timeline[0].execution : execution
  return <InlineAskRequestsContext.Provider value={ask.value}>
    <div data-testid="tool">{showTool && <ToolPartView execution={tool} partKey="ask-test" compact={layout === 'compact'} descriptive={layout === 'descriptive'} defaultExpanded />}</div>
    {duplicate && <ToolPartView execution={tool} partKey="ask-duplicate" defaultExpanded />}
    <div data-testid="dock"><ExtensionUiDialogHost sessionId={sessionId} pendingRequests={ask.pending} /></div>
    <div data-testid="sidebar"><ExtensionsPanel sessionId={sessionId} /></div>
    {ask.dialogs}
  </InlineAskRequestsContext.Provider>
}

beforeEach(async () => {
  extensionUiStore.reset()
  respondPiExtensionUi.mockReset().mockResolvedValue(undefined)
  keybindingStore.resetAll()
  setUiDisclosureState('message:ask-test', true, false)
  setUiDisclosureState('message:ask-duplicate', true, false)
  await i18n.changeLanguage('en')
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('native ask ownership', () => {
  it('matches an assistant tool using native question identity without optional-field differences', () => {
    const call = { ...execution.call, arguments: { questions: [{ ...request.questions[0], header: '', multi: false }] } }
    const assistant = { kind: 'assistant_message', blocks: [call], toolResults: {}, toolExecutions: {} } as PiAssistantMessageItem
    expect(matchNativeAskRequests([assistant], [request]).get(call.id)).toBe(request)
    const result = { role: 'toolResult' as const, toolCallId: call.id, toolName: 'ask', content: [], isError: false, timestamp: 2 }
    expect(matchNativeAskRequests([{ ...assistant, toolResults: { [call.id]: result } }], [request]).size).toBe(0)
  })

  it('leaves unmatched background requests and ambiguous calls in the dock', () => {
    expect(matchNativeAskRequests([], [request]).size).toBe(0)
    const other: PiTimelineItem = { kind: 'tool_result', entryId: 'other', timestamp: 2, execution: { ...execution, call: { ...execution.call, id: 'other-call' } } }
    expect(matchNativeAskRequests([...items, other], [request]).size).toBe(0)
    expect(matchNativeAskRequests(items, [request, { ...request, requestId: 'another' }]).size).toBe(0)
    expect(matchNativeAskRequests([{ ...other, execution: { ...execution, interruption: 'cancelled' } }], [request]).size).toBe(0)
  })

  it.each(['compact', 'descriptive', 'timeline'] as const)('renders one form in the %s tool layout and only a summary in the sidebar', layout => {
    extensionUiStore.requestOpened(request)
    render(<Harness layout={layout} />)
    expect(screen.getAllByRole('dialog', { name: 'Ask' })).toHaveLength(1)
    expect(within(screen.getByTestId('tool')).getByRole('button', { name: 'Submit' })).toBeDisabled()
    expect(screen.getByTestId('dock')).toBeEmptyDOMElement()
    expect(within(screen.getByTestId('sidebar')).queryByRole('button')).toBeNull()
    expect(within(screen.getByTestId('sidebar')).getByText('Choose a mode')).toBeInTheDocument()
  })

  it('keeps one form and its draft when the tool collapses, unmounts, and returns', () => {
    extensionUiStore.requestOpened(request)
    const { rerender } = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Other (type your own)' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this answer' } })
    fireEvent.click(screen.getByTestId('tool').querySelector('button[aria-expanded]')!)
    expect(within(screen.getByTestId('dock')).getByRole('textbox')).toHaveValue('Keep this answer')
    fireEvent.click(screen.getByTestId('tool').querySelector('button[aria-expanded]')!)
    expect(within(screen.getByTestId('tool')).getByRole('textbox')).toHaveValue('Keep this answer')
    rerender(<Harness showTool={false} />)
    expect(within(screen.getByTestId('dock')).getByRole('textbox')).toHaveValue('Keep this answer')
    rerender(<Harness duplicate />)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('textbox')).toHaveValue('Keep this answer')
  })

  it('restores an unmatched ask in the dock and preserves separate drafts while paging', () => {
    extensionUiStore.requestOpened(request)
    extensionUiStore.requestOpened({ ...request, requestId: 'ask-2', createdAt: '2026-11-07T10:01:00Z', questions: [{ id: 'next', question: 'Second question', options: [{ label: 'Second answer' }] }] })
    render(<Harness timeline={[]} showTool={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    fireEvent.click(screen.getByTitle('Next'))
    expect(screen.getByRole('group', { name: 'Second question' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Second answer' }))
    fireEvent.click(screen.getByTitle('Previous'))
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('keeps in-flight submission locked when the form moves and restores the completed answer renderer', async () => {
    let finish!: () => void
    respondPiExtensionUi.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    extensionUiStore.requestOpened(request)
    const { rerender } = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    rerender(<Harness showTool={false} />)
    expect(screen.getByRole('button', { name: '…' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(respondPiExtensionUi).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(screen.queryByRole('dialog')).toBeNull()
    const completed: PiToolExecution = { ...execution, isRunning: false, result: { role: 'toolResult', toolCallId: execution.call.id, toolName: 'ask', content: [], isError: false, timestamp: 2, details: { selectedOptions: ['Plan'] } } }
    rerender(<Harness timeline={[{ kind: 'tool_result', entryId: 'done', timestamp: 2, execution: completed }]} />)
    expect(within(screen.getByTestId('tool')).getByText('Choose a mode')).toBeInTheDocument()
    expect(within(screen.getByTestId('tool')).queryByRole('button', { name: 'Submit' })).toBeNull()
  })

  it('uses the configured send shortcut, ignores IME Enter, and cancels once with Escape', async () => {
    extensionUiStore.requestOpened(request)
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    const dialog = screen.getByRole('dialog')
    vi.spyOn(keybindingStore, 'getKey').mockReturnValue('Alt+Enter')
    fireEvent.compositionStart(dialog)
    fireEvent.keyDown(dialog, { key: 'Enter', altKey: true })
    fireEvent.compositionEnd(dialog)
    fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true })
    expect(respondPiExtensionUi).not.toHaveBeenCalled()
    fireEvent.keyDown(dialog, { key: 'Enter', altKey: true })
    await waitFor(() => expect(respondPiExtensionUi).toHaveBeenCalledWith(request.sessionId, request.requestId, expect.objectContaining({ answers: [{ id: 'mode', selectedOptions: ['Plan'] }] })))
    act(() => { extensionUiStore.requestOpened({ ...request, requestId: 'cancel-me' }) })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(respondPiExtensionUi).toHaveBeenLastCalledWith(request.sessionId, 'cancel-me', expect.objectContaining({ cancelled: true })))
  })

  it('keeps answers on response failure and does not reuse drafts across runtime generations or sessions', async () => {
    respondPiExtensionUi.mockRejectedValueOnce(new Error('Disconnected'))
    extensionUiStore.requestOpened(request)
    const { rerender } = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Disconnected')
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-pressed', 'true')
    act(() => { extensionUiStore.requestOpened({ ...request, workerGeneration: 'worker-2' }) })
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-pressed', 'false')
    act(() => { extensionUiStore.requestOpened({ ...request, sessionId: 'other-session' }) })
    rerender(<Harness sessionId="other-session" showTool={false} />)
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('submits native multi-select and free text together, including an empty multi-select', async () => {
    const multi: NativeAskRequest = { ...request, questions: [{ ...request.questions[0], multi: true }, { id: 'none', question: 'Optional choices', multi: true, options: [{ label: 'Optional' }] }] }
    extensionUiStore.requestOpened(multi)
    render(<Harness timeline={[]} showTool={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    const group = screen.getByRole('group', { name: 'Choose a mode' })
    fireEvent.click(within(group).getByRole('button', { name: 'Other (type your own)' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'With notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(respondPiExtensionUi).toHaveBeenCalledWith(request.sessionId, request.requestId, expect.objectContaining({ answers: [
      { id: 'mode', selectedOptions: ['Plan'], customInput: 'With notes' }, { id: 'none', selectedOptions: [] },
    ] })))
  })
})
