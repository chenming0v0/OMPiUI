import { useSyncExternalStore } from 'react'
import { isToolInteractionDescriptor, type ToolInteractionDescriptor } from '@ompiui/protocol'
import { serverStore } from '../store/serverStore'

const descriptors = new Map<string, ToolInteractionDescriptor>()
const listeners = new Set<() => void>()
const key = (serverId: string, sessionId: string, toolCallId: string) => JSON.stringify([serverId, sessionId, toolCallId])
const notify = () => { for (const listener of listeners) listener() }

/** Live registration evidence only; completed history uses its preserved result details. */
export const toolInteractionStore = {
  set(toolCallId: string, sessionId: string, value: unknown, serverId = serverStore.getActiveServerId() ?? ''): void {
    if (!isToolInteractionDescriptor(value) || value.toolCallId !== toolCallId || value.sessionId !== sessionId) return
    const id = key(serverId, sessionId, toolCallId)
    descriptors.delete(id)
    descriptors.set(id, value)
    // A UI registration cache is not the runtime registry.
    while (descriptors.size > 128) descriptors.delete(descriptors.keys().next().value!)
    notify()
  },
  get(serverId: string, sessionId: string, toolCallId: string): ToolInteractionDescriptor | undefined {
    return descriptors.get(key(serverId, sessionId, toolCallId))
  },
  delete(toolCallId: string, sessionId: string, serverId = serverStore.getActiveServerId() ?? ''): void {
    if (descriptors.delete(key(serverId, sessionId, toolCallId))) notify()
  },
  clearSession(sessionId: string, serverId = serverStore.getActiveServerId() ?? ''): void {
    let changed = false
    for (const id of descriptors.keys()) {
      const [server, session] = JSON.parse(id) as string[]
      if (server === serverId && session === sessionId) { descriptors.delete(id); changed = true }
    }
    if (changed) notify()
  },
  clearAll(): void { descriptors.clear(); notify() },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
}

export function useToolInteractionDescriptor(serverId: string, sessionId: string | null | undefined, toolCallId: string) {
  return useSyncExternalStore(toolInteractionStore.subscribe, () => sessionId
    ? toolInteractionStore.get(serverId, sessionId, toolCallId) : undefined)
}
