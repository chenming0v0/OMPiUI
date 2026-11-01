import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionChangesPanel } from './SessionChangesPanel'
import { changeScopeStore } from '../store/changeScopeStore'
import { layoutStore } from '../store/layoutStore'
import { FullscreenProvider } from '../contexts'
import { serverStore } from '../store/serverStore'

const { getHostGitInfo, getHostGitDiff, getHostGitFileDiff } = vi.hoisted(() => ({
  getHostGitInfo: vi.fn(),
  getHostGitDiff: vi.fn(),
  getHostGitFileDiff: vi.fn(),
}))

vi.mock('../omp/transport/index.js', () => ({
  getHostGitInfo,
  getHostGitDiff,
  getHostGitFileDiff,
}))

vi.mock('../omp/workspaces', () => ({ resolveWorkspacePath: async (directory?: string) => directory ?? null }))

vi.mock('./DiffViewer', () => ({
  DiffViewer: ({ before, after }: { before: string; after: string }) => <div data-testid="diff-viewer">{before}|{after}</div>,
  useDiffViewerData: () => ({
    beforeTokens: null,
    afterTokens: null,
    pairedLines: [],
    unifiedLines: [],
    lineNumberWidth: 1,
  }),
}))

function renderSessionChangesPanel() {
  return render(
    <FullscreenProvider>
      <SessionChangesPanel sessionId="session-1" directory="/repo" />
    </FullscreenProvider>,
  )
}

