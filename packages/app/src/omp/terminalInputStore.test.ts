import { afterEach, expect, it, vi } from 'vitest'
import { getTerminalInputQueue } from './terminalInputStore'
import { layoutStore } from '../store/layoutStore'
import type { PiSocket } from './ompSocket'

const id = 'retained-terminal'
afterEach(() => { layoutStore.removeTerminalTab(id); vi.useRealTimers() })

it('retains accepted input across file-tab switches and panel moves, and releases actual terminal removal', () => {
  vi.useFakeTimers()
  layoutStore.addTerminalTab({ id, title: 'QA', status: 'connected' })
  const queue = getTerminalInputQueue(id)
  const first = { readyState: 1, send: vi.fn(), close: vi.fn() } as unknown as PiSocket
  const second = { readyState: 1, send: vi.fn(), close: vi.fn() } as unknown as PiSocket
  queue.connect(first, true)
  queue.enqueue('a'.repeat(32768) + 'b'.repeat(32768))
  const initial = JSON.parse(vi.mocked(first.send).mock.calls[0][0] as string)
  queue.acknowledge(first, { type: 'input_ack', inputId: initial.inputId, accepted: true })
  queue.disconnect(first)
  const files = layoutStore.addFilesTab('bottom')
  layoutStore.setActiveTab('bottom', files)
  layoutStore.moveTab(id, 'right')
  expect(getTerminalInputQueue(id)).toBe(queue)
  expect(queue.pendingText).toBe('b'.repeat(32768))
  queue.connect(second, true)
  const rest = JSON.parse(vi.mocked(second.send).mock.calls[0][0] as string)
  queue.acknowledge(second, { type: 'input_ack', inputId: rest.inputId, accepted: true })
  expect(initial.data + rest.data).toBe('a'.repeat(32768) + 'b'.repeat(32768))
  expect(queue.pendingBytes).toBe(0)
  layoutStore.removeTerminalTab(id)
  expect(queue.enqueue('removed')).toBe('closed')
  layoutStore.removeTab(files)
})

it('preserves unknown ACK recovery instead of automatically replaying it in a new view', () => {
  vi.useFakeTimers()
  layoutStore.addTerminalTab({ id, title: 'QA', status: 'connected' })
  const queue = getTerminalInputQueue(id)
  const socket = { readyState: 1, send: vi.fn(), close: vi.fn() } as unknown as PiSocket
  queue.connect(socket, true)
  queue.enqueue('may have executed')
  queue.disconnect(socket)
  layoutStore.moveTab(id, 'right')
  const reopened = getTerminalInputQueue(id)
  expect(reopened.state).toBe('interrupted')
  expect(reopened.pendingText).toBe('may have executed')
  const replacement = { readyState: 1, send: vi.fn(), close: vi.fn() } as unknown as PiSocket
  reopened.connect(replacement, true)
  vi.advanceTimersByTime(20_000)
  expect(replacement.send).not.toHaveBeenCalled()
})
