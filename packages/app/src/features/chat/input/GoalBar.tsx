import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { IconButton } from '../../../components/ui'
import {
  CloseIcon,
  ExpandIcon,
  PauseIcon,
  PlayIcon,
  TargetIcon,
  TrashIcon,
} from '../../../components/Icons'
import { piSessionStateStore } from '../../../omp/state/index.js'
import { manageSessionGoal } from '../../../omp/transport/index.js'
import type { SessionGoalSnapshot } from '../../../omp/vendor/pi-coding-agent'

interface GoalBarProps {
  sessionId?: string | null
  isCompact: boolean
}

const GOAL_STATUS_KEYS: Record<string, string> = {
  active: 'goalBar.active',
  paused: 'goalBar.paused',
  'budget-limited': 'goalBar.budgetLimited',
  complete: 'goalBar.complete',
}

/** 防御式解析 state.goal / goal_updated 事件里的 goal 快照（外来 JSON） */
function parseGoal(raw: unknown): SessionGoalSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.objective !== 'string' || value.objective.trim() === '') return null
  // dropGoal 会先广播一次 status=dropped 的 goal 再清空，UI 视为无目标
  if (value.status === 'dropped') return null
  return {
    id: typeof value.id === 'string' ? value.id : '',
    objective: value.objective,
    status: typeof value.status === 'string' ? value.status : 'active',
    tokenBudget: typeof value.tokenBudget === 'number' ? value.tokenBudget : undefined,
    tokensUsed: typeof value.tokensUsed === 'number' ? value.tokensUsed : 0,
    timeUsedSeconds: typeof value.timeUsedSeconds === 'number' ? value.timeUsedSeconds : 0,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  }
}

function useSessionGoal(sessionId: string | null | undefined): SessionGoalSnapshot | null {
  // useSyncExternalStore 要求 getSnapshot 返回稳定引用：state 对象没变时
  // 必须复用上次解析结果，否则每次调用都产出新对象 → 无限重渲染崩溃
  const cacheRef = useRef<{ raw: unknown; out: SessionGoalSnapshot | null }>({ raw: undefined, out: null })
  const subscribe = useCallback(
    (onStoreChange: () => void) => piSessionStateStore.subscribe(onStoreChange),
    [],
  )
  const getSnapshot = useCallback((): SessionGoalSnapshot | null => {
    const raw = sessionId ? piSessionStateStore.getState(sessionId)?.goal : undefined
    const cache = cacheRef.current
    if (cache.raw === raw) return cache.out
    const out = parseGoal(raw)
    cacheRef.current = { raw, out }
    return out
  }, [sessionId])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function normalizeMs(timestamp: number): number | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null
  // 秒级时间戳 → 毫秒
  return timestamp < 1e12 ? timestamp * 1000 : timestamp
}

