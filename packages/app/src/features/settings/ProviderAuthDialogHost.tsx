import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import {
  clearProviderAuthEvent,
  dismissProviderAuthFlow,
  beginProviderAuthRecovery,
  resetProviderAuthFlows,
  restoreProviderAuthFlows,
  useManagementEvents,
  type ProviderAuthFlowState,
} from '../../omp/managementEventStore'
import type { ProviderAuthPrompt } from '@ompiui/protocol'
import {
  cancelProviderAuth,
  listActiveProviderFlows,
  respondProviderAuth,
} from '../../omp/transport/index.js'
import { registerSessionConsumer } from '../../hooks/useGlobalEvents'
import { serverStore } from '../../store/serverStore'

export function ProviderAuthDialogHost() {
  const { flows } = useManagementEvents()
  const consumerId = useId()
  // Recover on mount/reconnect, never applying an older server/request snapshot
  // over a newer prompt, submission or dismissal.
  useEffect(() => {
    let disposed = false
    let controller: AbortController | undefined
    const restore = () => {
      if (disposed) return
      controller?.abort()
      const request = new AbortController()
      controller = request
      const generation = serverStore.getActiveServerGeneration()
      const recovery = beginProviderAuthRecovery()
      void listActiveProviderFlows(request.signal).then(snapshot => {
        if (request.signal.aborted || generation !== serverStore.getActiveServerGeneration()) return
        restoreProviderAuthFlows(snapshot, recovery)
      }).catch(() => undefined)
    }
    const unsubscribeReconnect = registerSessionConsumer(consumerId, null, { onReconnected: restore })
    const unsubscribeServer = serverStore.onServerChange(() => {
      controller?.abort()
      resetProviderAuthFlows()
      // Let the existing backend switch listeners finish clearing their stores.
      queueMicrotask(restore)
    })
    restore()
    return () => {
      disposed = true
      controller?.abort()
      unsubscribeReconnect()
      unsubscribeServer()
    }
  }, [consumerId])
  const flow = useMemo(() => Object.values(flows).find(item => item.event), [flows])
  if (!flow) return null
  const eventKey = flow.event?.type === 'prompt' ? flow.event.promptId : flow.event?.type
  return <ProviderAuthDialog key={`${serverStore.getActiveServerGeneration()}:${flow.flowId}:${eventKey}`} flow={flow} />
}

function ProviderAuthDialog({ flow }: { flow: ProviderAuthFlowState }) {
  const { t } = useTranslation(['settings', 'common'])
  const event = flow.event
  const generation = serverStore.getActiveServerGeneration()
  const prompt = event?.type === 'prompt' ? (event.prompt as ProviderAuthPrompt) : undefined
  const [value, setValue] = useState(prompt?.type === 'select' ? prompt.options?.[0]?.id ?? '' : '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!event) return null
  const terminal = event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled'

  const close = async () => {
    if (terminal) {
      dismissProviderAuthFlow(flow.flowId)
      return
    }
    setSubmitting(true)
    try {
      await cancelProviderAuth(flow.flowId)
      if (generation === serverStore.getActiveServerGeneration()) dismissProviderAuthFlow(flow.flowId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSubmitting(false)
    }
  }

  const submit = async () => {
    if (event.type !== 'prompt' || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await respondProviderAuth(flow.flowId, event.promptId, value)
      if (generation === serverStore.getActiveServerGeneration()) clearProviderAuthEvent(flow.flowId, event)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog isOpen onClose={() => void close()} title={t('pi.authTitle')} width={500} showCloseButton={!submitting}>
      <div className="space-y-4">
        <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.authProvider', { id: flow.providerId })}{flow.sessionId ? ` · ${t('pi.sessionScope')}` : ` · ${t('pi.globalScopeLabel')}`}</p>
        {event.type === 'prompt' ? (
          <>
            <p className="whitespace-pre-wrap text-[length:var(--fs-sm)] text-text-200">{prompt!.message}</p>
            {prompt!.type === 'select' ? (
              <div className="space-y-2">
                {prompt!.options?.map(option => (
                  <label key={option.id} className="flex cursor-pointer gap-2 rounded-md border border-border-100 p-2 text-[length:var(--fs-sm)] text-text-200">
                    <input type="radio" name="provider-auth-option" value={option.id} checked={value === option.id} onChange={() => setValue(option.id)} className="accent-accent-main-100" />
                    <span><span className="block text-text-100">{option.label}</span>{option.description ? <span className="block text-[length:var(--fs-xs)] text-text-400">{option.description}</span> : null}</span>
                  </label>
                ))}
              </div>
            ) : (
              <input
                autoFocus
                type={prompt!.type === 'secret' ? 'password' : 'text'}
                value={value}
                placeholder={prompt!.placeholder}
                onChange={input => setValue(input.target.value)}
                onKeyDown={key => { if (key.key === 'Enter' && value) void submit() }}
                className="h-9 w-full rounded-md border border-border-200 bg-bg-100 px-3 text-[length:var(--fs-sm)] text-text-100 outline-none focus:border-accent-main-100"
              />
            )}
          </>
        ) : event.type === 'notification' ? (
          <div className="space-y-2"><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-200/50 p-3 text-[length:var(--fs-xs)] text-text-200">{formatNotification(event.event)}</pre>{extractUrls(event.event).map(url => <a key={url} href={url} target="_blank" rel="noreferrer" className="block break-all text-[length:var(--fs-xs)] text-accent-main-100 underline">{t('pi.openAuthUrl')}</a>)}</div>
        ) : event.type === 'failed' ? (
          <p className="text-[length:var(--fs-sm)] text-danger-100">{event.message}</p>
        ) : (
          <p className="text-[length:var(--fs-sm)] text-text-200">{event.type === 'completed' ? t('pi.authCompleted') : t('pi.authCancelled')}</p>
        )}
        {flow.notifications.length > 0 && event.type !== 'notification' ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-200/40 p-2 text-[length:var(--fs-xs)] text-text-400">{flow.notifications.map(formatNotification).join('\n')}</pre>
        ) : null}
        {error ? <p role="alert" className="text-[length:var(--fs-sm)] text-danger-100">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={submitting} onClick={() => void close()}>{terminal ? t('common:close') : t('common:cancel')}</Button>
          {event.type === 'prompt' ? <Button isLoading={submitting} disabled={!value} onClick={() => void submit()}>{t('pi.continue')}</Button> : null}
          {event.type === 'notification' ? <Button disabled={submitting} onClick={() => clearProviderAuthEvent(flow.flowId, event)}>{t('pi.keepWaiting')}</Button> : null}
        </div>
      </div>
    </Dialog>
  )
}

function formatNotification(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function extractUrls(value: unknown): string[] {
  const urls = new Set<string>()
  const visit = (candidate: unknown) => {
    if (typeof candidate === 'string') {
      for (const match of candidate.matchAll(/https?:\/\/[^\s"'<>]+/g)) urls.add(match[0])
      return
    }
    if (Array.isArray(candidate)) candidate.forEach(visit)
    else if (candidate && typeof candidate === 'object') Object.values(candidate).forEach(visit)
  }
  visit(value)
  return [...urls]
}
