import { createContext, useContext, useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore, type RefObject } from 'react'
import type { ReasoningTranslationIntent, ReasoningTranslationPriority, ReasoningTranslationSnapshot } from '@ompiui/protocol'
import type { PiAssistantMessageItem, PiUserMessageItem } from './domain/index.js'
import { getApiBase, piFetch } from './httpClient'
import { serverStore } from '../store/serverStore'
import type { ReasoningTranslationBudget } from '../store/reasoningTranslationSettings'
import { buildReasoningTranslationLines, composeReasoningTranslationLines } from './reasoningTranslationDisplay'

export type ContextTimelineItem = PiAssistantMessageItem | PiUserMessageItem
export const ReasoningTranslationContext = createContext<{
  scope: string
  sessionId: string
  model: string
  budget: ReasoningTranslationBudget
} | null>(null)

// Display snapshots only. Translation jobs and successful fragments belong to the backend.
const snapshots = new Map<string, ReasoningTranslationSnapshot>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function remember(key: string, snapshot: ReasoningTranslationSnapshot) {
  snapshots.delete(key)
  snapshots.set(key, snapshot)
  if (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value!)
  for (const listener of listeners) listener()
}

export function useReasoningReadingPriority(ref: RefObject<Element | null>, reading: boolean): ReasoningTranslationPriority | null {
  const [visible, setVisible] = useState(false)
  const [near, setNear] = useState(false)
  const [foreground, setForeground] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const element = ref.current
    if (!element) { setVisible(false); setNear(false); return }
    const visibility = () => setForeground(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', visibility)
    if (typeof IntersectionObserver === 'undefined') {
      const rect = element.getBoundingClientRect()
      setVisible(rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight)
      return () => document.removeEventListener('visibilitychange', visibility)
    }
    const viewport = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)))
    const neighbors = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { rootMargin: '400px 0px' })
    viewport.observe(element)
    neighbors.observe(element)
    return () => {
      viewport.disconnect()
      neighbors.disconnect()
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [ref])
  return !foreground ? null : visible ? reading ? 'reading' : 'visible' : near ? 'prewarm' : null
}

export function useReasoningSessionReading(sessionId: string | null | undefined, ref: RefObject<Element | null>) {
  const visible = useReasoningReadingPriority(ref, false) === 'visible'
  const [readerId] = useState(() => crypto.randomUUID())
  const generation = serverStore.getActiveServerGeneration()
  useEffect(() => {
    if (!sessionId || !visible) return
    const publish = (active: boolean) => {
      if (serverStore.getActiveServerGeneration() !== generation) return
      void piFetch(`${getApiBase()}/api/v1/pi/reasoning/reading`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, readerId, active }), privateStream: true,
      }).catch(() => undefined)
    }
    publish(true)
    const timer = setInterval(() => publish(true), 30_000)
    return () => { clearInterval(timer); publish(false) }
  }, [sessionId, visible, generation, readerId])
}

type ReadingIntent = {
  blockIndex?: number
  priority?: ReasoningTranslationPriority | null
  interactionId?: string
}

