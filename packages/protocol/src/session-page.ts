import type { EventCursor } from "./envelope.js"
import type { JsonObject, JsonValue } from "./json.js"

export type SessionHead = {
  sdkVersion: string
  revision: number
  sessionFormatVersion?: number
  header: JsonObject | null
  leafId: string | null
  entryCount: number
  epoch: string
}

export type LiveMessage = {
  id: string
  revision: number
  phase: "streaming" | "persisting"
  message: JsonValue
}

export type BranchCheckpoint = {
  position: EventCursor
  liveMessage?: LiveMessage
}

export type EntriesPage = {
  head: SessionHead
  items: JsonObject[]
  checkpoint?: BranchCheckpoint
  beforeCursor?: string
  hasMore: boolean
  /** 运行时历史快照标识；只有持有该标识的客户端可以请求增量。 */
  syncCursor?: string
  /** 存在时 items 仅含相对该快照新增的条目。 */
  deltaFrom?: string
}

export type BranchSyncRequest = {
  syncCursor?: string
  /** 客户端已加载历史的最早条目，用于刷新向前分页游标。 */
  beforeId?: string
}

/**
 * Global session activity status (sessions.activity channel, server stream).
 * Full snapshot on every change: sessions present are active; absent = idle.
 */
export type SessionActivityStatus =
  | { type: "busy" }
  | { type: "compacting" }
  | { type: "retry"; attempt: number; message: string; next: number }

export type SessionsActivitySnapshot = {
  sessions: Record<string, SessionActivityStatus>
}
