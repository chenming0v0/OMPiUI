import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { extensionUiStore } from '../omp/extensionUiStore'
import { extensionTuiStore } from '../omp/extensionTuiStore'
import { commandFeedbackStore, type CommandFeedbackEntry, type CommandFeedbackStatus } from '../omp/commandFeedbackStore'
import { ExtensionUiDialogCard } from '../features/chat/ExtensionUiDialogCard'
import { ExtensionTuiView } from './ExtensionTuiView'
import { stripAnsi } from '../utils/ansiUtils'
import { usePiSessionRuntimeState } from '../omp/hooks'
import { isJsonObject } from '@ompiui/protocol'

const feedbackStatusConfig: Record<CommandFeedbackStatus, { label: string; className: string }> = {
  ok: { label: 'ok', className: 'text-success-100 bg-success-100/10' },
  error: { label: 'error', className: 'text-danger-100 bg-danger-100/10' },
  warning: { label: 'warning', className: 'text-warning-100 bg-warning-100/10' },
  info: { label: 'info', className: 'text-info-100 bg-info-100/10' },
}

/**
 * Extensions panel — extension UI for the current session: interactive
 * dialogs inline, the offscreen extension TUI mirror (component widgets /
 * custom() / footer / header) rendered with xterm.js, plus read-only state
 * (statuses, text widgets, working indicator, title).
 */
