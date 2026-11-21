import { subagentDigest, type SubagentDataBlock } from '@ompiui/protocol'

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
type CacheMetadata = { key: string; bytes: number; accessed: number; fingerprint?: string }
const memory = new Map<string, CachedSubagentHistory>()
const recentAccess = new Map<string, number>()
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
  recentAccess.clear()
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

export async function saveSubagentBlocks(history: CachedSubagentHistory, verifiedSaved = false): Promise<void> {
  const { key } = history
  memory.delete(key)
  memory.set(key, history)
  while (memory.size > 8) memory.delete(memory.keys().next().value!)
  try {
    // 完整窗口下次刷新不发送旧快照；未读完时快照和游标必须一同保留。
    const fingerprint = subagentDigest([
      history.projection, history.nextByte, history.hasMore, history.hasMore ? history.snapshot : null,
      history.blocks.map(({ fromByte, nextByte, hash }) => [fromByte, nextByte, hash]),
    ])
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, META], 'readwrite')
      const store = tx.objectStore(STORE)
      const metadata = tx.objectStore(META)
      const accessed = Date.now()
      const lastAccess = (entry: CacheMetadata) => Math.max(entry.accessed, recentAccess.get(entry.key) ?? 0)
      const write = () => {
        const bytes = new TextEncoder().encode(JSON.stringify(history)).byteLength
        const request = metadata.getAll()
        request.onsuccess = () => {
          const entries = (request.result as CacheMetadata[])
            .filter(entry => entry.key !== key)
            .sort((a, b) => lastAccess(a) - lastAccess(b))
          let total = entries.reduce((sum, entry) => sum + entry.bytes, bytes)
          while (entries.length && (total > MAX_BYTES || entries.length >= MAX_RECORDS)) {
            const removed = entries.shift()!
            total -= removed.bytes
            store.delete(removed.key)
            metadata.delete(removed.key)
          }
          store.put(history, key)
          metadata.put({ key, bytes, accessed, fingerprint }, key)
        }
      }
      if (verifiedSaved) {
        // 在同一事务内判断，以磁盘上的记录为准，避免把失败写入或已淘汰条目当成命中。
        const request = metadata.get(key)
        request.onsuccess = () => {
          const entry = request.result as CacheMetadata | undefined
          if (entry?.fingerprint !== fingerprint) write()
        }
      } else {
        write()
      }
      tx.oncomplete = () => {
        // 无变化时不写元数据，仍记住本页内的最近访问供淘汰排序。
        recentAccess.delete(key)
        recentAccess.set(key, accessed)
        while (recentAccess.size > MAX_RECORDS) recentAccess.delete(recentAccess.keys().next().value!)
        resolve()
      }
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    // 配额不足时保留本次内存结果，不把存储故障升级为网络故障。
  }
}
