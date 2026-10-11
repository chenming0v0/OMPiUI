import type { FaultNotice, FaultReport, FaultUploadProgress } from '@ompiui/protocol'

export type SavedFault = {
  notice: FaultNotice
  serverId: string
  report: FaultReport
  reportRevision?: string
  upload: FaultUploadProgress
  previousLinks?: string[]
  open: boolean
}

const META_KEY = 'ompiui-fault-report'
const DATABASE = 'ompiui-fault-reports'
let writes = Promise.resolve()
let storedContent: string | undefined

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('reports')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function readSavedFault(): SavedFault | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(META_KEY) ?? 'null') as SavedFault | null
    if (!saved?.notice?.id || !saved.serverId || typeof saved.report?.content !== 'string') return undefined
    return saved
  } catch { return undefined }
}

/** 元数据和客户端摘要同步保存；较大的后端报告放 IndexedDB，不阻塞 UI。 */
export function saveFault(saved: SavedFault): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify({
      ...saved,
      report: saved.report.content.length > 150_000
        ? { ...saved.report, content: saved.report.content.slice(0, 150_000), complete: false, unavailable: [...saved.report.unavailable, 'full_report_in_indexeddb'] }
        : saved.report,
    }))
  } catch { /* 存储失败仍保留内存报告和下载入口。 */ }
  writes = writes.then(() => persist(saved)).catch(() => undefined)
}

async function persist(saved: SavedFault): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('reports', 'readwrite')
      const store = tx.objectStore('reports')
      // 上传每个分片只更新链接，避免重复复制和写入几十 MiB 的同一份报告。
      if (storedContent !== saved.report.content) store.put(saved.report.content, 'content')
      store.put({ ...saved, report: { ...saved.report, content: '' } }, 'latest')
      tx.oncomplete = () => { storedContent = saved.report.content; resolve() }
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}

export async function readFullSavedFault(): Promise<SavedFault | undefined> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction('reports').objectStore('reports')
      const request = store.get('latest')
      request.onsuccess = () => {
        const saved = request.result as SavedFault | undefined
        if (!saved || saved.report.content) { resolve(saved); return }
        const content = store.get('content')
        content.onsuccess = () => resolve(typeof content.result === 'string'
          ? { ...saved, report: { ...saved.report, content: content.result } } : undefined)
        content.onerror = () => reject(content.error)
      }
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
}
