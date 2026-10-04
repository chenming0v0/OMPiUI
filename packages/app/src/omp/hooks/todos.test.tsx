import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { usePiSessionTodos } from './index'
import { piBranchStore } from '../state/index.js'
import type { PiBranchPage, SessionEntry } from '../domain/index.js'

const sessionId = 'todo-snapshots'
function resultEntry(id: string, details: unknown, isError = false): SessionEntry {
  return {
    type: 'message', id, parentId: null, timestamp: '2026-10-03T00:00:00Z',
    message: { role: 'toolResult', toolCallId: id, toolName: 'todo', content: [], timestamp: 0, details, isError },
  }
}
function seed(items: SessionEntry[]) {
  piBranchStore.setData(sessionId, {
    head: { sdkVersion: 'test', revision: items.length, header: null, leafId: null, entryCount: items.length, epoch: 'test' },
    items, hasMore: false,
  } as PiBranchPage)
}
afterEach(() => piBranchStore.clear(sessionId))

describe('usePiSessionTodos', () => {
  it('uses committed phases, ignores failed/view snapshots, and clears on an empty snapshot', () => {
    const initial = resultEntry('init', { op: 'init', phases: [{ name: '验证', tasks: [{ content: '验证模型', status: 'in_progress' }] }] })
    seed([initial])
    const { result } = renderHook(() => usePiSessionTodos(sessionId))
    expect(result.current.map(item => [item.phase, item.content, item.status])).toEqual([['验证', '验证模型', 'in_progress']])
    act(() => seed([initial, resultEntry('failed', { op: 'done', phases: [] }, true), resultEntry('view', { op: 'view', phases: [] })]))
    expect(result.current.map(item => item.content)).toEqual(['验证模型'])
    act(() => seed([initial, resultEntry('removed', { op: 'rm', phases: [] })]))
    expect(result.current).toEqual([])
  })

  it('restores native user edits and does not mix tasks from another session', () => {
    seed([{
      type: 'custom', id: 'edit', parentId: null, timestamp: '2026-10-03T00:00:00Z', customType: 'user_todo_edit',
      data: { phases: [{ name: '发布', tasks: [{ content: '等待签名', status: 'blocked', blocker: '等待用户授权' }] }] },
    }])
    const { result, rerender } = renderHook(({ id }) => usePiSessionTodos(id), { initialProps: { id: sessionId } })
    expect(result.current.map(item => [item.phase, item.content, item.status, item.blocker])).toEqual([['发布', '等待签名', 'blocked', '等待用户授权']])
    rerender({ id: 'other-session' })
    expect(result.current).toEqual([])
  })
})
