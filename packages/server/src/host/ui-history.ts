import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  isJsonObject, jsonByteSize, utf8Prefix,
  type CommandFeedbackEntry, type ExtensionDiagnosticEntry, type JsonObject,
  type NotificationChange, type NotificationEntry, type NotificationType, type UiHistoryScope,
} from '@ompiui/protocol'
import type { EventHub } from '../event-hub.ts'

const NOTIFICATION_LIMIT = 50
const FEEDBACK_LIMIT = 100
// Full output is retained separately from the short notification preview and
// from the WS replay window. Per-scope and aggregate byte limits bound memory.
const SCOPE_BYTES = 8 * 1024 * 1024
const TOTAL_FEEDBACK_BYTES = 32 * 1024 * 1024
const MAX_FEEDBACK_SESSIONS = 256
const SERVER_STREAM = { kind: 'server', id: 'server' } as const

function invalid(): never {
  throw Object.assign(new Error('Invalid UI history request'), { code: 'INVALID_REQUEST' })
}

function notificationType(value: unknown): value is NotificationType {
  return value === 'permission' || value === 'question' || value === 'completed' ||
    value === 'error' || value === 'warning' || value === 'info'
}

export function historyScope(kind: unknown, sessionId: unknown): UiHistoryScope {
  if (kind === 'notifications' || kind === 'diagnostics') return { kind }
  if (kind === 'feedback' && typeof sessionId === 'string' && sessionId && sessionId.length <= 256) {
    return { kind, sessionId }
  }
  return invalid()
}

function notificationChange(input: JsonObject): NotificationChange {
  switch (input.action) {
    case 'clear':
    case 'markAllRead': return { action: input.action }
    case 'markRead':
    case 'dismiss':
      if (typeof input.id === 'string') return { action: input.action, id: input.id }
      break
    case 'markSessionRead':
      if (typeof input.sessionId === 'string' && (input.type === undefined || notificationType(input.type))) {
        return { action: input.action, sessionId: input.sessionId, type: input.type }
      }
  }
  return invalid()
}

type FeedbackInput = Omit<CommandFeedbackEntry, 'id' | 'at'>
type NotificationInput = Omit<NotificationEntry, 'read'>

class FeedbackLog<T> {
  readonly rows: { entry: T; bytes: number }[] = []
  bytes = 0

  append(entry: T): boolean {
    const bytes = jsonByteSize(entry, SCOPE_BYTES)
    if (bytes > SCOPE_BYTES) return false
    this.rows.push({ entry, bytes })
    this.bytes += bytes
    while (this.rows.length > FEEDBACK_LIMIT || this.bytes > SCOPE_BYTES) this.bytes -= this.rows.shift()!.bytes
    return true
  }

  snapshot(): T[] {
    return this.rows.map(row => row.entry).reverse()
  }
}

/** Each AppServer authenticates a single host identity (shared by paired clients).
 * Only notification history is persisted; feedback/diagnostics retain their
 * process lifetime and never go into the operational diagnostics logs. */
export class UiHistory {
  private notifications: NotificationEntry[] = []
  private readonly feedback = new Map<string, FeedbackLog<CommandFeedbackEntry>>()
  private diagnostics = new FeedbackLog<ExtensionDiagnosticEntry>()
  private feedbackBytes = 0
  // Remember recently accepted worker frames even when their rows were cleared.
  private readonly seen = new Map<string, true>()

  constructor(private readonly hub: EventHub, private readonly notificationsFile?: string) {
    if (!notificationsFile || !existsSync(notificationsFile)) return
    try {
      const saved: unknown = JSON.parse(readFileSync(notificationsFile, 'utf8'))
      if (Array.isArray(saved)) this.notifications = saved.slice(0, NOTIFICATION_LIMIT)
    } catch {
      // Older/corrupt notification data must not prevent the backend from starting.
    }
  }

