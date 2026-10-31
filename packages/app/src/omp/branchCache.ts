import { subagentDigest } from '@ompiui/protocol'
import type { PiBranchPage } from './domain'
import { windowBranch } from './branchWindow'
import { getApiBase, getPiAuthToken } from './httpClient'
import { serverStore } from '../store/serverStore'

const DATABASE = 'ompiui-branch-cache'
const STORE = 'branches'
const META = 'metadata'
const MAX_RECORDS = 16
const MAX_BYTES = 64 * 1024 * 1024
const WRITE_DELAY_MS = 1_000
interface CachedBranch { key: string; page: PiBranchPage; bytes: number; savedAt: number }
let database: Promise<IDBDatabase> | undefined
const pending = new Map<string, PiBranchPage>()
let writeTimer: ReturnType<typeof setTimeout> | undefined

/** Credentials are only used as a namespace digest, never persisted with history. */
export function branchCacheKey(sessionId: string): string {
  return JSON.stringify([serverStore.getActiveServerId(), getApiBase() || window.location.origin, subagentDigest(getPiAuthToken() ?? ''), sessionId])
}

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE)
        request.result.createObjectStore(META)
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); database = undefined }
        resolve(request.result)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Branch cache upgrade blocked'))
    })
    void database.catch(() => { database = undefined })
  }
  return database
}

/** Persist only the bounded latest window, never all paginated history. */
export function cachePiBranch(sessionId: string, page: PiBranchPage): void {
  pending.set(branchCacheKey(sessionId), page)
  if (writeTimer !== undefined) return
  writeTimer = setTimeout(() => { writeTimer = undefined; void flushPiBranchCache() }, WRITE_DELAY_MS)
}

export async function flushPiBranchCache(): Promise<void> {
  if (writeTimer !== undefined) clearTimeout(writeTimer)
  writeTimer = undefined
  const pages = [...pending]
  pending.clear()
  if (!pages.length) return
  try {
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readwrite')
      const store = tx.objectStore(STORE)
      const metadata = tx.objectStore(META)
      const request = metadata.getAll()
      request.onsuccess = () => {
        const updating = new Set(pages.map(([key]) => key))
        const entries = (request.result as Array<{ key: string; bytes: number; savedAt: number }>).filter(record => !updating.has(record.key))
        const now = Date.now()
        for (const [key, raw] of pages) {
          const page = windowBranch(raw.client?.historyWindowed ? { ...raw, client: { ...raw.client, historyWindowed: false } } : raw)
          const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength
          if (bytes > MAX_BYTES) { store.delete(key); metadata.delete(key); continue }
          store.put({ key, page, bytes, savedAt: now } satisfies CachedBranch, key)
          metadata.put({ key, bytes, savedAt: now }, key)
          entries.push({ key, bytes, savedAt: now })
        }
        entries.sort((a, b) => a.savedAt - b.savedAt)
        let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
        while (entries.length > MAX_RECORDS || total > MAX_BYTES) {
          const removed = entries.shift()!
          total -= removed.bytes
          store.delete(removed.key)
          metadata.delete(removed.key)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    // Storage is best effort; quota/private mode must not break live history.
  }
}

export async function loadCachedPiBranch(sessionId: string): Promise<PiBranchPage | undefined> {
  const key = branchCacheKey(sessionId)
  const queued = pending.get(key)
  let page = queued
  if (!page) {
    try {
      const db = await openDatabase()
      page = await new Promise<PiBranchPage | undefined>((resolve, reject) => {
        const request = db.transaction(STORE).objectStore(STORE).get(key)
        request.onsuccess = () => resolve((request.result as CachedBranch | undefined)?.page)
        request.onerror = () => reject(request.error)
      })
    } catch { return undefined }
  }
  if (!page || !page.head || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean') return undefined
  // Cached text is useful immediately; cached runtime activity is not authority.
  // Keep checkpoint+cursor paired for replay, but do not animate a dead process.
  const live = page.checkpoint?.liveMessage
  const toolExecutions = { ...page.client?.toolExecutions }
  for (const item of page.items) {
    if (item.type === 'message' && item.message.role === 'assistant') {
      for (const block of item.message.content) if (block.type === 'toolCall') toolExecutions[block.id] ??= { call: block }
    }
    if (item.type === 'custom' && item.customType === 'tool_execution_start') {
      const data = item.data as { toolCallId?: unknown } | undefined
      if (typeof data?.toolCallId === 'string') toolExecutions[data.toolCallId] ??= { isRunning: true }
    }
  }
  if (live?.message.role === 'assistant') {
    for (const block of live.message.content) if (block.type === 'toolCall') toolExecutions[block.id] ??= { call: block }
  }
  const resultIds = new Set(page.items.flatMap(item => item.type === 'message' && item.message.role === 'toolResult' ? [item.message.toolCallId] : []))
  for (const [id, execution] of Object.entries(toolExecutions)) {
    if (!resultIds.has(id) && !execution.result && execution.completedAt === undefined && !execution.error)
      toolExecutions[id] = { ...execution, isRunning: false, awaitingSnapshot: true }
  }
  return {
    ...page,
    ...(live?.phase === 'streaming' ? { checkpoint: { ...page.checkpoint!, liveMessage: { ...live, phase: 'persisting' } } } : {}),
    ...(Object.keys(toolExecutions).length ? { client: { ...page.client, toolExecutions } } : {}),
  }
}

export async function removeCachedPiBranch(sessionId: string): Promise<void> {
  const key = branchCacheKey(sessionId)
  pending.delete(key)
  try {
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.objectStore(META).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch { /* Optional client cache, not native session storage. */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { void flushPiBranchCache() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPiBranchCache()
  })
}
