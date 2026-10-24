import { memo, useState, useCallback, useEffect, useMemo, useSyncExternalStore, type RefCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { isJsonObject } from '@ompiui/protocol'
import { ContentBlock } from '../../../../components'
import { ChevronRightIcon, ExternalLinkIcon, StopIcon } from '../../../../components/Icons'
import { useDisclosureScrollLock } from '../../../../hooks'
import { useSessionNavigation } from '../../../../contexts/SessionNavigationContext'
import { abortPiOperation, openSubagentSession } from '../../../../omp/controllers/index.js'
import { getOmpSubagentMessages } from '../../../../omp/transport/index.js'
import { piSessionStateStore } from '../../../../omp/state/index.js'
import { activeSessionStore } from '../../../../store/activeSessionStore'
import {
  ompSubagentStore,
  transcriptItemsFromMessages,
  type OmpSubagentRun,
  type OmpSubagentTranscriptItem,
} from '../../../../omp/ompSubagentStore'
import { subagentDisplayTitle } from '../../../../omp/ompSubagentFormat'
import { buildPersistedSubagentRun, deriveChildSessionFile, extractPersistedResults, type PersistedSubagentResult } from './persistedSubagentRun'
import { useUiDisclosureState } from '../../../../utils/uiDisclosureState'
import type { ToolRendererProps } from '../types'
import { getToolExecutionStatus } from '../../../../omp/domain/index.js'
import { toolResultText } from '../toolResultContent'
import { MessageExpandPanel, useMessageExpandRender } from '../../messageExpand'
import { SubagentSessionPreview } from './SubagentSessionPreview'
import { useTaskRuntimeStopped } from '../useTaskRuntimeStopped'

// ============================================
// Task Tool Renderer (子 agent)
//
// 设计原则：
// 1. 渐进式展开 - 默认显示摘要，点击展开详情
// 2. 视觉层次 - 左侧缩进线区分嵌套层级
// 3. 状态优先 - 运行中/完成/错误状态一目了然
// 4. 按需交互 - 输入框只在需要时显示
// ============================================

type TaskSlot = {
  index: number
  input: Record<string, unknown>
  result?: PersistedSubagentResult
  liveRun?: OmpSubagentRun
}

export const TaskRenderer = memo(function TaskRenderer({ execution, partKey, data, onFullscreenChange }: ToolRendererProps) {
  const { currentSessionId } = useSessionNavigation()
  const { t } = useTranslation('message')
  const input = isJsonObject(execution.call.arguments) ? execution.call.arguments : undefined
  const metadata = isJsonObject(execution.result?.details) ? execution.result.details : undefined
  const results = useMemo(() => extractPersistedResults(metadata), [metadata])
  const liveRuns = useOmpSubagentRuns(execution.call.id, currentSessionId)
  const slots = useMemo(() => {
    const byIndex = new Map<number, TaskSlot>()
    const inputs = Array.isArray(input?.tasks) ? input.tasks.filter(isJsonObject) : [input ?? {}]
    inputs.forEach((task, index) => byIndex.set(index, { index, input: task }))
    results.forEach((result, position) => {
      const index = typeof result.index === 'number' ? result.index : position
      const slot = byIndex.get(index) ?? { index, input: {} }
      slot.result = result
      byIndex.set(index, slot)
    })
    for (const run of liveRuns) {
      const named = [...byIndex.values()].find(slot => slot.input.name === run.id || slot.result?.id === run.id)
      const index = named?.index ?? run.index
      const slot = named ?? byIndex.get(index) ?? { index, input: {} }
      slot.liveRun = run
      byIndex.set(index, slot)
    }
    if (byIndex.size === 0) byIndex.set(0, { index: 0, input: {} })
    return [...byIndex.values()].sort((a, b) => a.index - b.index)
  }, [input, results, liveRuns])
  const intent = typeof input?.i === 'string' ? input.i : typeof input?.description === 'string' ? input.description : undefined
  const sessionId = typeof metadata?.sessionId === 'string' ? metadata.sessionId : undefined
  return (
    <div className="min-w-0 space-y-2">
      {slots.map(slot => (
        <SubagentTask
          key={slot.index}
          slot={slot}
          execution={execution}
          partKey={`${partKey}:${slot.index}`}
          intent={intent}
          targetSessionId={slots.length === 1 ? sessionId : undefined}
          showAggregateOutput={slots.length === 1}
          onFullscreenChange={onFullscreenChange}
          aggregateError={data.error}
        />
      ))}
      {slots.length > 1 && (data.error || (execution.result && toolResultText(execution.result))) && (
        <ContentBlock label={t(getToolExecutionStatus(execution) === 'error' ? 'task.error' : 'task.result')} stateKey={`message:${partKey}:aggregate-result`} content={data.error || toolResultText(execution.result)} variant={getToolExecutionStatus(execution) === 'error' ? 'error' : undefined} defaultCollapsed onFullscreenChange={onFullscreenChange} fullscreenId={`task:${partKey}:aggregate-result`} />
      )}
    </div>
  )
})

function SubagentTask({ slot, execution, partKey, intent, targetSessionId, showAggregateOutput, aggregateError, onFullscreenChange }: {
  slot: TaskSlot
  execution: ToolRendererProps['execution']
  partKey: string
  intent?: string
  targetSessionId?: string
  showAggregateOutput: boolean
  onFullscreenChange?: ToolRendererProps['onFullscreenChange']
  aggregateError?: string
}) {
  const { t } = useTranslation('message')
  const { navigateToSession, currentDirectory, currentSessionId } = useSessionNavigation()
  // 先确认运行状态，再按展开状态读取历史；中断且没有结果的任务不能永久计时。
  const liveRun = slot.liveRun
  const runtimeStopped = useTaskRuntimeStopped()
  const executionStatus = getToolExecutionStatus(execution)
  const hasStarted = executionStatus !== 'pending' || (liveRun !== undefined && liveRun.status !== 'pending')
  const isRunning = liveRun
    ? liveRun.status === 'running' && (!execution.result || liveRun.detached) && (!runtimeStopped || liveRun.detached)
    : executionStatus === 'running' && !runtimeStopped
  // 运行中与失败都默认展开：失败说明（聚合结果、mergeError）不能折叠隐藏，
  // 否则 exitCode=0 但合并失败的子代理会看起来像全流程成功（#364/#374）。
  // 这里用不依赖子代理历史的先行判定作展开默认值。
  const prelimIsError = isTaskSlotFailed(slot.result, liveRun, executionStatus === 'error' || Boolean(execution.result?.isError))
  const [expanded, setExpanded] = useUiDisclosureState(`message:${partKey}:task-body`, isRunning || prelimIsError)
  const [isContentFullscreen, setIsContentFullscreen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const effectiveExpanded = expanded || isContentFullscreen
  const shouldRenderBody = useMessageExpandRender(effectiveExpanded)
  // 中途崩溃没有 task 结果，但已命名子代理的转录仍在父文件同名目录。
  const diskResult = useMemo<PersistedSubagentResult | undefined>(() => slot.result ??
    (hasStarted && typeof slot.input.name === 'string' && slot.input.name ? {
      id: slot.input.name,
      agent: typeof slot.input.agent === 'string' ? slot.input.agent : undefined,
      task: typeof slot.input.task === 'string' ? slot.input.task : undefined,
      index: slot.index,
    } : undefined), [slot.result, slot.input, slot.index, hasStarted])
  const { run: persistedRun, loading: previewLoading, reload: reloadPreview } = usePersistedSubagentRun(
    execution.call.id, diskResult, Boolean(liveRun), currentSessionId, shouldRenderBody,
    !slot.result ? runtimeStopped ? 'aborted' : isRunning ? 'running' : 'pending' : undefined,
  )
  const subagentRun = liveRun ?? persistedRun
  // 中断且无结果的任务（runtime 已停）也算失败；其余全部走 isTaskSlotFailed。
  const isError = prelimIsError || (!isRunning && hasStarted && !execution.result && runtimeStopped)
  const isCompleted = !isRunning && !isError && Boolean(slot.result || execution.result || subagentRun?.status === 'completed')
  const name = subagentDisplayTitle(
    typeof slot.input.name === 'string' ? slot.input.name : undefined,
    slot.result?.id,
  )
  const detail = subagentDisplayTitle(
    slot.result?.description,
    subagentRun?.description,
    typeof slot.input.description === 'string' ? slot.input.description : undefined,
    intent,
  )
  const description = name && detail && name !== detail
    ? `${name} · ${detail}`
    : name || detail || t('task.subtask')
  const prompt = typeof slot.input.prompt === 'string' ? slot.input.prompt
    : typeof slot.input.task === 'string' ? slot.input.task
      : slot.result?.assignment || subagentRun?.task || ''
  const agentType = subagentRun?.agent || (typeof slot.input.agent === 'string' ? slot.input.agent : undefined)
    || (typeof slot.input.subagent_type === 'string' ? slot.input.subagent_type : undefined) || 'task'
  const sessionFile = subagentRun?.sessionFile

  const handleOpenSubagent = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation()
    if (opening) return
    setOpening(true)
    setOpenError(null)
    try {
      if (sessionFile) {
        const directory = activeSessionStore.getSessionMeta(subagentRun?.sessionId ?? '')?.directory ?? currentDirectory ?? ''
        const target = await openSubagentSession(directory, sessionFile)
        navigateToSession(target.id, target.directory || undefined)
      } else if (targetSessionId) {
        navigateToSession(targetSessionId, currentDirectory || undefined)
      }
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error))
    } finally {
      setOpening(false)
    }
  }, [opening, sessionFile, subagentRun?.sessionId, targetSessionId, currentDirectory, navigateToSession])

  const resultOutput = [slot.result?.output, slot.result?.error, slot.result?.mergeError, execution.error,
    showAggregateOutput ? aggregateError || (execution.result ? toolResultText(execution.result) : undefined) : undefined].filter(value => typeof value === 'string' && value.trim()).join('\n')
  const handleContentFullscreenChange = useCallback((isFullscreen: boolean) => {
    setIsContentFullscreen(isFullscreen)
    onFullscreenChange?.(isFullscreen)
  }, [onFullscreenChange])
  const handleStop = useCallback((event: React.MouseEvent) => {
    event.stopPropagation()
    if (targetSessionId) void abortPiOperation(targetSessionId).catch(() => undefined)
  }, [targetSessionId])
  useEffect(() => {
    if (!isRunning) return
    const frameId = requestAnimationFrame(() => setExpanded(true, { touched: false, respectUser: true }))
    return () => cancelAnimationFrame(frameId)
  }, [isRunning, setExpanded])

  return (
    <div ref={rootRef} className="min-w-0">
      <TaskHeader
        agentType={agentType}
        description={description}
        status={isRunning ? 'running' : isError ? 'error' : isCompleted ? 'completed' : 'pending'}
        expanded={expanded}
        headerRef={headerRef}
        onToggle={() => withScrollLock(() => setExpanded(!expanded))}
        onOpenSession={sessionFile || targetSessionId ? handleOpenSubagent : undefined}
        opening={opening}
        onStop={isRunning && targetSessionId ? handleStop : undefined}
      />
      {openError && <p role="alert" className="pt-1 text-[length:var(--fs-xs)] text-danger-100 break-words">{openError}</p>}
      <MessageExpandPanel open={effectiveExpanded} innerClassName="overflow-hidden">
        {shouldRenderBody && (
          <div className="pt-2 space-y-3">
            {prompt && <div className="text-[length:var(--fs-xs)] text-text-500 leading-relaxed whitespace-nowrap overflow-hidden text-ellipsis">{prompt}</div>}
            {prompt && subagentRun && <hr className="border-border-200/30" />}
            {hasStarted && <SubagentSessionPreview run={subagentRun} loading={previewLoading} onLoadMore={persistedRun ? reloadPreview : undefined} />}
            {isCompleted && resultOutput && (
              <ContentBlock label={t('task.result')} stateKey={`message:${partKey}:task-result`} content={resultOutput} defaultCollapsed onFullscreenChange={handleContentFullscreenChange} fullscreenId={`task:${partKey}:result`} />
            )}
            {isError && (
              <ContentBlock label={t('task.error')} stateKey={`message:${partKey}:task-error`} content={resultOutput || t('task.taskFailed')} variant="error" onFullscreenChange={handleContentFullscreenChange} fullscreenId={`task:${partKey}:error`} />
            )}
          </div>
        )}
      </MessageExpandPanel>
    </div>
  )
}