  read(scope: { kind: 'notifications' }): NotificationEntry[]
  read(scope: { kind: 'diagnostics' }): ExtensionDiagnosticEntry[]
  read(scope: { kind: 'feedback'; sessionId: string }): CommandFeedbackEntry[]
  read(scope: UiHistoryScope): NotificationEntry[] | ExtensionDiagnosticEntry[] | CommandFeedbackEntry[]
  read(scope: UiHistoryScope) {
    if (scope.kind === 'notifications') return this.notifications
    if (scope.kind === 'diagnostics') return this.diagnostics.snapshot()
    return this.feedback.get(scope.sessionId)?.snapshot() ?? []
  }

  change(scope: UiHistoryScope, input: unknown): void {
    if (!isJsonObject(input)) return invalid()
    if (scope.kind === 'notifications') {
      const change = notificationChange(input)
      const current = this.notifications
      let next: NotificationEntry[]
      switch (change.action) {
        case 'clear': next = []; break
        case 'dismiss': next = current.filter(row => row.id !== change.id); break
        default: next = current.map(row => {
          const matches = change.action === 'markAllRead' ||
            (change.action === 'markRead' && row.id === change.id) ||
            (change.action === 'markSessionRead' && row.sessionId === change.sessionId && (!change.type || row.type === change.type))
          return matches && !row.read ? { ...row, read: true } : row
        })
      }
      if (next.length !== current.length || next.some((row, index) => row !== current[index])) {
        this.persistNotifications(next)
        this.notifications = next
        this.invalidate(scope)
      }
      return
    }
    if (input.action !== 'clear') return invalid()
    if (scope.kind === 'feedback') {
      if (!this.removeFeedback(scope.sessionId)) return
    } else {
      if (!this.diagnostics.rows.length) return
      this.diagnostics = new FeedbackLog()
    }
    this.invalidate(scope)
  }

  complete(sessionId: string, directory: string, id: string): void {
    if (!this.accept(`completion:${id}`)) return
    this.addNotification({ id: `completed:${id}`, type: 'completed', title: sessionId.slice(0, 12), body: '', sessionId, directory, timestamp: Date.now() })
  }

  command(sessionId: string, directory: string, event: JsonObject, eventId: string | (() => string)): void {
    const feedback = nativeFeedback(sessionId, event)
    if (!feedback) return
    const id = typeof eventId === 'function' ? eventId() : eventId
    if (this.accept(`feedback:${id}`)) this.addFeedback(feedback, directory, id)
  }

  extensionNotify(sessionId: string, directory: string, event: JsonObject): void {
    if (event.type !== 'notify' || typeof event.message !== 'string') return
    const status = event.notifyType === 'error' ? 'error' : event.notifyType === 'warning' ? 'warning' : 'info'
    this.addFeedback({ sessionId, command: '', kind: 'notify', source: 'Extension', status, message: event.message }, directory, randomUUID())
  }

  extensionError(workerGeneration: string, runtimeId: string, frame: JsonObject): void {
    if (frame.type !== 'extension_error' || typeof frame.error !== 'string') return
    if (this.diagnostics.append({
      id: randomUUID(), at: Date.now(), workerGeneration, runtimeId,
      command: '', kind: 'notify', status: 'error', message: frame.error,
      source: typeof frame.extensionPath === 'string' ? frame.extensionPath : 'OMP runtime',
      originalType: frame.type, context: typeof frame.event === 'string' ? `event: ${frame.event}` : undefined,
    })) this.invalidate({ kind: 'diagnostics' })
  }

  removeFeedback(sessionId: string): boolean {
    const log = this.feedback.get(sessionId)
    if (!log) return false
    this.feedbackBytes -= log.bytes
    return this.feedback.delete(sessionId)
  }

