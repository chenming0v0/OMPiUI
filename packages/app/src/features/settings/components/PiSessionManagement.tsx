import { useCallback, useEffect, useId, useMemo, useState, memo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRightLeft, Brain, Download, MessageSquareText, Plus, Puzzle, RefreshCw, Terminal, TriangleAlert } from 'lucide-react'
import type { SessionInfo } from '../../../omp/vendor/pi-coding-agent'
import type { JsonObject, JsonValue } from '@ompiui/protocol'
import { Button } from '../../../components/ui/Button'
import {
  abortPiBashExecution,
  appendPiCustomEntry,
  cyclePiModel,
  cyclePiThinkingLevel,
  executePiBash,
  exportPiSession,
  loadPiSessionsForCwd,
  newPiSessionFrom,
  openPiSession,
  sendPiCustomMessage,
  sendPiPrompt,
  sendPiUserMessage,
  setPiScopedModels,
  waitForPiIdle,
} from '../../../omp/controllers/index.js'
import { usePiSessionRuntimeState } from '../../../omp/hooks/index.js'
import { Toggle, SettingsSection, SettingsSubgroup, SettingsSelect, SettingsDisclosure, settingsFieldClass, settingsFieldAreaClass } from './SettingsUI'

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function PiSessionManagement({ sessionId, workspacePath }: { sessionId: string | null; workspacePath: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const state = usePiSessionRuntimeState(sessionId)
  const sessionChoiceName = useId()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [targetSessionPath, setTargetSessionPath] = useState('')
  const [scopedModels, setScopedModels] = useState('')
  const [bashCommand, setBashCommand] = useState('')
  const [bashResult, setBashResult] = useState<unknown>()
  const [bashExcludeFromContext, setBashExcludeFromContext] = useState(false)
  const [exportPath, setExportPath] = useState('')
  const [exportResult, setExportResult] = useState<unknown>()
  const [customType, setCustomType] = useState('')
  const [customPayload, setCustomPayload] = useState('{}')
  const [userMessage, setUserMessage] = useState('')
  const [deliveryMode, setDeliveryMode] = useState<'' | 'steer' | 'followUp'>('')
  const [promptText, setPromptText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const model = useMemo(() => record(state?.model), [state])
  const scopedModelPatternsText = useMemo(() => {
    const patterns = state?.scopedModelPatterns;
    if (Array.isArray(patterns)) return patterns.filter(item => typeof item === 'string').join('\n')
    return (Array.isArray(state?.scopedModels) ? state.scopedModels : []).flatMap(item => {
      if (typeof item === 'string') return [item]
      const scoped = record(item)
      const candidate = record(scoped.model)
      if (typeof candidate.provider !== 'string' || typeof candidate.id !== 'string') return []
      return [`${candidate.provider}/${candidate.id}${typeof scoped.thinkingLevel === 'string' ? `:${scoped.thinkingLevel}` : ''}`]
    }).join('\n')
  }, [state?.scopedModelPatterns, state?.scopedModels])
  const otherSessions = useMemo(() => sessions.filter(item => item.id !== sessionId), [sessions, sessionId])

  const load = useCallback(async () => {
    try {
      const nextSessions = await loadPiSessionsForCwd(workspacePath)
      setSessions(nextSessions)
      setTargetSessionPath(current => current || nextSessions.find(item => item.id !== sessionId)?.path || '')
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId, workspacePath])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  // Refresh the shortlist only when its native value or target changes, so
  // unrelated state updates do not overwrite edits that have not been applied.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setScopedModels(scopedModelPatternsText)
  }, [sessionId, scopedModelPatternsText])
  /* eslint-enable react-hooks/set-state-in-effect */

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  if (!sessionId) {
    return (
      <SettingsSection title={t('pi.sessionTitle')} description={t('pi.sessionOpenSession')}>
        {null}
      </SettingsSection>
    )
  }

  const enterSession = (targetId: string, directory?: string) => {
    const dir = directory ?? workspacePath
    window.location.hash = `#/session/${encodeURIComponent(targetId)}?dir=${encodeURIComponent(dir)}`
    window.dispatchEvent(new CustomEvent('ompiui:sessions-changed'))
  }

  const parseJson = () => {
    try { return JSON.parse(customPayload) as JsonValue } catch { throw new Error(t('pi.invalidJson')) }
  }

  const stateLabel = state?.isStreaming ? t('pi.stateStreaming') : state ? t('pi.stateIdle') : t('pi.stateLoading')
  const modelLabel = typeof model.provider === 'string' ? `${model.provider}/${String(model.id ?? model.modelId ?? '')}` : t('pi.noModel')
  const thinkingLevel = String(state?.thinkingLevel ?? '')
  const thinkingLabel = thinkingLevel
    ? t(`pi.thinkingLevels.${thinkingLevel}`, { defaultValue: thinkingLevel })
    : t('pi.sessionValueUnknown')
  const selectedSession = otherSessions.find(item => item.path === targetSessionPath)
  const selectedSessionLabel = selectedSession?.name || selectedSession?.firstMessage || selectedSession?.id || targetSessionPath

  return (
    <SettingsSection
      title={t('pi.sessionTitle')}
      description={t('pi.sessionDescription')}
      status={(
        <span role="status" className="inline-flex items-center gap-1.5 rounded-full bg-bg-200 px-2 py-0.5 text-[length:var(--fs-xs)] font-medium text-text-300">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${state?.isStreaming ? 'bg-accent-main-100' : 'bg-text-400'}`} />
          {stateLabel}
        </span>
      )}
    >
      {error ? <p role="alert" className="min-w-0 whitespace-pre-wrap text-[length:var(--fs-xs)] text-danger-100 [overflow-wrap:anywhere]">{error}</p> : null}

      <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-[length:var(--fs-xs)] text-text-400">{t('pi.sessionCurrentModel')}</dt>
          <dd className="mt-1 min-w-0">
            <p className="text-[length:var(--fs-sm)] font-medium leading-relaxed text-text-100 [overflow-wrap:anywhere]">{modelLabel}</p>
            <Button size="sm" variant="secondary" className="mt-2 min-h-8" isLoading={busy === 'cycle-model'} disabled={busy !== null} onClick={() => void run('cycle-model', () => cyclePiModel(sessionId))}>
              <RefreshCw size={14} aria-hidden="true" />
              {t('pi.nextModel')}
            </Button>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[length:var(--fs-xs)] text-text-400">{t('pi.thinking')}</dt>
          <dd className="mt-1 min-w-0">
            <p className="text-[length:var(--fs-sm)] font-medium leading-relaxed text-text-100 [overflow-wrap:anywhere]">{thinkingLabel}</p>
            <Button size="sm" variant="secondary" className="mt-2 min-h-8" isLoading={busy === 'cycle-thinking'} disabled={busy !== null} onClick={() => void run('cycle-thinking', () => cyclePiThinkingLevel(sessionId))}>
              <Brain size={14} aria-hidden="true" />
              {t('pi.cycleThinking')}
            </Button>
          </dd>
        </div>
      </dl>

      <SessionCommandGroup icon={<ArrowRightLeft size={16} />} title={t('pi.sessionControls')} description={t('pi.sessionControlsDescription')}>
        <SettingsSubgroup title={t('pi.scopedModelsLabel')} description={t('pi.scopedModelsDescription')}>
          <textarea aria-label={t('pi.scopedModelsLabel')} rows={3} className={`${settingsFieldAreaClass} font-mono`} value={scopedModels} onChange={event => setScopedModels(event.target.value)} />
          <Button size="sm" className="min-h-8" isLoading={busy === 'scoped-models'} disabled={busy !== null} onClick={() => void run('scoped-models', () => setPiScopedModels(sessionId, scopedModels.split(/\r?\n/).map(item => item.trim()).filter(Boolean)))}>{t('pi.applyModelScope')}</Button>
        </SettingsSubgroup>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 basis-48 text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('pi.waitForIdleDescription')}</p>
          <Button size="sm" variant="secondary" className="min-h-8" isLoading={busy === 'idle'} disabled={busy !== null} onClick={() => void run('idle', () => waitForPiIdle(sessionId))}>{t('pi.waitForIdle')}</Button>
        </div>

        <SettingsSubgroup title={t('pi.sessionChangeTitle')} description={t('pi.sessionChangeDescription')} className="border-t border-border-200/60 pt-4">
          <fieldset className="min-w-0">
            <legend className="mb-2 text-[length:var(--fs-xs)] font-medium text-text-200">{t('pi.savedSessions')}</legend>
            {otherSessions.length > 0 ? (
              <div className="max-h-48 space-y-1 overflow-auto overscroll-contain rounded-lg bg-bg-200/40 p-1 custom-scrollbar">
                {otherSessions.map(item => (
                  <label key={item.path} className={`flex min-w-0 cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 text-[length:var(--fs-sm)] leading-relaxed transition-colors hover:bg-bg-200 ${targetSessionPath === item.path ? 'bg-bg-200 text-text-100' : 'text-text-300'}`}>
                    <input type="radio" name={sessionChoiceName} value={item.path} checked={targetSessionPath === item.path} onChange={() => setTargetSessionPath(item.path)} className="mt-1 shrink-0 accent-accent-main-100" />
                    <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.name || item.firstMessage || item.id}</span>
                  </label>
                ))}
              </div>
            ) : <p className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('pi.noOtherSessions')}</p>}
          </fieldset>
          {targetSessionPath ? (
            <p className="min-w-0 text-[length:var(--fs-xs)] leading-relaxed">
              <span className="block text-text-400">{t('pi.sessionSelected')}</span>
              <span className="block whitespace-pre-wrap text-text-200 [overflow-wrap:anywhere]">{selectedSessionLabel}</span>
            </p>
          ) : null}
          <Button size="sm" variant="secondary" className="min-h-8 w-full sm:w-auto" isLoading={busy === 'switch'} disabled={busy !== null || !targetSessionPath} onClick={() => void run('switch', async () => {
            const opened = await openPiSession(workspacePath, targetSessionPath)
            if (opened.sessionId) enterSession(opened.sessionId, opened.cwd ?? undefined)
          })}>{t('pi.switchSession')}</Button>

          <div className="space-y-3 border-t border-border-200/60 pt-4">
            <p className="flex items-start gap-2 text-[length:var(--fs-xs)] leading-relaxed text-danger-100">
              <TriangleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span className="min-w-0">{t('pi.newNativeSessionDescription')}</span>
            </p>
            <Button size="sm" variant="danger" className="min-h-8 w-full sm:w-auto" isLoading={busy === 'new'} disabled={busy !== null} onClick={() => void run('new', async () => {
              const result = await newPiSessionFrom(sessionId)
              if (!result.cancelled && result.targetSessionId) enterSession(result.targetSessionId, result.targetCwd ?? undefined)
            })}>
              <Plus size={14} aria-hidden="true" />
              {t('pi.newNativeSession')}
            </Button>
          </div>
        </SettingsSubgroup>
      </SessionCommandGroup>

      <SessionCommandGroup icon={<MessageSquareText size={16} />} title={t('pi.sessionMessages')} description={t('pi.sessionMessagesDescription')}>
        <SettingsSubgroup title={t('pi.sessionUserMessage')} description={t('pi.sessionDeliveryDescription')}>
          <textarea aria-label={t('pi.sessionUserMessage')} rows={3} className={settingsFieldAreaClass} value={userMessage} placeholder={t('pi.userMessagePlaceholder')} onChange={event => setUserMessage(event.target.value)} />
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="min-w-0 space-y-1.5">
              <p className="text-[length:var(--fs-xs)] font-medium text-text-200">{t('pi.sessionDeliveryMode')}</p>
              <SettingsSelect
                ariaLabel={t('pi.sessionDeliveryMode')}
                value={deliveryMode}
                onChange={setDeliveryMode}
                options={[
                  { value: '' as const, label: t('pi.nextTurn') },
                  { value: 'steer' as const, label: t('pi.steer') },
                  { value: 'followUp' as const, label: t('pi.followUp') },
                ]}
              />
            </div>
            <Button size="sm" className="min-h-8" isLoading={busy === 'user-message'} disabled={busy !== null || !userMessage.trim()} onClick={() => void run('user-message', async () => { await sendPiUserMessage(sessionId, userMessage.trim(), undefined, deliveryMode || undefined); setUserMessage('') })}>{t('common:send')}</Button>
          </div>
        </SettingsSubgroup>

        <SettingsSubgroup title={t('pi.sessionPromptTitle')} description={t('pi.sessionPromptDescription')} className="border-t border-border-200/60 pt-4">
          <textarea aria-label={t('pi.sessionPromptTitle')} rows={3} className={settingsFieldAreaClass} value={promptText} placeholder={t('pi.promptPlaceholder')} onChange={event => setPromptText(event.target.value)} />
          <Button size="sm" variant="secondary" className="min-h-8" isLoading={busy === 'prompt'} disabled={busy !== null || !promptText.trim()} onClick={() => void run('prompt', async () => {
            await sendPiPrompt(sessionId, promptText.trim())
            setPromptText('')
          })}>{t('pi.prompt')}</Button>
        </SettingsSubgroup>
      </SessionCommandGroup>

      <SessionCommandGroup icon={<Terminal size={16} />} title={t('pi.bashGroup')} description={t('pi.sessionBashDescription')}>
        <label className="block space-y-1.5">
          <span className="text-[length:var(--fs-xs)] font-medium text-text-200">{t('pi.sessionBashCommand')}</span>
          <input className={`${settingsFieldClass} font-mono`} value={bashCommand} placeholder={t('pi.bashPlaceholder')} onChange={event => setBashCommand(event.target.value)} />
        </label>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0"><Toggle enabled={bashExcludeFromContext} onChange={() => setBashExcludeFromContext(value => !value)} ariaLabel={t('pi.excludeBash')} /></span>
          <span className="min-w-0 text-[length:var(--fs-xs)] leading-relaxed text-text-300">{t('pi.excludeBash')}</span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button size="sm" className="min-h-8" isLoading={busy === 'bash'} disabled={busy !== null || !bashCommand.trim()} onClick={() => void run('bash', async () => setBashResult(await executePiBash(sessionId, bashCommand.trim(), bashExcludeFromContext)))}>{t('pi.runBash')}</Button>
          <Button size="sm" variant="secondary" className="min-h-8" isLoading={busy === 'abort-bash'} disabled={busy !== null} onClick={() => void run('abort-bash', () => abortPiBashExecution(sessionId))}>{t('pi.abortBash')}</Button>
        </div>
        {bashResult !== undefined ? (
          <div className="min-w-0 space-y-1.5" role="status">
            <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.sessionCommandResult')}</p>
            <ResultValue value={bashResult} />
          </div>
        ) : null}
      </SessionCommandGroup>

      <SessionCommandGroup icon={<Download size={16} />} title={t('pi.sessionExport')} description={t('pi.sessionExportDescription')}>
        <label className="block space-y-1.5">
          <span className="text-[length:var(--fs-xs)] font-medium text-text-200">{t('pi.outputPath')}</span>
          <input className={settingsFieldClass} value={exportPath} placeholder={t('pi.outputPath')} onChange={event => setExportPath(event.target.value)} />
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button size="sm" variant="secondary" className="min-h-8" isLoading={busy === 'export-html'} disabled={busy !== null || !exportPath.trim()} onClick={() => void run('export-html', async () => setExportResult(await exportPiSession(sessionId, 'html', exportPath.trim())))}>{t('pi.exportHtml')}</Button>
          <Button size="sm" variant="secondary" className="min-h-8" isLoading={busy === 'export-jsonl'} disabled={busy !== null || !exportPath.trim()} onClick={() => void run('export-jsonl', async () => setExportResult(await exportPiSession(sessionId, 'jsonl', exportPath.trim())))}>{t('pi.exportJsonl')}</Button>
        </div>
        {exportResult !== undefined ? (
          <div className="min-w-0 space-y-1.5" role="status">
            <p className="text-[length:var(--fs-xs)] text-text-400">{t('pi.sessionCommandResult')}</p>
            <p className="whitespace-pre-wrap text-[length:var(--fs-xs)] leading-relaxed text-text-300 [overflow-wrap:anywhere]">{formatValue(exportResult)}</p>
          </div>
        ) : null}
      </SessionCommandGroup>

      <SessionCommandGroup icon={<Puzzle size={16} />} title={t('pi.extensionHostCommands')} description={t('pi.extensionHostCommandsDescription')}>
        <label className="block space-y-1.5">
          <span className="text-[length:var(--fs-xs)] font-medium text-text-200">{t('pi.customType')}</span>
          <input className={settingsFieldClass} value={customType} placeholder={t('pi.customType')} onChange={event => setCustomType(event.target.value)} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[length:var(--fs-xs)] font-medium text-text-200">{t('pi.sessionCustomPayload')}</span>
          <textarea rows={4} className={`${settingsFieldAreaClass} font-mono`} value={customPayload} onChange={event => setCustomPayload(event.target.value)} />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 basis-48 text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('pi.sendCustomMessageDescription')}</p>
          <Button size="sm" variant="secondary" className="min-h-8" isLoading={busy === 'custom-message'} disabled={busy !== null || !customType.trim()} onClick={() => void run('custom-message', async () => { const value = parseJson(); const content = [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }]; await sendPiCustomMessage(sessionId, { customType: customType.trim(), content, display: true }) })}>{t('pi.sendCustomMessage')}</Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 basis-48 text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('pi.appendCustomEntryDescription')}</p>
          <Button size="sm" variant="secondary" className="min-h-8" isLoading={busy === 'custom-entry'} disabled={busy !== null || !customType.trim()} onClick={() => void run('custom-entry', () => appendPiCustomEntry(sessionId, customType.trim(), parseJson()))}>{t('pi.appendCustomEntry')}</Button>
        </div>
      </SessionCommandGroup>
    </SettingsSection>
  )
}

function SessionCommandGroup({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <SettingsDisclosure
      className="border-t border-border-200/60 pt-4 [&>button]:w-full [&>button]:items-start [&>button]:gap-2.5 [&>button]:text-left [&>button>span]:min-w-0 [&>button>span]:flex-1 [&>button>svg]:mt-1"
      title={(
        <span className="flex min-w-0 items-start gap-2.5">
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-text-400">{icon}</span>
          <span className="min-w-0">
            <span className="block text-[length:var(--fs-sm)] font-medium text-text-100">{title}</span>
            <span className="mt-0.5 block text-[length:var(--fs-xs)] font-normal leading-relaxed text-text-400">{description}</span>
          </span>
        </span>
      )}
    >
      <div className="min-w-0 space-y-5 pt-2">{children}</div>
    </SettingsDisclosure>
  )
}

const ResultValue = memo(function ResultValue({ value }: { value: unknown }) {
  return (
    <pre className="min-w-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-bg-200/40 p-2 text-[length:var(--fs-xs)] text-text-300 [overflow-wrap:anywhere]">{formatValue(value)}</pre>
  )
})

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
