import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as transport from '../transport/index.js'
import { loadPiModelRoles, savePiModelRoles } from './modelRoles'
import { piModelRolesStore } from '../state/piModelRolesStore'
import { serverStore } from '../../store/serverStore'
import { readModelRolesCache } from '../modelSettingsCache'

describe('shared model role requests', () => {
  beforeEach(() => {
    localStorage.clear()
    piModelRolesStore.restoreCache()
  })
  afterEach(() => vi.restoreAllMocks())

  it('ignores a read started before a disconnect when a recovery read succeeds', async () => {
    let resolve!: (value: Record<string, string>) => void
    vi.spyOn(transport, 'getPiModelRoles')
      .mockReturnValueOnce(new Promise(done => { resolve = done }))
      .mockResolvedValueOnce({ default: 'custom/new' })
    const first = loadPiModelRoles()
    piModelRolesStore.markDisconnected()
    await loadPiModelRoles(true)
    resolve({ default: 'custom/old' })
    await first
    expect(piModelRolesStore.getSnapshot()).toMatchObject({ roles: { default: 'custom/new' }, syncStatus: 'synced' })
    expect(readModelRolesCache()).toEqual({ default: 'custom/new' })
  })

  it('does not let a read started during save overwrite the saved result', async () => {
    let resolveSave!: (value: Record<string, string>) => void
    let resolveRead!: (value: Record<string, string>) => void
    vi.spyOn(transport, 'setPiModelRoles').mockReturnValue(new Promise(done => { resolveSave = done }))
    vi.spyOn(transport, 'getPiModelRoles').mockReturnValue(new Promise(done => { resolveRead = done }))
    const saving = savePiModelRoles({ default: 'custom/new' })
    const reading = loadPiModelRoles(true)
    resolveSave({ default: 'custom/new' })
    await saving
    resolveRead({ default: 'custom/old' })
    await reading
    expect(readModelRolesCache()).toEqual({ default: 'custom/new' })
  })

  it('does not update shared roles or browser cache after switching server mid-read', async () => {
    let resolve!: (value: Record<string, string>) => void
    vi.spyOn(transport, 'getPiModelRoles').mockReturnValue(new Promise(done => { resolve = done }))
    const originalId = serverStore.getActiveServerId()
    const remote = serverStore.addServer({ name: 'Role cache test', url: 'http://role-cache.test' })
    const reading = loadPiModelRoles()
    try {
      serverStore.setActiveServer(remote.id)
      piModelRolesStore.restoreCache()
      resolve({ default: 'custom/old-server' })
      await reading
      expect(piModelRolesStore.getSnapshot()).toMatchObject({ roles: null, syncStatus: 'unknown' })
      expect(readModelRolesCache()).toBeNull()
    } finally {
      serverStore.setActiveServer(originalId)
      serverStore.removeServer(remote.id)
    }
  })
})
