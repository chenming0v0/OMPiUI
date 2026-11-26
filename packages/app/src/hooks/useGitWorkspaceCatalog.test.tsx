import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitWorkspaceCatalog } from './useGitWorkspaceCatalog'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const getCurrentProjectMock = vi.fn()
const listWorktreesMock = vi.fn()
const subscribeToConnectionStateMock = vi.fn()
const onServerChangeMock = vi.fn()
const { connectWorkspace, disconnectWorkspace } = vi.hoisted(() => ({ connectWorkspace: vi.fn(), disconnectWorkspace: vi.fn() }))
vi.mock('./useServerStore', () => ({ useServerStore: () => ({ activeServerGeneration: 0 }) }))
vi.mock('./useGlobalEvents', () => ({ registerSessionConsumer: () => () => undefined }))
vi.mock('../omp/eventStream.js', () => ({ piEventStream: { connectWorkspace, disconnectWorkspace } }))
vi.mock('../omp/workspaces', () => ({ resolveWorkspacePath: async (root: string) => root }))
let latestServerChange: (() => void) | undefined

vi.mock('../api', () => ({
  getCurrentProject: (...args: unknown[]) => getCurrentProjectMock(...args),
}))

vi.mock('../omp/transport', () => ({
  getHostGitWorktrees: (...args: unknown[]) => listWorktreesMock(...args),
}))

vi.mock('../api/events', () => ({
  subscribeToConnectionState: (...args: unknown[]) => subscribeToConnectionStateMock(...args),
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    onServerChange: (...args: unknown[]) => onServerChangeMock(...args),
  },
}))

describe('useGitWorkspaceCatalog', () => {
  beforeEach(() => {
    getCurrentProjectMock.mockReset()
    listWorktreesMock.mockReset()
    subscribeToConnectionStateMock.mockReset()
    onServerChangeMock.mockReset()
    latestServerChange = undefined

    subscribeToConnectionStateMock.mockReturnValue(vi.fn())
    onServerChangeMock.mockImplementation(listener => {
      latestServerChange = listener as () => void
      return vi.fn()
    })
    listWorktreesMock.mockResolvedValue({ primaryRoot: 'C:/repo', worktrees: ['C:/repo', 'C:/repo-worktree'].map(path => ({
      path, head: 'abc123', branch: 'refs/heads/main', detached: false, bare: false, locked: false, lockReason: null, prunable: false,
    })) })
  })

  it('refetches workspace metadata on server endpoint changes while stale requests are in flight', async () => {
    const staleRequest = createDeferred<{ gitRoot: string; path: string }>()
    const freshRequest = createDeferred<{ gitRoot: string; path: string }>()

    getCurrentProjectMock.mockImplementationOnce(() => staleRequest.promise).mockImplementationOnce(() => freshRequest.promise)

    const directories = ['C:\\repo']
    const { result } = renderHook(() => useGitWorkspaceCatalog(directories))

    await waitFor(() => expect(getCurrentProjectMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      latestServerChange?.()
      await Promise.resolve()
    })

    expect(getCurrentProjectMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      freshRequest.resolve({ gitRoot: 'C:/repo', path: 'C:/repo' })
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.catalog.get('C:/repo')?.workspaces).toEqual(['C:/repo', 'C:/repo-worktree'])
    })

    await act(async () => {
      staleRequest.resolve({ gitRoot: 'C:/stale', path: 'C:/stale' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.catalog.get('C:/repo')?.rootDirectory).toBe('C:/repo')
    expect(result.current.catalog.get('C:/repo')?.workspaces).toEqual(['C:/repo', 'C:/repo-worktree'])
  })

  it('refreshes the sidebar from the primary checkout while a linked checkout is selected', async () => {
    connectWorkspace.mockClear()
    const linked = 'C:/repo-worktree'
    const directories = [linked]
    getCurrentProjectMock.mockResolvedValue({ gitRoot: linked, path: linked })
    const { result } = renderHook(() => useGitWorkspaceCatalog(directories))
    await waitFor(() => expect(connectWorkspace).toHaveBeenCalledWith('C:/repo'))
    const updated = ['C:/repo', linked, 'C:/new-worktree']
    listWorktreesMock.mockResolvedValue({ primaryRoot: 'C:/repo', worktrees: updated.map(path => ({
      path, head: 'abc123', branch: `refs/heads/${path === linked ? 'linked-next' : 'main'}`,
      detached: false, bare: false, locked: false, lockReason: null, prunable: false,
    })) })
    act(() => window.dispatchEvent(new CustomEvent('ompiui:workspace-git-updated', {
      detail: { workspacePath: 'c:\\repo', catalogChanged: true },
    })))
    await waitFor(() => expect(result.current.catalog.get(linked)?.workspaces).toEqual(updated))
    expect(result.current.catalog.get(linked)?.workspaceBranches.get(linked)).toBe('linked-next')
  })
})
