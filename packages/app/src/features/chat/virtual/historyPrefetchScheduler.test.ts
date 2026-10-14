import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryPrefetchScheduler } from './historyPrefetchScheduler'

const schedulers: HistoryPrefetchScheduler[] = []

function scheduler(read: ConstructorParameters<typeof HistoryPrefetchScheduler>[0]) {
  const result = new HistoryPrefetchScheduler(read)
  schedulers.push(result)
  return result
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('adaptive history prefetch scheduling', () => {
  it('starts fast immediately and continues while the reader does not scroll, with exponential delays', async () => {
    const read = vi.fn().mockResolvedValue(true)
    scheduler(read).resume()
    expect(read).toHaveBeenCalledWith('fast', expect.any(AbortSignal))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(read.mock.calls.map(call => call[0])).toEqual(['fast', 'idle'])
    await vi.advanceTimersByTimeAsync(1999)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(8000)
    expect(read).toHaveBeenCalledTimes(5)
  })

  it('resets a slow idle schedule immediately when upward reading boosts it', async () => {
    const read = vi.fn().mockResolvedValue(true)
    const current = scheduler(read)
    current.resume()
    await vi.advanceTimersByTimeAsync(7000)
    expect(read).toHaveBeenCalledTimes(4)
    current.boost()
    expect(read.mock.calls.at(-1)?.[0]).toBe('fast')
    await vi.advanceTimersByTimeAsync(1000)
    expect(read.mock.calls.at(-1)?.[0]).toBe('idle')
    expect(read).toHaveBeenCalledTimes(6)
  })

  it('coalesces multiple boosts during a request without starting duplicate concurrent reads', async () => {
    let resolve!: (result: boolean) => void
    const read = vi.fn()
      .mockReturnValueOnce(new Promise<boolean>(done => { resolve = done }))
      .mockResolvedValue(true)
    const current = scheduler(read)
    current.resume()
    current.boost()
    current.boost()
    expect(read).toHaveBeenCalledTimes(1)
    resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(read.mock.calls.map(call => call[0])).toEqual(['fast', 'fast'])
  })

  it('stops at the history or cache limit and can resume fast after the reader consumes a page', async () => {
    const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const current = scheduler(read)
    current.resume()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(1)
    current.boost()
    await vi.advanceTimersByTimeAsync(1000)
    expect(read.mock.calls.map(call => call[0])).toEqual(['fast', 'fast', 'idle'])
  })

  it('pauses for a hidden view and prevents a pending read from continuing after unmount', async () => {
    let resolve!: (result: boolean) => void
    const read = vi.fn().mockReturnValueOnce(new Promise<boolean>(done => { resolve = done })).mockResolvedValue(true)
    const current = scheduler(read)
    current.resume()
    const signal = read.mock.calls[0][1] as AbortSignal
    current.pause()
    expect(signal.aborted).toBe(true)
    resolve(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(1)
    current.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    current.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('dispatches slow reads through browser idle callbacks when available', async () => {
    const idle = vi.fn().mockReturnValue(1)
    const cancelIdle = vi.fn()
    vi.stubGlobal('requestIdleCallback', idle)
    vi.stubGlobal('cancelIdleCallback', cancelIdle)
    const read = vi.fn().mockResolvedValue(true)
    const current = scheduler(read)
    current.resume()
    await vi.advanceTimersByTimeAsync(1000)
    expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 })
    expect(read).toHaveBeenCalledTimes(1)
    current.boost()
    expect(cancelIdle).toHaveBeenCalledWith(1)
    await vi.advanceTimersByTimeAsync(1000)
    idle.mock.calls.at(-1)![0]({ didTimeout: false, timeRemaining: () => 20 })
    await vi.advanceTimersByTimeAsync(0)
    expect(read.mock.calls.at(-1)?.[0]).toBe('idle')
  })
})
