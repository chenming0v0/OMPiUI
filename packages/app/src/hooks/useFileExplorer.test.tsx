import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorer } from './useFileExplorer'
import { changeScopeStore } from '../store/changeScopeStore'

const { listDirectory, getFileContent, getFileStatus, getHostGitDiff, invalidateWorkspaceFileCaches, saveFile, resolveWorkspacePath } = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  getFileContent: vi.fn(),
  getFileStatus: vi.fn(),
  getHostGitDiff: vi.fn(),
  invalidateWorkspaceFileCaches: vi.fn(),
  saveFile: vi.fn(),
  resolveWorkspacePath: vi.fn(async (directory?: string) => directory ?? null),
}))

vi.mock('../omp/workspaces', () => ({ resolveWorkspacePath }))
vi.mock('../omp/transport/index.js', () => ({ getHostGitDiff }))

vi.mock('../omp/files', () => ({
  listDirectory,
  getFileContent,
  getFileStatus,
  invalidateWorkspaceFileCaches,
  saveFile,
  simplifyGitStatus: (status: string) =>
    status === 'added' || status === 'untracked' || status === 'copied' ? 'added' : status === 'deleted' ? 'deleted' : 'modified',
  toAbsoluteEntryPath: (root: string | undefined, p: string) => (root ? `${root}/${p}` : p),
}))

