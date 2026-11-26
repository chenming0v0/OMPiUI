import {
  UI_HISTORY_PATH, isJsonObject,
  type CommandFeedbackEntry, type ExtensionDiagnosticEntry, type NotificationChange, type NotificationEntry, type UiHistoryScope,
} from '@ompiui/protocol'
import { getApiBase, piFetch } from './httpClient'
import { serverStore } from '../store/serverStore'
import { notificationStore } from '../store/notificationStore'
import { commandFeedbackStore } from './commandFeedbackStore'
import { extensionDiagnosticStore } from './extensionDiagnosticStore'

type Read = {
  controller: AbortController
  dirty: boolean
  added: Set<string>
}

const notifications = { kind: 'notifications' } as const
const diagnostics = { kind: 'diagnostics' } as const

function historyUrl(scope: UiHistoryScope): string {
  const query = new URLSearchParams({ kind: scope.kind })
  if (scope.kind === 'feedback') query.set('sessionId', scope.sessionId)
  return `${getApiBase()}${UI_HISTORY_PATH}?${query}`
}

function readKey(scope: UiHistoryScope): string {
  return scope.kind === 'feedback' ? `feedback:${scope.sessionId}` : scope.kind
}

// One flight per scope. An invalidation during a GET requests a trailing GET;
// an old response must not resurrect rows cleared while the read was in flight.
const reads = new Map<string, Read>()
const feedbackSessions = new Set<string>()

function refresh(scope: UiHistoryScope, addedId?: string): void {
  const key = readKey(scope)
  const current = reads.get(key)
  if (current) {
    current.dirty = true
    if (addedId && current.added.size < 50) current.added.add(addedId)
    return
  }
  const read: Read = { controller: new AbortController(), dirty: false, added: new Set(addedId ? [addedId] : []) }
  reads.set(key, read)
  const generation = serverStore.getActiveServerGeneration()
  void (async () => {
    do {
      read.dirty = false
      const response = await piFetch(historyUrl(scope), { signal: read.controller.signal })
      if (!response.ok) return
      const body: unknown = await response.json()
      if (reads.get(key) !== read || generation !== serverStore.getActiveServerGeneration()) return
      if (!read.dirty && isJsonObject(body) && Array.isArray(body.entries)) {
        if (scope.kind === 'notifications') notificationStore.replaceShared(body.entries as unknown as NotificationEntry[], read.added)
        else if (scope.kind === 'diagnostics') extensionDiagnosticStore.replaceShared(body.entries as unknown as ExtensionDiagnosticEntry[])
        else commandFeedbackStore.replaceShared(scope.sessionId, body.entries as unknown as CommandFeedbackEntry[])
      }
    } while (read.dirty)
  })().catch(() => {
    // The next subscription, resync or invalidation retries the read.
  }).finally(() => {
    if (reads.get(key) === read) reads.delete(key)
  })
}

async function change(scope: UiHistoryScope, body: NotificationChange): Promise<void> {
  const generation = serverStore.getActiveServerGeneration()
  const url = historyUrl(scope)
  try {
    const response = await piFetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (response.status === 404) return // Compatibility with older servers.
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (generation === serverStore.getActiveServerGeneration() && (scope.kind !== 'feedback' || feedbackSessions.has(scope.sessionId))) {
      refresh(scope)
    }
  } catch (error) {
    if (generation === serverStore.getActiveServerGeneration()) console.warn('Could not update shared UI history', error)
  }
}

export const uiHistory = {
  refreshServer() {
    refresh(notifications)
    refresh(diagnostics)
  },
  refreshFeedback(sessionId: string) {
    feedbackSessions.add(sessionId)
    refresh({ kind: 'feedback', sessionId })
  },
  receive(payload: unknown, sessionId: string | null, liveAfter: number) {
    if (!isJsonObject(payload)) return
    if (sessionId && payload.kind === 'feedback') this.refreshFeedback(sessionId)
    else if (!sessionId && payload.kind === 'diagnostics') refresh(diagnostics)
    else if (!sessionId && payload.kind === 'notifications') {
      // History is always restored. Historical replay never generates toasts.
      const now = serverStore.getActiveCalibratedNow() ?? Date.now()
      const live = typeof payload.timestamp === 'number' && payload.timestamp >= liveAfter && now - payload.timestamp <= 8000
      refresh(notifications, live && typeof payload.addedId === 'string' ? payload.addedId : undefined)
    }
  },
  forgetFeedback(sessionId: string) {
    feedbackSessions.delete(sessionId)
    const key = readKey({ kind: 'feedback', sessionId })
    reads.get(key)?.controller.abort()
    reads.delete(key)
    commandFeedbackStore.replaceShared(sessionId, [])
  },
  reset() {
    feedbackSessions.clear()
    for (const read of reads.values()) read.controller.abort()
    reads.clear()
    commandFeedbackStore.reset()
    extensionDiagnosticStore.reset()
  },
  changeNotifications(body: NotificationChange) {
    return change(notifications, body)
  },
  clearFeedback(sessionId: string) {
    commandFeedbackStore.remove(sessionId)
    return change({ kind: 'feedback', sessionId }, { action: 'clear' })
  },
  clearDiagnostics() {
    extensionDiagnosticStore.clearLocal()
    return change(diagnostics, { action: 'clear' })
  },
}

notificationStore.onSharedChange(uiHistory.changeNotifications)
