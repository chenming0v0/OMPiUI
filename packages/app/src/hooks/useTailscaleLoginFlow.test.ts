import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTailscaleLoginFlow, type TailscaleAuthSnapshot } from './useTailscaleLoginFlow'

const mocks = vi.hoisted(() => ({
  start: vi.fn<(signal: AbortSignal) => Promise<TailscaleAuthSnapshot>>(),
  poll: vi.fn<(signal: AbortSignal) => Promise<TailscaleAuthSnapshot>>(),
  open: vi.fn<(url: string) => Promise<void | 'manual'>>(),
}))

const firstUrl = 'https://login.tailscale.com/a/1'
const secondUrl = 'https://login.tailscale.com/a/2'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  mocks.start.mockResolvedValue({ backendState: 'NeedsLogin', authUrl: null })
  mocks.poll.mockResolvedValue({ backendState: 'NeedsLogin', authUrl: null })
  mocks.open.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function renderFlow(overrides: Partial<Parameters<typeof useTailscaleLoginFlow>[0]> = {}) {
  return renderHook(options => useTailscaleLoginFlow({
    start: mocks.start, poll: mocks.poll, open: mocks.open,
    timeoutMessage: 'timed out', ...options,
  }), { initialProps: overrides })
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

  it.each(['Running', 'NeedsMachineAuth'])('prioritizes %s over a stale URL returned by start', async backendState => {
    mocks.start.mockResolvedValue({ backendState, authUrl: firstUrl })
    const { result } = renderFlow()
    await act(async () => { await result.current.beginLogin() })
    expect(result.current.phase).toBe('idle')
    expect(result.current.authUrl).toBeNull()
    expect(result.current.error).toBe('')
    expect(mocks.start.mock.calls[0][0].aborted).toBe(true)
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.poll).not.toHaveBeenCalled()
  })

  it.each(['Running', 'NeedsMachineAuth'])('prioritizes %s over a stale URL returned by login polling', async backendState => {
    const { result } = renderFlow()
    await act(async () => { await result.current.beginLogin() })
    mocks.poll.mockResolvedValue({ backendState, authUrl: firstUrl })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(result.current.phase).toBe('idle')
    expect(result.current.authUrl).toBeNull()
    expect(result.current.error).toBe('')
    expect(mocks.open).not.toHaveBeenCalled()
    const pollsAfterCompletion = mocks.poll.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(mocks.poll).toHaveBeenCalledTimes(pollsAfterCompletion)
  })

  it.each(['Running', 'NeedsMachineAuth'])('clears a kept authorization link when ordinary polling reports %s', async backendState => {
    mocks.poll.mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: firstUrl })
    const { result } = renderFlow()
    await act(async () => { await result.current.refreshStatus() })
    expect(result.current.phase).toBe('authReady')
    mocks.poll.mockResolvedValueOnce({ backendState, authUrl: secondUrl })
    await act(async () => { await result.current.refreshStatus() })
    expect(result.current.phase).toBe('idle')
    expect(result.current.authUrl).toBeNull()
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('keeps opening visible until the asynchronous browser launch completes', async () => {
    const launch = deferred<void | 'manual'>()
    mocks.start.mockResolvedValue({ backendState: 'NeedsLogin', authUrl: firstUrl })
    mocks.open.mockReturnValueOnce(launch.promise)
    const { result } = renderFlow({ statusPollMs: 1_000 })
    await act(async () => {})
    mocks.poll.mockClear()
    let login!: Promise<void>
    await act(async () => { login = result.current.beginLogin() })
    expect(result.current.phase).toBe('opening')
    expect(result.current.authUrl).toBe(firstUrl)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); await result.current.refreshStatus(true) })
    expect(result.current.phase).toBe('opening')
    expect(mocks.poll).not.toHaveBeenCalled()
    await act(async () => { launch.resolve(undefined); await login })
    expect(result.current.phase).toBe('authorizing')
  })

  it.each(['start', 'poll'] as const)('shows authReady rather than authorizing when %s yields a manually opened link', async source => {
    const launch = deferred<void | 'manual'>()
    mocks[source].mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: firstUrl })
    mocks.open.mockReturnValueOnce(launch.promise)
    const { result } = renderFlow()
    let login!: Promise<void>
    await act(async () => { login = result.current.beginLogin() })
    expect(result.current.phase).toBe('opening')
    await act(async () => { launch.resolve('manual'); await login })
    expect(result.current.phase).toBe('authReady')
    expect(result.current.authUrl).toBe(firstUrl)
    expect(result.current.error).toBe('')
  })

  it('ignores repeated beginLogin calls during starting and opening', async () => {
    const start = deferred<TailscaleAuthSnapshot>()
    const launch = deferred<void | 'manual'>()
    mocks.start.mockReturnValueOnce(start.promise)
    mocks.open.mockReturnValueOnce(launch.promise)
    const { result } = renderFlow()
    let login!: Promise<void>
    await act(async () => {
      login = result.current.beginLogin()
      void result.current.beginLogin()
    })
    const signal = mocks.start.mock.calls[0][0]
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(false)
    expect(result.current.phase).toBe('starting')
    await act(async () => { start.resolve({ backendState: 'NeedsLogin', authUrl: firstUrl }) })
    expect(result.current.phase).toBe('opening')
    await act(async () => { await result.current.beginLogin() })
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(mocks.open).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(false)
    await act(async () => { launch.resolve(undefined); await login })
    expect(result.current.phase).toBe('authorizing')
  })

  it('returns a fresh live AbortSignal from reset and aborts it on the next reset', async () => {
    const { result } = renderFlow()
    await act(async () => { await result.current.beginLogin() })
    const previous = mocks.start.mock.calls[0][0]
    let first: unknown
    act(() => { first = result.current.reset() })
    expect(previous.aborted).toBe(true)
    expect(first).toBeInstanceOf(AbortSignal)
    expect((first as AbortSignal).aborted).toBe(false)
    expect(first).not.toBe(previous)
    let second: unknown
    act(() => { second = result.current.reset() })
    expect((first as AbortSignal).aborted).toBe(true)
    expect(second).toBeInstanceOf(AbortSignal)
    expect((second as AbortSignal).aborted).toBe(false)
    expect(second).not.toBe(first)
    await act(async () => { await result.current.refreshStatus() })
    expect(mocks.poll.mock.calls.at(-1)?.[0]).toBe(second)
  })

  describe.each(['reset', 'unmount'] as const)('cancellation by %s', cancel => {
    it.each([
      ['start', 'resolve'], ['start', 'reject'],
      ['poll', 'resolve'], ['poll', 'reject'],
      ['open', 'resolve'], ['open', 'reject'],
    ] as const)('ignores an old %s %s after cancellation', async (operation, outcome) => {
      const response = deferred<TailscaleAuthSnapshot>()
      const launch = deferred<void | 'manual'>()
      const onPollError = vi.fn()
      if (operation === 'open') {
        mocks.start.mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: firstUrl })
        mocks.open.mockReturnValueOnce(launch.promise)
      } else {
        mocks[operation].mockReturnValueOnce(response.promise)
      }
      const { result, unmount } = renderFlow({ onPollError })
      let login!: Promise<void>
      await act(async () => { login = result.current.beginLogin() })
      const signal = mocks.start.mock.calls[0][0]
      if (operation === 'poll') expect(mocks.poll.mock.calls[0][0]).toBe(signal)
      if (cancel === 'reset') act(() => { result.current.reset() })
      else unmount()
      expect(signal.aborted).toBe(true)
      const stateAfterCancel = { phase: result.current.phase, authUrl: result.current.authUrl, error: result.current.error }
      const pollsAfterCancel = mocks.poll.mock.calls.length
      await act(async () => {
        if (operation === 'open') {
          if (outcome === 'resolve') launch.resolve('manual')
          else launch.reject(new Error('late browser failure'))
        } else if (outcome === 'resolve') {
          response.resolve({ backendState: 'NeedsLogin', authUrl: secondUrl })
        } else {
          response.reject(new Error('late request failure'))
        }
        await login
      })
      expect({ phase: result.current.phase, authUrl: result.current.authUrl, error: result.current.error }).toEqual(stateAfterCancel)
      if (cancel === 'reset') expect(stateAfterCancel).toEqual({ phase: 'idle', authUrl: null, error: '' })
      expect(mocks.open).toHaveBeenCalledTimes(operation === 'open' ? 1 : 0)
      expect(onPollError).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
      expect(mocks.poll).toHaveBeenCalledTimes(pollsAfterCancel)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it.each(['resolve', 'reject'] as const)('does not let an old poll %s release a new generation request lock', async outcome => {
    const oldPoll = deferred<TailscaleAuthSnapshot>()
    const newPoll = deferred<TailscaleAuthSnapshot>()
    const onPollError = vi.fn()
    mocks.poll.mockReturnValueOnce(oldPoll.promise).mockReturnValueOnce(newPoll.promise)
    const { result } = renderFlow({ onPollError })
    let oldRefresh!: Promise<void>
    let newRefresh!: Promise<void>
    await act(async () => { oldRefresh = result.current.refreshStatus() })
    const oldSignal = mocks.poll.mock.calls[0][0]
    act(() => { result.current.reset() })
    await act(async () => { newRefresh = result.current.refreshStatus() })
    const newSignal = mocks.poll.mock.calls[1][0]
    expect(oldSignal.aborted).toBe(true)
    expect(newSignal.aborted).toBe(false)
    expect(newSignal).not.toBe(oldSignal)
    await act(async () => {
      if (outcome === 'resolve') oldPoll.resolve({ backendState: 'Running', authUrl: firstUrl })
      else oldPoll.reject(new Error('old poll failed'))
      await oldRefresh
      await result.current.refreshStatus(true)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mocks.poll).toHaveBeenCalledTimes(2)
    expect(newSignal.aborted).toBe(false)
    expect(result.current.phase).toBe('idle')
    expect(onPollError).not.toHaveBeenCalled()
    await act(async () => {
      newPoll.resolve({ backendState: 'NeedsLogin', authUrl: secondUrl })
      await newRefresh
      await result.current.refreshStatus()
    })
    expect(mocks.poll).toHaveBeenCalledTimes(3)
  })

  it.each(['resolve', 'reject'] as const)('does not let an old start %s overwrite or unlock a new start', async outcome => {
    const oldStart = deferred<TailscaleAuthSnapshot>()
    const newStart = deferred<TailscaleAuthSnapshot>()
    mocks.start.mockReturnValueOnce(oldStart.promise).mockReturnValueOnce(newStart.promise)
    const { result } = renderFlow()
    let oldLogin!: Promise<void>
    let newLogin!: Promise<void>
    await act(async () => { oldLogin = result.current.beginLogin() })
    const oldSignal = mocks.start.mock.calls[0][0]
    act(() => { result.current.reset() })
    await act(async () => { newLogin = result.current.beginLogin() })
    const newSignal = mocks.start.mock.calls[1][0]
    expect(oldSignal.aborted).toBe(true)
    await act(async () => {
      if (outcome === 'resolve') oldStart.resolve({ backendState: 'Running', authUrl: firstUrl })
      else oldStart.reject(new Error('old start failed'))
      await oldLogin
      await result.current.refreshStatus(true)
    })
    expect(result.current.phase).toBe('starting')
    expect(result.current.error).toBe('')
    expect(mocks.poll).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
    expect(newSignal.aborted).toBe(false)
    await act(async () => {
      newStart.resolve({ backendState: 'NeedsLogin', authUrl: secondUrl })
      await newLogin
    })
    expect(result.current.authUrl).toBe(secondUrl)
    expect(result.current.phase).toBe('authorizing')
  })

  it.each(['resolve', 'reject'] as const)('does not let an old open %s overwrite or unlock a new browser launch', async outcome => {
    const oldLaunch = deferred<void | 'manual'>()
    const newLaunch = deferred<void | 'manual'>()
    mocks.start.mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: firstUrl })
      .mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: secondUrl })
    mocks.open.mockReturnValueOnce(oldLaunch.promise).mockReturnValueOnce(newLaunch.promise)
    const { result } = renderFlow()
    let oldLogin!: Promise<void>
    let newLogin!: Promise<void>
    await act(async () => { oldLogin = result.current.beginLogin() })
    act(() => { result.current.reset() })
    await act(async () => { newLogin = result.current.beginLogin() })
    await act(async () => {
      if (outcome === 'resolve') oldLaunch.resolve('manual')
      else oldLaunch.reject(new Error('old browser failed'))
      await oldLogin
      await result.current.refreshStatus(true)
    })
    expect(result.current.phase).toBe('opening')
    expect(result.current.authUrl).toBe(secondUrl)
    expect(result.current.error).toBe('')
    expect(mocks.poll).not.toHaveBeenCalled()
    expect(mocks.open).toHaveBeenCalledTimes(2)
    await act(async () => { newLaunch.resolve(undefined); await newLogin })
    expect(result.current.phase).toBe('authorizing')
  })

  it('shares one in-flight poll across ordinary timers, login timers, manual refresh and visibility resume', async () => {
    const status = deferred<TailscaleAuthSnapshot>()
    const loginPoll = deferred<TailscaleAuthSnapshot>()
    mocks.poll.mockReturnValueOnce(status.promise).mockReturnValueOnce(loginPoll.promise)
    const { result } = renderFlow({ statusPollMs: 1_000, pollMs: 250 })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const statusSignal = mocks.poll.mock.calls[0][0]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
      await result.current.refreshStatus()
      await result.current.refreshStatus(true)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mocks.poll).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.beginLogin() })
    expect(statusSignal.aborted).toBe(true)
    expect(mocks.poll).toHaveBeenCalledTimes(2)
    await act(async () => {
      status.resolve({ backendState: 'NeedsLogin', authUrl: firstUrl })
      await vi.advanceTimersByTimeAsync(2_000)
      await result.current.refreshStatus(true)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mocks.poll).toHaveBeenCalledTimes(2)
    expect(mocks.open).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('waitingAuthUrl')
    await act(async () => { loginPoll.resolve({ backendState: 'NeedsLogin', authUrl: secondUrl }) })
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(secondUrl)
    expect(result.current.phase).toBe('authorizing')
  })

  it('uses force to bypass paused ordinary polling, but never the hidden-page gate', async () => {
    const { result, rerender } = renderFlow({ statusPollMs: 1_000, paused: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); await result.current.refreshStatus() })
    expect(mocks.poll).not.toHaveBeenCalled()
    await act(async () => { await result.current.refreshStatus(true) })
    expect(mocks.poll).toHaveBeenCalledTimes(1)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => {
      await result.current.refreshStatus(true)
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(mocks.poll).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    rerender({ statusPollMs: 1_000, paused: false })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(mocks.poll).toHaveBeenCalledTimes(2)
  })

  it.each(['url', 'Running', 'NeedsMachineAuth', 'missing'] as const)('reads authoritative %s before applying elapsed timeout after a long hidden interval', async state => {
    const { result } = renderFlow()
    await act(async () => { await result.current.beginLogin() })
    const pollsBeforeHidden = mocks.poll.mock.calls.length
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(mocks.poll).toHaveBeenCalledTimes(pollsBeforeHidden)
    expect(result.current.phase).toBe('waitingAuthUrl')
    const status = deferred<TailscaleAuthSnapshot>()
    mocks.poll.mockReturnValueOnce(status.promise)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(mocks.poll).toHaveBeenCalledTimes(pollsBeforeHidden + 1)
    expect(result.current.phase).toBe('waitingAuthUrl')
    expect(result.current.error).toBe('')
    await act(async () => {
      status.resolve({
        backendState: state === 'Running' || state === 'NeedsMachineAuth' ? state : 'NeedsLogin',
        authUrl: state === 'missing' ? null : firstUrl,
      })
    })
    if (state === 'url') {
      expect(mocks.open).toHaveBeenCalledExactlyOnceWith(firstUrl)
      expect(result.current.phase).toBe('authorizing')
      expect(result.current.error).toBe('')
    } else {
      expect(mocks.open).not.toHaveBeenCalled()
      expect(result.current.phase).toBe(state === 'missing' ? 'error' : 'idle')
      expect(result.current.error).toBe(state === 'missing' ? 'timed out' : '')
      expect(result.current.authUrl).toBeNull()
    }
  })

  it('tracks authoritative URL rotation and clearing without automatically reopening a browser', async () => {
    mocks.start.mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: firstUrl })
    const { result } = renderFlow({ statusPollMs: 1_000 })
    await act(async () => {})
    await act(async () => { await result.current.beginLogin() })
    mocks.poll.mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: firstUrl })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(result.current.phase).toBe('authorizing')
    mocks.poll.mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: secondUrl })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(result.current.phase).toBe('authReady')
    expect(result.current.authUrl).toBe(secondUrl)
    expect(mocks.open).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.reopenAuthPage() })
    expect(mocks.open).toHaveBeenLastCalledWith(secondUrl)
    mocks.poll.mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: null })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(result.current.phase).toBe('idle')
    expect(result.current.authUrl).toBeNull()
    expect(result.current.error).toBe('')
    await act(async () => { await result.current.reopenAuthPage() })
    expect(mocks.open).toHaveBeenCalledTimes(2)
  })

  it.each(['resolve', 'reject'] as const)('cancels an existing poll before reopen and ignores its late %s', async outcome => {
    const pendingPoll = deferred<TailscaleAuthSnapshot>()
    const launch = deferred<void | 'manual'>()
    const onPollError = vi.fn()
    mocks.poll.mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: firstUrl })
      .mockReturnValueOnce(pendingPoll.promise)
    const { result } = renderFlow({ onPollError })
    await act(async () => { await result.current.refreshStatus() })
    let refresh!: Promise<void>
    await act(async () => { refresh = result.current.refreshStatus() })
    const signal = mocks.poll.mock.calls[1][0]
    mocks.open.mockImplementationOnce(url => {
      expect(signal.aborted).toBe(true)
      expect(url).toBe(firstUrl)
      return launch.promise
    })
    let reopen!: Promise<void>
    await act(async () => { reopen = result.current.reopenAuthPage() })
    expect(signal.aborted).toBe(true)
    expect(result.current.phase).toBe('opening')
    await act(async () => {
      if (outcome === 'resolve') pendingPoll.resolve({ backendState: 'Running', authUrl: secondUrl })
      else pendingPoll.reject(new Error('cancelled status failed'))
      await refresh
    })
    expect(result.current.phase).toBe('opening')
    expect(result.current.authUrl).toBe(firstUrl)
    expect(result.current.error).toBe('')
    expect(onPollError).not.toHaveBeenCalled()
    await act(async () => { launch.resolve(undefined); await reopen })
    expect(result.current.phase).toBe('authorizing')
  })

  it.each(['start', 'poll', 'open', 'timeout'] as const)('can retry login after a %s failure', async operation => {
    const failure = new Error(`${operation} failed`)
    const onPollError = vi.fn()
    if (operation === 'start') mocks.start.mockRejectedValueOnce(failure)
    else if (operation === 'poll') mocks.poll.mockRejectedValueOnce(failure)
    else if (operation === 'open') {
      mocks.start.mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: firstUrl })
      mocks.open.mockRejectedValueOnce(failure)
    }
    const { result } = renderFlow({ onPollError })
    await act(async () => { await result.current.beginLogin() })
    if (operation === 'timeout') await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(result.current.phase).toBe('error')
    expect(result.current.error).toBe(operation === 'timeout' ? 'timed out' : failure.message)
    expect(onPollError).toHaveBeenCalledTimes(operation === 'poll' ? 1 : 0)
    const oldSignal = mocks.start.mock.calls[0][0]
    const retry = deferred<TailscaleAuthSnapshot>()
    mocks.start.mockReturnValueOnce(retry.promise)
    let login!: Promise<void>
    await act(async () => { login = result.current.beginLogin() })
    expect(oldSignal.aborted).toBe(true)
    expect(result.current.phase).toBe('starting')
    expect(result.current.error).toBe('')
    expect(result.current.authUrl).toBeNull()
    await act(async () => { retry.resolve({ backendState: 'NeedsLogin', authUrl: secondUrl }); await login })
    expect(result.current.phase).toBe('authorizing')
    expect(result.current.authUrl).toBe(secondUrl)
    expect(mocks.open).toHaveBeenLastCalledWith(secondUrl)
  })

  it('can retry browser launch from the preserved URL after opening fails', async () => {
    mocks.start.mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: firstUrl })
    mocks.open.mockRejectedValueOnce(new Error('browser unavailable')).mockResolvedValueOnce('manual')
    const { result } = renderFlow()
    await act(async () => { await result.current.beginLogin() })
    expect(result.current.phase).toBe('error')
    await act(async () => { await result.current.reopenAuthPage() })
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(mocks.open).toHaveBeenNthCalledWith(2, firstUrl)
    expect(result.current.phase).toBe('authReady')
    expect(result.current.error).toBe('')
  })

  it('reports ordinary poll errors without preventing subsequent refreshes', async () => {
    const failure = new Error('status unavailable')
    const onPollError = vi.fn()
    mocks.poll.mockRejectedValueOnce(failure).mockResolvedValueOnce({ backendState: 'NeedsLogin', authUrl: firstUrl })
    const { result } = renderFlow({ onPollError })
    await act(async () => { await result.current.refreshStatus() })
    expect(onPollError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(result.current.phase).toBe('idle')
    expect(result.current.error).toBe('')
    await act(async () => { await result.current.refreshStatus() })
    expect(mocks.poll).toHaveBeenCalledTimes(2)
    expect(result.current.phase).toBe('authReady')
    expect(result.current.authUrl).toBe(firstUrl)
  })
})