function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** 桌面端锚在输入框上方的浮层 / 移动端从底部弹出的 sheet，共用同一份编辑器内容 */
function GoalEditor({
  goal,
  draft,
  onDraftChange,
  onSave,
  onClose,
  onDrop,
  isCompact,
  sessionId,
}: {
  goal: SessionGoalSnapshot | null
  draft: string
  onDraftChange: (value: string) => void
  onSave: () => void
  onClose: () => void
  onDrop: () => void
  isCompact: boolean
  sessionId?: string | null
}) {
  const { t } = useTranslation('chat')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSave = draft.trim().length > 0 && !!sessionId

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      if (canSave) onSave()
    }
  }

  const body = (
    <>
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="flex items-center gap-2 text-[length:var(--fs-sm)] font-medium text-text-200">
          <TargetIcon size={14} className="text-accent-main-100" />
          {t('goalBar.editGoal')}
        </div>
        <IconButton size="sm" aria-label={t('common:close')} onClick={onClose}>
          <CloseIcon size={14} />
        </IconButton>
      </div>
      {!sessionId && (
        <div className="px-4 py-2 mx-3 mb-2 rounded-lg bg-accent-main-100/10 border border-accent-main-100/20">
          <p className="text-[length:var(--fs-sm)] text-text-300">
            {t('goalBar.noSessionHint')}
          </p>
        </div>
      )}
      <div className="px-3">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={event => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('goalBar.objectivePlaceholder')}
          disabled={!sessionId}
          rows={isCompact ? 5 : 4}
          className="w-full resize-none bg-transparent rounded-xl px-2 py-2 text-text-100 placeholder:text-text-500 focus:outline-none custom-scrollbar text-[length:var(--fs-base)] disabled:opacity-50 disabled:cursor-not-allowed"
        />
      </div>
      <div
        className="flex items-center gap-2 px-3 pb-3"
        style={isCompact ? { paddingBottom: 'max(0.75rem, var(--safe-area-inset-bottom, 0px))' } : undefined}
      >
        {goal && sessionId && (
          <button
            type="button"
            onClick={onDrop}
            className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg text-[length:var(--fs-sm)] text-red-400 hover:bg-red-400/10 transition-colors"
          >
            <TrashIcon size={13} />
            {t('goalBar.drop')}
          </button>
        )}
        <div className="flex-1" />
        {!isCompact && (
          <span className="text-[length:var(--fs-xs)] text-text-500/70">{t('goalBar.saveHint')}</span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="h-8 px-3 rounded-lg text-[length:var(--fs-sm)] text-text-300 hover:bg-bg-200 transition-colors"
        >
          {t('common:cancel')}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className="h-8 px-4 rounded-lg text-[length:var(--fs-sm)] bg-accent-main-000 hover:bg-accent-main-200 text-oncolor-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('common:save')}
        </button>
      </div>
    </>
  )

  if (isCompact) {
    // 移动端：底部弹层（portal 到 body，避免被输入区的 transform 包裹层困住）
    return createPortal(
      <div className="fixed inset-0 z-[250]">
        <div className="absolute inset-0 bg-black/50 animate-goal-backdrop-in" onClick={onClose} />
        <div
          data-goal-editor-sheet
          className="absolute inset-x-0 bottom-0 rounded-t-2xl glass border-t border-border-200/60 shadow-2xl animate-goal-sheet-in"
        >
          <div className="flex justify-center pt-2 pb-1">
            <div className="h-1 w-10 rounded-full bg-border-200" />
          </div>
          {body}
        </div>
      </div>,
      document.body,
    )
  }

  return (
    <div
      data-goal-editor-sheet
      className="absolute bottom-full left-0 right-0 mb-2 z-40 glass border border-border-200/60 rounded-2xl shadow-lg overflow-hidden"
    >
      {body}
    </div>
  )
}

export const GoalBar = memo(function GoalBar({ sessionId, isCompact }: GoalBarProps) {
  const { t } = useTranslation('chat')
  const goal = useSessionGoal(sessionId)
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)

  // active 目标的已用时间本地跳动（goal_updated / state 刷新间不冻结）
  useEffect(() => {
    if (!goal || goal.status !== 'active') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [goal?.status, goal?.updatedAt])

  // 桌面端点击浮层外关闭；移动端 sheet 有遮罩，不需要
  useEffect(() => {
    if (!editorOpen || isCompact) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current && !rootRef.current.contains(target)) setEditorOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [editorOpen, isCompact])

  const openEditor = useCallback(() => {
    setDraft(goal?.objective ?? '')
    setEditorOpen(true)
  }, [goal?.objective])

  const closeEditor = useCallback(() => setEditorOpen(false), [])

  // goal 操作走 worker 侧的 `goal` 命令：确定性变更 + worker 合成 goal_updated
  // 事件 → eventStream 刷新 state → 本组件经 piSessionStateStore 拿到新快照
  const runGoalOp = useCallback(
    (op: 'set' | 'pause' | 'resume' | 'drop', objective?: string) => {
      if (!sessionId) return
      manageSessionGoal(sessionId, op, objective).catch(() => undefined)
    },
    [sessionId],
  )

  const handleSave = useCallback(() => {
    const text = draft.trim()
    if (text === '') return
    setEditorOpen(false)
    runGoalOp('set', text)
  }, [draft, runGoalOp])

  const handleTogglePause = useCallback(() => {
    runGoalOp(goal?.status === 'paused' ? 'resume' : 'pause')
  }, [goal?.status, runGoalOp])

  const handleDrop = useCallback(() => {
    setEditorOpen(false)
    runGoalOp('drop')
  }, [runGoalOp])

  // 已用时长：快照值 + active 时从 updatedAt 到现在的本地增量
  let elapsedLabel: string | null = null
  if (goal) {
    let seconds = goal.timeUsedSeconds
    if (goal.status === 'active') {
      const updatedAtMs = normalizeMs(goal.updatedAt)
      if (updatedAtMs !== null) {
        seconds += Math.max(0, (now - updatedAtMs) / 1000)
      }
    }
    elapsedLabel = formatElapsed(seconds)
  }

  const statusKey = goal ? (GOAL_STATUS_KEYS[goal.status] ?? 'goalBar.active') : 'goalBar.setGoal'

  // 无 sessionId 时禁用操作按钮但仍允许打开编辑器（用户可以看到占位提示）
  const canOperate = !!sessionId

  return (
    <div ref={rootRef} className="relative" data-goal-bar>
      {editorOpen && (
        <GoalEditor
          goal={goal}
          draft={draft}
          onDraftChange={setDraft}
          onSave={handleSave}
          onClose={closeEditor}
          onDrop={handleDrop}
          isCompact={isCompact}
          sessionId={sessionId}
        />
      )}

      {goal ? (
        <div className="mb-2 flex items-center gap-1 h-9 pl-3 pr-1.5 rounded-xl glass border border-border-200/60 text-[length:var(--fs-sm)]">
          <TargetIcon size={14} className="shrink-0 text-accent-main-100" />
          <button
            type="button"
            onClick={openEditor}
            title={goal.objective}
            disabled={!canOperate}
            className="flex items-center gap-2 min-w-0 flex-1 text-left disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="shrink-0 text-text-300">{t(statusKey)}</span>
            <span className="truncate text-text-100">{goal.objective}</span>
            {elapsedLabel && <span className="shrink-0 text-text-500">• {elapsedLabel}</span>}
          </button>
          {/* 只有可暂停/可恢复的状态才显示切换按钮；complete/dropped 无意义 */}
          {(goal.status === 'active' || goal.status === 'paused' || goal.status === 'budget-limited') && (
            <IconButton
              size="sm"
              aria-label={t(goal.status === 'paused' ? 'goalBar.resume' : 'goalBar.pause')}
              onClick={handleTogglePause}
              disabled={!canOperate}
            >
              {goal.status === 'paused' ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
            </IconButton>
          )}
          <IconButton size="sm" aria-label={t('goalBar.editGoal')} onClick={openEditor} disabled={!canOperate}>
            <ExpandIcon size={14} />
          </IconButton>
          <IconButton size="sm" aria-label={t('goalBar.drop')} onClick={handleDrop} disabled={!canOperate}>
            <TrashIcon size={14} />
          </IconButton>
        </div>
      ) : (
        <button
          type="button"
          onClick={openEditor}
          disabled={!canOperate}
          className="mb-2 w-full flex items-center justify-center gap-2 h-10 px-4 rounded-xl glass border border-border-200/60 text-[length:var(--fs-sm)] font-medium text-text-200 hover:text-accent-main-100 hover:border-accent-main-100/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-text-200 disabled:hover:border-border-200/60 shadow-sm hover:shadow-md"
        >
          <TargetIcon size={16} className="shrink-0" />
          <span>{t('goalBar.setGoal')}</span>
        </button>
      )}
    </div>
  )
})
