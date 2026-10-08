import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileReadResponse } from '@ompiui/protocol'
import { FileExplorer } from './FileExplorer'
import { FullscreenProvider } from '../contexts'
import { layoutStore, useLayoutStore } from '../store/layoutStore'
import { hasUnsavedFileChanges, setFileEditorDirty } from '../store/unsavedFileStore'

const { getFileContent, saveFile, searchFiles, searchText } = vi.hoisted(() => ({
  getFileContent: vi.fn(), saveFile: vi.fn(), searchFiles: vi.fn(), searchText: vi.fn(),
}))

// Keep the explorer hook, preview tabs, dirty registry and layout store real.
vi.mock('../hooks', async () => ({ useFileExplorer: (await import('../hooks/useFileExplorer')).useFileExplorer }))
vi.mock('../hooks/useAutoRefresh', () => ({ useAutoRefresh: vi.fn() }))
vi.mock('../hooks/useServerStore', () => ({ useServerStore: () => ({ activeServer: null }) }))
vi.mock('../omp/eventStream', () => ({ piEventStream: { connectWorkspace: vi.fn(), disconnectWorkspace: vi.fn() } }))
vi.mock('../omp/workspaces', () => ({ resolveWorkspacePath: async (directory: string) => directory }))
vi.mock('../omp/files', () => ({
  getFileContent, saveFile, searchFiles, searchText,
  listDirectory: async () => ['a.ts', 'b.ts'].map(name => ({ name, path: name, type: 'file', ignored: false })),
  getFileStatus: async () => [],
  simplifyGitStatus: (status: string) => status,
  toAbsoluteEntryPath: (directory: string, path: string) => `${directory}/${path}`,
  invalidateWorkspaceFileCaches: vi.fn(),
  createDirectory: vi.fn(), createFile: vi.fn(), deleteEntry: vi.fn(), moveEntry: vi.fn(),
}))
vi.mock('./CodePreview', () => ({
  CodePreview: ({ code, readOnly = true, onChange }: { code: string; readOnly?: boolean; onChange?: (value: string) => void }) =>
    <textarea aria-label="code editor" value={code} readOnly={readOnly} onChange={event => onChange?.(event.target.value)} />,
}))

