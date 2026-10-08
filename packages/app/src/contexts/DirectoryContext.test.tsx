import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode, useContext, useLayoutEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryProvider } from './DirectoryContext'
import { DirectoryContext } from './DirectoryContext.shared'
import { serverStore } from '../store/serverStore'
import { serverStorage } from '../utils/perServerStorage'

const mocks = vi.hoisted(() => ({ setDirectory: vi.fn() }))
vi.mock('../hooks/useRouter', () => ({
  useRouter: () => ({ directory: undefined, setDirectory: mocks.setDirectory }),
}))
vi.mock('../store/layoutStore', () => ({
  useLayoutStore: () => ({ sidebarExpanded: true }),
  layoutStore: { setSidebarExpanded: vi.fn() },
}))

const savedKey = 'ompiui-saved-directories'
const recentKey = 'ompiui-recent-projects'
const savedA = [{ path: '/a', name: 'A', addedAt: 1 }]
const savedB = [{ path: '/b', name: 'B', addedAt: 2 }]

function seed(serverId: string, saved: unknown, recent: unknown) {
  localStorage.setItem(`srv:${serverId}:${savedKey}`, JSON.stringify(saved))
  localStorage.setItem(`srv:${serverId}:${recentKey}`, JSON.stringify(recent))
}

function stored(serverId: string, key: string) {
  return JSON.parse(localStorage.getItem(`srv:${serverId}:${key}`) ?? 'null')
}

function wrapper({ children }: { children: ReactNode }) {
  return <StrictMode><DirectoryProvider>{children}</DirectoryProvider></StrictMode>
}

describe('DirectoryProvider server isolation', () => {
  let serverA: string
  let serverB: string

  beforeEach(() => {
    localStorage.clear()
    mocks.setDirectory.mockClear()
    serverA = serverStore.addServer({ name: 'A', url: 'http://a.test' }).id
    serverB = serverStore.addServer({ name: 'B', url: 'http://b.test' }).id
    seed(serverA, savedA, { '/a': 10 })
    seed(serverB, savedB, { '/b': 20 })
    serverStore.setActiveServer(serverA)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    serverStore.setActiveServer('local')
    serverStore.removeServer(serverA)
    serverStore.removeServer(serverB)
  })

  it('loads saved directories and recency together before consumers commit on a server switch', () => {
    const committed: Array<{ serverId: string; paths: string[]; recent: Record<string, number> }> = []
    const { result } = renderHook(() => {
      const context = useContext(DirectoryContext)!
      useLayoutEffect(() => {
        committed.push({
          serverId: serverStore.getActiveServerId(),
          paths: context.savedDirectories.map(directory => directory.path),
          recent: context.recentProjects,
        })
      }, [context])
      return context
    }, { wrapper })

    expect(result.current.savedDirectories).toEqual(savedA)
    act(() => { serverStore.setActiveServer(serverB) })
    expect(result.current.savedDirectories).toEqual(savedB)
    expect(result.current.recentProjects).toEqual({ '/b': 20 })
    expect(committed.filter(value => value.serverId === serverB)).toEqual([
      { serverId: serverB, paths: ['/b'], recent: { '/b': 20 } },
    ])

    act(() => { result.current.addDirectory('/b/new') })
    expect(stored(serverB, savedKey).map((directory: { path: string }) => directory.path)).toEqual(['/b', '/b/new'])
    expect(stored(serverA, savedKey)).toEqual(savedA)
    expect(stored(serverA, recentKey)).toEqual({ '/a': 10 })

    act(() => { serverStore.setActiveServer(serverA) })
    expect(result.current.savedDirectories).toEqual(savedA)
    expect(result.current.recentProjects).toEqual({ '/a': 10 })
  })

  it('never persists a queued old-server edit under the new server id', () => {
    const writes: Array<{ serverId: string; key: string; value: unknown }> = []
    const setJSON = serverStorage.setJSON
    vi.spyOn(serverStorage, 'setJSON').mockImplementation((key, value) => {
      writes.push({ serverId: serverStore.getActiveServerId(), key, value })
      setJSON(key, value)
    })
    const { result } = renderHook(() => useContext(DirectoryContext)!, { wrapper })
    writes.length = 0

    act(() => {
      result.current.addDirectory('/a/queued')
      serverStore.setActiveServer(serverB)
    })

    expect(stored(serverB, savedKey)).toEqual(savedB)
    expect(stored(serverB, recentKey)).toEqual({ '/b': 20 })
    expect(writes.filter(write => write.serverId === serverB)).toEqual([
      { serverId: serverB, key: savedKey, value: savedB },
      { serverId: serverB, key: recentKey, value: { '/b': 20 } },
    ])
  })

  it('uses empty state for a server without saved data and rejects callbacks from the old server', () => {
    localStorage.removeItem(`srv:${serverB}:${savedKey}`)
    localStorage.removeItem(`srv:${serverB}:${recentKey}`)
    const { result } = renderHook(() => useContext(DirectoryContext)!, { wrapper })
    const previous = result.current

    act(() => { serverStore.setActiveServer(serverB) })
    expect(result.current.savedDirectories).toEqual([])
    expect(result.current.recentProjects).toEqual({})
    act(() => {
      previous.addDirectory('/a/stale')
      previous.setCurrentDirectory('/a/stale')
    })
    expect(result.current.savedDirectories).toEqual([])
    expect(result.current.recentProjects).toEqual({})
    expect(mocks.setDirectory).not.toHaveBeenCalled()
    expect(stored(serverA, savedKey)).toEqual(savedA)
  })

  it('does not cross-write when the server changes between render and persistence effects', () => {
    const writes: Array<{ serverId: string; key: string; value: unknown }> = []
    const setJSON = serverStorage.setJSON
    vi.spyOn(serverStorage, 'setJSON').mockImplementation((key, value) => {
      writes.push({ serverId: serverStore.getActiveServerId(), key, value })
      setJSON(key, value)
    })
    const { result } = renderHook(() => {
      const context = useContext(DirectoryContext)!
      useLayoutEffect(() => { serverStore.setActiveServer(serverB) }, [])
      return context
    }, { wrapper })

    expect(result.current.savedDirectories).toEqual(savedB)
    expect(result.current.recentProjects).toEqual({ '/b': 20 })
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) {
      expect(write.serverId).toBe(serverB)
      expect(write.value).toEqual(write.key === savedKey ? savedB : { '/b': 20 })
    }
    expect(stored(serverA, savedKey)).toEqual(savedA)
    expect(stored(serverA, recentKey)).toEqual({ '/a': 10 })
  })
})
