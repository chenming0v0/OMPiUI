import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTailscaleLoginFlow } from './useTailscaleLoginFlow'

const mocks = vi.hoisted(() => ({
  start: vi.fn(), poll: vi.fn(), open: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.start.mockResolvedValue({ backendState: 'NeedsLogin', authUrl: null })
  mocks.poll.mockResolvedValue({ backendState: 'NeedsLogin', authUrl: null })
  mocks.open.mockResolvedValue(undefined)
})
afterEach(() => { vi.useRealTimers() })

function renderFlow(overrides: Partial<Parameters<typeof useTailscaleLoginFlow>[0]> = {}) {
  return renderHook(() => useTailscaleLoginFlow({
    start: mocks.start, poll: mocks.poll, open: mocks.open,
    timeoutMessage: 'timed out', ...overrides,
  }))
}

describe('Tailscale login flow state machine', () => {
  it('stays visible as waiting while the authorization link has not arrived', async () => {
    const { result } = renderFlow()
    await act(async () => { void result.current.beginLogin() })
    expect(result.current.phase).toBe('waitingAuthUrl')
    expect(result.current.authUrl).toBeNull()
    expect(result.current.error).toBe('')
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('opens the browser as soon as a poll returns the authorization link', async () => {
    vi.useFakeTimers()
    const { result } = renderFlow()
    await act(async () => { void result.current.beginLogin() })
    mocks.poll.mockResolvedValue({ backendState: 'NeedsLogin', authUrl: 'https://login.tailscale.com/a/1' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(result.current.phase).toBe('authorizing')
    expect(result.current.authUrl).toBe('https://login.tailscale.com/a/1')
    expect(mocks.open).toHaveBeenCalledWith('https://login.tailscale.com/a/1')
    expect(mocks.open).toHaveBeenCalledTimes(1)
  })

  it('surfaces a timeout error and stops polling when no link ever appears', async () => {
    vi.useFakeTimers()
    const { result } = renderFlow()
    await act(async () => { void result.current.beginLogin() })
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(result.current.phase).toBe('error')
    expect(result.current.error).toBe('timed out')
    expect(mocks.open).not.toHaveBeenCalled()
    const pollsAfterError = mocks.poll.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(mocks.poll).toHaveBeenCalledTimes(pollsAfterError)
  })

  it('returns to idle without opening anything when start reports an authenticated identity', async () => {
    mocks.start.mockResolvedValue({ backendState: 'Running', authUrl: null })
    const { result } = renderFlow()
    await act(async () => { void result.current.beginLogin() })
    expect(result.current.phase).toBe('idle')
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.poll).not.toHaveBeenCalled()
  })

  it('reports start failures as an error state', async () => {
    mocks.start.mockRejectedValue(new Error('Tailscale native operation timed out'))
    const { result } = renderFlow()
    await act(async () => { void result.current.beginLogin() })
    expect(result.current.phase).toBe('error')
    expect(result.current.error).toBe('Tailscale native operation timed out')
  })

  it('reports browser launch failures while keeping the link for manual retry', async () => {
    mocks.start.mockResolvedValue({ backendState: 'NeedsLogin', authUrl: 'https://login.tailscale.com/a/1' })
    mocks.open.mockRejectedValue(new Error('No browser is available'))
    const { result } = renderFlow()
    await act(async () => { void result.current.beginLogin() })
    expect(result.current.phase).toBe('error')
    expect(result.current.error).toBe('No browser is available')
    expect(result.current.authUrl).toBe('https://login.tailscale.com/a/1')
  })

  it('reopens the authorization page from the kept link', async () => {
    mocks.start.mockResolvedValue({ backendState: 'NeedsLogin', authUrl: 'https://login.tailscale.com/a/1' })
    const { result } = renderFlow()
    await act(async () => { void result.current.beginLogin() })
    mocks.open.mockClear()
    await act(async () => { await result.current.reopenAuthPage() })
    expect(mocks.open).toHaveBeenCalledWith('https://login.tailscale.com/a/1')
  })

  it('resets back to idle when the caller observes completion', async () => {
    mocks.start.mockResolvedValue({ backendState: 'NeedsLogin', authUrl: 'https://login.tailscale.com/a/1' })
    const { result } = renderFlow()
    await act(async () => { void result.current.beginLogin() })
    expect(result.current.phase).toBe('authorizing')
    await act(async () => { result.current.reset() })
    expect(result.current.phase).toBe('idle')
    expect(result.current.authUrl).toBeNull()
    expect(result.current.error).toBe('')
  })

  it('skips polling while the page is hidden and catches up on return', async () => {
    vi.useFakeTimers()
    const { result } = renderFlow()
    await act(async () => { void result.current.beginLogin() })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    mocks.poll.mockResolvedValue({ backendState: 'NeedsLogin', authUrl: 'https://login.tailscale.com/a/1' })
    mocks.poll.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(mocks.poll).not.toHaveBeenCalled()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(mocks.open).toHaveBeenCalledWith('https://login.tailscale.com/a/1')
  })
})