export function useReasoningTranslation(entryId: string | undefined, partKey: string, source: string, _streaming: boolean, paused: boolean, intent: ReadingIntent = {}) {
  const context = useContext(ReasoningTranslationContext)
  const key = context && entryId ? JSON.stringify([context.scope, context.sessionId, context.model, context.budget, partKey]) : ''
  const snapshot = useSyncExternalStore(subscribe, () => snapshots.get(key) ?? null, () => null)
  const [readerId] = useState(() => crypto.randomUUID())
  const priority = intent.priority === undefined ? 'visible' : intent.priority
  const interactionId = priority === 'reading' ? intent.interactionId : undefined
  const blockIndex = intent.blockIndex ?? Number(partKey.slice(partKey.lastIndexOf(':') + 1))
  const enabled = Boolean(context && entryId && source.trim() && priority) && !paused
  const [transportFailed, setTransportFailed] = useState('')
  const [retry, setRetry] = useState(0)
  const [reveal, setReveal] = useState(() => {
    const saved = snapshots.get(key)
    const chunks = saved ? [...saved.chunks, ...(saved.partial ? [saved.partial] : [])] : []
    const lines = buildReasoningTranslationLines(source, chunks)
    return { key, line: lines.findLastIndex(line => line.ready) }
  })

  useEffect(() => {
    if (!enabled || !context || !entryId || !priority) return
    const controller = new AbortController()
    let reconnect: ReturnType<typeof setTimeout> | undefined
    setTransportFailed('')
    const body: ReasoningTranslationIntent = {
      sessionId: context.sessionId, entryId, blockIndex, readerId,
      model: context.model, budget: context.budget, priority,
      ...(interactionId ? { interactionId } : {}),
    }
    const watch = async () => {
      let transient = true
      try {
        const response = await piFetch(`${getApiBase()}/api/v1/pi/reasoning/translate`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          signal: controller.signal, timeoutMs: 300_000, privateStream: true,
        })
        if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
          transient = response.status >= 500
          await response.body?.cancel()
          throw new Error('Translation unavailable')
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        try {
          for (;;) {
            const { value, done } = await reader.read()
            controller.signal.throwIfAborted()
            if (done) {
              if (snapshots.get(key)?.status === 'complete' || snapshots.get(key)?.status === 'failed') return
              throw new Error('Incomplete translation subscription')
            }
            pending += decoder.decode(value, { stream: true })
            let newline: number
            while ((newline = pending.indexOf('\n')) >= 0) {
              const frame = JSON.parse(pending.slice(0, newline)) as { snapshot?: ReasoningTranslationSnapshot; error?: boolean }
              pending = pending.slice(newline + 1)
              if (frame.error) { transient = false; throw new Error('Translation failed') }
              if (frame.snapshot) remember(key, frame.snapshot)
            }
            if (pending.length > 2 * 1024 * 1024) { transient = false; throw new Error('Translation snapshot too large') }
          }
        } finally {
          void reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      } catch {
        if (controller.signal.aborted) return
        setTransportFailed(key)
        if (!transient) {
          const saved = snapshots.get(key)
          if (saved) remember(key, { ...saved, partial: undefined, status: 'failed' })
        }
        if (transient) reconnect = setTimeout(() => setRetry(value => value + 1), 1500)
      }
    }
    void watch()
    const reconnectNow = () => { if (document.visibilityState === 'visible') setRetry(value => value + 1) }
    window.addEventListener('online', reconnectNow)
    window.addEventListener('focus', reconnectNow)
    return () => {
      controller.abort()
      clearTimeout(reconnect)
      window.removeEventListener('online', reconnectNow)
      window.removeEventListener('focus', reconnectNow)
    }
    // The server observes live source changes; frontend token updates do not restart jobs.
  }, [enabled, context, key, entryId, blockIndex, priority, interactionId, readerId, retry])

  const chunks = snapshot?.chunks
  const partial = snapshot?.partial
  const lines = useMemo(() => buildReasoningTranslationLines(source, [
    ...(chunks ?? []), ...(partial ? [partial] : []),
  ]), [source, chunks, partial])
  const revealedThroughLine = reveal.key === key ? reveal.line : -1
  const nextLine = lines.findIndex((line, index) => line.ready && index > revealedThroughLine)
  const revealNextLine = useEffectEvent(() => setReveal({ key, line: nextLine }))
  useEffect(() => {
    if (!enabled || nextLine < 0) return
    const frame = requestAnimationFrame(() => revealNextLine())
    return () => cancelAnimationFrame(frame)
  }, [enabled, key, nextLine])
  return {
    available: Boolean(key),
    failed: enabled && (transportFailed === key || snapshot?.status === 'failed'),
    pending: enabled && (snapshot?.status === 'queued' || snapshot?.status === 'running' || !snapshot),
    text: !paused && key ? composeReasoningTranslationLines(lines, revealedThroughLine) : '',
  }
}
