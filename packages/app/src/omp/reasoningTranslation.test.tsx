import { createElement, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReasoningTranslationContext, useReasoningTranslation, type ContextTimelineItem } from './reasoningTranslation'

const { piFetchMock } = vi.hoisted(() => ({ piFetchMock: vi.fn() }))
vi.mock('./httpClient', () => ({ getApiBase: () => '', piFetch: piFetchMock }))

let scopeNumber = 0
function wrapper(items: ContextTimelineItem[] = []) {
  const value = { scope: `translation-test-${++scopeNumber}`, model: 'openai/test', budget: 8192 as const, getItems: () => items }
  return ({ children }: { children: ReactNode }) => createElement(ReasoningTranslationContext.Provider, { value }, children)
}

function response(frames: unknown[]) {
  return new Response(frames.map(frame => JSON.stringify(frame) + '\n').join(''), {
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

describe('reasoning translation', () => {
  beforeEach(() => {
    piFetchMock.mockReset().mockResolvedValue(response([{ delta: '中文译文' }, { done: true }]))
  })

  it('keeps the original without making requests when translation is disabled', async () => {
    const { result } = renderHook(() => useReasoningTranslation('entry', 'entry:0', 'Reasoning', false, false))
    await act(async () => {})
    expect(result.current.available).toBe(false)
    expect(result.current.text).toBe('')
    expect(piFetchMock).not.toHaveBeenCalled()
  })

  it('buffers short live excerpts and translates them when the reasoning finishes', async () => {
    const { result, rerender } = renderHook(({ streaming }) => useReasoningTranslation('entry', 'entry:0', 'Short reasoning', streaming, false), {
      wrapper: wrapper(), initialProps: { streaming: true },
    })
    expect(piFetchMock).not.toHaveBeenCalled()
    rerender({ streaming: false })
    await waitFor(() => expect(result.current.text).toBe('中文译文'))
    expect(result.current.pending).toBe(false)
    const [url, init] = piFetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/pi/reasoning/translate')
    expect(init.privateStream).toBe(true)
    expect(JSON.parse(init.body)).toEqual({ model: 'openai/test', text: 'Short reasoning', history: [], budget: 8192 })
  })

  it('preserves completed translations across virtual remounts and only translates the new suffix', async () => {
    const sharedWrapper = wrapper()
    const first = renderHook(() => useReasoningTranslation('entry', 'entry:0', 'First.', false, false), { wrapper: sharedWrapper })
    await waitFor(() => expect(first.result.current.text).toBe('中文译文'))
    first.unmount()
    piFetchMock.mockResolvedValue(response([{ delta: '后续译文' }, { done: true }]))
    const second = renderHook(() => useReasoningTranslation('entry', 'entry:0', 'First.Second.', false, false), { wrapper: sharedWrapper })
    await waitFor(() => expect(second.result.current.text).toBe('中文译文后续译文'))
    expect(JSON.parse(piFetchMock.mock.calls[1][1].body).text).toBe('Second.')
  })

  it('aborts the active request on pause and resumes from the untranslated excerpt', async () => {
    let requestSignal: AbortSignal | undefined
    piFetchMock.mockImplementationOnce((_url, init) => {
      requestSignal = init.signal
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
    })
    const { result, rerender } = renderHook(({ paused }) => useReasoningTranslation('entry', 'entry:0', 'Reasoning', false, paused), {
      wrapper: wrapper(), initialProps: { paused: false },
    })
    await waitFor(() => expect(requestSignal).toBeDefined())
    rerender({ paused: true })
    expect(requestSignal!.aborted).toBe(true)
    expect(result.current.text).toBe('')
    rerender({ paused: false })
    await waitFor(() => expect(result.current.text).toBe('中文译文'))
    expect(piFetchMock).toHaveBeenCalledTimes(2)
  })

  it('discards a failed stream and leaves the original available for rendering', async () => {
    piFetchMock.mockResolvedValue(response([{ delta: '不完整译文' }, { error: true }]))
    const { result } = renderHook(() => useReasoningTranslation('entry', 'entry:0', 'Reasoning', false, false), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.text).toBe('')
    expect(result.current.pending).toBe(false)
  })

  it('bounds recent context and excludes reasoning and future messages from the request', async () => {
    const items = Array.from({ length: 14 }, (_, index) => ({
      kind: index % 2 ? 'assistant_message' : 'user_message', entryId: `history-${index}`,
      blocks: [{ type: 'text', text: `message-${index}` }, { type: 'thinking', thinking: 'private previous reasoning' }],
    })) as ContextTimelineItem[]
    items.push({ kind: 'assistant_message', entryId: 'entry', blocks: [] } as unknown as ContextTimelineItem)
    items.push({ kind: 'user_message', entryId: 'future', blocks: [{ type: 'text', text: 'future message' }] } as unknown as ContextTimelineItem)
    const { result } = renderHook(() => useReasoningTranslation('entry', 'entry:0', 'Reasoning', false, false), { wrapper: wrapper(items) })
    await waitFor(() => expect(result.current.pending).toBe(false))
    const body = JSON.parse(piFetchMock.mock.calls[0][1].body)
    expect(body.history).toHaveLength(9)
    expect(body.history[0].text).toBe('message-5')
    expect(body.history.at(-1).text).toBe('message-13')
    expect(JSON.stringify(body)).not.toContain('private previous reasoning')
    expect(JSON.stringify(body)).not.toContain('future message')
  })
})
