import { useEffect, useRef } from 'react'
import i18n from '../i18n'
import { useFocusedSessionId } from '../omp/hooks/index.js'
import { activeSessionStore } from '../store/activeSessionStore'
import { notificationStore } from '../store/notificationStore'
import { notificationEventSettingsStore } from '../store/notificationEventSettingsStore'
import { useNotification } from './useNotification'

/**
 * Session streaming is delivered by PiEventSocket; this consumer contract
 * only carries lifecycle notifications (idle/error/reconnect/scroll).
 */
export interface SessionEventCallbacks {
  onScrollRequest?: () => void
  onSessionIdle?: (sessionID: string) => void
  onSessionError?: (sessionID: string) => void
  onReconnected?: (reason: 'network' | 'server-switch') => void
}

interface SessionConsumer {
  sessionId: string | null
  callbacks: SessionEventCallbacks
}

const sessionConsumers = new Map<string, SessionConsumer>()
const sessionIdleListeners = new Set<(sessionId: string) => void>()
const notifiedIdleSessions = new Set<string>()

export function registerSessionConsumer(
  consumerId: string,
  sessionId: string | null,
  callbacks: SessionEventCallbacks,
): () => void {
  sessionConsumers.set(consumerId, { sessionId, callbacks })
  return () => sessionConsumers.delete(consumerId)
}

export function notifySessionIdle(sessionId: string): void {
  for (const consumer of sessionConsumers.values()) {
    if (consumer.sessionId === sessionId) consumer.callbacks.onSessionIdle?.(sessionId)
  }
  if (notifiedIdleSessions.has(sessionId)) return
  notifiedIdleSessions.add(sessionId)
  sessionIdleListeners.forEach(listener => listener(sessionId))
}

export function notifySessionStarted(sessionId: string): void {
  notifiedIdleSessions.delete(sessionId)
}

export function subscribeSessionIdle(listener: (sessionId: string) => void): () => void {
  sessionIdleListeners.add(listener)
  return () => sessionIdleListeners.delete(listener)
}

export function notifyReconnected(): void {
  for (const consumer of sessionConsumers.values()) consumer.callbacks.onReconnected?.('network')
}

export function updateConsumerSessionId(consumerId: string, sessionId: string | null) {
  const consumer = sessionConsumers.get(consumerId)
  if (consumer) consumer.sessionId = sessionId
}

export function hasOtherConsumerForSession(sessionId: string, consumerId: string): boolean {
  for (const [id, consumer] of sessionConsumers) {
    if (id !== consumerId && consumer.sessionId === sessionId) return true
  }
  return false
}

/** Pi session events are subscribed through pi/eventSocket, not legacy SSE. */
export function useGlobalEvents() {
  const focusedSessionId = useFocusedSessionId()
  const focusedSessionIdRef = useRef(focusedSessionId)
  useEffect(() => {
    focusedSessionIdRef.current = focusedSessionId
  }, [focusedSessionId])
  const { sendNotification } = useNotification()

  useEffect(() => {
    return notificationStore.onPush((type, entry) => {
      if (type !== 'completed' || entry.target === 'extensions' || entry.sessionId === focusedSessionIdRef.current) return
      if (notificationEventSettingsStore.isSystemEnabled('completed')) {
        const meta = activeSessionStore.getSessionMeta(entry.sessionId)
        void sendNotification(meta?.title || entry.title, i18n.t('chat:notification.completed'), {
          sessionId: entry.sessionId, directory: entry.directory,
        })
      }
    })
  }, [sendNotification])
}