  private accept(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.set(id, true)
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!)
    return true
  }

  private addFeedback(input: FeedbackInput, directory: string, id: string): void {
    const entry: CommandFeedbackEntry = { ...input, id, at: Date.now() }
    const log = this.feedback.get(input.sessionId) ?? new FeedbackLog<CommandFeedbackEntry>()
    const previous = log.bytes
    if (log.append(entry)) {
      this.feedbackBytes += log.bytes - previous
      this.feedback.delete(input.sessionId)
      this.feedback.set(input.sessionId, log)
      while (this.feedback.size > MAX_FEEDBACK_SESSIONS || this.feedbackBytes > TOTAL_FEEDBACK_BYTES) {
        const sessionId = this.feedback.keys().next().value!
        this.removeFeedback(sessionId)
        this.invalidate({ kind: 'feedback', sessionId })
      }
      this.invalidate({ kind: 'feedback', sessionId: input.sessionId })
    }
    this.addNotification({
      id: `feedback:${id}`, type: entry.status === 'ok' ? 'completed' : entry.status,
      title: utf8Prefix(entry.source ?? 'Native command', 256), body: utf8Prefix(entry.message, 2048),
      sessionId: entry.sessionId, directory, timestamp: entry.at, target: 'extensions',
    })
  }

  private addNotification(input: NotificationInput): void {
    if (this.notifications.some(row => row.id === input.id)) return
    const entry = { ...input, directory: input.directory && utf8Prefix(input.directory, 8192), read: false }
    const next = [entry, ...this.notifications].slice(0, NOTIFICATION_LIMIT)
    try {
      this.persistNotifications(next)
    } catch {
      // A disk failure must not suppress the originating worker event.
    }
    this.notifications = next
    this.invalidate({ kind: 'notifications' }, entry.id)
  }

  private persistNotifications(next: NotificationEntry[]): void {
    if (this.notificationsFile) {
      mkdirSync(dirname(this.notificationsFile), { recursive: true, mode: 0o700 })
      const temporary = `${this.notificationsFile}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
        renameSync(temporary, this.notificationsFile)
      } finally {
        rmSync(temporary, { force: true })
      }
    }
  }

  private invalidate(scope: UiHistoryScope, addedId?: string): void {
    this.hub.publish(scope.kind === 'feedback' ? { kind: 'session', id: scope.sessionId } : SERVER_STREAM,
      'ui.history', { kind: scope.kind, ...(addedId ? { addedId, timestamp: Date.now() } : {}) })
  }
}

function nativeFeedback(sessionId: string, event: JsonObject): FeedbackInput | null {
  const source = typeof event.source === 'string' ? event.source : 'Native command'
  const base = { sessionId, command: '', kind: 'command' as const, source }
  if (event.type === 'command_output' && typeof event.text === 'string') {
    return { ...base, message: event.text, status: event.isError === true || event.level === 'error' || event.status === 'error'
      ? 'error' : event.level === 'warning' ? 'warning' : 'info' }
  }
  if (event.type === 'extension_error' && event.event === 'command' && typeof event.extensionPath === 'string' &&
      event.extensionPath.startsWith('command:') && typeof event.error === 'string') {
    return { ...base, source: event.extensionPath, command: event.extensionPath.slice('command:'.length), status: 'error', message: event.error }
  }
  if (event.type === 'prompt_result' && event.agentInvoked === false && (event.status === 'error' || event.status === 'aborted')) {
    const error = event.error
    const message = typeof error === 'string' ? error : isJsonObject(error) && typeof error.message === 'string'
      ? error.message : event.status === 'aborted' ? 'Command aborted.' : 'Native command failed.'
    return { ...base, message, status: event.status === 'error' ? 'error' : 'info' }
  }
  if (event.type === 'notice' || event.type === 'rpc_frame_error' || event.type === 'rpc_stream_error') {
    const message = event.type !== 'notice' && typeof event.error === 'string' ? event.error :
      typeof event.text === 'string' ? event.text : typeof event.message === 'string' ? event.message : typeof event.error === 'string' ? event.error : ''
    return {
      ...base, kind: 'notify', message, source: typeof event.source === 'string' ? event.source : 'OMP runtime',
      status: event.level === 'error' || event.type !== 'notice' ? 'error' : event.level === 'warning' ? 'warning' : 'info',
      originalType: typeof event.originalType === 'string' ? event.originalType : undefined,
      context: typeof event.text === 'string' && event.text !== message ? event.text : undefined,
    }
  }
  return null
}
