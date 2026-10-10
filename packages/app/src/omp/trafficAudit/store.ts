import { redactTrafficUrl } from './privacy'

export const TRAFFIC_RECORD_LIMIT = 2000
export type TrafficProtocol = 'http' | 'ws'
export type TrafficDirection = 'exchange' | 'sent' | 'received' | 'connection'
export type TrafficStatus = 'pending' | 'headers' | 'complete' | 'error' | 'aborted' | 'open' | 'closed'

export interface TrafficRecord {
  id: number
  timestamp: number
  server: string
  url: string
  path: string
  protocol: TrafficProtocol
  direction: TrafficDirection
  operation: string
  status: TrafficStatus
  sentBytes: number | null
  receivedBytes: number | null
  attempt?: number
  statusCode?: number
  headersMs?: number
  durationMs?: number
  connectionId?: number
  sessionId?: string
  contentType?: string
  contentEncoding?: string
  declaredBytes?: number
  error?: string
  requestPreview?: string
  responsePreview?: string
}

export interface TrafficTotals {
  sentBytes: number
  receivedBytes: number
  httpRequests: number
  wsMessages: number
  connections: number
  errors: number
}

export interface TrafficSnapshot {
  enabled: boolean
  previews: boolean
  startedAt: number
  dropped: number
  records: readonly TrafficRecord[]
  totals: Readonly<Record<string, TrafficTotals>>
}

export interface TrafficHandle {
  record: TrafficRecord
  generation: number
  preview: boolean
  previewGeneration: number
}

export function emptyTrafficTotals(): TrafficTotals {
  return { sentBytes: 0, receivedBytes: 0, httpRequests: 0, wsMessages: 0, connections: 0, errors: 0 }
}

export class TrafficAuditStore {
  private enabled = true
  private previews = false
  private previewGeneration = 0
  private startedAt = Date.now()
  private dropped = 0
  private nextId = 1
  private generation = 0
  private records = new Map<number, TrafficRecord>()
  private totals: Record<string, TrafficTotals> = {}
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private snapshot: TrafficSnapshot | undefined

  private readonly limit: number

  constructor(limit = TRAFFIC_RECORD_LIMIT) {
    this.limit = limit
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getSnapshot = (): TrafficSnapshot => {
    this.snapshot ??= {
      enabled: this.enabled,
      previews: this.previews,
      startedAt: this.startedAt,
      dropped: this.dropped,
      records: [...this.records.values()].reverse(),
      totals: Object.fromEntries(Object.entries(this.totals).map(([key, value]) => [key, { ...value }])),
    }
    return this.snapshot
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size && this.timer) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
    }
  }

  private changed(immediate = false): void {
    this.snapshot = undefined
    if (!this.listeners.size) return
    if (immediate) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      for (const listener of this.listeners) listener()
    } else if (!this.timer) {
      // 流式事件只更新内存；设置页最多每半秒接收一次通知。
      this.timer = setTimeout(() => {
        this.timer = undefined
        for (const listener of this.listeners) listener()
      }, 500)
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.changed(true)
  }

  setPreviews(previews: boolean): void {
    this.previews = previews
    if (!previews) {
      this.previewGeneration++
      for (const [id, record] of this.records) {
        this.records.set(id, { ...record, requestPreview: undefined, responsePreview: undefined })
      }
    }
    this.changed(true)
  }

  clear(): void {
    this.generation++
    this.startedAt = Date.now()
    this.dropped = 0
    this.records.clear()
    this.totals = {}
    this.changed(true)
  }

  start(
    input: string,
    data: Pick<TrafficRecord, 'protocol' | 'direction' | 'operation' | 'status' | 'sentBytes' | 'receivedBytes'> &
      Partial<Pick<TrafficRecord, 'attempt' | 'connectionId'>>,
    serverUrl?: string,
  ): TrafficHandle | undefined {
    if (!this.enabled) return
    const endpoint = redactTrafficUrl(input)
    const server = serverUrl ? redactTrafficUrl(serverUrl).server : endpoint.server
    const record: TrafficRecord = { ...endpoint, ...data, server, id: this.nextId++, timestamp: Date.now() }
    this.records.set(record.id, record)
    if (this.records.size > this.limit) {
      this.records.delete(this.records.keys().next().value!)
      this.dropped++
    }
    const total = (this.totals[server] ??= emptyTrafficTotals())
    total.sentBytes += record.sentBytes ?? 0
    total.receivedBytes += record.receivedBytes ?? 0
    if (record.protocol === 'http') total.httpRequests++
    else if (record.direction === 'connection') total.connections++
    else total.wsMessages++
    this.changed()
    return { record, generation: this.generation, preview: this.previews, previewGeneration: this.previewGeneration }
  }

  update(handle: TrafficHandle | undefined, patch: Partial<TrafficRecord>): void {
    if (!handle || handle.generation !== this.generation) return
    const previous = this.records.get(handle.record.id) ?? handle.record
    const next = { ...previous, ...patch }
    if (!this.previews) {
      next.requestPreview = undefined
      next.responsePreview = undefined
    }
    handle.record = next
    const total = this.totals[next.server]
    total.sentBytes += (next.sentBytes ?? 0) - (previous.sentBytes ?? 0)
    total.receivedBytes += (next.receivedBytes ?? 0) - (previous.receivedBytes ?? 0)
    if (
      (next.status === 'error' || next.status === 'aborted') &&
      previous.status !== 'error' &&
      previous.status !== 'aborted'
    )
      total.errors++
    if (this.records.has(next.id)) this.records.set(next.id, next)
    this.changed()
  }

  canPreview(handle: TrafficHandle | undefined): boolean {
    return (
      !!handle?.preview &&
      this.previews &&
      handle.generation === this.generation &&
      handle.previewGeneration === this.previewGeneration
    )
  }
}

export const trafficAuditStore = new TrafficAuditStore()
