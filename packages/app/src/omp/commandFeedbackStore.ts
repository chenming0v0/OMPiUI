/**
 * Command feedback log — a per-session record of command output and notices.
 * Notifications are transient and truncated; this store keeps the full message
 * for the lifetime of the client session so the extension panel can show detail.
 */

export type CommandFeedbackStatus = 'ok' | 'error' | 'warning' | 'info'

export interface CommandFeedbackEntry {
  id: string
  sessionId: string
  /** Command name without the leading slash. Empty when the native event has no command name. */
  command: string
  args?: string
  /** Display origin, separate from the unmodified output text. */
  source?: string
  status: CommandFeedbackStatus
  message: string
  /** 'command' = native command feedback; 'notify' = extension/runtime notices. */
  kind?: 'command' | 'notify'
  at: number
}

interface CommandFeedbackSnapshot {
  sessions: Readonly<Record<string, ReadonlyArray<CommandFeedbackEntry>>>
}

const MAX_ENTRIES_PER_SESSION = 100

let current: CommandFeedbackSnapshot = { sessions: {} }
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export const commandFeedbackStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  getSnapshot(): CommandFeedbackSnapshot {
    return current
  },

  add(entry: Omit<CommandFeedbackEntry, 'id' | 'at' | 'kind'> & { kind?: 'command' | 'notify' }): CommandFeedbackEntry {
    const full: CommandFeedbackEntry = {
      ...entry,
      kind: entry.kind ?? 'command',
      id: globalThis.crypto?.randomUUID?.() ?? `${entry.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      at: Date.now(),
    }
    const session = current.sessions[entry.sessionId] ?? []
    const nextSession = [full, ...session].slice(0, MAX_ENTRIES_PER_SESSION)
    current = { sessions: { ...current.sessions, [entry.sessionId]: nextSession } }
    emit()
    return full
  },

  /** Acceptance alone is not a result. Only actual native output or failure creates feedback. */
  addNativeEvent(sessionId: string, event: Record<string, unknown>): CommandFeedbackEntry | null {
    const source = typeof event.source === 'string' ? event.source : 'Native command'
    if (event.type === 'extension_error' && event.event === 'command' && typeof event.extensionPath === 'string' && event.extensionPath.startsWith('command:') && typeof event.error === 'string') {
      return this.add({ sessionId, command: event.extensionPath.slice('command:'.length), source: event.extensionPath, status: 'error', message: event.error })
    }
    if (event.type === 'command_output' && typeof event.text === 'string') {
      return this.add({
        sessionId,
        command: '',
        source,
        status: event.isError === true || event.level === 'error' || event.status === 'error' ? 'error' : event.level === 'warning' ? 'warning' : 'info',
        message: event.text,
      })
    }
    // Agent failures already have their own message surface. Local command
    // failures can finish without any assistant message or command_output.
    if (event.type !== 'prompt_result' || event.agentInvoked !== false) return null
    if (event.status !== 'error' && event.status !== 'aborted') return null
    const error = event.error
    const message = typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : event.status === 'aborted' ? 'Command aborted.' : 'Native command failed.'
    return this.add({ sessionId, command: '', source, status: event.status === 'error' ? 'error' : 'info', message })
  },

  remove(sessionId: string): void {
    if (!(sessionId in current.sessions)) return
    const sessions = { ...current.sessions }
    delete sessions[sessionId]
    current = { sessions }
    emit()
  },

  reset(): void {
    current = { sessions: {} }
    emit()
  },
}
