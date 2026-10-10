import type { Model, Api } from '../vendor/pi-ai'
import { readModelsCache, writeModelsCache } from '../modelSettingsCache'

export type PiModelsSyncStatus = 'unknown' | 'disconnected' | 'synced'

/**
 * Available Pi models store (from models.list).
 * Follows app store convention: subscribe/notify + stable snapshots.
 */
class PiModelsStore {
  private models: Model<Api>[] = readModelsCache()
  private loading = false
  private syncStatus: PiModelsSyncStatus = 'unknown'
  private syncVersion = 0
  private error: Error | null = null
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  setLoading(loading: boolean): void {
    this.loading = loading
    this.notify()
  }

  setModels(models: Model<Api>[]): void {
    this.models = models
    this.error = null
    this.loading = false
    this.syncStatus = 'synced'
    writeModelsCache(models)
    this.notify()
  }

  restoreCache(): void {
    this.models = readModelsCache()
    this.error = null
    this.loading = false
    this.syncStatus = 'unknown'
    this.syncVersion += 1
    this.notify()
  }

  markDisconnected(): void {
    this.syncStatus = 'disconnected'
    this.loading = false
    this.syncVersion += 1
    this.notify()
  }

  getSyncVersion(): number {
    return this.syncVersion
  }

  isSynced(): boolean {
    return this.syncStatus === 'synced'
  }

  getSyncStatus(): PiModelsSyncStatus {
    return this.syncStatus
  }

  clear(): void {
    this.models = []
    this.error = null
    this.markDisconnected()
  }

  setError(error: Error): void {
    this.error = error
    this.loading = false
    this.syncStatus = 'disconnected'
    this.notify()
  }

  getModels(): readonly Model<Api>[] {
    return this.models
  }

  isLoading(): boolean {
    return this.loading && this.models.length === 0
  }

  getError(): Error | null {
    return this.error
  }
}

export const piModelsStore = new PiModelsStore()
