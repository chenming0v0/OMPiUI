import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReasoningTranslationSnapshot } from '@ompiui/protocol'
import { ReasoningTranslationContext, useReasoningTranslation } from './reasoningTranslation'

const { piFetchMock } = vi.hoisted(() => ({ piFetchMock: vi.fn() }))
vi.mock('./httpClient', () => ({ getApiBase: () => '', piFetch: piFetchMock }))

let scopeNumber = 0
function wrapper() {
  const value = { scope: `translation-test-${++scopeNumber}`, sessionId: `session-${scopeNumber}`, model: 'openai/test', budget: 8192 as const }
  return ({ children }: { children: ReactNode }) => createElement(ReasoningTranslationContext.Provider, { value }, children)
}
function snapshot(source: string, translation: string): ReasoningTranslationSnapshot {
  return { blockId: 'logical:0', source, chunks: [{ source, translation }], status: 'complete' }
}
function response(frames: unknown[]) {
  return new Response(frames.map(frame => JSON.stringify(frame) + '\n').join(''), { headers: { 'content-type': 'application/x-ndjson' } })
}
function liveResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
  const send = async (value: ReasoningTranslationSnapshot) => {
    await act(async () => controller.enqueue(new TextEncoder().encode(JSON.stringify({ snapshot: value }) + '\n')))
  }
  return { response: new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }), send }
}

