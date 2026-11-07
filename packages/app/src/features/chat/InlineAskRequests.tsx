import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import type { PiTimelineItem } from '../../omp/domain'
import { extensionUiStore } from '../../omp/extensionUiStore'
import { NativeAskDialogCard } from './NativeAskDialogCard'
import { askRequestKey, matchNativeAskRequests, type NativeAskRequest } from './nativeAskMatching'

type AskSlot = { requestKey: string; inline: boolean; element: HTMLDivElement }
type InlineAskContext = {
  requestsByCall: Map<string, NativeAskRequest>
  register: (token: symbol, slot: AskSlot | null) => void
}

export const InlineAskRequestsContext = createContext<InlineAskContext | null>(null)

export function useInlineAskRequests(sessionId: string | null, items: PiTimelineItem[]) {
  const snapshot = useSyncExternalStore(extensionUiStore.subscribe, extensionUiStore.getSnapshot, extensionUiStore.getSnapshot)
  const requests = useMemo(() => sessionId ? snapshot.sessions[sessionId]?.pending ?? [] : [], [sessionId, snapshot])
  const requestsByCall = useMemo(() => matchNativeAskRequests(items, requests), [items, requests])
  const [slots, setSlots] = useState(() => new Map<symbol, AskSlot>())
  const register = useCallback((token: symbol, slot: AskSlot | null) => {
    setSlots(previous => {
      if (!slot && !previous.has(token)) return previous
      const next = new Map(previous)
      if (slot) next.set(token, slot)
      else next.delete(token)
      return next
    })
  }, [])
  const value = useMemo(() => ({ requestsByCall, register }), [requestsByCall, register])
  const targets = useMemo(() => {
    const matched = new Set([...requestsByCall.values()].map(askRequestKey))
    const next = new Map<string, AskSlot>()
    for (const slot of slots.values()) {
      if (slot.inline && !matched.has(slot.requestKey)) continue
      const previous = next.get(slot.requestKey)
      if (!previous || (!previous.inline && slot.inline)) next.set(slot.requestKey, slot)
    }
    return next
  }, [slots, requestsByCall])
  const pending = useMemo(() => requests.filter(request => !targets.get(askRequestKey(request))?.inline), [requests, targets])

  // 表单状态留在稳定的请求实例上；Portal 迁移和队列翻页只改变挂载位置。
  const dialogs = requests.filter((request): request is NativeAskRequest => request.kind === 'ask').map(request => (
    <NativeAskDialogCard key={askRequestKey(request)} request={request} target={targets.get(askRequestKey(request))?.element ?? null} />
  ))
  return { value, pending, dialogs }
}

export function useInlineAskRequest(callId: string): NativeAskRequest | undefined {
  return useContext(InlineAskRequestsContext)?.requestsByCall.get(callId)
}

export function NativeAskSlot({ request, inline = false }: { request: NativeAskRequest; inline?: boolean }) {
  const context = useContext(InlineAskRequestsContext)
  const register = context?.register
  const [token] = useState(() => Symbol('ask-slot'))
  const requestKey = askRequestKey(request)
  const ref = useCallback((element: HTMLDivElement | null) => {
    register?.(token, element ? { requestKey, inline, element } : null)
  }, [register, token, requestKey, inline])
  return <div ref={ref} data-ask-location={inline ? 'inline' : 'dock'} />
}
