import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serverStore } from '../store/serverStore'
import { serverStorage } from '../utils/perServerStorage'
import { readModelsCache, writeModelsCache, readModelRolesCache, writeModelRolesCache } from './modelSettingsCache'
import { piModelsStore } from './state/piModelsStore'
import type { Api, Model } from './vendor/pi-ai'

const model: Model<Api> & { kind: string } = {
  id: 'cached-model', name: 'Cached model', provider: 'custom', api: 'openai-responses',
  baseUrl: 'https://private.test/?api_key=secret', headers: { Authorization: 'Bearer secret' },
  reasoning: true, thinkingLevelMap: { off: null, high: 'high' }, kind: 'tiny', input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 32000,
}

describe('model settings cache', () => {
  beforeEach(() => {
    localStorage.clear()
    piModelsStore.clear()
  })

  afterEach(() => vi.restoreAllMocks())

  it('restores models immediately without restoring live-sync state', () => {
    piModelsStore.setModels([model])
    expect(piModelsStore.isSynced()).toBe(true)
    piModelsStore.restoreCache()
    expect(piModelsStore.getModels()).toMatchObject([{ id: model.id, kind: 'tiny', thinkingLevelMap: model.thinkingLevelMap }])
    expect(piModelsStore.getSyncStatus()).toBe('unknown')
    expect(piModelsStore.isSynced()).toBe(false)
    piModelsStore.setLoading(true)
    expect(piModelsStore.isLoading()).toBe(false)
    piModelsStore.setError(new Error('offline'))
    expect(piModelsStore.getModels()).toHaveLength(1)
    expect(piModelsStore.getSyncStatus()).toBe('disconnected')
    expect(piModelsStore.isSynced()).toBe(false)
  })

  it('does not persist credentials or runtime URLs', () => {
    writeModelsCache([model])
    const raw = serverStorage.get('ompiui-models-cache')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('headers')
    expect(raw).not.toContain('private.test')
    expect(readModelsCache()[0].input).toEqual(['text', 'image'])
  })

  it('keeps successful empty results instead of reviving removed models', () => {
    piModelsStore.setModels([model])
    piModelsStore.setModels([])
    piModelsStore.restoreCache()
    expect(piModelsStore.getModels()).toEqual([])
    piModelsStore.setLoading(true)
    expect(piModelsStore.isLoading()).toBe(true)
  })

  it('isolates both caches by server and rejects a saved endpoint change', () => {
    writeModelsCache([model])
    writeModelRolesCache({ default: 'custom/cached-model' })
    const originalId = serverStore.getActiveServerId()
    const remote = serverStore.addServer({ name: 'Remote cache test', url: 'http://cache.test' })
    try {
      serverStore.setActiveServer(remote.id)
      piModelsStore.restoreCache()
      expect(piModelsStore.getModels()).toEqual([])
      expect(readModelRolesCache()).toBeNull()
      writeModelsCache([{ ...model, id: 'remote' }])
      writeModelRolesCache({ smol: 'custom/remote' })
      serverStore.setActiveServer(originalId)
      piModelsStore.restoreCache()
      expect(piModelsStore.getModels()[0].id).toBe('cached-model')
      expect(readModelRolesCache()).toEqual({ default: 'custom/cached-model' })
      expect(piModelsStore.isSynced()).toBe(false)
      serverStore.setActiveServer(remote.id)
      expect(readModelsCache()[0].id).toBe('remote')
      serverStore.updateServer(remote.id, { url: 'http://other-host.test' })
      expect(readModelsCache()).toEqual([])
      expect(readModelRolesCache()).toBeNull()
    } finally {
      serverStore.setActiveServer(originalId)
      serverStore.removeServer(remote.id)
    }
  })

  it('ignores malformed and unsupported cache entries', () => {
    serverStorage.set('ompiui-models-cache', '{bad json')
    expect(readModelsCache()).toEqual([])
    serverStorage.setJSON('ompiui-model-roles-cache', { version: 999, value: {} })
    expect(readModelRolesCache()).toBeNull()
    writeModelsCache([model])
    const valid = serverStorage.getJSON<Record<string, unknown>>('ompiui-models-cache')
    serverStorage.setJSON('ompiui-models-cache', { ...valid, value: [null, {}] })
    expect(readModelsCache()).toEqual([])
  })

  it('continues updating in memory if browser storage is unavailable', () => {
    vi.spyOn(serverStorage, 'set').mockImplementation(() => undefined)
    piModelsStore.setModels([model])
    expect(piModelsStore.getModels()).toEqual([model])
    expect(piModelsStore.isSynced()).toBe(true)
  })
})
