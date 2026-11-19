import { act, waitFor } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiSession } from '../../../types/session'
import { useChildSessions } from './childSessions'

const listPiChildSessionsMock = vi.hoisted(() => vi.fn())
const serverGenerationMock = vi.hoisted(() => vi.fn(() => 1))
const serverIdMock = vi.hoisted(() => vi.fn(() => 'local'))
const serverListeners = vi.hoisted(() => new Set<() => void>())

vi.mock('../../../omp/transport/index.js', () => ({
  listPiChildSessions: listPiChildSessionsMock,
}))
vi.mock('../../../store/serverStore', () => ({
  serverStore: {
    getActiveServerGeneration: serverGenerationMock,
    getActiveServerId: serverIdMock,
    subscribe: (listener: () => void) => {
      serverListeners.add(listener)
      return () => serverListeners.delete(listener)
    },
  },
}))

const PARENT_PATH = 'C:/proj/sessions/abc.jsonl'

function makeParent(): UiSession {
  return { id: 'parent-1', directory: 'C:/proj', title: 'parent', createdAt: 1, updatedAt: 1, path: PARENT_PATH }
}

describe('useChildSessions', () => {
  beforeEach(() => {
    listPiChildSessionsMock.mockReset()
    serverGenerationMock.mockReset().mockReturnValue(1)
    serverIdMock.mockReset().mockReturnValue('local')
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
    expect(listPiChildSessionsMock).toHaveBeenCalledWith(PARENT_PATH, expect.any(AbortSignal))
    expect(result.current.sessions[0]).toMatchObject({
      id: 'child-1',
      directory: 'C:/proj',
      title: 'ProjectScout',
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

  it('refreshes the loaded list when ompiui:sessions-changed fires and keeps the child selected', async () => {
    listPiChildSessionsMock.mockResolvedValue([
      { id: 'child-1', cwd: 'C:/proj', name: 'scout', path: 'C:/proj/sessions/abc/scout.jsonl' },
    ])
    const lookup = new Map([['parent-1', makeParent()]])
    const { result, rerender } = renderHook(
      ({ selectedId }: { selectedId: string | null }) => useChildSessions(selectedId, lookup),
      { initialProps: { selectedId: 'parent-1' as string | null } },
    )
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    listPiChildSessionsMock.mockResolvedValue([
      { id: 'child-1', cwd: 'C:/proj', name: 'Project scout', path: 'C:/proj/sessions/abc/scout.jsonl' },
      { id: 'child-2', cwd: 'C:/proj', name: 'Docs', path: 'C:/proj/sessions/abc/docs.jsonl' },
    ])
    window.dispatchEvent(new CustomEvent('omompiui:sessions-changed'))
    expect(listPiChildSessionsMock).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
    await waitFor(() => expect(result.current.sessions).toHaveLength(2), { timeout: 1500 })
    expect(result.current.sessions.map(session => session.title)).toEqual(['Project scout', 'Docs'])

    rerender({ selectedId: 'child-1' })
    expect(result.current.parentId).toBe('parent-1')
    expect(result.current.sessions).toHaveLength(2)
  })

  it('does not reload when refreshed session objects keep the same parent id and path', async () => {
    listPiChildSessionsMock.mockResolvedValue([
      { id: 'child-1', cwd: 'C:/proj', name: 'scout', path: 'C:/proj/sessions/abc/scout.jsonl' },
    ])
    const { result, rerender } = renderHook(
      ({ parent }: { parent: UiSession }) => useChildSessions(parent.id, new Map([[parent.id, parent]])),
      { initialProps: { parent: makeParent() } },
    )
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    const children = result.current.sessions
    rerender({ parent: { ...makeParent(), title: 'new title', updatedAt: 2, messageCount: 10 } })
    expect(listPiChildSessionsMock).toHaveBeenCalledTimes(1)
    expect(result.current.sessions).toBe(children)
  })

  it('reloads for a changed parent identity even when the path is unchanged', async () => {
    listPiChildSessionsMock.mockResolvedValue([])
    const { result, rerender } = renderHook(
      ({ parent }: { parent: UiSession }) => useChildSessions(parent.id, new Map([[parent.id, parent]])),
      { initialProps: { parent: makeParent() } },
    )
    await waitFor(() => expect(result.current.parentId).toBe('parent-1'))
    rerender({ parent: { ...makeParent(), id: 'replacement' } })
    expect(result.current.parentId).toBeNull()
    await waitFor(() => expect(result.current.parentId).toBe('replacement'))
    expect(listPiChildSessionsMock).toHaveBeenCalledTimes(2)
  })

  it('does not load while hidden and refreshes when shown without losing a selected child', async () => {
    listPiChildSessionsMock.mockResolvedValue([
      { id: 'child-1', cwd: 'C:/proj', name: 'scout', path: 'C:/proj/sessions/abc/scout.jsonl' },
    ])
    const lookup = new Map([['parent-1', makeParent()]])
    const { result, rerender } = renderHook(
      ({ enabled, selectedId }: { enabled: boolean; selectedId: string }) => useChildSessions(selectedId, lookup, enabled),
      { initialProps: { enabled: false, selectedId: 'parent-1' } },
    )
    expect(listPiChildSessionsMock).not.toHaveBeenCalled()
    rerender({ enabled: true, selectedId: 'parent-1' })
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    rerender({ enabled: false, selectedId: 'child-1' })
    window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
    expect(listPiChildSessionsMock).toHaveBeenCalledTimes(1)
    expect(result.current.parentId).toBe('parent-1')
    rerender({ enabled: true, selectedId: 'child-1' })
    await waitFor(() => expect(listPiChildSessionsMock).toHaveBeenCalledTimes(2))
    expect(result.current.sessions[0]?.id).toBe('child-1')
  })

  it('continues refreshing the owning list while a loaded child is selected', async () => {
    listPiChildSessionsMock.mockResolvedValue([
      { id: 'child-1', cwd: 'C:/proj', name: 'scout', path: 'C:/proj/sessions/abc/scout.jsonl' },
    ])
    const lookup = new Map([['parent-1', makeParent()]])
    const { result, rerender } = renderHook(
      ({ selectedId }: { selectedId: string }) => useChildSessions(selectedId, lookup),
      { initialProps: { selectedId: 'parent-1' } },
    )
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    rerender({ selectedId: 'child-1' })
    listPiChildSessionsMock.mockResolvedValue([
      { id: 'child-1', cwd: 'C:/proj', name: 'updated title', path: 'C:/proj/sessions/abc/scout.jsonl' },
    ])
    window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
    await waitFor(() => expect(result.current.sessions[0]?.title).toBe('updated title'), { timeout: 1500 })
    expect(result.current.parentId).toBe('parent-1')
  })

  it('reloads the owning list after server reattachment while a child stays selected', async () => {
    const child = { id: 'child-1', cwd: 'C:/proj', name: 'old title', path: 'C:/proj/sessions/abc/scout.jsonl' }
    listPiChildSessionsMock.mockResolvedValueOnce([child])
    const lookup = new Map([['parent-1', makeParent()]])
    const { result, rerender } = renderHook(
      ({ selectedId }: { selectedId: string }) => useChildSessions(selectedId, lookup),
      { initialProps: { selectedId: 'parent-1' } },
    )
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    rerender({ selectedId: 'child-1' })
    let resolveReload!: (value: unknown) => void
    listPiChildSessionsMock.mockReturnValueOnce(new Promise(resolve => { resolveReload = resolve }))

    act(() => {
      serverGenerationMock.mockReturnValue(2)
      serverListeners.forEach(listener => listener())
    })
    expect(result.current.sessions).toEqual([])
    expect(listPiChildSessionsMock).toHaveBeenCalledTimes(2)
    expect(listPiChildSessionsMock).toHaveBeenLastCalledWith(PARENT_PATH, expect.any(AbortSignal))
    await act(async () => { resolveReload([{ ...child, name: 'new title' }]) })
    expect(result.current.parentId).toBe('parent-1')
    expect(result.current.sessions[0]?.title).toBe('new title')
  })

  it('discards an old server response after the new generation has loaded', async () => {
    let resolveOld!: (value: unknown) => void
    const child = { id: 'child-1', cwd: 'C:/proj', name: 'new title', path: 'C:/proj/sessions/abc/scout.jsonl' }
    listPiChildSessionsMock.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce([child])
    const lookup = new Map([['parent-1', makeParent()]])
    const { result } = renderHook(() => useChildSessions('parent-1', lookup))
    const oldSignal = listPiChildSessionsMock.mock.calls[0][1] as AbortSignal
    act(() => {
      serverGenerationMock.mockReturnValue(2)
      serverListeners.forEach(listener => listener())
    })
    await waitFor(() => expect(result.current.sessions[0]?.title).toBe('new title'))
    expect(oldSignal.aborted).toBe(true)
    await act(async () => { resolveOld([]) })
    expect(result.current.sessions[0]?.title).toBe('new title')
  })

  it('does not reuse a selected child owner from a different server', async () => {
    listPiChildSessionsMock.mockResolvedValue([
      { id: 'child-1', cwd: 'C:/proj', name: 'scout', path: 'C:/proj/sessions/abc/scout.jsonl' },
    ])
    const lookup = new Map([['parent-1', makeParent()]])
    const { result, rerender } = renderHook(
      ({ selectedId }: { selectedId: string }) => useChildSessions(selectedId, lookup),
      { initialProps: { selectedId: 'parent-1' } },
    )
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    rerender({ selectedId: 'child-1' })
    act(() => {
      serverIdMock.mockReturnValue('remote')
      serverGenerationMock.mockReturnValue(2)
      serverListeners.forEach(listener => listener())
    })
    expect(result.current.parentId).toBeNull()
    expect(result.current.sessions).toEqual([])
    expect(listPiChildSessionsMock).toHaveBeenCalledTimes(1)
  })

  it.each(['resolve', 'reject'] as const)('coalesces an in-flight refresh and preserves its dirty tail after %s', async outcome => {
    vi.useFakeTimers()
    let settle!: () => void
    listPiChildSessionsMock.mockReturnValueOnce(new Promise((resolve, reject) => {
      settle = () => outcome === 'resolve' ? resolve([]) : reject(new Error('temporary read failure'))
    })).mockResolvedValueOnce([
      { id: 'child-1', cwd: 'C:/proj', name: 'latest', path: 'C:/proj/sessions/abc/scout.jsonl' },
    ])
    const lookup = new Map([['parent-1', makeParent()]])
    const { result, unmount } = renderHook(() => useChildSessions('parent-1', lookup))
    try {
      act(() => {
        for (let index = 0; index < 3; index++) window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      expect(listPiChildSessionsMock).toHaveBeenCalledTimes(1)
      await act(async () => { settle() })
      expect(listPiChildSessionsMock).toHaveBeenCalledTimes(2)
      expect(result.current.sessions[0]?.title).toBe('latest')
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('uses an explicit name before the first user message', async () => {
    listPiChildSessionsMock.mockResolvedValue([
      {
        id: 'child-1',
        cwd: 'C:/proj',
        name: 'Read the catalog',
        firstMessage: 'Complete assignment thoroughly: # Target',
        path: 'C:/proj/sessions/abc/catalog.jsonl',
      },
    ])
    const lookup = new Map([['parent-1', makeParent()]])
    const { result } = renderHook(() => useChildSessions('parent-1', lookup))
    await waitFor(() => expect(result.current.sessions[0]?.title).toBe('Read the catalog'))
  })

  it('falls back to the child file stem instead of the wrapping assignment prompt', async () => {
    listPiChildSessionsMock.mockResolvedValue([
      {
        id: 'child-1',
        cwd: 'C:/proj',
        name: '',
        firstMessage: 'Complete assignment thoroughly: # Target',
        path: 'C:/proj/sessions/abc/ReadmeScout.jsonl',
      },
    ])
    const lookup = new Map([['parent-1', makeParent()]])
    const { result } = renderHook(() => useChildSessions('parent-1', lookup))
    await waitFor(() => expect(result.current.sessions[0]?.title).toBe('ReadmeScout'))
  })
})