describe('useFileExplorer change scope', () => {
  beforeEach(() => {
    changeScopeStore.clearAll()
    vi.clearAllMocks()

    listDirectory.mockResolvedValue([
      { name: 'src', path: 'src', type: 'directory' },
      { name: 'session.ts', path: 'src/session.ts', type: 'file' },
      { name: 'turn.ts', path: 'src/turn.ts', type: 'file' },
    ])
    getFileContent.mockResolvedValue({ type: 'text', content: 'test' })
    getFileStatus.mockResolvedValue([])
    getHostGitDiff.mockImplementation(async (_workspace, mode) => ({
      mode,
      files: [{ file: mode === 'branch' ? 'src/branch.ts' : 'src/git.ts', status: 'added', additions: 1, deletions: 0, binary: false }],
    }))
  })

  it('updates file statuses when the shared change mode changes', async () => {
    const { result } = renderHook(() => useFileExplorer({ directory: '/repo', autoLoad: true, sessionId: 'session-1' }))

    await waitFor(() => {
      expect(result.current.fileStatus.get('src/git.ts')?.status).toBe('added')
    })

    expect(getHostGitDiff).toHaveBeenCalledWith('/repo', 'git')

    act(() => {
      changeScopeStore.setMode('session-1', 'branch')
    })

    await waitFor(() => {
      expect(result.current.fileStatus.get('src/branch.ts')?.status).toBe('added')
    })

    expect(result.current.fileStatus.get('src/git.ts')).toBeUndefined()
    expect(getHostGitDiff).toHaveBeenCalledWith('/repo', 'branch')
  })

  it('restores expanded folders per directory when switching projects', async () => {
    listDirectory.mockImplementation(async (parentPath: string, directory: string) => {
      if (parentPath === '') {
        return [{ name: 'src', path: 'src', type: 'directory' }]
      }

      if (parentPath === 'src') {
        return [
          {
            name: directory === '/repo-a' ? 'a.ts' : 'b.ts',
            path: `src/${directory === '/repo-a' ? 'a.ts' : 'b.ts'}`,
            type: 'file',
          },
        ]
      }

      return []
    })

    const { result, rerender } = renderHook(
      ({ directory }) => useFileExplorer({ directory, autoLoad: true }),
      { initialProps: { directory: '/repo-a' } },
    )

    await waitFor(() => {
      expect(result.current.tree).toHaveLength(1)
    })

    act(() => {
      result.current.toggleExpand('src')
    })

    await waitFor(() => {
      expect(result.current.expandedPaths.has('src')).toBe(true)
      expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/a.ts')
    })

    rerender({ directory: '/repo-b' })

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-b/src')
      expect(result.current.tree[0]?.children?.[0]?.path).toBeUndefined()
      expect(result.current.expandedPaths.has('src')).toBe(false)
    })

    rerender({ directory: '/repo-a' })

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-a/src')
      expect(result.current.expandedPaths.has('src')).toBe(true)
      expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/a.ts')
    })
  })

  it('ignores stale child loads after switching directories', async () => {
    let resolveRepoAChildren: (nodes: Array<{ name: string; path: string; type: 'file' }>) => void

    listDirectory.mockImplementation((parentPath: string, directory: string) => {
      if (parentPath === '') {
        return Promise.resolve([{ name: 'src', path: 'src', absolute: `${directory}/src`, type: 'directory', ignored: false }])
      }

      if (parentPath === 'src' && directory === '/repo-a') {
        return new Promise(resolve => {
          resolveRepoAChildren = resolve
        })
      }

      if (parentPath === 'src' && directory === '/repo-b') {
        return Promise.resolve([
          { name: 'b.ts', path: 'src/b.ts', type: 'file' },
        ])
      }

      return Promise.resolve([])
    })

    const { result, rerender } = renderHook(
      ({ directory }) => useFileExplorer({ directory, autoLoad: true }),
      { initialProps: { directory: '/repo-a' } },
    )

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-a/src')
    })

    act(() => {
      result.current.toggleExpand('src')
    })

    rerender({ directory: '/repo-b' })

    await waitFor(() => {
      expect(result.current.tree[0]?.absolute).toBe('/repo-b/src')
    })

    act(() => {
      result.current.toggleExpand('src')
    })

    await waitFor(() => {
      expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/b.ts')
    })

    await act(async () => {
      resolveRepoAChildren!([
        { name: 'a.ts', path: 'src/a.ts', type: 'file' },
      ])
    })

    expect(result.current.tree[0]?.absolute).toBe('/repo-b/src')
    expect(result.current.tree[0]?.children?.map(child => child.path)).toEqual(['src/b.ts'])
  })

  it('refreshes an expanded parent and open preview after a workspace event', async () => {
    listDirectory.mockImplementation(async (parentPath: string) => parentPath === ''
      ? [{ name: 'src', path: 'src', absolute: '/repo/src', type: 'directory', ignored: false }]
      : [{ name: 'a.ts', path: 'src/a.ts', absolute: '/repo/src/a.ts', type: 'file', ignored: false }])
    getFileContent.mockResolvedValueOnce({ type: 'text', content: 'before' })
      .mockResolvedValueOnce({ type: 'text', content: 'after' })
    const { result } = renderHook(() => useFileExplorer({ directory: '/repo', autoLoad: true }))
    await waitFor(() => expect(result.current.tree[0]?.path).toBe('src'))
    act(() => result.current.toggleExpand('src'))
    await waitFor(() => expect(result.current.tree[0]?.children?.[0]?.path).toBe('src/a.ts'))
    await act(() => result.current.loadPreview('src/a.ts'))
    expect(result.current.previewContent?.content).toBe('before')

    act(() => window.dispatchEvent(new CustomEvent('ompiui:workspace-files-changed', {
      detail: {
        workspacePath: '/repo', revision: 1,
        changes: [{ path: 'src/a.ts', kind: 'changed', type: 'file' }], rescan: false,
      },
    })))
    await waitFor(() => expect(result.current.previewContent?.content).toBe('after'))
    expect(invalidateWorkspaceFileCaches).toHaveBeenCalledWith('/repo')
    expect(listDirectory.mock.calls.filter(call => call[0] === 'src').length).toBeGreaterThanOrEqual(2)
  })

  it.each(['directory', 'session'] as const)('does not publish a save into a new %s with the same file path', async scope => {
    let resolveSave!: (value: unknown) => void
    saveFile.mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve }))
    const { result, rerender } = renderHook(
      props => useFileExplorer({ ...props, autoLoad: false }),
      { initialProps: { directory: '/repo-a', sessionId: 'session-a' } },
    )
    await act(() => result.current.loadPreview('a.ts'))
    let save!: ReturnType<typeof result.current.savePreview>
    act(() => { save = result.current.savePreview('a.ts', 'old workspace save') })
    rerender(scope === 'directory'
      ? { directory: '/repo-b', sessionId: 'session-a' }
      : { directory: '/repo-a', sessionId: 'session-b' })
    getFileContent.mockResolvedValueOnce({ type: 'text', content: 'new scope', etag: 'new-scope-etag' })
    await act(() => result.current.loadPreview('a.ts'))
    await act(async () => {
      resolveSave({ type: 'text', content: 'old workspace save', etag: 'old-save-etag' })
      await save
    })
    expect(result.current.previewContent?.content).toBe('new scope')
    await act(() => result.current.loadPreview('a.ts'))
    expect(result.current.previewContent?.etag).toBe('new-scope-etag')
  })

  it('rejects an older save response after another request saved the same file', async () => {
    let resolveOldSave!: (value: unknown) => void
    saveFile.mockReturnValueOnce(new Promise(resolve => { resolveOldSave = resolve }))
      .mockResolvedValueOnce({ type: 'text', content: 'newest', etag: 'newest-etag' })
    const { result } = renderHook(() => useFileExplorer({ directory: '/repo', autoLoad: false }))
    await act(() => result.current.loadPreview('a.ts'))
    let oldSave!: ReturnType<typeof result.current.savePreview>
    act(() => { oldSave = result.current.savePreview('a.ts', 'old') })
    await act(() => result.current.savePreview('a.ts', 'newest'))
    await act(async () => {
      resolveOldSave({ type: 'text', content: 'old', etag: 'old-etag' })
      await oldSave
    })
    expect(result.current.previewContent?.content).toBe('newest')
    await act(() => result.current.loadPreview('a.ts'))
    expect(result.current.previewContent?.etag).toBe('newest-etag')
  })

  it('does not replace the content or cache of a reopened file with an old editor save', async () => {
    let resolveSave!: (value: unknown) => void
    saveFile.mockReturnValueOnce(new Promise(resolve => { resolveSave = resolve }))
    const { result } = renderHook(() => useFileExplorer({ directory: '/repo', autoLoad: false }))
    await act(() => result.current.loadPreview('a.ts'))
    let save!: ReturnType<typeof result.current.savePreview>
    act(() => { save = result.current.savePreview('a.ts', 'old draft') })
    await act(() => result.current.loadPreview('b.ts'))
    await act(() => result.current.loadPreview('a.ts'))
    await act(async () => {
      resolveSave({ type: 'text', content: 'old draft', etag: 'old-etag' })
      await save
    })
    expect(result.current.previewContent?.content).toBe('test')
    await act(() => result.current.loadPreview('a.ts'))
    expect(result.current.previewContent?.content).toBe('test')
  })
})
