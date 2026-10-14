import { isJsonObject, jsonByteSize, type EventEnvelope } from "@ompiui/protocol"
import { MAX_WATCHED_WORKSPACES } from "./host/workspace-watcher.ts"
import { workspacePathKey } from "./host/workspace-store.ts"

type PendingEvent = { event: EventEnvelope; bytes: number }
type PendingWorkspace = { files?: PendingEvent; git?: PendingEvent }

/** One IPC write in flight; a stalled parent retains at most two invalidations per watched root. */
export class WorkspaceWatchSender {
  private readonly watched = new Set<string>()
  private readonly pending = new Map<string, PendingWorkspace>()
  private pendingBytes = 0
  private sending = false
  private closed = false
  private readonly maxWorkspaces: number
  private readonly maxMessageBytes: number
  private readonly maxPendingBytes: number

  constructor(
    private readonly transmit: (event: EventEnvelope, done: (error?: Error) => void) => void,
    private readonly onError: (error: Error) => void,
    limits: { maxWorkspaces?: number; maxMessageBytes?: number; maxPendingBytes?: number } = {},
  ) {
    this.maxWorkspaces = limits.maxWorkspaces ?? MAX_WATCHED_WORKSPACES
    this.maxMessageBytes = limits.maxMessageBytes ?? 128 * 1024
    this.maxPendingBytes = limits.maxPendingBytes ?? 512 * 1024
  }

  watch(root: string): boolean {
    if (this.closed) return false
    const key = workspacePathKey(root)
    if (this.watched.has(key)) return true
    if (this.watched.size >= this.maxWorkspaces) {
      this.fail(new Error("workspace watcher IPC root capacity exceeded"))
      return false
    }
    this.watched.add(key)
    return true
  }

  unwatch(root: string): void {
    const key = workspacePathKey(root)
    this.watched.delete(key)
    const pending = this.pending.get(key)
    if (!pending) return
    this.pendingBytes -= (pending.files?.bytes ?? 0) + (pending.git?.bytes ?? 0)
    this.pending.delete(key)
  }

  send(event: EventEnvelope): void {
    if (this.closed || !this.watched.has(workspacePathKey(event.stream.id))) return
    if (event.channel !== "workspace.files" && event.channel !== "workspace.git") return
    const key = workspacePathKey(event.stream.id)
    const pending = this.pending.get(key) ?? {}
    const field = event.channel === "workspace.files" ? "files" : "git"
    const previous = pending[field]
    if (previous) {
      this.pendingBytes -= previous.bytes
      pending[field] = undefined
    }
    // A second batch can include create/delete transitions that cannot be represented
    // by keeping only the last path update. A rescan preserves their final state.
    let item = field === "files" && previous ? this.rescan(event) : this.measure(event)
    if (item.bytes > this.maxMessageBytes && field === "files") item = this.rescan(event)
    if (this.pendingBytes + item.bytes > this.maxPendingBytes) {
      if (field === "files") item = this.rescan(event)
      this.compactPendingFiles()
    }
    if (item.bytes > this.maxMessageBytes || this.pendingBytes + item.bytes > this.maxPendingBytes) {
      // The parent republishes files+Git invalidations when this child exits. Never
      // silently discard a root whose minimum invalidation itself cannot fit.
      this.fail(new Error("workspace watcher IPC invalidation exceeds its byte budget"))
      return
    }
    pending[field] = item
    this.pendingBytes += item.bytes
    this.pending.set(key, pending)
    this.drain()
  }

  dispose(): void {
    this.closed = true
    this.watched.clear()
    this.pending.clear()
    this.pendingBytes = 0
  }

  private measure(event: EventEnvelope): PendingEvent {
    return { event, bytes: jsonByteSize(event, this.maxMessageBytes) }
  }

  private rescan(event: EventEnvelope): PendingEvent {
    // These payloads are created in-process by WorkspaceWatcher, not received from IPC.
    const payload = event.payload
    if (!isJsonObject(payload) || typeof payload.revision !== "number") throw new Error("invalid workspace watcher payload")
    return this.measure({
      ...event,
      payload: {
        workspacePath: event.stream.id,
        revision: payload.revision,
        changes: [],
        rescan: true,
      },
    })
  }

  private compactPendingFiles(): void {
    for (const pending of this.pending.values()) {
      if (!pending.files) continue
      const payload = pending.files.event.payload
      if (isJsonObject(payload) && payload.rescan === true) continue
      const compacted = this.rescan(pending.files.event)
      this.pendingBytes += compacted.bytes - pending.files.bytes
      pending.files = compacted
    }
  }

  private drain(): void {
    if (this.closed || this.sending) return
    const next = this.pending.entries().next().value
    if (!next) return
    const [key, pending] = next
    const item = pending.files ?? pending.git!
    if (pending.files) pending.files = undefined
    else pending.git = undefined
    this.pendingBytes -= item.bytes
    this.pending.delete(key)
    if (pending.files || pending.git) this.pending.set(key, pending)
    this.sending = true
    let completed = false
    const done = (error?: Error) => {
      if (completed) return
      completed = true
      this.sending = false
      if (this.closed) return
      if (error) this.fail(error)
      else this.drain()
    }
    try {
      this.transmit(item.event, done)
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private fail(error: Error): void {
    this.dispose()
    this.onError(error)
  }
}
