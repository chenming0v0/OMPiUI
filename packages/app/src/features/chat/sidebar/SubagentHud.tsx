import { memo, useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentIcon, ChevronDownIcon, CloseIcon, StopIcon } from '../../../components/Icons'
import { useSessionNavigation } from '../../../contexts/SessionNavigationContext'
import { abortPiOperation, openSubagentSession } from '../../../omp/controllers/index.js'
import { ompSubagentStore, selectHudRuns, type OmpSubagentRun } from '../../../omp/ompSubagentStore'
import { formatCompactDuration, formatCompactTokens } from '../../../omp/ompSubagentFormat'
import { activeSessionStore } from '../../../store/activeSessionStore'

// ============================================
// SubagentHud —— detached 后台子代理的全局 HUD 侧栏
//
// 语义对齐 OpenCodeUI 的 pinned 列表：不随当前会话/项目过滤变化，
// 常驻钉在侧栏内容区顶部（recents/active 两个 tab 都可见）。
// 数据源是 ompSubagentStore 的 detached run：
// - 运行中的条目即使父会话没有打开 pane 也会经 server 流镜像推进
// - 点击行跳到父会话（TaskRenderer 内联视图承接转录）
// - 终态条目可单条清除或一键清空；清除记录持久化到 localStorage
// ============================================

const COLLAPSED_STORAGE_KEY = 'ompiui-subagent-hud-collapsed'

interface SubagentHudProps {
  selectedSessionId: string | null
  onSelectSession: (session: { id: string; directory?: string }) => void
  onCloseMobile?: () => void
}

function isTerminal(run: OmpSubagentRun): boolean {
  return run.status !== 'running' && run.status !== 'pending'
}

function loadCollapsed(): boolean {
  return localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1'
}

