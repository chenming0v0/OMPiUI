import { useSyncExternalStore } from 'react'
import type { JsonObject, ProviderAuthEvent } from '@ompiui/protocol'
import { isJsonObject } from '@ompiui/protocol'

/** packages.progress payload (worker-side emission is not wired yet). */
export type PackageProgress = JsonObject & { commandId: string }

export interface ProviderAuthFlowState {
  flowId: string
  providerId: string
  sessionId?: string
  event?: ProviderAuthEvent
  notifications: unknown[]
}

export interface ManagementEventSnapshot {
  flows: Record<string, ProviderAuthFlowState>
  packageProgress: Record<string, PackageProgress>
  resourceRevisions: Record<string, string>
  providerRevision: number
}

let snapshot: ManagementEventSnapshot = {
  flows: {},
  packageProgress: {},
  resourceRevisions: {},
  providerRevision: 0,
}

const listeners = new Set<() => void>()
const streamListeners = new Set<() => void>()
const providerIds = new Set<string>()
// Each recovery observes only flows not changed since that request began.
// Keep dismissals here too, so a late snapshot cannot resurrect a closed flow.
let authRecovery = new Set<string>()

export function beginProviderAuthRecovery(): Set<string> {
  authRecovery = new Set()
  return authRecovery
}

export function restoreProviderAuthFlows(raw: unknown, recovery: Set<string>): void {
  if (recovery !== authRecovery || !Array.isArray(raw)) return
  const flows = { ...snapshot.flows }
  const restoredProviders: string[] = []
  for (const item of raw) {
    if (!isJsonObject(item) || typeof item.flowId !== 'string' || typeof item.providerId !== 'string') continue
    if (recovery.has(item.flowId)) continue
    const event = item.event
    if (event != null && (!isJsonObject(event) || event.flowId !== item.flowId || event.providerId !== item.providerId)) continue
    if (event != null && !(event.type === 'notification' || (
      event.type === 'prompt' && typeof event.promptId === 'string' && isJsonObject(event.prompt)
    ))) continue
    flows[item.flowId] = {
      flowId: item.flowId,
      providerId: item.providerId,
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : undefined,
      event: event == null ? undefined : event as ProviderAuthEvent,
      notifications: Array.isArray(item.notifications) ? item.notifications : [],
    }
    restoredProviders.push(item.providerId)
  }
  emit({ ...snapshot, flows })
  trackManagementProviders(restoredProviders)
}

export function resetProviderAuthFlows(): void {
  beginProviderAuthRecovery()
  emit({ ...snapshot, flows: {} })
}

function emit(next: ManagementEventSnapshot) {
  snapshot = next
  listeners.forEach(listener => listener())
}

export function getManagementEventSnapshot(): ManagementEventSnapshot {
  return snapshot
}

export function subscribeManagementEvents(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useManagementEvents(): ManagementEventSnapshot {
  return useSyncExternalStore(subscribeManagementEvents, getManagementEventSnapshot, getManagementEventSnapshot)
}

export function trackManagementProviders(ids: Iterable<string>): void {
  let changed = false
  for (const id of ids) {
    if (!id || providerIds.has(id)) continue
    providerIds.add(id)
    changed = true
  }
  if (changed) streamListeners.forEach(listener => listener())
}

export function getTrackedManagementProviders(): string[] {
  return [...providerIds]
}

export function subscribeManagementStreams(listener: () => void): () => void {
  streamListeners.add(listener)
  return () => streamListeners.delete(listener)
}

export function registerProviderAuthFlow(flowId: string, providerId: string, sessionId?: string): void {
  authRecovery.add(flowId)
  const current = snapshot.flows[flowId]
  emit({
    ...snapshot,
    flows: {
      ...snapshot.flows,
      [flowId]: {
        flowId,
        providerId,
        sessionId: sessionId ?? current?.sessionId,
        event: current?.event,
        notifications: current?.notifications ?? [],
      },
    },
  })
}

export function receiveProviderAuthEvent(event: ProviderAuthEvent, sessionId?: string): void {
  authRecovery.add(event.flowId)
  const current = snapshot.flows[event.flowId]
  emit({
    ...snapshot,
    flows: {
      ...snapshot.flows,
      [event.flowId]: {
        flowId: event.flowId,
        providerId: event.providerId,
        sessionId: sessionId ?? current?.sessionId,
        event: event.type === 'notification' && current?.event?.type === 'prompt' ? current.event : event,
        notifications: event.type === 'notification'
          ? [...(current?.notifications ?? []), event.event]
          : current?.notifications ?? [],
      },
    },
  })
}

export function dismissProviderAuthFlow(flowId: string): void {
  authRecovery.add(flowId)
  if (!snapshot.flows[flowId]) return
  const flows = { ...snapshot.flows }
  delete flows[flowId]
  emit({ ...snapshot, flows })
}

export function clearProviderAuthEvent(flowId: string, expectedEvent: ProviderAuthEvent): void {
  const current = snapshot.flows[flowId]
  if (!current?.event) return
  const matches = expectedEvent.type === 'prompt'
    ? current.event.type === 'prompt' && current.event.promptId === expectedEvent.promptId
    : current.event === expectedEvent
  if (!matches) return
  authRecovery.add(flowId)
  emit({
    ...snapshot,
    flows: { ...snapshot.flows, [flowId]: { ...current, event: undefined } },
  })
}

export function receiveProviderAuthUpdated(): void {
  emit({ ...snapshot, providerRevision: snapshot.providerRevision + 1 })
}

export function receivePackageProgress(progress: PackageProgress): void {
  emit({
    ...snapshot,
    packageProgress: { ...snapshot.packageProgress, [progress.commandId]: progress },
  })
}

export function receiveResourceRevision(workspacePath: string | undefined, revision: string): void {
  if (!workspacePath) return
  emit({
    ...snapshot,
    resourceRevisions: { ...snapshot.resourceRevisions, [workspacePath]: revision },
  })
}

export function resetManagementEvents(): void {
  beginProviderAuthRecovery()
  providerIds.clear()
  emit({ flows: {}, packageProgress: {}, resourceRevisions: {}, providerRevision: 0 })
  streamListeners.forEach(listener => listener())
}