describe('SessionChangesPanel', () => {
  let originalServerUrl: string
  beforeEach(() => {
    vi.clearAllMocks()
    originalServerUrl = serverStore.getActiveServer()!.url
    changeScopeStore.clearAll()
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb =>
      window.setTimeout(() => cb(performance.now()), 16),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
    getHostGitInfo.mockResolvedValue({
      branch: 'feature/test',
      defaultBranch: 'main',
      root: true,
      detached: false,
      unborn: false,
      ahead: 0,
      behind: 0,
    })
    getHostGitFileDiff.mockImplementation(async (_workspace, file) => ({
      file,
      status: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
      patch: `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1 +1 @@
-old
+new
`,
    }))
    getHostGitDiff.mockImplementation(async (_workspace, mode) => ({
      mode,
      files: mode === 'branch'
        ? [{ file: 'src/branch.ts', status: 'modified', additions: 1, deletions: 1, binary: false }]
        : [{ file: 'src/git.ts', status: 'modified', additions: 1, deletions: 1, binary: false }],
    }))
  })

  afterEach(() => {
    cleanup()
    serverStore.updateServer(serverStore.getActiveServerId(), { url: originalServerUrl })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('loads Git diffs and shows the first file preview by default', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getHostGitDiff).toHaveBeenCalledWith('/repo', 'git', expect.any(AbortSignal))
    expect(screen.getByText('1f')).toBeInTheDocument()
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('-1').length).toBeGreaterThan(0)
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Change mode: Git changes/ })).toBeInTheDocument()
    expect(screen.getAllByText('git.ts').length).toBeGreaterThan(0)
  })

  it('keeps change viewing controls without staging or commit management', async () => {
    renderSessionChangesPanel()
    await act(async () => { await vi.runAllTimersAsync() })

    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()
    for (const name of ['List', 'Tree', 'Unified', 'Split', 'Refresh']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: /commit|stage selected|unstage selected/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Manage Git staging and commit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Commit message' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))
    await act(async () => { await vi.runAllTimersAsync() })
    expect(screen.getByRole('menuitemradio', { name: 'Staged' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: 'Unstaged' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Staged' }))
    await act(async () => { await vi.runAllTimersAsync() })
    expect(getHostGitDiff).toHaveBeenCalledWith('/repo', 'staged', expect.any(AbortSignal))
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()
  })

  it('does not offer unsupported session or turn scopes', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.advanceTimersByTime(48)
      await Promise.resolve()
    })

    expect(screen.queryByText('Session changes')).not.toBeInTheDocument()
    expect(screen.queryByText('Last turn changes')).not.toBeInTheDocument()
  })

  it('switches to branch changes when available', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.advanceTimersByTime(48)
      await Promise.resolve()
    })

    fireEvent.click(screen.getByText('Branch changes'))

    await act(async () => {
      vi.advanceTimersByTime(240)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getHostGitDiff).toHaveBeenCalledWith('/repo', 'branch', expect.any(AbortSignal))
    expect(changeScopeStore.getMode('session-1')).toBe('branch')
    expect(screen.getAllByText('branch.ts').length).toBeGreaterThan(0)
  })

  it('hides the branch scope for unborn repositories', async () => {
    getHostGitInfo.mockResolvedValue({
      branch: 'master',
      unborn: true,
      root: true,
      detached: false,
      ahead: 0,
      behind: 0,
    })
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.advanceTimersByTime(48)
      await Promise.resolve()
    })

    expect(screen.queryByText('Branch changes')).not.toBeInTheDocument()
  })

  it('supports keyboard navigation in the change mode menu and exposes toggle state', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: /Change mode:/ }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    const menu = screen.getByRole('menu', { name: 'Change mode' })
    const gitChangesOption = screen.getByRole('menuitemradio', { name: 'Git changes' })
    const branchChangesOption = screen.getByRole('menuitemradio', { name: 'Branch changes' })

    expect(gitChangesOption).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(branchChangesOption).toHaveFocus()

    const treeButton = screen.getByRole('button', { name: 'Tree' })
    const listButton = screen.getByRole('button', { name: 'List' })
    const unifiedButton = screen.getByRole('button', { name: 'Unified' })
    const splitButton = screen.getByRole('button', { name: 'Split' })

    expect(treeButton).toHaveAttribute('aria-pressed', 'true')
    expect(unifiedButton).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(listButton)
    fireEvent.click(splitButton)

    expect(listButton).toHaveAttribute('aria-pressed', 'true')
    expect(treeButton).toHaveAttribute('aria-pressed', 'false')
    expect(splitButton).toHaveAttribute('aria-pressed', 'true')
    expect(unifiedButton).toHaveAttribute('aria-pressed', 'false')
  })

  it('opens the change mode menu from ArrowUp with focus on the last option', async () => {
    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.keyDown(screen.getByRole('button', { name: /Change mode:/ }), { key: 'ArrowUp' })

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('menuitemradio', { name: 'Unstaged' })).toHaveFocus()
  })

  it('does not offer unsupported Git initialization', async () => {
    getHostGitInfo.mockRejectedValueOnce(new Error('not a git repository'))

    renderSessionChangesPanel()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(screen.getByText('No Git repository detected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Initialize Git repository' })).not.toBeInTheDocument()
  })

  it('opens the selected change file in the files panel from the context menu', async () => {
    const openFilePreview = vi.spyOn(layoutStore, 'openFilePreview')

    render(
      <FullscreenProvider>
        <SessionChangesPanel sessionId="session-1" directory="/repo" position="bottom" />
      </FullscreenProvider>,
    )

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    const fileButtons = screen.getAllByRole('button', { name: /git\.ts/ })
    fireEvent.contextMenu(fileButtons[0])
    fireEvent.click(screen.getByRole('button', { name: 'Open in Files' }))

    expect(openFilePreview).toHaveBeenCalledWith({ path: 'src/git.ts', name: 'git.ts' }, 'bottom')
  })

  it.each(['before', 'after'] as const)('refetches an unchanged selected file when its invalidated patch resolves %s refresh', async timing => {
    let resolveOldPatch!: (value: unknown) => void
    let resolveNewPatch!: (value: unknown) => void
    let resolveList!: (value: unknown) => void
    getHostGitFileDiff.mockReturnValueOnce(new Promise(resolve => { resolveOldPatch = resolve }))
      .mockReturnValueOnce(new Promise(resolve => { resolveNewPatch = resolve }))
    renderSessionChangesPanel()
    await act(async () => { await Promise.resolve() })
    expect(getHostGitFileDiff).toHaveBeenCalledTimes(1)
    const oldSignal = getHostGitFileDiff.mock.calls[0][3] as AbortSignal
    getHostGitDiff.mockReturnValueOnce(new Promise(resolve => { resolveList = resolve }))

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await act(async () => { await Promise.resolve() })
    expect(getHostGitDiff).toHaveBeenCalledTimes(2)
    expect(oldSignal.aborted).toBe(true)
    expect(getHostGitFileDiff).toHaveBeenCalledTimes(1)
    const patch = (value: string) => ({
      file: 'src/git.ts', status: 'modified', additions: 1, deletions: 1, binary: false,
      patch: `--- a/src/git.ts\n+++ b/src/git.ts\n@@ -1 +1 @@\n-old\n+${value}\n`,
    })
    if (timing === 'before') await act(async () => resolveOldPatch(patch('stale')))

    await act(async () => resolveList({
      mode: 'git', files: [{ file: 'src/git.ts', status: 'modified', additions: 1, deletions: 1, binary: false }],
    }))
    expect(getHostGitFileDiff).toHaveBeenCalledTimes(2)
    expect(getHostGitFileDiff).toHaveBeenLastCalledWith('/repo', 'src/git.ts', 'git', expect.any(AbortSignal))
    await act(async () => resolveNewPatch(patch('fresh')))
    expect(screen.getByTestId('diff-viewer')).toHaveTextContent('fresh')
    if (timing === 'after') await act(async () => resolveOldPatch(patch('stale')))
    expect(screen.getByTestId('diff-viewer')).toHaveTextContent('fresh')
    expect(screen.getByTestId('diff-viewer')).not.toHaveTextContent('stale')
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    expect(getHostGitFileDiff).toHaveBeenCalledTimes(2)
  })

  it('retries an invalidated pending patch even when refreshing its list fails', async () => {
    getHostGitFileDiff.mockReturnValueOnce(new Promise(() => {}))
    renderSessionChangesPanel()
    await act(async () => { await Promise.resolve() })
    expect(getHostGitFileDiff).toHaveBeenCalledTimes(1)
    getHostGitDiff.mockRejectedValueOnce(new Error('list refresh failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await act(async () => { await Promise.resolve() })
    expect(getHostGitFileDiff).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('diff-viewer')).toHaveTextContent('new')
  })
  it('does not restore old viewer metadata after the active endpoint changes', async () => {
    const oldList = Promise.withResolvers<unknown>()
    getHostGitDiff.mockReturnValueOnce(oldList.promise)
    renderSessionChangesPanel()
    await act(async () => { await Promise.resolve() })
    getHostGitDiff.mockResolvedValue({ mode: 'git', files: [{ file: 'src/replacement.ts', status: 'modified', additions: 1, deletions: 1, binary: false }] })
    act(() => serverStore.updateServer(serverStore.getActiveServerId(), { url: 'http://127.0.0.1:19993' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getAllByText('replacement.ts').length).toBeGreaterThan(0)
    await act(async () => oldList.resolve({ mode: 'git', files: [{ file: 'src/obsolete.ts', status: 'modified', additions: 1, deletions: 1, binary: false }] }))
    expect(screen.queryByText('obsolete.ts')).not.toBeInTheDocument()
    expect(screen.getByTestId('diff-viewer')).toBeInTheDocument()
    expect(screen.getAllByText('replacement.ts').length).toBeGreaterThan(0)
  })
})
