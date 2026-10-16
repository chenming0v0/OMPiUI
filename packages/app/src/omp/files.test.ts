import { beforeEach, expect, it, vi } from 'vitest'
import { getFileContent, saveFile } from './files'

const api = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), resolve: vi.fn() }))
vi.mock('./workspaces', () => ({ resolveWorkspacePath: api.resolve }))
vi.mock('./transport/index.js', () => ({
  readHostFile: api.read, writeHostFile: api.write,
  createHostFileEntry: vi.fn(), deleteHostFileEntry: vi.fn(), getHostGitStatus: vi.fn(),
  listHostFiles: vi.fn(), moveHostFileEntry: vi.fn(), searchHostFilesByName: vi.fn(), searchHostFilesText: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  api.resolve.mockResolvedValue('/repo')
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
