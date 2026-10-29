import { isJsonObject } from '@ompiui/protocol'
import type { CommandFeedbackEntry } from './commandFeedbackStore'

export interface ExtensionDiagnosticEntry extends Omit<CommandFeedbackEntry, 'sessionId'> {
  workerGeneration: string
  runtimeId: string
}

const MAX_ENTRIES = 100
let sequence = 0
let current: ReadonlyArray<ExtensionDiagnosticEntry> = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Host diagnostics deliberately have no session identity or navigation target. */
export const extensionDiagnosticStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  getSnapshot(): ReadonlyArray<ExtensionDiagnosticEntry> {
    return current
  },

  addNativeEvent(payload: unknown): ExtensionDiagnosticEntry | null {
    if (!isJsonObject(payload) || typeof payload.workerGeneration !== 'string' || typeof payload.runtimeId !== 'string') return null
    const frame = payload.frame
    if (!isJsonObject(frame) || frame.type !== 'extension_error' || typeof frame.error !== 'string') return null
    const entry: ExtensionDiagnosticEntry = {
      id: globalThis.crypto?.randomUUID?.() ?? `extension-${Date.now()}-${++sequence}`, at: Date.now(),
      workerGeneration: payload.workerGeneration, runtimeId: payload.runtimeId,
      command: '', kind: 'notify', status: 'error', message: frame.error,
      source: typeof frame.extensionPath === 'string' ? frame.extensionPath : 'OMP runtime',
      originalType: frame.type,
      context: typeof frame.event === 'string' ? `event: ${frame.event}` : undefined,
    }
    current = [entry, ...current].slice(0, MAX_ENTRIES)
    emit()
    return entry
  },

  reset(): void {
    if (!current.length) return
    current = []
    emit()
  },
}
