import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionInfo } from '../api/events'
import { serverStore } from '../store/serverStore'
import { piModelsStore } from './state/piModelsStore'
import { piModelRolesStore } from './state/piModelRolesStore'
import { installModelSettingsSync } from './modelSettingsSync'

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  loadModels: vi.fn().mockResolvedValue([]),
  loadRoles: vi.fn().mockResolvedValue({}),
}))

vi.mock('../api/events', () => ({ subscribeToConnectionState: mocks.subscribe }))
vi.mock('./controllers/index.js', () => ({ loadPiModels: mocks.loadModels }))
vi.mock('./controllers/modelRoles', () => ({ loadPiModelRoles: mocks.loadRoles }))

function connection(state: ConnectionInfo['state']): void {
  const listener = mocks.subscribe.mock.calls[0][0] as (info: ConnectionInfo) => void
  listener({ state, lastEventTime: Date.now(), reconnectAttempt: 0 })
}

describe('app-wide model settings connection lifecycle', () => {
  beforeAll(() => installModelSettingsSync())

  beforeEach(() => {
    vi.spyOn(serverStore, 'getHealth').mockReturnValue(null)
    connection('connected')
    mocks.loadModels.mockClear()
    mocks.loadRoles.mockClear()
    localStorage.clear()
    piModelsStore.restoreCache()
    piModelRolesStore.restoreCache()
  })

  afterEach(() => vi.restoreAllMocks())

  it('installs the existing connection subscription only once', () => {
    installModelSettingsSync()
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps green through periodic checking without extra requests', () => {
    piModelsStore.setModels([])
    piModelRolesStore.setRoles({})
    connection('connecting')
    connection('connected')
    expect(piModelsStore.getSyncStatus()).toBe('synced')
    expect(piModelRolesStore.getSnapshot().syncStatus).toBe('synced')
    expect(mocks.loadModels).not.toHaveBeenCalled()
    expect(mocks.loadRoles).not.toHaveBeenCalled()
  })

  it('marks both modules red and refreshes previously used roles on recovery', () => {
    piModelsStore.setModels([])
    piModelRolesStore.beginRead()
    piModelRolesStore.setRoles({ default: 'custom/model' })
    connection('error')
    expect(piModelsStore.getSyncStatus()).toBe('disconnected')
    expect(piModelRolesStore.getSnapshot()).toMatchObject({
      syncStatus: 'disconnected', roles: { default: 'custom/model' },
    })
    connection('connecting')
    connection('connected')
    expect(mocks.loadModels).toHaveBeenCalledTimes(1)
    expect(mocks.loadRoles).toHaveBeenCalledWith(true)
    // 接通不等于同步完成；必须等同步响应才能变绿。
    expect(piModelsStore.getSyncStatus()).toBe('disconnected')
    expect(piModelRolesStore.getSnapshot().syncStatus).toBe('disconnected')
  })

  it('does not invalidate recovery requests repeatedly while health remains offline', () => {
    connection('error')
    const modelVersion = piModelsStore.getSyncVersion()
    const roleVersion = piModelRolesStore.getVersion()
    connection('error')
    expect(piModelsStore.getSyncVersion()).toBe(modelVersion)
    expect(piModelRolesStore.getVersion()).toBe(roleVersion)
  })

  it('keeps never-synced data gray on initial connection and avoids unused role requests', () => {
    connection('disconnected')
    expect(piModelsStore.getSyncStatus()).toBe('unknown')
    expect(piModelRolesStore.getSnapshot().syncStatus).toBe('unknown')
    connection('connected')
    expect(mocks.loadRoles).not.toHaveBeenCalled()
  })

  it('handles browser offline and online events without an open settings component', () => {
    piModelsStore.setModels([])
    piModelRolesStore.beginRead()
    piModelRolesStore.setRoles({})
    window.dispatchEvent(new Event('offline'))
    expect(piModelsStore.getSyncStatus()).toBe('disconnected')
    expect(piModelRolesStore.getSnapshot().syncStatus).toBe('disconnected')
    window.dispatchEvent(new Event('online'))
    expect(mocks.loadModels).toHaveBeenCalledTimes(1)
    expect(mocks.loadRoles).toHaveBeenCalledWith(true)
  })
})
