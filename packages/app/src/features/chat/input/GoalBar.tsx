import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { PiCommandParams } from '@ompiui/protocol'
import { IconButton } from '../../../components/ui'
import { CloseIcon, ExpandIcon, PauseIcon, PlayIcon, TargetIcon, TrashIcon } from '../../../components/Icons'
import { piSessionStateStore } from '../../../omp/state/index.js'
import { refreshPiSessionState } from '../../../omp/controllers/index.js'
import { manageSessionGoal, waitHostCommand } from '../../../omp/transport/index.js'
import type { SessionGoalSnapshot } from '../../../omp/vendor/pi-coding-agent'

interface GoalBarProps {
  sessionId?: string | null
  isCompact: boolean
  onSetGoal?: (objective: string, tokenBudget?: number) => Promise<boolean> | boolean
  queuedMessages?: ReactNode
}
type GoalOptions = Omit<PiCommandParams['goal'], 'op'>
type GoalView = { goal: SessionGoalSnapshot | null; enabled: boolean; mode: string }
const EMPTY_GOAL: GoalView = { goal: null, enabled: false, mode: '' }
const STATUS_KEYS: Record<string, string> = {
  active: 'goalBar.active', paused: 'goalBar.paused', 'budget-limited': 'goalBar.budgetLimited', complete: 'goalBar.complete',
}

function parseGoal(raw: unknown): GoalView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_GOAL
  const state = raw as Record<string, unknown>
  const value = state.goal as Record<string, unknown> | undefined
  if (!value || typeof value.objective !== 'string' || typeof value.id !== 'string' || value.status === 'dropped') return EMPTY_GOAL
  if (typeof value.tokensUsed !== 'number' || typeof value.timeUsedSeconds !== 'number') return EMPTY_GOAL
  return { enabled: state.enabled === true, mode: typeof state.mode === 'string' ? state.mode : '', goal: {
    id: value.id, objective: value.objective, status: typeof value.status === 'string' ? value.status : '',
    tokenBudget: typeof value.tokenBudget === 'number' ? value.tokenBudget : undefined,
    tokensUsed: value.tokensUsed, timeUsedSeconds: value.timeUsedSeconds,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  } }
}

