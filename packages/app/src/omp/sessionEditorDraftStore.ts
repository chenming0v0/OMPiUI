import { useSyncExternalStore } from "react"
import type { Attachment } from "../features/attachment"

interface SessionEditorDraft {
  text: string
  attachments?: Attachment[]
  revision: number
}

const drafts = new Map<string, SessionEditorDraft>()
const listeners = new Set<() => void>()
const syncTimers = new Map<string, ReturnType<typeof setTimeout>>()
let syncDraft: ((sessionId: string, text: string) => void | Promise<void>) | undefined
const synchronizers = new Map<symbol, NonNullable<typeof syncDraft>>()
let revision = 0

function emit() {
  for (const listener of listeners) listener()
}

export function setSessionEditorDraft(
  sessionId: string,
  text: string,
  options: { sync?: boolean; attachments?: Attachment[] } = {},
) {
  drafts.set(sessionId, { text, attachments: options.attachments, revision: ++revision })
  emit()
  if (options.sync === false) {
    clearTimeout(syncTimers.get(sessionId))
    syncTimers.delete(sessionId)
    return
  }
  syncSessionEditorDraft(sessionId, text)
}

/** 普通输入只调度同步，不触发 InputBox 的撤销恢复与附件替换。 */
export function syncSessionEditorDraft(sessionId: string, text: string): void {
  clearTimeout(syncTimers.get(sessionId))
  syncTimers.delete(sessionId)
  if (!syncDraft) return
  syncTimers.set(sessionId, setTimeout(() => {
    syncTimers.delete(sessionId)
    void syncDraft?.(sessionId, text)
  }, 500))
}

export function configureSessionEditorDraftSync(
  sync: ((sessionId: string, text: string) => void | Promise<void>) | undefined,
): () => void {
  if (sync) {
    const owner = Symbol()
    synchronizers.set(owner, sync)
    syncDraft = sync
    return () => {
      synchronizers.delete(owner)
      syncDraft = [...synchronizers.values()].at(-1)
      if (!syncDraft) {
        for (const timer of syncTimers.values()) clearTimeout(timer)
        syncTimers.clear()
      }
    }
  }
  synchronizers.clear()
  syncDraft = undefined
  for (const timer of syncTimers.values()) clearTimeout(timer)
  syncTimers.clear()
  return () => {}
}

export function clearSessionEditorDraft(sessionId: string) {
  clearTimeout(syncTimers.get(sessionId))
  syncTimers.delete(sessionId)
  if (!drafts.delete(sessionId)) return
  emit()
}

export function useSessionEditorDraft(sessionId: string | null): SessionEditorDraft | null {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (sessionId ? drafts.get(sessionId) ?? null : null),
    () => null,
  )
}
