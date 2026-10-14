import type { PiBranchPage } from './domain'

type HistoryEntry = PiBranchPage['items'][number]
type Request = {
  anchor: HistoryEntry
  page: Promise<PiBranchPage>
  bytes: number
}

type Buffer = {
  requests: Map<string, Request>
  bytes: number
  budgetBlocked: boolean
}

export type HistoryPrefetchMode = 'fast' | 'idle'
export const HISTORY_PREFETCH_MAX_PAGES = 16
const MAX_PREFETCH_BYTES = 8 * 1024 * 1024
const encoder = new TextEncoder()

/** 预取页不写会话 store；同一原生边界共享请求，前台读取后移出缓冲。 */
export class HistoryPagePrefetch {
  private readonly buffers = new Map<string, Buffer>()

  private buffer(sessionId: string, generation: number): Buffer {
    const key = JSON.stringify([generation, sessionId])
    let buffer = this.buffers.get(key)
    if (!buffer) buffer = { requests: new Map(), bytes: 0, budgetBlocked: false }
    this.buffers.delete(key)
    this.buffers.set(key, buffer)
    // 支持分屏/会话切换，历史正文最多保留两个会话的预取预算。
    while (this.buffers.size > 2) this.buffers.delete(this.buffers.keys().next().value!)
    return buffer
  }

  private remove(buffer: Buffer, key: string, request: Request): void {
    if (buffer.requests.get(key) !== request) return
    buffer.requests.delete(key)
    buffer.bytes -= request.bytes
    if (request.bytes > 0) buffer.budgetBlocked = false
  }

  peek(sessionId: string, generation: number, anchor: HistoryEntry): Promise<PiBranchPage> | undefined {
    const buffer = this.buffer(sessionId, generation)
    const existing = buffer.requests.get(anchor.id)
    if (existing && existing.anchor !== anchor) {
      // 原生条目被替换意味着浏览/刷新换了历史，旧的预取链不可继续占用预算。
      buffer.requests.clear()
      buffer.bytes = 0
      buffer.budgetBlocked = false
      return undefined
    }
    return existing?.anchor === anchor ? existing.page : undefined
  }

  canPrefetch(sessionId: string, generation: number): boolean {
    const buffer = this.buffer(sessionId, generation)
    return !buffer.budgetBlocked && buffer.requests.size < HISTORY_PREFETCH_MAX_PAGES && buffer.bytes < MAX_PREFETCH_BYTES
  }

  private request(
    sessionId: string,
    generation: number,
    anchor: HistoryEntry,
    read: () => Promise<PiBranchPage>,
  ): { key: string; request: Request; buffer: Buffer } {
    const buffer = this.buffer(sessionId, generation)
    const key = anchor.id
    const existing = buffer.requests.get(key)
    if (existing?.anchor === anchor) return { key, request: existing, buffer }
    if (existing) this.remove(buffer, key, existing)

    const request: Request = { anchor, page: read(), bytes: 0 }
    request.page = request.page.then(page => {
      if (buffer.requests.get(key) === request) {
        const bytes = encoder.encode(JSON.stringify(page)).byteLength
        if (buffer.bytes + bytes > MAX_PREFETCH_BYTES) {
          this.remove(buffer, key, request)
          buffer.budgetBlocked = true
        } else {
          request.bytes = bytes
          buffer.bytes += bytes
        }
      }
      return page
    }).catch(error => {
      this.remove(buffer, key, request)
      throw error
    })
    buffer.requests.set(key, request)
    while (buffer.requests.size > HISTORY_PREFETCH_MAX_PAGES) {
      const key = buffer.requests.keys().next().value!
      this.remove(buffer, key, buffer.requests.get(key)!)
    }
    return { key, request, buffer }
  }

  prefetch(sessionId: string, generation: number, anchor: HistoryEntry, read: () => Promise<PiBranchPage>): Promise<PiBranchPage> {
    return this.request(sessionId, generation, anchor, read).request.page
  }

  take(sessionId: string, generation: number, anchor: HistoryEntry, read: () => Promise<PiBranchPage>): Promise<PiBranchPage> {
    const { key, request, buffer } = this.request(sessionId, generation, anchor, read)
    return request.page.finally(() => {
      this.remove(buffer, key, request)
    })
  }

  clear(): void {
    this.buffers.clear()
  }
}

export const historyPagePrefetch = new HistoryPagePrefetch()
