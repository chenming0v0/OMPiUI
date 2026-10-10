import { readModelRolesCache, writeModelRolesCache } from '../modelSettingsCache'
import type { PiModelsSyncStatus } from './piModelsStore'

interface ModelRolesSnapshot {
  roles: Record<string, string> | null
  syncStatus: PiModelsSyncStatus
  error: Error | null
}

class PiModelRolesStore {
  private snapshot: ModelRolesSnapshot = {
    roles: readModelRolesCache(),
    syncStatus: 'unknown',
    error: null,
  }
  private version = 0
  private requested = false
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ModelRolesSnapshot => this.snapshot

  private update(snapshot: ModelRolesSnapshot): void {
    this.snapshot = snapshot
    this.listeners.forEach(listener => listener())
  }

  restoreCache(): void {
    this.version += 1
    this.requested = false
    this.update({ roles: readModelRolesCache(), syncStatus: 'unknown', error: null })
  }

  hasRequested(): boolean {
    return this.requested
  }

  getVersion(): number {
    return this.version
  }

  beginRead(): number {
    this.requested = true
    return this.version
  }

  beginWrite(): number {
    this.requested = true
    return ++this.version
  }

  setRoles(roles: Record<string, string>): void {
    writeModelRolesCache(roles)
    this.update({ roles, syncStatus: 'synced', error: null })
  }

  setError(error: Error): void {
    this.update({ ...this.snapshot, syncStatus: 'disconnected', error })
  }

  markDisconnected(): void {
    this.version += 1
    this.update({ ...this.snapshot, syncStatus: 'disconnected' })
  }
}

export const piModelRolesStore = new PiModelRolesStore()