function text(content: string, etag = content, path = 'a.ts'): FileReadResponse {
  return { path, type: 'text', content, encoding: 'utf-8', etag, mimeType: 'text/plain', size: content.length }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

let panelTabId: string
const activePath = () => layoutStore.getState().panelTabs.find(tab => tab.id === panelTabId)?.previewFile?.path
const editor = () => screen.getByRole('textbox', { name: 'code editor' })
const changeDraft = (value: string) => fireEvent.change(editor(), { target: { value } })

function Workspace() {
  const tab = useLayoutStore().panelTabs.find(tab => tab.id === panelTabId)!
  return <FullscreenProvider>
    <FileExplorer panelTabId={panelTabId} directory="/repo" previewFile={tab.previewFile ?? null} previewFiles={tab.previewFiles ?? []} />
  </FullscreenProvider>
}

async function editFile() {
  render(<Workspace />)
  await waitFor(() => expect(editor()).toHaveValue('base a.ts'))
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  changeDraft('unsaved a.ts')
  expect(hasUnsavedFileChanges()).toBe(true)
}

describe('FileExplorer workspace editing integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getFileContent.mockImplementation(async (path: string) => text(`base ${path}`, `etag ${path}`, path))
    saveFile.mockImplementation(async (path: string, content: FileReadResponse) => text(content.content, 'next-etag', path))
    searchFiles.mockResolvedValue(['b.ts'])
    searchText.mockResolvedValue([{
      path: { text: 'b.ts' }, lines: { text: 'matched text' }, line_number: 3, absolute_offset: 20,
      submatches: [{ start: 0, end: 7, match: { text: 'matched' } }],
    }])
    panelTabId = layoutStore.addFilesTab('right')
    layoutStore.openFilePreview({ path: 'b.ts', name: 'b.ts' }, 'right')
    layoutStore.openFilePreview({ path: 'a.ts', name: 'a.ts' }, 'right')
  })

  afterEach(() => {
    cleanup()
    layoutStore.removeTab(panelTabId)
    setFileEditorDirty('another-panel', false)
    vi.restoreAllMocks()
  })

  it.each(['tree', 'filename search', 'content search', 'preview tab', 'close tab', 'close all'])(
    'preserves the draft on cancel and navigates only after confirmation: %s', async source => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      await editFile()
      let target: HTMLElement
      if (source.endsWith('search')) {
        fireEvent.change(screen.getByRole('textbox', { name: 'Search files' }), { target: { value: 'match' } })
        await screen.findByText('matched text')
        target = source === 'content search'
          ? screen.getByRole('button', { name: /matched text/ })
          : screen.getByRole('button', { name: 'b.ts b.ts' })
      } else if (source === 'close tab') {
        target = screen.getByRole('button', { name: 'Close a.ts' })
      } else if (source === 'close all') {
        target = screen.getByRole('button', { name: 'Close all tabs' })
      } else {
        const buttons = screen.getAllByRole('button', { name: 'b.ts' })
        target = buttons[source === 'tree' ? 0 : 1]
      }

      fireEvent.click(target)
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(activePath()).toBe('a.ts')
      expect(editor()).toHaveValue('unsaved a.ts')
      expect(editor()).not.toHaveAttribute('readonly')
      expect(hasUnsavedFileChanges()).toBe(true)

      confirm.mockReturnValue(true)
      fireEvent.click(target)
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(activePath()).toBe(source === 'close all' ? undefined : 'b.ts')
      await waitFor(() => expect(hasUnsavedFileChanges()).toBe(false))
      if (source !== 'close all') await waitFor(() => expect(editor()).toHaveValue('base b.ts'))
    },
  )

  it('keeps a same-file selection and unrelated-panel dirty state out of the discard prompt', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await editFile()
    fireEvent.click(screen.getAllByRole('button', { name: 'a.ts' })[0])
    expect(confirm).not.toHaveBeenCalled()
    expect(editor()).toHaveValue('unsaved a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    setFileEditorDirty('another-panel', true)
    fireEvent.click(screen.getAllByRole('button', { name: 'b.ts' })[0])
    expect(confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(editor()).toHaveValue('base b.ts'))
  })

  it('retains typing during save, advances the text/ETag baseline and saves the newer draft next', async () => {
    const pending = deferred<FileReadResponse>()
    saveFile.mockReturnValueOnce(pending.promise)
    await editFile()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveFile).toHaveBeenCalledWith('a.ts', expect.objectContaining({ content: 'unsaved a.ts', etag: 'etag a.ts' }), '/repo')
    changeDraft('newer draft')
    await act(async () => pending.resolve(text('unsaved a.ts', 'saved-etag')))
    expect(editor()).toHaveValue('newer draft')
    expect(editor()).not.toHaveAttribute('readonly')
    expect(hasUnsavedFileChanges()).toBe(true)
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()

    changeDraft('unsaved a.ts')
    expect(hasUnsavedFileChanges()).toBe(false)
    changeDraft('newest draft')
    fireEvent.keyDown(window, { ctrlKey: true, key: 's' })
    await waitFor(() => expect(saveFile).toHaveBeenLastCalledWith('a.ts', expect.objectContaining({ content: 'newest draft', etag: 'saved-etag' }), '/repo'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument())
    expect(editor()).toHaveValue('newest draft')
    expect(hasUnsavedFileChanges()).toBe(false)
  })

  it.each(['resolve', 'reject'] as const)('ignores a switched-away editor save that later %ss', async outcome => {
    const pending = deferred<FileReadResponse>()
    saveFile.mockReturnValueOnce(pending.promise)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await editFile()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'b.ts' })[0])
    await waitFor(() => expect(editor()).toHaveValue('base b.ts'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    changeDraft('draft b.ts')
    await act(async () => {
      if (outcome === 'resolve') pending.resolve(text('unsaved a.ts', 'saved-etag'))
      else pending.reject(new Error('old save failed'))
    })
    expect(editor()).toHaveValue('draft b.ts')
    expect(editor()).not.toHaveAttribute('readonly')
    expect(screen.queryByText('old save failed')).not.toBeInTheDocument()
    expect(hasUnsavedFileChanges()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveFile).toHaveBeenLastCalledWith('b.ts', expect.objectContaining({ content: 'draft b.ts', etag: 'etag b.ts' }), '/repo'))
  })
})
