import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionActivityWatchdog } from './sessionActivityWatchdog'

describe('SessionActivityWatchdog', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps at most one status request in flight per active session', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const check = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const watchdog = new SessionActivityWatchdog(() => ['active'], check, 1000, 900)

    watchdog.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(check).toHaveBeenCalledTimes(1)

    finish()
    await vi.advanceTimersByTimeAsync(1000)
    expect(check).toHaveBeenCalledTimes(2)
    watchdog.stop()
  })

  it('aborts outstanding checks when stopped', async () => {
    const check = vi.fn((_sessionId: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const watchdog = new SessionActivityWatchdog(() => ['active'], check)

    watchdog.start()
    watchdog.cancel('active')
    expect(check.mock.calls[0]?.[1].aborted).toBe(true)
    watchdog.stop()
  })
})
