import { beforeEach, expect, it, vi } from 'vitest'
import { clearAllWorkspaceFileCaches, getFileContent, invalidateWorkspaceFileCaches, listDirectory, saveFile } from './files'
import { serverStore } from '../store/serverStore'

const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), resolve: vi.fn(), list: vi.fn() }))
vi.mock('./workspaces', () => ({ resolveWorkspacePath: api.resolve }))
vi.mock('./transport/index.js', () => ({
  readHostFile: api.read, writeHostFile: api.write,
  createHostFileEntry: vi.fn(), deleteHostFileEntry: vi.fn(), getHostGitStatus: vi.fn(),
  listHostFiles: api.list, moveHostFileEntry: vi.fn(), searchHostFilesByName: vi.fn(), searchHostFilesText: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  clearAllWorkspaceFileCaches()
  api.resolve.mockResolvedValue('/repo')
})

it.each(['', 'src'])('shares cancellable directory reads and caches the result for %s', async path => {
  const pending = Promise.withResolvers<{ entries: [] }>()
  api.list.mockReturnValueOnce(pending.promise)
  const first = new AbortController()
  const second = new AbortController()
  const cancelled = listDirectory(path, '/repo', first.signal)
  const kept = listDirectory(path, '/repo', second.signal)
  expect(api.list).toHaveBeenCalledTimes(1)
  first.abort()
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  expect(api.list.mock.calls[0]?.[2]?.aborted).toBe(false)
  pending.resolve({ entries: [] })
  await expect(kept).resolves.toEqual([])
  await listDirectory(path, '/repo', new AbortController().signal)
  expect(api.list).toHaveBeenCalledTimes(1)
  invalidateWorkspaceFileCaches('/repo')
  api.list.mockResolvedValueOnce({ entries: [] })
  await listDirectory(path, '/repo', new AbortController().signal)
  expect(api.list).toHaveBeenCalledTimes(2)
})

it('aborts the shared directory request when its last reader leaves', async () => {
  const pending = Promise.withResolvers<{ entries: [] }>()
  api.list.mockReturnValueOnce(pending.promise)
  const controller = new AbortController()
  const waiting = listDirectory('', '/repo', controller.signal)
  controller.abort()
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  expect(api.list.mock.calls[0]?.[2]?.aborted).toBe(true)
  pending.resolve({ entries: [] })
  await Promise.resolve()
  api.list.mockResolvedValueOnce({ entries: [] })
  await listDirectory('', '/repo')
  expect(api.list).toHaveBeenCalledTimes(2)
})

it('keeps absolute directory browsing caches separate without an explicit workspace', async () => {
  api.list.mockResolvedValue({ entries: [] })
  await listDirectory('/first')
  await listDirectory('/second')
  await listDirectory('/first')
  expect(api.list).toHaveBeenCalledTimes(2)
  expect(api.list.mock.calls.map(call => call[0])).toEqual(['/first', '/second'])
})

it('does not reuse cached directories after the active server generation changes', async () => {
  let generation = 1
  const activeGeneration = vi.spyOn(serverStore, 'getActiveServerGeneration').mockImplementation(() => generation)
  api.list.mockResolvedValue({ entries: [] })
  try {
    await listDirectory('', '/repo')
    generation++
    await listDirectory('', '/repo')
    expect(api.list).toHaveBeenCalledTimes(2)
  } finally {
    activeGeneration.mockRestore()
  }
})

it('restores exactly the submitted body alongside the no-content save receipt', async () => {
  api.write.mockResolvedValue({ type: 'text', content: '', etag: 'new', size: 6, encoding: 'utf-8' })
  const saved = await saveFile('a.txt', { content: 'after\n', etag: 'old' }, '/repo')
  expect(saved).toMatchObject({ content: 'after\n', etag: 'new' })
  expect(api.write).toHaveBeenCalledWith('/repo', 'a.txt', 'after\n', {
    ifMatch: 'old', encoding: 'utf-8', returnContent: false,
  })
  expect(api.read).not.toHaveBeenCalled()
})

it('propagates preview cancellation and never starts a read cancelled during workspace lookup', async () => {
  const controller = new AbortController()
  api.read.mockResolvedValue({ content: 'body' })
  await getFileContent('a.txt', '/repo', 'etag', controller.signal)
  expect(api.read).toHaveBeenCalledWith('/repo', 'a.txt', controller.signal, 'etag', undefined)
  api.read.mockClear()
  let resolve!: (path: string) => void
  api.resolve.mockReturnValueOnce(new Promise<string>(done => { resolve = done }))
  const waiting = getFileContent('b.txt', '/repo', undefined, controller.signal)
  controller.abort()
  resolve('/repo')
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  expect(api.read).not.toHaveBeenCalled()
})
