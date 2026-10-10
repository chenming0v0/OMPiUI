import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPiModels } from './index'
import * as transport from '../transport/index'
import { piModelsStore } from '../state/piModelsStore'
import { serverStore } from '../../store/serverStore'
import { readModelsCache } from '../modelSettingsCache'
import type { JsonValue } from '@ompiui/protocol'

const models = [{
  id: 'live', name: 'Live model', provider: 'custom', api: 'openai-responses',
  input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 32000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}]

describe('model loading and live-sync status', () => {
  beforeEach(() => {
    localStorage.clear()
    piModelsStore.clear()
  })
  afterEach(() => vi.restoreAllMocks())

  it('deduplicates concurrent loads and writes a successful response to cache', async () => {
    let resolve!: (value: JsonValue) => void
    const request = new Promise<JsonValue>(done => { resolve = done })
    const list = vi.spyOn(transport, 'listPiModels').mockReturnValue(request)
    const first = loadPiModels()
    const second = loadPiModels()
    expect(piModelsStore.isSynced()).toBe(false)
    resolve(models)
    await Promise.all([first, second])
    expect(list).toHaveBeenCalledTimes(1)
    expect(piModelsStore.isSynced()).toBe(true)
    expect(readModelsCache()).toMatchObject([{ id: 'live' }])
  })

  it('keeps cached data but returns to red after a failed refresh', async () => {
    piModelsStore.setModels(models as unknown as Parameters<typeof piModelsStore.setModels>[0])
    vi.spyOn(transport, 'listPiModels').mockRejectedValue(new Error('request failed'))
    await expect(loadPiModels()).rejects.toThrow('request failed')
    expect(piModelsStore.isSynced()).toBe(false)
    expect(piModelsStore.getModels()).toMatchObject([{ id: 'live' }])
  })

  it('ignores a pre-disconnect response and allows an independent reconnect load', async () => {
    let resolve!: (value: JsonValue) => void
    const old = new Promise<JsonValue>(done => { resolve = done })
    vi.spyOn(transport, 'listPiModels').mockReturnValueOnce(old).mockResolvedValueOnce(models)
    const first = loadPiModels()
    piModelsStore.markDisconnected()
    await loadPiModels()
    resolve([{ ...models[0], id: 'old' }])
    await first
    expect(piModelsStore.getModels()[0].id).toBe('live')
    expect(piModelsStore.isSynced()).toBe(true)
    expect(readModelsCache()[0].id).toBe('live')
  })

  it('does not update or cross-write after switching servers mid-request', async () => {
    let resolve!: (value: JsonValue) => void
    vi.spyOn(transport, 'listPiModels').mockReturnValue(new Promise<JsonValue>(done => { resolve = done }))
    const originalId = serverStore.getActiveServerId()
    const remote = serverStore.addServer({ name: 'Other', url: 'http://other-cache.test' })
    const first = loadPiModels()
    try {
      serverStore.setActiveServer(remote.id)
      piModelsStore.restoreCache()
      resolve(models)
      await first
      expect(piModelsStore.isSynced()).toBe(false)
      expect(piModelsStore.getModels()).toEqual([])
      expect(readModelsCache()).toEqual([])
    } finally {
      serverStore.setActiveServer(originalId)
      serverStore.removeServer(remote.id)
    }
  })
})
