import { afterEach, expect, it } from 'vitest'
import { piBranchStore } from './piBranchStore'
import type { PiBranchPage } from '../domain'

const page = (count: number) =>
  ({
    head: { sdkVersion: 'test', epoch: 'test', revision: 1, header: null, leafId: null, entryCount: count },
    items: Array.from({ length: count }, (_, index) => ({ id: String(index), parentId: null, timestamp: new Date(index).toISOString(), type: 'message', message: { role: 'user', content: String(index), timestamp: index } })),
    hasMore: false,
  }) as PiBranchPage
afterEach(() => piBranchStore.clearAll())

it('evicts inactive histories without dropping another active pane', () => {
  piBranchStore.retain('active')
  const loaded = { ...page(500), client: { historyWindowed: true } }
  piBranchStore.setData('active', loaded)
  for (let index = 0; index < 10; index++) piBranchStore.setData(`old-${index}`, page(10))
  expect(piBranchStore.getData('old-0')).toBeNull()
  expect(piBranchStore.getData('old-9')).not.toBeNull()
  expect(piBranchStore.getData('active')?.items).toEqual(loaded.items)
  piBranchStore.release('active')
  expect(piBranchStore.getData('active')).toBeNull()
})

it('keeps completed tool evidence received before initial history hydration', () => {
  const call = { type: 'toolCall' as const, id: 'early', name: 'eval', arguments: {} }
  piBranchStore.patchToolExecution('early-session', 'early', { call, isRunning: true, startedAt: 1 })
  piBranchStore.patchToolExecution('early-session', 'early', { isRunning: false, completedAt: 5 })
  piBranchStore.setData('early-session', page(0))
  expect(piBranchStore.getData('early-session')?.client?.toolExecutions?.early).toMatchObject({ call, isRunning: false, completedAt: 5 })
})

it('seals prehydration started tools on a crash without claiming they completed', () => {
  piBranchStore.patchToolExecution('early-crash', 'early', { isRunning: true, startedAt: 1 })
  piBranchStore.interruptToolExecutions('early-crash', 'Worker exited')
  piBranchStore.setData('early-crash', page(0))
  expect(piBranchStore.getData('early-crash')?.client?.toolExecutions?.early).toMatchObject({ isRunning: false, error: 'Worker exited' })
  expect(piBranchStore.getData('early-crash')?.client?.toolExecutions?.early.result).toBeUndefined()
})

it('keeps terminal evidence across reconnect epochs and stale starts, then accepts a real result', () => {
  const call = { type: 'toolCall' as const, id: 'lost', name: 'bash', arguments: {} }
  const branch: PiBranchPage = { ...page(0), items: [{ type: 'message', id: 'assistant', parentId: null, timestamp: new Date(1).toISOString(), message: { role: 'assistant', content: [call], timestamp: 1 } } as PiBranchPage['items'][number]] }
  piBranchStore.setData('reconnect', branch)
  piBranchStore.patchToolExecution('reconnect', call.id, { call, startedAt: 1, isRunning: true })
  piBranchStore.interruptToolExecutions('reconnect', 'The runtime exited with code 23', 'failed')
  piBranchStore.setData('reconnect', { ...branch, client: { toolExecutions: { lost: { startedAt: 1, isRunning: true } } } })
  expect(piBranchStore.patchToolExecution('reconnect', call.id, { isRunning: true })).toBe(false)
  expect(piBranchStore.getData('reconnect')?.client?.toolExecutions?.lost).toMatchObject({ isRunning: false, error: 'The runtime exited with code 23', interruption: 'failed' })
  const result = { role: 'toolResult' as const, toolCallId: call.id, toolName: call.name, content: [{ type: 'text' as const, text: 'The buffered final result' }], timestamp: 20, isError: false }
  piBranchStore.setData('reconnect', { ...branch, items: [...branch.items, { type: 'message', id: 'result', parentId: 'assistant', timestamp: new Date(20).toISOString(), message: result }] })
  expect(piBranchStore.getData('reconnect')?.client?.toolExecutions?.lost).toMatchObject({ result, isRunning: false, error: undefined, interruption: undefined })
})

it('upgrades an unknown outcome with the real exit reason without overwriting completed or unstarted calls', () => {
  piBranchStore.patchToolExecution('exit', 'lost', { isRunning: true, startedAt: 1 })
  piBranchStore.patchToolExecution('exit', 'done', { startedAt: 1, completedAt: 2, isRunning: false })
  piBranchStore.patchToolExecution('exit', 'queued', { call: { type: 'toolCall', id: 'queued', name: 'read', arguments: {} } })
  piBranchStore.interruptToolExecutions('exit', 'No result in the settled snapshot', 'unknown')
  piBranchStore.interruptToolExecutions('exit', 'Stopped by the user', 'cancelled')
  piBranchStore.setData('exit', page(0))
  const executions = piBranchStore.getData('exit')?.client?.toolExecutions
  expect(executions?.lost).toMatchObject({ isRunning: false, interruption: 'cancelled', error: 'Stopped by the user' })
  expect(executions?.done).toMatchObject({ isRunning: false, completedAt: 2 })
  expect(executions?.done?.error).toBeUndefined()
  expect(executions?.queued?.error).toBeUndefined()
  expect(executions?.lost?.result).toBeUndefined()
})

it('does not let an unseen delayed start erase a prehydration crash boundary', () => {
  piBranchStore.interruptToolExecutions('delayed-start', 'Runtime code 23', 'failed')
  piBranchStore.patchToolExecution('delayed-start', 'late-call', { isRunning: true, startedAt: 1 })
  piBranchStore.setData('delayed-start', page(0))
  expect(piBranchStore.getData('delayed-start')?.client?.toolExecutions?.['late-call']).toMatchObject({ isRunning: false, interruption: 'failed', error: 'Runtime code 23' })
  piBranchStore.beginToolExecutions('delayed-start')
  piBranchStore.patchToolExecution('delayed-start', 'new-call', { isRunning: true, startedAt: 20 })
  expect(piBranchStore.getData('delayed-start')?.client?.toolExecutions?.['new-call']).toMatchObject({ isRunning: true })
  expect(piBranchStore.getData('delayed-start')?.client?.toolExecutions?.['new-call'].error).toBeUndefined()
})
