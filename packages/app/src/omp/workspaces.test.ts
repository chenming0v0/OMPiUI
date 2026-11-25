import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serverStore } from '../store/serverStore'
import { serverStorage } from '../utils/perServerStorage'
import { ensureHostWorkspaceWatch, resetWorkspaceResolutionCache, resetWorkspaceWatchRegistrations, resolveWorkspacePath } from './workspaces'

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

  it('keeps path resolution single-flight while re-confirming watches after reconnect', async () => {
    expect(await Promise.all([resolveWorkspacePath('/repo'), resolveWorkspacePath('/repo')])).toEqual(['/repo', '/repo'])
    expect(host.execute.mock.calls.filter(([name]) => name === 'workspaces.open')).toHaveLength(1)
    expect(host.execute.mock.calls.filter(([name]) => name === 'workspaces.watch')).toHaveLength(1)

    const generation = serverStore.getActiveServerGeneration()
    resetWorkspaceWatchRegistrations()
    expect(await Promise.all([resolveWorkspacePath('/repo'), resolveWorkspacePath('/repo')])).toEqual(['/repo', '/repo'])
    expect(serverStore.getActiveServerGeneration()).toBe(generation)
    expect(host.execute.mock.calls.filter(([name]) => name === 'workspaces.open')).toHaveLength(1)
    expect(host.execute.mock.calls.filter(([name]) => name === 'workspaces.watch')).toHaveLength(2)
  })

  it('retries a failed registration without repeating read-only path resolution', async () => {
    const original = host.execute.getMockImplementation()!
    host.execute.mockImplementation((name: string, params?: { rootPath?: string }) => name === 'workspaces.watch'
      ? Promise.reject(new Error('disconnected')) : original(name, params))
    await expect(resolveWorkspacePath('/repo')).rejects.toThrow('disconnected')
    host.execute.mockImplementation(original)
    expect(await resolveWorkspacePath('/repo')).toBe('/repo')
    expect(host.execute.mock.calls.filter(([name]) => name === 'workspaces.open')).toHaveLength(1)
    expect(host.execute.mock.calls.filter(([name]) => name === 'workspaces.watch')).toHaveLength(2)
  })

  it('does not let a pre-reconnect rejection remove the new registration flight', async () => {
    const old = Promise.withResolvers<{ ok: boolean }>()
    const current = Promise.withResolvers<{ ok: boolean }>()
    host.execute.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise)
    const beforeReconnect = ensureHostWorkspaceWatch('/repo')
    resetWorkspaceWatchRegistrations()
    const afterReconnect = ensureHostWorkspaceWatch('/repo')
    old.reject(new Error('old connection closed'))
    await Promise.resolve()
    await Promise.resolve()
    const concurrent = ensureHostWorkspaceWatch('/repo')
    expect(host.execute).toHaveBeenCalledTimes(2)
    current.resolve({ ok: true })
    await Promise.all([beforeReconnect, afterReconnect, concurrent])
    expect(host.execute).toHaveBeenCalledTimes(2)
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
      expect(host.execute).toHaveBeenCalledTimes(1)
      expect(host.execute).toHaveBeenCalledWith('workspaces.open', { rootPath: '/old-project' }, undefined)
    } finally {
      serverStore.setActiveServer('local')
      serverStore.removeServer(next.id)
    }
  })
})