// ============================================
// Task Header
// ============================================

interface TaskHeaderProps {
  agentType: string
  description: string
  status: string
  expanded: boolean
  onToggle: () => void
  headerRef?: RefCallback<HTMLElement>
  sessionId?: string
  /** 打开子会话（OMP 按 sessionFile 直开；pi 驱动按 sessionId 导航） */
  onOpenSession?: (e: React.MouseEvent) => void
  onStop?: (e: React.MouseEvent) => void
  opening?: boolean
}

export const TaskHeader = memo(function TaskHeader({
  agentType,
  description,
  status,
  expanded,
  onToggle,
  headerRef,
  sessionId,
  onOpenSession,
  onStop,
  opening = false,
}: TaskHeaderProps) {
  const { t } = useTranslation('message')
  const { navigateToSession, currentDirectory } = useSessionNavigation()
  const handleOpenSession = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!sessionId) return
      navigateToSession(sessionId, currentDirectory || undefined)
    },
    [sessionId, navigateToSession, currentDirectory],
  )

  const isRunning = status === 'running'
  const isError = status === 'error'
  const isCompleted = status === 'completed'

  const agentBadgeClass = `shrink-0 px-1.5 py-0.5 text-[length:var(--fs-xxs)] font-medium rounded-xs ${
    isRunning
      ? 'bg-accent-main-100/20 text-accent-main-100'
      : isError
        ? 'bg-danger-100/20 text-danger-100'
        : isCompleted
          ? 'bg-accent-secondary-100/20 text-accent-secondary-100'
          : 'bg-bg-300 text-text-300'
  }`

  return (
    <div ref={headerRef} className="flex items-center gap-2 py-1 group">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? t('showLess') : t('showMore')}
        title={expanded ? t('showLess') : t('showMore')}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm text-text-400 transition-colors hover:bg-bg-200/70 hover:text-text-100 bg-transparent border-none p-0"
      >
        {/* Expand icon */}
        <span className={`text-text-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>
          <ChevronRightIcon size={12} />
        </span>
      </button>

      {sessionId || onOpenSession ? (
        <button
          type="button"
          disabled={opening}
          aria-busy={opening}
          onClick={onOpenSession ?? handleOpenSession}
          className={`${agentBadgeClass} border-none transition-opacity hover:opacity-80`}
          title={t('task.openSession')}
        >
          {agentType}
        </button>
      ) : (
        <span className={agentBadgeClass}>{agentType}</span>
      )}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group/title flex min-w-0 flex-1 self-stretch items-center text-left bg-transparent border-none p-0"
        title={expanded ? t('showLess') : t('showMore')}
      >
        <span className="min-w-0 truncate text-[length:var(--fs-sm)] text-text-300 group-hover/title:text-text-100">
          {description}
        </span>
      </button>
      {status === 'pending' && <span className="text-[length:var(--fs-xxs)] text-text-400">{t('toolPart.pending')}</span>}

      {/* Stop button (running) */}
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          aria-label={t('task.stop')}
          className="flex-shrink-0 w-[18px] h-[18px] p-0 flex items-center justify-center text-text-400 hover:text-danger-100 hover:bg-danger-100/10 rounded-sm transition-colors active:scale-90 bg-transparent border-none"
          title={t('task.stop')}
        >
          <StopIcon size={10} />
        </button>
      )}

      {/* Open session */}
      {(sessionId || onOpenSession) && (
        <button
          type="button"
          onClick={onOpenSession ?? handleOpenSession}
          disabled={opening}
          aria-busy={opening}
          aria-label={t('task.openSession')}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm text-text-300 hover:text-accent-main-100 hover:bg-bg-200 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-main-100 disabled:opacity-50 bg-transparent border-none"
          title={t('task.openSession')}
        >
          <ExternalLinkIcon size={12} />
        </button>
      )}
    </div>
  )
})

// ============================================
// Sub Session View —— OMP 子代理实时转录
//
// OMP 的 task 工具（subagent）在 `omp --mode rpc` 下通过 subagent_lifecycle /
// subagent_progress / subagent_event 帧实时上报（parentToolCallId 关联到本
// 工具调用的 call.id）。渲染贴近 OpenCodeUI 的 SubSessionView：
// 消息分组、运行中工具徽标和预览滚动由 SubagentSessionPreview 负责。
// ============================================

function useOmpSubagentRuns(toolCallId: string, parentSessionId: string | null | undefined): OmpSubagentRun[] {
  // 按 call.id 分片订阅：别的 run 刷帧不会换本键的引用，长会话里
  // 几十个 TaskRenderer 不会跟着每一个子代理帧重渲染（卡死根因）
  const getRuns = useCallback(
    () => ompSubagentStore.getRunsForToolCall(toolCallId, parentSessionId),
    [toolCallId, parentSessionId],
  )
  return useSyncExternalStore(ompSubagentStore.subscribe, getRuns, getRuns)
}

// ============================================
// 落盘回退 hook：run 重建的纯逻辑在 persistedSubagentRun.ts，
// 这里负责拉取子会话文件的磁盘转录（subagent.messages 的 worker 端兜底）。
// ============================================

/**
 * 从持久化结果重建子代理 run 并拉取磁盘转录。仅在实时注册表没有对应
 * run 时生效（有 run 说明实时路径在工作，回退让位）。
 *
 * 转录按需拉取（enabled）：折叠的历史 task 行不触发任何 worker 调用，
 * 展开时才去解析子会话文件。长会话挂载时数十行并发 list/preview 会
 * 把 worker 的同步文件解析打满，实时帧全部停摆（卡死帮凶）。
 */
function usePersistedSubagentRun(
  callId: string,
  result: PersistedSubagentResult | undefined,
  hasLiveRun: boolean,
  parentSessionId: string | null | undefined,
  enabled: boolean,
  fallbackStatus?: OmpSubagentRun['status'],
): { run?: OmpSubagentRun; loading: boolean; reload: () => void } {
  // 只选原始值（sessionFile/cwd 字符串）：订阅整个 state 对象会让
  // 每个历史 task 行跟着父会话的每次 state 刷新重渲染
  const getParentFile = useCallback(() => {
    const state = parentSessionId ? piSessionStateStore.getState(parentSessionId) : null
    return typeof state?.sessionFile === 'string' ? state.sessionFile : null
  }, [parentSessionId])
  const parentFile = useSyncExternalStore(piSessionStateStore.subscribe, getParentFile, getParentFile)
  const baseRun = useMemo(() => {
    if (hasLiveRun || !result || !parentSessionId) return undefined
    const run = buildPersistedSubagentRun(callId, result, deriveChildSessionFile(result, parentFile ?? undefined), parentSessionId)
    return run && fallbackStatus ? { ...run, status: fallbackStatus } : run
  }, [callId, hasLiveRun, parentSessionId, result, parentFile, fallbackStatus])
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision(value => value + 1), [])
  const [loaded, setLoaded] = useState<{ key: string; items: OmpSubagentTranscriptItem[]; revision?: number; truncated?: boolean; hasMore?: boolean }>({ key: '', items: [] })
  useEffect(() => {
    if (!enabled || !baseRun?.sessionFile || !parentSessionId) return
    let cancelled = false
    const controller = new AbortController()
    // 走 subagent.messages 磁盘兜底：只读这一份子会话文件。
    // 不要 open + previewSessionById——后者会 summarizeAll / 深度扫全部子会话。
    void getOmpSubagentMessages(parentSessionId, { sessionFile: baseRun.sessionFile }, controller.signal)
      .then(result => {
        if (cancelled) return
        const record = result && typeof result === 'object' && !Array.isArray(result)
          ? result as Record<string, unknown>
          : undefined
        const messages = Array.isArray(record?.messages) ? record.messages as unknown[] : []
        setLoaded({ key: baseRun.id, items: transcriptItemsFromMessages(messages), revision,
          truncated: Boolean(record?.truncated), hasMore: Boolean(record?.hasMore) })
      }).catch(() => {
        if (!cancelled) setLoaded({ key: baseRun.id, items: [], revision })
      })
    return () => { cancelled = true; controller.abort() }
  }, [baseRun?.id, baseRun?.sessionFile, parentSessionId, enabled, revision])
  return useMemo(
    () => ({
      run: baseRun ? { ...baseRun, transcript: loaded.key === baseRun.id ? loaded.items : [],
        historyLoaded: loaded.key === baseRun.id, historyTruncated: loaded.truncated, historyHasMore: loaded.hasMore } : undefined,
      loading: Boolean(enabled && baseRun?.sessionFile && (loaded.key !== baseRun.id || loaded.revision !== revision)),
      reload,
    }),
    [baseRun, loaded, enabled, revision, reload],
  )
}

// ============================================
// Icons & Helpers
// ============================================

/**
 * 子任务失败判定（#400）：有自身结果或实时 run 时只看自身，
 * 两者都缺才回退聚合状态，避免批量 task 一个失败全员标红。
 * exitCode=0 但 mergeError 存在仍算失败（#374）。
 * 落盘回退 run 的状态是合成的（fallbackStatus），不算自身证据。
 */
function isTaskSlotFailed(
  result: PersistedSubagentResult | undefined,
  liveRun: OmpSubagentRun | undefined,
  aggregateFailed: boolean,
): boolean {
  const runFailed = liveRun?.status === 'failed' || liveRun?.status === 'aborted'
  // 非终态的实时 run 不算自身证据：聚合已结束而 run 仍停在 running 时要回退聚合
  if (!result && !runFailed && liveRun?.status !== 'completed') return aggregateFailed
  const resultFailed = Boolean(result && (result.aborted || result.error || result.mergeError ||
    (result.exitCode !== undefined && result.exitCode !== 0)))
  return resultFailed || runFailed
}
