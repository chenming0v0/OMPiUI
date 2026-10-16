import type { PiBranchPage } from './domain'

type HistoryEntry = PiBranchPage['items'][number]
type Request = {
  anchor: HistoryEntry
  buffer: Buffer
  flightKey: string
  controller: AbortController
  users: number
  settled: boolean
  cancelPrefetch: Set<() => void>
  page: Promise<PiBranchPage>
  bytes: number
}

type Buffer = {
  sessionId: string
  visibleAnchor?: HistoryEntry
  visibleItems?: HistoryEntry[]
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
  private readonly flights = new Set<Request>()
  private evictedViews = new WeakSet<HistoryEntry[]>()

  private buffer(sessionId: string, generation: number): Buffer {
    const key = JSON.stringify([generation, sessionId])
    let buffer = this.buffers.get(key)
    if (!buffer) buffer = { sessionId, requests: new Map(), bytes: 0, budgetBlocked: false }
    this.buffers.delete(key)
    this.buffers.set(key, buffer)
    // 支持分屏/会话切换，历史正文最多保留两个会话的预取预算。
    while (this.buffers.size > 2) {
      const oldestKey = this.buffers.keys().next().value!
      const oldest = this.buffers.get(oldestKey)!
      this.buffers.delete(oldestKey)
      if (oldest.visibleItems) this.evictedViews.add(oldest.visibleItems)
      this.reset(oldest)
    }
    return buffer
  }

  private remove(request: Request): void {
    const { buffer } = request
    const key = request.anchor.id
    if (buffer.requests.get(key) !== request) return
    buffer.requests.delete(key)
    buffer.bytes -= request.bytes
    if (request.bytes > 0) buffer.budgetBlocked = false
  }

  private evict(request: Request): void {
    this.remove(request)
    // 淘汰只释放预取消费者；仍在阅读这一页的前台继续持有共享请求。
    for (const cancel of request.cancelPrefetch) cancel()
  }

  private reset(buffer: Buffer): void {
    for (const request of buffer.requests.values()) this.evict(request)
    buffer.budgetBlocked = false
  }

  track(sessionId: string, generation: number, items: HistoryEntry[], background = false): boolean {
    if (background && this.evictedViews.has(items)) return false
    if (!background) this.evictedViews.delete(items)
    const buffer = this.buffer(sessionId, generation)
    if (!background) buffer.budgetBlocked = false
    buffer.visibleAnchor = items[0]
    buffer.visibleItems = items
    return true
  }

  prune(getItems: (sessionId: string) => HistoryEntry[] | undefined): void {
    for (const [key, buffer] of this.buffers) {
      if (!buffer.visibleAnchor) continue
      const items = getItems(buffer.sessionId)
      if (items === buffer.visibleItems) continue
      if (!items?.includes(buffer.visibleAnchor)) {
        this.buffers.delete(key)
        this.reset(buffer)
      } else {
        buffer.visibleItems = items
      }
    }
  }

  has(sessionId: string, generation: number, anchor: HistoryEntry): boolean {
    const buffer = this.buffer(sessionId, generation)
    const existing = buffer.requests.get(anchor.id)
    if (existing && existing.anchor !== anchor) {
      // 原生条目被替换意味着浏览/刷新换了历史，旧的预取链不可继续占用预算。
      this.reset(buffer)
      return false
    }
    return existing?.anchor === anchor
  }

  canPrefetch(sessionId: string, generation: number): boolean {
    const buffer = this.buffer(sessionId, generation)
    return !buffer.budgetBlocked && buffer.requests.size < HISTORY_PREFETCH_MAX_PAGES && buffer.bytes < MAX_PREFETCH_BYTES
  }

  private request(
    sessionId: string,
    generation: number,
    anchor: HistoryEntry,
    read: (signal: AbortSignal) => Promise<PiBranchPage>,
  ): Request {
    const buffer = this.buffer(sessionId, generation)
    const key = anchor.id
    const existing = buffer.requests.get(key)
    if (existing?.anchor === anchor) return existing
    if (existing) this.reset(buffer)

    const flightKey = JSON.stringify([generation, sessionId, key])
    for (const flight of this.flights) {
      if (flight.flightKey !== flightKey || flight.anchor !== anchor) continue
      flight.buffer = buffer
      buffer.requests.set(key, flight)
      buffer.bytes += flight.bytes
      if (buffer.bytes > MAX_PREFETCH_BYTES) {
        this.remove(flight)
        buffer.budgetBlocked = true
      }
      while (buffer.requests.size > HISTORY_PREFETCH_MAX_PAGES) {
        this.evict(buffer.requests.values().next().value!)
      }
      return flight
    }
    const controller = new AbortController()
    const request: Request = {
      anchor, buffer, flightKey, controller, users: 0, settled: false, cancelPrefetch: new Set(), bytes: 0,
      page: (async () => read(controller.signal))(),
    }
    request.page = request.page.then(page => {
      request.settled = true
      controller.signal.throwIfAborted()
      const currentBuffer = request.buffer
      if (currentBuffer.requests.get(key) === request) {
        const bytes = encoder.encode(JSON.stringify(page)).byteLength
        if (currentBuffer.bytes + bytes > MAX_PREFETCH_BYTES) {
          this.remove(request)
          currentBuffer.budgetBlocked = true
        } else {
          request.bytes = bytes
          currentBuffer.bytes += bytes
        }
      }
      return page
    }).catch(error => {
      request.settled = true
      this.remove(request)
      throw error
    }).finally(() => {
      this.flights.delete(request)
    })
    buffer.requests.set(key, request)
    this.flights.add(request)
    while (buffer.requests.size > HISTORY_PREFETCH_MAX_PAGES) {
      this.evict(buffer.requests.values().next().value!)
    }
    return request
  }

  private consume(request: Request, take: boolean, signal?: AbortSignal): Promise<PiBranchPage> {
    request.users++
    const { promise, resolve, reject } = Promise.withResolvers<PiBranchPage>()
    let settled = false
    const finish = () => {
      if (settled) return false
      settled = true
      signal?.removeEventListener('abort', onAbort)
      request.controller.signal.removeEventListener('abort', onRequestAbort)
      request.cancelPrefetch.delete(onEvict)
      if (--request.users === 0 && !request.settled) {
        this.remove(request)
        this.flights.delete(request)
        request.controller.abort()
      }
      return true
    }
    const onAbort = () => { if (finish()) reject(signal?.reason) }
    const onRequestAbort = () => { if (finish()) reject(request.controller.signal.reason) }
    const onEvict = () => {
      if (finish()) reject(new DOMException('History prefetch evicted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    request.controller.signal.addEventListener('abort', onRequestAbort, { once: true })
    if (!take) request.cancelPrefetch.add(onEvict)
    request.page.then(
      page => {
        if (!finish()) return
        if (take) this.remove(request)
        resolve(page)
      },
      error => { if (finish()) reject(error) },
    )
    if (signal?.aborted) onAbort()
    else if (request.controller.signal.aborted) onRequestAbort()
    return promise
  }

  async prefetch(
    sessionId: string,
    generation: number,
    anchor: HistoryEntry,
    read: (signal: AbortSignal) => Promise<PiBranchPage>,
    signal?: AbortSignal,
  ): Promise<PiBranchPage> {
    signal?.throwIfAborted()
    return this.consume(this.request(sessionId, generation, anchor, read), false, signal)
  }

  async take(
    sessionId: string,
    generation: number,
    anchor: HistoryEntry,
    read: (signal: AbortSignal) => Promise<PiBranchPage>,
    signal?: AbortSignal,
  ): Promise<PiBranchPage> {
    signal?.throwIfAborted()
    return this.consume(this.request(sessionId, generation, anchor, read), true, signal)
  }

  clear(): void {
    this.evictedViews = new WeakSet()
    for (const request of this.flights.values()) request.controller.abort()
    this.flights.clear()
    for (const buffer of this.buffers.values()) this.reset(buffer)
    this.buffers.clear()
  }
}

export const historyPagePrefetch = new HistoryPagePrefetch()
