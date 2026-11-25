import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadReasoningTranslationConfig, setReasoningTranslationConcurrency, useReasoningTranslationConfig } from './reasoningTranslationConfig'
import { ReasoningTranslationConcurrencySetting } from '../features/settings/components/ReasoningTranslationConcurrencySetting'

const mocks = vi.hoisted(() => ({ generation: 1, fetch: vi.fn() }))
vi.mock('../omp/httpClient', () => ({ getApiBase: () => '', piFetch: mocks.fetch }))
vi.mock('./serverStore', () => ({ serverStore: { getActiveServerGeneration: () => mocks.generation } }))
vi.mock('../hooks/useServerStore', () => ({ useServerStore: () => ({ activeServerGeneration: mocks.generation }) }))
const reply = (concurrency: number) => new Response(JSON.stringify({ concurrency }), { headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  mocks.generation++
  mocks.fetch.mockReset().mockImplementation(async (_url, init) => reply(init?.method === 'POST' ? JSON.parse(init.body).concurrency : 5))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('backend translation concurrency configuration', () => {
  it('reads the effective default and saves the selected backend quota', async () => {
    const { result } = renderHook(useReasoningTranslationConfig)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.concurrency).toBe(5)
    await act(async () => setReasoningTranslationConcurrency(8))
    expect(result.current.concurrency).toBe(8)
    expect(mocks.fetch).toHaveBeenCalledWith('/api/v1/pi/reasoning/config', expect.objectContaining({ method: 'POST', body: '{"concurrency":8}' }))
  })

  it('does not apply an old config read after a newer successful save', async () => {
    const old = Promise.withResolvers<Response>()
    mocks.fetch.mockReturnValueOnce(old.promise)
    const { result } = renderHook(useReasoningTranslationConfig)
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
    await act(async () => setReasoningTranslationConcurrency(9))
    expect(result.current.concurrency).toBe(9)
    await act(async () => { old.resolve(reply(2)) })
    expect(result.current.concurrency).toBe(9)
  })

  it('does not race visible refreshes against an in-flight save', async () => {
    const { result } = renderHook(useReasoningTranslationConfig)
    await waitFor(() => expect(result.current.loading).toBe(false))
    const save = Promise.withResolvers<Response>()
    mocks.fetch.mockReturnValueOnce(save.promise)
    let pending!: Promise<void>
    act(() => { pending = setReasoningTranslationConcurrency(10) })
    const requests = mocks.fetch.mock.calls.length
    await act(async () => loadReasoningTranslationConfig())
    expect(mocks.fetch).toHaveBeenCalledTimes(requests)
    await act(async () => { save.resolve(reply(10)); await pending })
    expect(result.current.concurrency).toBe(10)
  })

  it('refreshes the shared effective quota while the settings page is visible', async () => {
    const { result } = renderHook(useReasoningTranslationConfig)
    await waitFor(() => expect(result.current.loading).toBe(false))
    vi.useFakeTimers()
    mocks.fetch.mockResolvedValueOnce(reply(7))
    // Focus is a real client recovery trigger; hidden documents never poll configuration.
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(result.current.concurrency).toBe(7)
  })

  it('rejects stale replies from a previously selected backend', async () => {
    const old = Promise.withResolvers<Response>()
    mocks.fetch.mockReturnValueOnce(old.promise)
    const { result, rerender } = renderHook(useReasoningTranslationConfig)
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
    mocks.generation++
    mocks.fetch.mockResolvedValueOnce(reply(12))
    rerender()
    await waitFor(() => expect(result.current.concurrency).toBe(12))
    await act(async () => { old.resolve(reply(1)) })
    expect(result.current.concurrency).toBe(12)
  })

  it('validates the UI range and reports failed saves without claiming a new quota', async () => {
    render(<ReasoningTranslationConcurrencySetting />)
    const input = screen.getByRole('spinbutton', { name: 'Automatic translation concurrency' })
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.change(input, { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(input, { target: { value: '8' } })
    mocks.fetch.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(input).toHaveValue(8)
    expect(input).toBeEnabled()
  })
})
