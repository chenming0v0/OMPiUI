import type { PiBranchPage } from '../domain/index.js'

interface BranchEntry {
  data: PiBranchPage | null
  loading: boolean
  error: Error | null
  requestVersion: number
}

const EMPTY_ENTRY: BranchEntry = { data: null, loading: false, error: null, requestVersion: 0 }

/**
 * Raw branch page store, keyed by session id (multi-pane safe).
 * Follows app store convention: subscribe/notify + stable snapshots.
 */
class PiBranchStore {
  private bySessionId = new Map<string, BranchEntry>()
  private listeners = new Set<() => void>()
  private nextVersion = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  private entry(sessionId: string): BranchEntry {
    let entry = this.bySessionId.get(sessionId)
    if (!entry) {
      entry = { data: null, loading: false, error: null, requestVersion: ++this.nextVersion }
      this.bySessionId.set(sessionId, entry)
    }
    return entry
  }

  setLoading(sessionId: string, loading: boolean): void {
    this.entry(sessionId).loading = loading
    this.notify()
  }

  setData(sessionId: string, data: PiBranchPage): void {
    const entry = this.entry(sessionId)
    entry.requestVersion = ++this.nextVersion
    entry.data = data
    entry.error = null
    entry.loading = false
    this.notify()
  }

  beginRequest(sessionId: string): number {
    const entry = this.entry(sessionId)
    entry.requestVersion = ++this.nextVersion
    return entry.requestVersion
  }

  isRequestCurrent(sessionId: string, version: number): boolean {
    return this.bySessionId.get(sessionId)?.requestVersion === version
  }

  setDataIfCurrent(sessionId: string, data: PiBranchPage, version: number): void {
    if (this.isRequestCurrent(sessionId, version)) this.setData(sessionId, data)
  }

  setError(sessionId: string, error: Error): void {
    const entry = this.entry(sessionId)
    entry.error = error
    entry.loading = false
    this.notify()
  }

  getData(sessionId: string): PiBranchPage | null {
    return this.bySessionId.get(sessionId)?.data ?? null
  }

  isLoading(sessionId: string): boolean {
    return this.bySessionId.get(sessionId)?.loading ?? false
  }

  getError(sessionId: string): Error | null {
    return this.bySessionId.get(sessionId)?.error ?? null
  }

  clear(sessionId: string): void {
    this.bySessionId.delete(sessionId)
    this.notify()
  }

  clearAll(): void {
    this.bySessionId.clear()
    this.notify()
  }
}

export const piBranchStore = new PiBranchStore()
export type { BranchEntry }
export { EMPTY_ENTRY as EMPTY_BRANCH_ENTRY }