describe('backend-owned reasoning translation display', () => {
  beforeEach(() => {
    piFetchMock.mockReset().mockImplementation(() => Promise.resolve(response([{ snapshot: snapshot('Reasoning', '中文译文') }])))
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0))
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => clearTimeout(frame))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('does not request translations for disabled or empty conversations', async () => {
    const disabled = renderHook(() => useReasoningTranslation('entry', 'entry:0', 'Reasoning', false, false))
    expect(disabled.result.current.available).toBe(false)
    const empty = renderHook(() => useReasoningTranslation('entry', 'entry:0', '', true, false), { wrapper: wrapper() })
    expect(empty.result.current.pending).toBe(false)
    await act(async () => {})
    expect(piFetchMock).not.toHaveBeenCalled()
  })

  it('sends only real session/block identity and reading intent, never browser source or context', async () => {
    const { result } = renderHook(() => useReasoningTranslation('native-entry', 'stable-live:2', 'Reasoning', false, false, {
      blockIndex: 2, priority: 'reading', interactionId: 'explicit-expansion',
    }), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.text).toBe('中文译文'))
    const [url, init] = piFetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/pi/reasoning/translate')
    expect(init.privateStream).toBe(true)
    expect(JSON.parse(init.body)).toEqual({
      sessionId: expect.stringMatching(/^session-/), entryId: 'native-entry', blockIndex: 2,
      readerId: expect.any(String), model: 'openai/test', budget: 8192, priority: 'reading', interactionId: 'explicit-expansion',
    })
    expect(JSON.parse(init.body)).not.toHaveProperty('text')
    expect(JSON.parse(init.body)).not.toHaveProperty('history')
  })

  it('does not enqueue hidden/offscreen blocks or grant automatic prewarm an expansion slot', async () => {
    const { rerender } = renderHook(({ priority }) => useReasoningTranslation('entry', 'entry:0', 'Reasoning', false, false, {
      priority, interactionId: 'old-expansion',
    }), { wrapper: wrapper(), initialProps: { priority: null as 'prewarm' | null } })
    await act(async () => {})
    expect(piFetchMock).not.toHaveBeenCalled()
    rerender({ priority: 'prewarm' })
    await waitFor(() => expect(piFetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(piFetchMock.mock.calls[0][1].body)).toMatchObject({ priority: 'prewarm' })
    expect(JSON.parse(piFetchMock.mock.calls[0][1].body)).not.toHaveProperty('interactionId')
  })

  it('keeps completed display across remount and native entry ID handoff', async () => {
    const sharedWrapper = wrapper()
    const first = renderHook(() => useReasoningTranslation('live-entry', 'stable:0', 'Reasoning', true, false), { wrapper: sharedWrapper })
    await waitFor(() => expect(first.result.current.text).toBe('中文译文'))
    first.unmount()
    const second = renderHook(({ entryId }) => useReasoningTranslation(entryId, 'stable:0', 'Reasoning', false, false), {
      wrapper: sharedWrapper, initialProps: { entryId: 'live-entry' },
    })
    expect(second.result.current.text).toBe('中文译文')
    second.rerender({ entryId: 'native-entry' })
    expect(second.result.current.text).toBe('中文译文')
    await waitFor(() => expect(piFetchMock.mock.calls.some(([, init]) => JSON.parse(init.body).entryId === 'native-entry')).toBe(true))
  })

  it('keeps one subscription while new source arrives and replaces only its appended tail', async () => {
    const live = liveResponse()
    piFetchMock.mockResolvedValueOnce(live.response)
    const { result, rerender } = renderHook(({ source }) => useReasoningTranslation('entry', 'entry:0', source, true, false), {
      wrapper: wrapper(), initialProps: { source: 'First.' },
    })
    await waitFor(() => expect(piFetchMock).toHaveBeenCalledTimes(1))
    await live.send(snapshot('First.', '第一段。'))
    await waitFor(() => expect(result.current.text).toBe('第一段。'))
    rerender({ source: 'First.Second.' })
    expect(result.current.text).toBe('第一段。Second.')
    expect(piFetchMock).toHaveBeenCalledTimes(1)
    await live.send({ blockId: 'logical:0', source: 'First.Second.', status: 'complete', chunks: [
      { source: 'First.', translation: '第一段。' }, { source: 'Second.', translation: '第二段。' },
    ] })
    await waitFor(() => expect(result.current.text).toBe('第一段。第二段。'))
    expect(piFetchMock).toHaveBeenCalledTimes(1)
  })

  it('restores in-flight partial display after remount without claiming success', async () => {
    const sharedWrapper = wrapper()
    const live = liveResponse()
    piFetchMock.mockResolvedValueOnce(live.response)
    const first = renderHook(() => useReasoningTranslation('entry', 'entry:0', 'Reasoning', false, false), { wrapper: sharedWrapper })
    await waitFor(() => expect(piFetchMock).toHaveBeenCalledTimes(1))
    const partial: ReasoningTranslationSnapshot = { blockId: 'logical:0', source: 'Reasoning', chunks: [], partial: { source: 'Reasoning', translation: '部分中文' }, status: 'running' }
    await live.send(partial)
    await waitFor(() => expect(first.result.current.text).toBe('部分中文'))
    first.unmount()
    piFetchMock.mockResolvedValueOnce(response([{ snapshot: partial }, { snapshot: snapshot('Reasoning', '完整中文') }]))
    const second = renderHook(() => useReasoningTranslation('entry', 'entry:0', 'Reasoning', false, false), { wrapper: sharedWrapper })
    expect(second.result.current.text).toBe('部分中文')
    expect(second.result.current.pending).toBe(true)
    await waitFor(() => expect(second.result.current.text).toBe('完整中文'))
    expect(second.result.current.pending).toBe(false)
  })

  it('reveals at most one new source line per animation frame', async () => {
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
    const source = 'First line.\nSecond line.\nThird line.'
    piFetchMock.mockResolvedValueOnce(response([{ snapshot: snapshot(source, '第一行。\n第二行。\n第三行。') }]))
    const { result } = renderHook(() => useReasoningTranslation('entry', 'entry:0', source, false, false), { wrapper: wrapper() })
    await waitFor(() => expect(frames.size).toBe(1))
    expect(result.current.text).toBe('')
    const advance = async () => {
      await act(async () => {
        const [id, callback] = frames.entries().next().value!
        frames.delete(id)
        callback(performance.now())
      })
    }
    await advance()
    expect(result.current.text).toBe('第一行。\nSecond line.\nThird line.')
    await advance()
    expect(result.current.text).toBe('第一行。\n第二行。\nThird line.')
    await advance()
    expect(result.current.text).toBe('第一行。\n第二行。\n第三行。')
  })

  it('pauses only its reader connection and resumes from the backend snapshot', async () => {
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
  })

  it('never commits incomplete output from a failed stream', async () => {
    piFetchMock.mockResolvedValueOnce(response([
      { snapshot: { blockId: 'logical:0', source: 'Reasoning', chunks: [], partial: { source: 'Reasoning', translation: '不完整中文' }, status: 'running' } },
      { error: true },
    ]))
    const { result } = renderHook(() => useReasoningTranslation('entry', 'entry:0', 'Reasoning', false, false), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.text).toBe('')
    expect(result.current.pending).toBe(false)
  })
})
