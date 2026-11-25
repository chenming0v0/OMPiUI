import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReasoningTranslationContext } from '../../omp/reasoningTranslation'
import { mergeLatestBranchPage } from '../../omp/branchMerge'
import { selectPiTimelineItems } from '../../omp/selectors'
import type { PiBranchPage } from '../../omp/domain'
import type { AssistantMessage } from '../../omp/vendor/pi-ai'
import { MessageRenderer } from './MessageRenderer'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('../../omp/httpClient', () => ({ getApiBase: () => '', piFetch: fetchMock }))
vi.mock('motion/mini', () => ({ animate: () => Promise.resolve() }))
vi.mock('../../hooks', async importOriginal => {
  const original = await importOriginal<typeof import('../../hooks')>()
  const { useRef } = await import('react')
  return { ...original, useDisclosureScrollLock: () => ({ rootRef: useRef(null), headerRef: useRef(null), withScrollLock: (action: () => void) => action() }) }
})
vi.mock('../../hooks/useDelayedRender', () => ({ useDelayedRender: (visible: boolean) => visible }))
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => ({
  reasoningDisplayMode: 'capsule', renderUserMarkdown: false, collapseUserMessages: false,
  descriptiveToolSteps: false, immersiveMode: false, actionsOnLatestAssistantOnly: false,
  stepFinishDisplay: { latestOnly: true, turnDuration: false, tokens: false, cache: false, cost: false, duration: false, agent: false, model: false, completedAt: false },
}) }))
vi.mock('./parts', async () => ({
  ReasoningPartView: (await import('./parts/ReasoningPartView')).ReasoningPartView,
  TextPartView: ({ part }: { part: { text: string } }) => <span>{part.text}</span>,
  MessageErrorView: () => null, ToolGroup: () => null,
}))

const original = 'Thought before saving.'
const message = (thinking: string, timestamp: number): AssistantMessage => ({
  role: 'assistant', timestamp, content: [{ type: 'thinking', thinking }],
  api: 'openai-responses', provider: 'openai', model: 'test', stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
})
const user = { type: 'message' as const, id: 'user-entry', parentId: null, timestamp: '2026-11-25T00:00:00Z', message: { role: 'user' as const, timestamp: 1000, content: 'Continue' } }
const context = { scope: 'real-handoff-regression', sessionId: 'session-handoff', model: 'openai/test', budget: 8192 as const }
function scene(page: PiBranchPage) {
  return <ReasoningTranslationContext.Provider value={context}>
    {selectPiTimelineItems(page).filter(item => item.kind === 'assistant_message').map(item => <MessageRenderer key={item.renderKey ?? item.entryId} item={item} />)}
  </ReasoningTranslationContext.Provider>
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect() {}
    unobserve() {}
  })
  fetchMock.mockImplementation(async (_url, init) => {
    const next = JSON.parse(init.body).entryId === 'next-live'
    const source = next ? 'New thought.' : original
    const snapshot = { blockId: next ? 'next-live:0' : 'live-assistant:0', source, status: 'complete', chunks: [{ source, translation: next ? '新的思考。' : '已保留的译文。' }] }
    return new Response(JSON.stringify({ snapshot }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('real thinking component live-to-history handoff', () => {
  it('preserves the component, disclosure and Chinese prefix when persistence and later thinking arrive', async () => {
    const first = message(original, 2000)
    const live: PiBranchPage = {
      head: { sdkVersion: 'test', revision: 1, header: { id: context.sessionId }, leafId: user.id, entryCount: 1, epoch: 'history' },
      items: [user], hasMore: false,
      checkpoint: { position: { epoch: 'stream', sequence: 1 }, liveMessage: { id: 'live-assistant', revision: 1, phase: 'streaming', complete: true, message: first } },
    }
    const view = render(scene(live))
    await waitFor(() => expect(screen.getAllByText('已保留的译文。').length).toBeGreaterThan(0))
    const disclosure = view.container.querySelector('button[aria-expanded]')! as HTMLButtonElement
    if (disclosure.getAttribute('aria-expanded') === 'true') fireEvent.click(disclosure)
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')

    const native = { type: 'message' as const, id: 'persisted-assistant', parentId: user.id, timestamp: '2026-11-25T00:00:01Z', message: first }
    const persisted = mergeLatestBranchPage(live, {
      head: { ...live.head, revision: 2, entryCount: 2, leafId: native.id },
      items: [user, native], hasMore: false,
      stableEntryIds: { [native.id]: 'live-assistant' },
      checkpoint: { position: { epoch: 'stream', sequence: 2 } },
    })
    view.rerender(scene(persisted))
    expect(view.container.querySelector('button[aria-expanded]')).toBe(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(view.container.textContent).toContain('已保留的译文。')
    expect(view.container.textContent).not.toContain(original)
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => JSON.parse(init.body).entryId === native.id)).toBe(true))

    view.rerender(scene({ ...persisted, checkpoint: { position: { epoch: 'stream', sequence: 3 }, liveMessage: {
      id: 'next-live', revision: 1, phase: 'streaming', complete: true, message: message('New thought.', 3000),
    } } }))
    expect(view.container.textContent).toContain('已保留的译文。')
    await waitFor(() => expect(screen.getAllByText('新的思考。').length).toBeGreaterThan(0))
    expect(view.container.textContent).not.toContain(original)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body)).not.toHaveProperty('text')
      expect(JSON.parse(init.body)).not.toHaveProperty('history')
    }
  })
})