function useSessionGoal(sessionId: string | null | undefined): GoalView {
  const cache = useRef<{ raw: unknown; out: GoalView }>({ raw: undefined, out: EMPTY_GOAL })
  const subscribe = useCallback((onChange: () => void) => piSessionStateStore.subscribe(onChange), [])
  const snapshot = useCallback(() => {
    const raw = sessionId ? piSessionStateStore.getState(sessionId)?.goalState : undefined
    if (cache.current.raw !== raw) cache.current = { raw, out: parseGoal(raw) }
    return cache.current.out
  }, [sessionId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`
}

export const GoalBar = memo(function GoalBar({ sessionId, isCompact, onSetGoal, queuedMessages }: GoalBarProps) {
  const { t } = useTranslation('chat')
  const { goal, mode, enabled } = useSessionGoal(sessionId)
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [budget, setBudget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const identity = useRef({ sessionId, epoch: 0 })
  if (identity.current.sessionId !== sessionId) identity.current = { sessionId, epoch: identity.current.epoch + 1 }
  const validBudget = budget.trim() === '' || (/^\d+$/.test(budget) && Number.isSafeInteger(Number(budget)) && Number(budget) > 0)
  const canReplace = !goal || (enabled && (goal.status === 'active' || goal.status === 'budget-limited'))
  const canOperate = !!sessionId || !!onSetGoal

  useEffect(() => { setEditorOpen(false); setBusy(false); setError(null) }, [sessionId])
  useEffect(() => {
    if (editorOpen) textareaRef.current?.focus()
  }, [editorOpen])
  useEffect(() => {
    if (!editorOpen || isCompact) return
    const outside = (event: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setEditorOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [editorOpen, isCompact])

  const openEditor = () => {
    setDraft(goal?.objective ?? '')
    setBudget(goal?.tokenBudget === undefined ? '' : String(goal.tokenBudget))
    setError(null)
    setEditorOpen(true)
  }
  const run = async (op: PiCommandParams['goal']['op'], options: GoalOptions = {}): Promise<boolean> => {
    if (!sessionId || busy) return false
    const captured = identity.current
    setBusy(true)
    setError(null)
    try {
      const command = await manageSessionGoal(sessionId, op, options)
      await waitHostCommand(command.id)
      try { await refreshPiSessionState(sessionId) }
      catch (cause) {
        if (captured === identity.current) setError(`${t('goalBar.refreshFailed')}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      return captured === identity.current
    } catch (cause) {
      if (captured === identity.current) setError(cause instanceof Error ? cause.message : t('goalBar.operationFailed'))
      return false
    } finally {
      if (captured === identity.current) setBusy(false)
    }
  }
  const save = async () => {
    if (!draft.trim() || !validBudget || busy) return
    const tokenBudget = budget.trim() === '' ? undefined : Number(budget)
    if (goal && draft.trim() === goal.objective) {
      if (await run('budget', tokenBudget === undefined ? { clearBudget: true } : { tokenBudget })) setEditorOpen(false)
    } else if (sessionId) {
      if (await run(goal ? 'replace' : 'create', { objective: draft.trim(), tokenBudget })) setEditorOpen(false)
    } else if (onSetGoal) {
      const captured = identity.current
      setBusy(true)
      try {
        const accepted = await onSetGoal(draft.trim(), tokenBudget)
        if (captured === identity.current) {
          if (accepted !== false) setEditorOpen(false)
          else setError(t('goalBar.saveFailed'))
        }
      } catch (cause) {
        if (captured === identity.current) setError(cause instanceof Error ? cause.message : t('goalBar.saveFailed'))
      } finally { if (captured === identity.current) setBusy(false) }
    }
  }
  const refresh = async () => {
    if (!sessionId || busy) return
    const captured = identity.current
    setBusy(true)
    setError(null)
    try { await refreshPiSessionState(sessionId) }
    catch (cause) { if (captured === identity.current) setError(cause instanceof Error ? cause.message : t('goalBar.operationFailed')) }
    finally { if (captured === identity.current) setBusy(false) }
  }
  const details = goal && (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-4 pb-2 text-[length:var(--fs-xs)] text-text-400" data-goal-metrics>
      <dt>{t('goalBar.id')}</dt><dd className="break-all">{goal.id}</dd>
      <dt>{t('goalBar.mode')}</dt><dd>{mode} / {enabled ? t('goalBar.enabled') : t('goalBar.disabled')}</dd>
      <dt>{t('goalBar.tokens')}</dt><dd>{goal.tokensUsed.toLocaleString()} / {goal.tokenBudget?.toLocaleString() ?? t('goalBar.unbounded')}</dd>
      <dt>{t('goalBar.remaining')}</dt><dd>{goal.tokenBudget === undefined ? t('goalBar.unbounded') : Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()}</dd>
      <dt>{t('goalBar.timeUsed')}</dt><dd>{elapsed(goal.timeUsedSeconds)}</dd>
    </dl>
  )
  const editor = (
    <div data-goal-editor-sheet className="rounded-2xl glass-alt">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-text-200">{t(goal ? 'goalBar.editGoal' : 'goalBar.setGoal')}</span>
        <IconButton size="sm" aria-label={t('common:close')} onClick={() => setEditorOpen(false)}><CloseIcon size={14} /></IconButton>
      </div>
      {details}
      {!sessionId && <p className="px-4 text-[length:var(--fs-xs)] text-text-400">{t('goalBar.noSessionHint')}</p>}
      <textarea ref={textareaRef} value={draft} onChange={event => setDraft(event.target.value)} disabled={busy || !canReplace}
        onPaste={event => {
          if (Array.from(event.clipboardData.items).some(item => item.kind === 'file' && item.type.startsWith('image/'))) {
            event.preventDefault(); setError(t('goalBar.imagesUnsupported'))
          }
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); setEditorOpen(false) }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() }
        }}
        placeholder={t('goalBar.objectivePlaceholder')} aria-label={t('goalBar.objective')} rows={isCompact ? 5 : 4}
        className="w-full resize-none bg-transparent px-4 py-2 text-text-100 focus:outline-none disabled:opacity-60" />
      <label className="flex items-center gap-2 px-4 pb-2 text-[length:var(--fs-sm)] text-text-300">
        {t('goalBar.tokenBudget')}
        <input aria-label={t('goalBar.tokenBudget')} type="text" inputMode="numeric" value={budget} onChange={event => setBudget(event.target.value)} disabled={busy}
          placeholder={t('goalBar.unbounded')} className="min-w-0 flex-1 rounded-lg border border-border-200 bg-transparent px-2 py-1" />
      </label>
      {!validBudget && <p role="alert" className="px-4 pb-2 text-red-400">{t('goalBar.invalidBudget')}</p>}
      <p className="px-4 pb-2 text-[length:var(--fs-xs)] text-text-500">{t('goalBar.nativeHint')}</p>
      {error && <p role="alert" className="px-4 pb-2 text-[length:var(--fs-xs)] text-red-400">{error}</p>}
      <div className="flex justify-end gap-2 px-3 pb-3" style={isCompact ? { paddingBottom: 'max(0.75rem, var(--safe-area-inset-bottom, 0px))' } : undefined}>
        <button type="button" onClick={() => setEditorOpen(false)} className="h-8 px-3 text-text-300">{t('common:cancel')}</button>
        <button type="button" onClick={() => void save()} disabled={busy || !draft.trim() || !validBudget}
          className="h-8 rounded-lg bg-accent-main-000 px-4 text-oncolor-100 disabled:opacity-40">{t('common:save')}</button>
      </div>
    </div>
  )
  return (
    <div ref={rootRef} className="relative z-0 min-w-0 mx-4 -mb-8 pb-8 rounded-2xl glass-alt border border-border-200/60" data-goal-bar>
      <div data-composer-queue className="max-h-[min(200px,25dvh)] overflow-y-auto custom-scrollbar rounded-t-2xl">{queuedMessages}</div>
      {editorOpen && !isCompact ? editor : (
        <div className="flex items-center gap-1 min-h-9 pl-3 pr-1.5 text-[length:var(--fs-sm)]">
          <TargetIcon size={14} className="shrink-0 text-accent-main-100" />
          <button type="button" onClick={openEditor} disabled={!canOperate || busy} className="min-w-0 flex-1 truncate text-left text-text-100"
            title={goal ? `${t(STATUS_KEYS[goal.status] ?? 'goalBar.unknownStatus')}: ${goal.objective}` : undefined}>
            {goal ? `${t(STATUS_KEYS[goal.status] ?? 'goalBar.unknownStatus')}: ${goal.objective}` : t('goalBar.setGoal')}
          </button>
          {sessionId && <IconButton size="sm" aria-label={t('goalBar.refresh')} onClick={() => void refresh()} disabled={busy}><ExpandIcon size={14} /></IconButton>}
          {goal && (goal.status === 'active' || goal.status === 'budget-limited' || goal.status === 'paused') && (
            <IconButton size="sm" aria-label={t(goal.status === 'paused' ? 'goalBar.resume' : 'goalBar.pause')}
              onClick={() => void run(goal.status === 'paused' ? 'resume' : 'pause')} disabled={!sessionId || busy}>
              {goal.status === 'paused' ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
            </IconButton>
          )}
          {goal && goal.status !== 'complete' && <button type="button" aria-label={t('goalBar.completeAction')} onClick={() => void run('complete')} disabled={!sessionId || busy}
            className="shrink-0 px-2 text-text-300 disabled:opacity-40">{t('goalBar.completeAction')}</button>}
          {goal && <IconButton size="sm" aria-label={t('goalBar.drop')} onClick={() => void run('drop')} disabled={!sessionId || busy}><TrashIcon size={14} /></IconButton>}
        </div>
      )}
      {goal && !editorOpen && <div className="px-4 pb-1 text-[length:var(--fs-xs)] text-text-400" data-goal-usage>
        {goal.tokensUsed.toLocaleString()} / {goal.tokenBudget?.toLocaleString() ?? t('goalBar.unbounded')} • {t('goalBar.remaining')}: {goal.tokenBudget === undefined ? t('goalBar.unbounded') : Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()} • {elapsed(goal.timeUsedSeconds)}
      </div>}
      {error && !editorOpen && <p role="alert" className="px-4 pb-2 text-[length:var(--fs-xs)] text-red-400">{error}</p>}
      {editorOpen && isCompact && createPortal(<div className="fixed inset-0 z-[250]">
        <div className="absolute inset-0 bg-black/50" onClick={() => setEditorOpen(false)} />
        <div className="absolute inset-x-0 bottom-0 max-h-[95dvh] overflow-y-auto custom-scrollbar rounded-t-2xl border-t border-border-200/60 shadow-2xl">{editor}</div>
      </div>, document.body)}
    </div>
  )
})