export function ExtensionsPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation('components')
  const runtimeState = usePiSessionRuntimeState(sessionId)
  const askUiState = runtimeState?.askUi
  const askUi = isJsonObject(askUiState) ? askUiState : undefined
  const snapshot = useSyncExternalStore(
    extensionUiStore.subscribe,
    extensionUiStore.getSnapshot,
    extensionUiStore.getSnapshot,
  )
  const tuiSnapshot = useSyncExternalStore(
    extensionTuiStore.subscribe,
    extensionTuiStore.getSnapshot,
    extensionTuiStore.getSnapshot,
  )
  const feedbackSnapshot = useSyncExternalStore(
    commandFeedbackStore.subscribe,
    commandFeedbackStore.getSnapshot,
    commandFeedbackStore.getSnapshot,
  )
  const state = sessionId ? snapshot.sessions[sessionId]?.state : undefined
  const pending = sessionId ? snapshot.sessions[sessionId]?.pending ?? [] : []
  const panels = sessionId ? tuiSnapshot.sessions[sessionId]?.panels ?? [] : []
  const feedback = sessionId ? feedbackSnapshot.sessions[sessionId] ?? [] : []

  if (!sessionId) {
    return <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)]">{t('rightPanel.noActiveSession')}</div>
  }

  const statuses = Object.entries(state?.statuses ?? {})
    .map(([key, value]) => ({ key, text: stripAnsi(value) }))
    .filter(status => status.text.trim())
  const widgets = Object.entries(state?.widgets ?? {})
    .map(([key, widget]) => ({ key, text: stripAnsi(widget.lines.join('\n')) }))
    .filter(widget => widget.text.trim())
  const hasWorking = Boolean(state?.workingMessage || state?.workingIndicator || state?.title)

  if (!askUi && !hasWorking && statuses.length === 0 && widgets.length === 0 && pending.length === 0 && panels.length === 0 && feedback.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-400 text-[length:var(--fs-sm)] px-4 text-center">
        {t('extensionsPanel.empty', 'No extension state')}
      </div>
    )
  }

  const sortedPending = [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return (
    <div className="h-full overflow-y-auto custom-scrollbar px-4 py-3 flex flex-col gap-4">
      {askUi && <section className="text-[length:var(--fs-xs)] text-text-400">
        <SectionLabel>{t('dialog.ask')}</SectionLabel>
        <p>{askUi.available === true
          ? t(askUi.surface === 'ask' ? 'dialog.askAvailable' : 'dialog.askBasicAvailable')
          : t(askUi.reason === 'runtime_unavailable' ? 'dialog.askRuntimeUnavailable' : 'dialog.askInactive')}</p>
      </section>}
      {/* Interactive dialogs inline (the floating cards above the composer stay too) */}
      {sortedPending.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionLabel>{t('extensionsPanel.dialogs', 'Dialog')}</SectionLabel>
          {sortedPending.map(request => (
            <ExtensionUiDialogCard key={JSON.stringify([request.sessionId, request.workerGeneration, request.requestId])} request={request} compact />
          ))}
        </section>
      )}

      {/* Command feedback log — full detail of every slash command the user ran */}
      {feedback.length > 0 && (
        <section className="min-w-0">
          <div className="mb-1.5 flex items-center justify-between">
            <SectionLabel>{t('extensionsPanel.commandFeedback', 'Command Feedback')}</SectionLabel>
            <button
              type="button"
              onClick={() => commandFeedbackStore.remove(sessionId)}
              className="shrink-0 rounded px-1.5 py-0.5 text-[length:var(--fs-xxs)] text-text-500 hover:text-danger-100 hover:bg-bg-200/60 transition-colors"
            >
              {t('extensionsPanel.clear', 'Clear')}
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {feedback.map(entry => (
              <CommandFeedbackItem key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      )}

      {/* Offscreen extension TUI mirror (component widgets / custom() / footer / header) */}
      {panels.length > 0 && (
        <section>
          <SectionLabel>{t('extensionsPanel.tui', 'Extension TUI')}</SectionLabel>
          <div className="rounded-md border border-border-200/60 bg-bg-000/60 overflow-hidden">
            <ExtensionTuiView sessionId={sessionId} className="w-full min-h-24 max-h-[60vh] px-1.5 py-1" />
          </div>
        </section>
      )}

      {state?.title && (
        <section>
          <SectionLabel>{t('extensionsPanel.title', 'Title')}</SectionLabel>
          <div className="text-[length:var(--fs-sm)] text-text-100">{state.title}</div>
        </section>
      )}

      {hasWorking && (state?.workingMessage || state?.workingIndicator) && (
        <section>
          <SectionLabel>{t('extensionsPanel.working', 'Working')}</SectionLabel>
          <div className="flex items-center gap-2 text-[length:var(--fs-sm)] text-accent-main-100">
            {state?.workingIndicator?.frames?.[0] && <span>{state.workingIndicator.frames[0]}</span>}
            {state?.workingMessage && <span>{state.workingMessage}</span>}
          </div>
        </section>
      )}

      {statuses.length > 0 && (
        <section>
          <SectionLabel>{t('extensionsPanel.statuses', 'Status')}</SectionLabel>
          <div className="flex flex-col gap-1">
            {statuses.map(({ key, text }) => (
              <div key={key} className="whitespace-pre-wrap break-words text-[length:var(--fs-sm)] text-text-200">
                {text}
              </div>
            ))}
          </div>
        </section>
      )}

      {widgets.length > 0 && (
        <section>
          <SectionLabel>{t('extensionsPanel.widgets', 'Extension Output')}</SectionLabel>
          <div className="flex flex-col gap-2">
            {widgets.map(({ key, text }) => (
              <pre key={key} className="whitespace-pre-wrap break-words rounded-md bg-bg-200/40 px-3 py-2 text-[length:var(--fs-sm)] text-text-200 font-mono">
                {text}
              </pre>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[length:var(--fs-xs)] uppercase tracking-wide text-text-500">{children}</div>
}

function CommandFeedbackItem({ entry }: { entry: CommandFeedbackEntry }) {
  const config = feedbackStatusConfig[entry.status]
  const at = new Date(entry.at)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`
  const isNotify = entry.kind === 'notify'
  return (
    <div className="min-w-0 rounded-md border border-border-200/50 bg-bg-200/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[length:var(--fs-xxs)] font-medium ${config.className}`}>
          {config.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-sm)] text-text-100">
          {entry.source ?? (isNotify ? '[extension]' : entry.command ? `/${entry.command}` : 'Native command')}
          {entry.command && entry.args ? <span className="text-text-400"> {entry.args}</span> : null}
        </span>
        <span className="shrink-0 font-mono text-[length:var(--fs-xxs)] text-text-500">{time}</span>
      </div>
      {entry.originalType !== undefined && (
        <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[length:var(--fs-xs)] text-text-400">originalType: {stripAnsi(entry.originalType)}</div>
      )}
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[length:var(--fs-sm)] text-text-200">
        {stripAnsi(entry.message)}
      </pre>
      {entry.context !== undefined && (
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[length:var(--fs-sm)] text-text-400">{stripAnsi(entry.context)}</pre>
      )}
    </div>
  )
}
