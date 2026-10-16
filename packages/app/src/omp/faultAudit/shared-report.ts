import type { FaultReport } from '@ompiui/protocol'
import { waitNetworkDelay } from '../networkRetry'
import { database } from './storage'

type Cached = { key: string; at: number; report: FaultReport }
type Lease = { owner: string; expires: number }
type Claim = { report?: FaultReport; owner?: string; waiting?: boolean }
const localFlights = new Map<string, Promise<FaultReport | undefined>>()
const CACHE = 'backend-cache'
const LEASE = 'backend-lease'

async function claim(key: string, force: boolean, allowNetwork: boolean): Promise<Claim> {
  const db = await database()
  try {
    return await new Promise<Claim>((resolve, reject) => {
      const tx = db.transaction('reports', 'readwrite')
      const store = tx.objectStore('reports')
      let result: Claim = {}
      const cached = store.get(CACHE)
      cached.onsuccess = () => {
        const value = cached.result as Cached | undefined
        if (!force && value?.key === key && Date.now() - value.at < (value.report.complete ? 10 * 60_000 : 30_000)) {
          result = { report: value.report }
          return
        }
        if (!allowNetwork) return
        const lease = store.get(LEASE)
        lease.onsuccess = () => {
          const held = lease.result as Lease | undefined
          if (held && held.expires > Date.now()) { result = { waiting: true }; return }
          const owner = `${Date.now()}:${Math.random()}`
          store.put({ owner, expires: Date.now() + 125_000 } satisfies Lease, LEASE)
          result = { owner }
        }
      }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}

async function release(key: string, owner: string, report?: FaultReport): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('reports', 'readwrite')
      const store = tx.objectStore('reports')
      const lease = store.get(LEASE)
      lease.onsuccess = () => {
        if ((lease.result as Lease | undefined)?.owner !== owner) return
        if (report) store.put({ key, at: Date.now(), report } satisfies Cached, CACHE)
        store.delete(LEASE)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}

/** IndexedDB 事务提供跨标签页互斥；只缓存一份后端正文，客户端摘要仍各自组装。 */
export function sharedFaultReport(
  key: string,
  load: () => Promise<FaultReport>,
  options: { force: boolean; allowNetwork: boolean; signal: AbortSignal; isCurrent: () => boolean },
): Promise<FaultReport | undefined> {
  const existing = localFlights.get(key)
  if (existing) return existing
  const flight = (async () => {
    for (;;) {
      options.signal.throwIfAborted()
      if (!options.isCurrent()) throw new DOMException('Server changed', 'AbortError')
      let admission: Claim
      try {
        if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable')
        admission = await claim(key, options.force, options.allowNetwork)
      } catch {
        // 禁用持久存储时仍可收集本页报告，不把正文写入 localStorage 充当缓存。
        return options.allowNetwork ? load() : undefined
      }
      if (admission.report) return admission.report
      if (admission.owner) {
        let report: FaultReport | undefined
        try {
          options.signal.throwIfAborted()
          if (!options.isCurrent()) throw new DOMException('Server changed', 'AbortError')
          report = await load()
          return report
        } finally {
          await release(key, admission.owner, report).catch(() => undefined)
        }
      }
      if (!admission.waiting) return undefined
      await waitNetworkDelay(250, options.signal)
    }
  })().finally(() => {
    if (localFlights.get(key) === flight) localFlights.delete(key)
  })
  localFlights.set(key, flight)
  return flight
}
