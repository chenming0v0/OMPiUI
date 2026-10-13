import type { SubagentDataBlock } from '@ompiui/protocol'

export type CachedSubagentHistory = {
  key: string
  projection: string
  snapshot: string
  blocks: SubagentDataBlock[]
  nextByte: number
  hasMore: boolean
}

const DATABASE = 'ompiui-subagent-history'
const STORE = 'histories'
const META = 'metadata'
const MAX_BYTES = 64 * 1024 * 1024
const MAX_RECORDS = 64
const memory = new Map<string, CachedSubagentHistory>()
let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE)
        request.result.createObjectStore(META)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Subagent cache upgrade blocked'))
    })
    void database.catch(() => {
      database = undefined
    })
  }
  return database
}

export function clearSubagentBlockMemory(): void {
  memory.clear()
}

export async function loadSubagentBlocks(key: string): Promise<CachedSubagentHistory | undefined> {
  const cached = memory.get(key)
  if (cached) return cached
  try {
    const db = await openDatabase()
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key)
      request.onsuccess = () => resolve(request.result as CachedSubagentHistory | undefined)
      request.onerror = () => reject(request.error)
    })
  } catch {
    // 禁用浏览器存储时仍使用内存缓存，不阻止历史读取。
    return undefined
  }
}

export async function saveSubagentBlocks(history: CachedSubagentHistory): Promise<void> {
  memory.delete(history.key)
  memory.set(history.key, history)
  while (memory.size > 8) memory.delete(memory.keys().next().value!)
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(history)).byteLength
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readwrite')
      const store = tx.objectStore(STORE)
      const metadata = tx.objectStore(META)
      const request = metadata.getAll()
      request.onsuccess = () => {
        const entries = (request.result as { key: string; bytes: number; accessed: number }[])
          .filter(entry => entry.key !== history.key)
          .sort((a, b) => a.accessed - b.accessed)
        let total = entries.reduce((sum, entry) => sum + entry.bytes, bytes)
        while (entries.length && (total > MAX_BYTES || entries.length >= MAX_RECORDS)) {
          const removed = entries.shift()!
          total -= removed.bytes
          store.delete(removed.key)
          metadata.delete(removed.key)
        }
        store.put(history, history.key)
        metadata.put({ key: history.key, bytes, accessed: Date.now() }, history.key)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    // 配额不足时保留本次内存结果，不把存储故障升级为网络故障。
  }
}
