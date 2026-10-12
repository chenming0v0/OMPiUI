import { randomUUID } from "node:crypto"
import {
  eventStreamKey,
  PROTOCOL_VERSION,
  type EventChannel,
  type EventCursor,
  type EventCursorMap,
  type EventEnvelope,
  type EventResyncReason,
  type EventStreamRef,
  type JsonValue,
} from "@ompiui/protocol"

type Listener = (event: EventEnvelope) => void
const MAX_STREAMS = 4096
// 仅被订阅/游标查询而从未发布过事件的流(幽灵流)的独立配额,上限远低于总容量
const MAX_PHANTOM_STREAMS = 1024

interface StreamState {
  stream: EventStreamRef
  epoch: string
  sequence: number
  history: EventEnvelope[]
  /** 从未由服务端发布过事件的流;订阅只能创建幽灵流 */
  phantom: boolean
}

export class EventHub {
  private readonly listeners = new Set<Listener>()
  private readonly streams = new Map<string, StreamState>()
  private readonly refs = new Map<string, number>()

  constructor(private readonly historyLimit = 256) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(stream: EventStreamRef, channel: EventChannel, payload: JsonValue): EventEnvelope {
    const state = this.getOrCreate(stream, false)
    state.sequence += 1
    const event: EventEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      stream,
      cursor: { epoch: state.epoch, sequence: state.sequence },
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      channel,
      payload,
    }
    state.history.push(event)
    if (state.history.length > this.historyLimit) {
      state.history.splice(0, state.history.length - this.historyLimit)
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* a failed subscriber must not break the others */
      }
    }
    return event
  }

  getCursor(stream: EventStreamRef): EventCursor {
    const state = this.getOrCreate(stream, true)
    return { epoch: state.epoch, sequence: state.sequence }
  }

  getCursorMap(streams: EventStreamRef[]): EventCursorMap {
    return Object.fromEntries(streams.map(stream => [eventStreamKey(stream), this.getCursor(stream)]))
  }

  replaySince(
    stream: EventStreamRef,
    cursor?: EventCursor,
  ): { events: EventEnvelope[]; resyncRequired: boolean; reason?: EventResyncReason } {
    const state = this.getOrCreate(stream, true)
    if (!cursor) return { events: [], resyncRequired: true, reason: "missing_cursor" }
    if (cursor.epoch !== state.epoch) return { events: [], resyncRequired: true, reason: "epoch_mismatch" }
    if (cursor.sequence > state.sequence) return { events: [], resyncRequired: true, reason: "future_cursor" }
    const oldest = state.history[0]?.cursor.sequence ?? state.sequence + 1
    if (cursor.sequence < oldest - 1) return { events: [], resyncRequired: true, reason: "history_expired" }
    return {
      events: state.history.filter(event => event.cursor.sequence > cursor.sequence),
      resyncRequired: false,
    }
  }

  resetEpoch(stream: EventStreamRef): void {
    const state = this.getOrCreate(stream, false)
    state.epoch = randomUUID()
    state.sequence = 0
    state.history.length = 0
  }

  /** 被至少一个连接订阅的流不参与淘汰(引用计数,连接断开或改订阅时释放) */
  retain(stream: EventStreamRef): void {
    const key = eventStreamKey(stream)
    this.refs.set(key, (this.refs.get(key) ?? 0) + 1)
  }

  release(stream: EventStreamRef): void {
    const key = eventStreamKey(stream)
    const count = (this.refs.get(key) ?? 0) - 1
    if (count > 0) this.refs.set(key, count)
    else this.refs.delete(key)
  }

  private getOrCreate(stream: EventStreamRef, observe: boolean): StreamState {
    const key = eventStreamKey(stream)
    const existing = this.streams.get(key)
    if (existing) {
      // Keep active streams recent so arbitrary client stream ids cannot pin
      // every historical stream in the process forever.
      this.streams.delete(key)
      this.streams.set(key, existing)
      if (!observe) existing.phantom = false
      return existing
    }
    if (observe) {
      // 观察型请求只能占用有限的幽灵槽位:超额时淘汰最旧的、无订阅者的幽灵流
      let phantoms = 0
      for (const state of this.streams.values()) if (state.phantom) phantoms += 1
      if (phantoms >= MAX_PHANTOM_STREAMS) this.evict(state => state.phantom)
    }
    if (this.streams.size >= MAX_STREAMS) {
      // 总容量满时优先淘汰无订阅者的幽灵流,其次最旧的无订阅者真实流;
      // 全部有订阅者时宁可超出上限也不切断他人的游标
      if (!this.evict(state => state.phantom)) this.evict(() => true)
    }
    const state: StreamState = { stream, epoch: randomUUID(), sequence: 0, history: [], phantom: observe }
    this.streams.set(key, state)
    return state
  }

  /** 按 Map 插入顺序(近似 LRU)淘汰第一个满足条件且无订阅者的流;返回是否淘汰成功 */
  private evict(match: (state: StreamState) => boolean): boolean {
    for (const [candidate, state] of this.streams) {
      if (!match(state) || (this.refs.get(candidate) ?? 0) > 0) continue
      this.streams.delete(candidate)
      return true
    }
    return false
  }
}
