import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serverStore } from '../store/serverStore'
import { serverStorage } from '../utils/perServerStorage'
import { resetWorkspaceResolutionCache, resolveWorkspacePath } from './workspaces'

const host = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('./transport/index.js', () => ({ postHostCommand: host.execute }))

describe('default project selection', () => {
  beforeEach(() => {
    localStorage.clear()
    serverStore.setActiveServer('local')
    resetWorkspaceResolutionCache()
    host.execute.mockReset()
    host.execute.mockImplementation(async (name: string, params?: { rootPath?: string }) => {
      if (name === 'workspaces.list') return { workspaces: [{ path: '/known-project' }] }
      if (name === 'workspaces.open') return { workspace: { path: params?.rootPath ?? '/home/user' } }
      return { ok: true }
    })
  })

  it('prefers the saved project over already known workspaces', async () => {
    serverStorage.set('ompiui-last-directory', '/saved-project')
    expect(await resolveWorkspacePath()).toBe('/saved-project')
  })

  it('uses an already opened project when there is no saved project', async () => {
    expect(await resolveWorkspacePath()).toBe('/known-project')
  })

  it('uses the server home directory when no project is known', async () => {
    host.execute.mockImplementation(async (name: string) => name === 'workspaces.list'
      ? { workspaces: [] }
      : name === 'workspaces.open' ? { workspace: { path: '/home/user' } } : { ok: true })
    expect(await resolveWorkspacePath()).toBe('/home/user')
  })

  it('does not silently choose another project when the saved directory is missing', async () => {
    serverStorage.set('ompiui-last-directory', '/missing')
    host.execute.mockRejectedValue(Object.assign(new Error('missing'), { code: 'WORKSPACE_NOT_FOUND' }))
    expect(await resolveWorkspacePath()).toBeNull()
  })

  it('discards an old server result before watching or using its directory', async () => {
    const { promise, resolve: release } = Promise.withResolvers<{ workspace: { path: string } }>()
    host.execute.mockImplementation(() => promise)
    const pending = resolveWorkspacePath('/old-project')
    const next = serverStore.addServer({ name: 'Next', url: 'http://next.test' })
    try {
      serverStore.setActiveServer(next.id)
      release({ workspace: { path: '/old-project' } })
      expect(await pending).toBeNull()
    } finally {
      serverStore.setActiveServer('local')
      serverStore.removeServer(next.id)
    }
  })
})
