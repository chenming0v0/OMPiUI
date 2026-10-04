import { useSyncExternalStore } from 'react'
import { useMemo } from 'react'
import { piSessionInfoStore, piBranchStore, piSessionStateStore, piModelsStore } from '../state/index.js'
import { paneLayoutStore } from '../../store/paneLayoutStore'
import { readTodoItems, type TodoItem } from '../domain/todo'

/**
 * React bindings for Pi stores.
 * Session-scoped hooks take sessionId (null yields empty snapshots),
 * keeping multi-pane renders isolated per session.
 */

/** Focused pane's session id (the app-wide "current session"). */
export function useFocusedSessionId(): string | null {
  return useSyncExternalStore(
    paneLayoutStore.subscribe,
    () => paneLayoutStore.getFocusedSessionId(),
    () => paneLayoutStore.getFocusedSessionId(),
  )
}

/** Whether the focused session has any timeline entries. */
export function useFocusedSessionHasEntries(): boolean {
  const sessionId = useFocusedSessionId()
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => (sessionId ? (piBranchStore.getData(sessionId)?.items.length ?? 0) > 0 : false),
    () => false,
  )
}

/**
 * Latest committed todo snapshot in the branch. Native OMP stores named phases;
 * historical TodoWrite entries store a flat todos array.
 */
export function usePiSessionTodos(sessionId: string | null): TodoItem[] {
  const branch = usePiBranchData(sessionId)
  return useMemo(() => {
    const items = branch?.items ?? []
    let latest: TodoItem[] = []
    for (const entry of items) {
      if (entry.type === 'custom' && entry.customType === 'user_todo_edit') {
        latest = readTodoItems(entry.data) ?? latest
        continue
      }
      if (entry.type !== 'message') continue
      const message = entry.message
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'toolCall' && block.name.toLowerCase().includes('todo') && Array.isArray(block.arguments.todos)) {
            const todos = readTodoItems(block.arguments)
            if (todos !== undefined) latest = todos
          }
        }
      } else if (message.role === 'toolResult' && message.toolName.toLowerCase().includes('todo')) {
        if (message.isError || message.details?.op === 'view') continue
        const todos = readTodoItems(message.details)
        if (todos !== undefined) latest = todos
      }
    }
    return latest
  }, [branch])
}

export function usePiSessionInfos() {
  return useSyncExternalStore(
    piSessionInfoStore.subscribe,
    () => piSessionInfoStore.getAll(),
    () => piSessionInfoStore.getAll(),
  )
}

export function usePiBranchData(sessionId: string | null) {
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => (sessionId ? piBranchStore.getData(sessionId) : null),
    () => (sessionId ? piBranchStore.getData(sessionId) : null),
  )
}

export function usePiBranchLoading(sessionId: string | null) {
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => (sessionId ? piBranchStore.isLoading(sessionId) : false),
    () => (sessionId ? piBranchStore.isLoading(sessionId) : false),
  )
}

export function usePiBranchError(sessionId: string | null) {
  return useSyncExternalStore(
    piBranchStore.subscribe,
    () => (sessionId ? piBranchStore.getError(sessionId) : null),
    () => (sessionId ? piBranchStore.getError(sessionId) : null),
  )
}

export function usePiSessionRuntimeState(sessionId: string | null) {
  return useSyncExternalStore(
    piSessionStateStore.subscribe,
    () => (sessionId ? piSessionStateStore.getState(sessionId) : null),
    () => (sessionId ? piSessionStateStore.getState(sessionId) : null),
  )
}

export function usePiModels() {
  const models = useSyncExternalStore(
    piModelsStore.subscribe,
    () => piModelsStore.getModels(),
    () => piModelsStore.getModels(),
  )
  const isLoading = useSyncExternalStore(
    piModelsStore.subscribe,
    () => piModelsStore.isLoading(),
    () => piModelsStore.isLoading(),
  )
  return { models, isLoading }
}

/**
 * Session display title, same chain as the session list:
 * runtime sessionName -> SessionInfo.name -> firstMessage.
 */
export function usePiSessionTitle(sessionId: string | null): string | null {
  const state = usePiSessionRuntimeState(sessionId)
  const sessionInfos = usePiSessionInfos()
  return useMemo(() => {
    if (!sessionId) return null
    const stateName = typeof state?.sessionName === 'string' && state.sessionName.trim() ? state.sessionName.trim() : null
    if (stateName) return stateName
    const info = sessionInfos.find(item => item.id === sessionId)
    return info?.name?.trim() || info?.firstMessage?.trim() || null
  }, [sessionId, state?.sessionName, sessionInfos])
}
