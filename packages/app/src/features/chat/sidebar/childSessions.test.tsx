import { waitFor } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiSession } from '../../../types/session'
import { useChildSessions } from './childSessions'

const listPiChildSessionsMock = vi.hoisted(() => vi.fn())
const serverGenerationMock = vi.hoisted(() => vi.fn(() => 1))

vi.mock('../../../omp/transport/index.js', () => ({
  listPiChildSessions: listPiChildSessionsMock,
}))
vi.mock('../../../store/serverStore', () => ({
  serverStore: { getActiveServerGeneration: serverGenerationMock },
}))

const PARENT_PATH = 'C:/proj/sessions/abc.jsonl'

function makeParent(): UiSession {
  return { id: 'parent-1', directory: 'C:/proj', title: 'parent', createdAt: 1, updatedAt: 1, path: PARENT_PATH }
}

describe('useChildSessions', () => {
  beforeEach(() => {
    listPiChildSessionsMock.mockReset()
    serverGenerationMock.mockClear()
  })

  it('loads child sessions for the selected parent and exposes the owning parent id', async () => {
    listPiChildSessionsMock.mockResolvedValue([
      {
        id: 'child-1',
        cwd: 'C:/proj',
        name: '',
        firstMessage: 'Complete assignment thoroughly',
        created: '2026-09-30T18:48:33.355Z',
        modified: 1_791_000_000_000,
        messageCount: 55,
        path: 'C:/proj/sessions/abc/ProjectScout.jsonl',
      },
    ])
    const lookup = new Map([['parent-1', makeParent()]])

    const { result } = renderHook(() => useChildSessions('parent-1', lookup))

    await waitFor(() => {
      expect(result.current.parentId).toBe('parent-1')
      expect(result.current.sessions).toHaveLength(1)
    })
    expect(listPiChildSessionsMock).toHaveBeenCalledWith(PARENT_PATH)
    expect(result.current.sessions[0]).toMatchObject({
      id: 'child-1',
      directory: 'C:/proj',
      title: 'Complete assignment thoroughly',
      path: 'C:/proj/sessions/abc/ProjectScout.jsonl',
      parentSessionPath: PARENT_PATH,
      isChildSession: true,
    })
  })

  it('keeps the loaded list while a child session is selected (not resolvable in the main lookup)', async () => {
    listPiChildSessionsMock.mockResolvedValue([
      { id: 'child-1', cwd: 'C:/proj', name: 'scout', path: 'C:/proj/sessions/abc/scout.jsonl' },
    ])
    const lookup = new Map([['parent-1', makeParent()]])

    const { result, rerender } = renderHook(
      ({ selectedId }: { selectedId: string | null }) => useChildSessions(selectedId, lookup),
      { initialProps: { selectedId: 'parent-1' as string | null } },
    )
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    // 选中子会话：主 lookup 里没有 → parentPath 解析为 null → 列表保持
    rerender({ selectedId: 'child-1' })
    expect(result.current.parentId).toBe('parent-1')
    expect(result.current.sessions).toHaveLength(1)
  })

  it('clears while a different parent loads to avoid flashing the previous list', async () => {
    listPiChildSessionsMock.mockImplementation((_path: string) =>
      _path.endsWith('abc.jsonl')
        ? Promise.resolve([{ id: 'child-1', cwd: 'C:/proj', name: 'a', path: 'C:/proj/sessions/abc/a.jsonl' }])
        : new Promise(() => {}),
    )
    const lookup = new Map([
      ['parent-1', makeParent()],
      ['parent-2', { id: 'parent-2', directory: 'C:/proj', title: 'p2', createdAt: 1, updatedAt: 1, path: 'C:/proj/sessions/def.jsonl' } as UiSession],
    ])

    const { result, rerender } = renderHook(
      ({ selectedId }: { selectedId: string | null }) => useChildSessions(selectedId, lookup),
      { initialProps: { selectedId: 'parent-1' as string | null } },
    )
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    // 切到另一个父会话：旧列表立刻清空，等新数据到达
    rerender({ selectedId: 'parent-2' })
    expect(result.current.parentId).toBeNull()
    expect(result.current.sessions).toHaveLength(0)
  })
})