export const SubagentHud = memo(function SubagentHud({ selectedSessionId, onSelectSession, onCloseMobile }: SubagentHudProps) {
  const { t } = useTranslation('chat')
  const { navigateToSession, currentDirectory } = useSessionNavigation()
  const snapshot = useSyncExternalStore(
    ompSubagentStore.subscribe,
    ompSubagentStore.getSnapshot,
    ompSubagentStore.getSnapshot,
  )
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const [openError, setOpenError] = useState<string | null>(null)

  const runs = useMemo(() => selectHudRuns(snapshot), [snapshot])
  const runningCount = useMemo(
    () => runs.filter(run => !isTerminal(run)).length,
    [runs],
  )
  const finishedCount = runs.length - runningCount

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // 持久化失败只影响刷新后的记忆
      }
      return next
    })
  }, [])

  // 点击行 → 打开子代理会话（看它在做什么，OpenCodeUI children 语义）；
  // 子会话文件未知（如刚启动尚未落盘）时回落到父会话
  const handleSelect = useCallback(
    (run: OmpSubagentRun) => {
      const directory = activeSessionStore.getSessionMeta(run.sessionId)?.directory ?? currentDirectory ?? ''
      if (run.sessionFile) {
        setOpenError(null)
        void openSubagentSession(directory, run.sessionFile).then(target => {
          navigateToSession(target.id, target.directory || undefined)
          if (window.innerWidth < 768) onCloseMobile?.()
        }).catch((error: unknown) => {
          setOpenError(error instanceof Error ? error.message : String(error))
        })
        return
      }
      onSelectSession({ id: run.sessionId, directory: directory || undefined })
    },
    [onSelectSession, navigateToSession, currentDirectory, onCloseMobile],
  )

  const handleStop = useCallback((e: React.MouseEvent, run: OmpSubagentRun) => {
    e.stopPropagation()
    void abortPiOperation(run.sessionId).catch(() => undefined)
  }, [])

  const handleDismiss = useCallback((e: React.MouseEvent, run: OmpSubagentRun) => {
    e.stopPropagation()
    ompSubagentStore.dismiss(run.id)
  }, [])

  const handleClearFinished = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    for (const run of runs) {
      if (isTerminal(run)) ompSubagentStore.dismiss(run.id)
    }
  }, [runs])

  if (runs.length === 0) return null

  return (
    <section aria-label={t('sidebar.subagentHud')} className="mx-2 mb-1 shrink-0">
      <div className="rounded-lg border border-border-200/60 glass-alt overflow-hidden">
        {/* 头部：折叠开关 + 计数 + 清除终态 */}
        <div className="flex items-center gap-1 pl-1.5 pr-1 h-8">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('sidebar.subagentHudExpand') : t('sidebar.subagentHudCollapse')}
            className="flex flex-1 min-w-0 items-center gap-1.5 h-full text-left bg-transparent border-none p-0"
          >
            <AgentIcon size={13} className="shrink-0 text-accent-main-100" />
            <span className="text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wider text-text-300 truncate">
              {t('sidebar.subagentHud')}
            </span>
            <span
              className={`inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-full px-1 text-[length:var(--fs-xxs)] font-medium leading-none ${
                runningCount > 0 ? 'bg-accent-main-100/15 text-accent-main-100' : 'bg-bg-300 text-text-400'
              }`}
            >
              {runningCount > 0 ? runningCount : runs.length}
            </span>
            <ChevronDownIcon
              size={13}
              className={`ml-auto shrink-0 text-text-400 transition-transform ${collapsed ? '' : 'rotate-180'}`}
            />
          </button>
          {!collapsed && finishedCount > 0 && (
            <button
              type="button"
              onClick={handleClearFinished}
              aria-label={t('sidebar.subagentHudClearFinished', { count: finishedCount })}
              title={t('sidebar.subagentHudClearFinished', { count: finishedCount })}
              className="shrink-0 h-6 w-6 flex items-center justify-center rounded-md text-text-400 hover:text-text-100 hover:bg-bg-200/60 transition-colors bg-transparent border-none p-0"
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>
        {openError && <p role="alert" className="px-2 pb-2 text-[length:var(--fs-xs)] text-danger-100">{openError}</p>}

        {!collapsed && (
          <div className="px-1 pb-1 space-y-0.5">
            {runs.map(run => (
              <SubagentHudRow
                key={run.id}
                run={run}
                isSelected={run.sessionId === selectedSessionId}
                onSelect={handleSelect}
                onStop={handleStop}
                onDismiss={handleDismiss}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
})

interface SubagentHudRowProps {
  run: OmpSubagentRun
  isSelected: boolean
  onSelect: (run: OmpSubagentRun) => void
  onStop: (e: React.MouseEvent, run: OmpSubagentRun) => void
  onDismiss: (e: React.MouseEvent, run: OmpSubagentRun) => void
}

const SubagentHudRow = memo(function SubagentHudRow({ run, isSelected, onSelect, onStop, onDismiss }: SubagentHudRowProps) {
  const { t } = useTranslation('chat')
  const terminal = isTerminal(run)
  const isFailed = run.status === 'failed' || run.status === 'aborted'
  const progress = run.progress
  const description = run.description || run.task || run.agent
  const durationMs = terminal
    ? (run.endedAt ?? 0) - run.startedAt || progress?.durationMs
    : progress?.durationMs

  const dotClass = terminal
    ? isFailed
      ? 'bg-danger-100'
      : 'bg-success-100'
    : 'bg-info-100 animate-pulse'
  const badgeClass = terminal
    ? isFailed
      ? 'bg-danger-100/15 text-danger-100'
      : 'bg-accent-secondary-100/15 text-accent-secondary-100'
    : 'bg-accent-main-100/15 text-accent-main-100'

  const stats = progress
    ? [
        `${progress.toolCount} tools`,
        `${formatCompactTokens(progress.tokens)} tok`,
        typeof durationMs === 'number' && durationMs > 0 ? formatCompactDuration(durationMs) : undefined,
      ].filter(Boolean).join(' · ')
    : ''

  return (
    <div
      className={`group/row flex flex-col gap-0.5 rounded-md pl-1.5 pr-1 py-1 transition-colors ${
        isSelected ? 'bg-bg-200/60' : 'hover:bg-bg-200/50'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
        <button
          type="button"
          onClick={() => onSelect(run)}
          title={t('sidebar.subagentHudOpenSession')}
          className="flex flex-1 min-w-0 items-center gap-1.5 text-left bg-transparent border-none p-0"
        >
          <span className={`shrink-0 px-1 py-0.5 rounded-xs text-[length:var(--fs-xxs)] font-medium ${badgeClass}`}>
            {run.agent}
          </span>
          <span className="min-w-0 flex-1 truncate text-[length:var(--fs-xs)] text-text-300 group-hover/row:text-text-100">
            {description}
          </span>
          {stats && (
            <span className="shrink-0 hidden md:block text-[length:var(--fs-xxs)] font-mono tabular-nums text-text-500">
              {stats}
            </span>
          )}
        </button>
        {terminal ? (
          <button
            type="button"
            onClick={e => onDismiss(e, run)}
            aria-label={t('sidebar.subagentHudDismiss')}
            title={t('sidebar.subagentHudDismiss')}
            className="shrink-0 w-5 h-5 p-0 flex items-center justify-center rounded-sm text-text-500 hover:text-text-100 hover:bg-bg-300 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 transition-all bg-transparent border-none"
          >
            <CloseIcon size={11} />
          </button>
        ) : (
          <button
            type="button"
            onClick={e => onStop(e, run)}
            aria-label={t('sidebar.subagentHudStop')}
            title={t('sidebar.subagentHudStop')}
            className="shrink-0 w-5 h-5 p-0 flex items-center justify-center rounded-sm text-text-400 hover:text-danger-100 hover:bg-danger-100/10 transition-colors active:scale-90 bg-transparent border-none"
          >
            <StopIcon size={10} />
          </button>
        )}
      </div>
      {/* 运行中第二行：当前正在执行的工具 */}
      {!terminal && progress?.currentTool && (
        <div className="pl-3">
          <span className="block truncate text-[length:var(--fs-xxs)] font-mono text-text-500">
            {progress.currentToolArgs ? `${progress.currentTool} · ${progress.currentToolArgs.slice(0, 40)}` : progress.currentTool}
          </span>
        </div>
      )}
    </div>
  )
})
