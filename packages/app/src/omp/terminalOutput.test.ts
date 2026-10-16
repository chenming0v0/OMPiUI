import { afterEach, expect, it, vi } from 'vitest'
import { createTerminalOutputConsumer } from './terminalOutput'

afterEach(() => vi.useRealTimers())

it('acknowledges consumed xterm output, coalesces callbacks and never snapshots an unparsed ready cursor', async () => {
  vi.useFakeTimers()
  const consumed: Array<() => void> = []
  const cursor = vi.fn()
  const ack = vi.fn()
  const output = createTerminalOutputConsumer((_data, done) => consumed.push(done), cursor, ack, () => true)
  output.write('first', 5, true)
  output.write('second', 11, true)
  output.ready(11)
  await vi.advanceTimersByTimeAsync(100)
  expect(cursor).not.toHaveBeenCalled()
  expect(ack).not.toHaveBeenCalled()
  consumed[0]()
  consumed[1]()
  expect(cursor.mock.calls).toEqual([[5], [11]])
  await vi.advanceTimersByTimeAsync(50)
  expect(ack.mock.calls).toEqual([[11]])
  output.write('legacy', 17, false)
  consumed[2]()
  await vi.advanceTimersByTimeAsync(100)
  expect(cursor).toHaveBeenLastCalledWith(17)
  expect(ack).toHaveBeenCalledTimes(1)
  output.write('discarded', 26, true)
  output.dispose()
  consumed[3]()
  expect(cursor).toHaveBeenLastCalledWith(26)
})

it('waits for writes already handed to xterm before reconnect can resume from its cursor', async () => {
  const consumed: Array<() => void> = []
  const cursor = vi.fn()
  const output = createTerminalOutputConsumer((_data, done) => consumed.push(done), cursor, vi.fn(), () => true)
  output.write('queued output', 42, true)
  let drained = false
  const drain = output.drain().then(() => { drained = true })
  expect(drained).toBe(false)
  consumed[0]!()
  await drain
  expect(drained).toBe(true)
  expect(cursor).toHaveBeenCalledWith(42)
})
