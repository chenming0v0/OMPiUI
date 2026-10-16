import { afterEach, expect, it, vi } from 'vitest'
import { loadPiSessions } from './index'
import { serverStore } from '../../store/serverStore'
import * as transport from '../transport'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('never retries an old session-list operation against the next backend', async () => {
  vi.useFakeTimers()
  let generation = 1
  vi.spyOn(serverStore, 'getActiveServerGeneration').mockImplementation(() => generation)
  const read = vi.spyOn(transport, 'listAllPiSessions').mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }))
  const rejected = expect(loadPiSessions()).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(0)
  generation++
  await vi.advanceTimersByTimeAsync(250)
  await rejected
  expect(read).toHaveBeenCalledTimes(1)
})
