import { memo, useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type RefCallback } from 'react'
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
import { formatCompactDuration, formatCompactTokens, subagentDisplayTitle } from '../../../../omp/ompSubagentFormat'
import { buildPersistedSubagentRun, deriveChildSessionFile, extractPersistedResults, type PersistedSubagentResult } from './persistedSubagentRun'
import { useUiDisclosureState } from '../../../../utils/uiDisclosureState'
import type { ToolRendererProps } from '../types'
import { toolResultText } from '../toolResultContent'
import { MessageExpandPanel, useMessageExpandRender } from '../../messageExpand'

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

export const TaskRenderer = memo(function TaskRenderer({ execution, partKey, onFullscreenChange }: ToolRendererProps) {
  const { currentSessionId } = useSessionNavigation()
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
        />
      ))}
    </div>
  )
})

function SubagentTask({ slot, execution, partKey, intent, targetSessionId, showAggregateOutput, onFullscreenChange }: {
  slot: TaskSlot
  execution: ToolRendererProps['execution']
  partKey: string
  intent?: string
  targetSessionId?: string
  showAggregateOutput: boolean
  onFullscreenChange?: ToolRendererProps['onFullscreenChange']
}) {
  const { t } = useTranslation('message')
  const { navigateToSession, currentDirectory, currentSessionId } = useSessionNavigation()
  // liveRun 缺席时持久化 run 必为终态（completed/failed/aborted），isRunning
  // 只由 liveRun / 工具结果决定，可先于转录 hook 计算——转录拉取要用
  // shouldRenderBody 门控（折叠的历史行不触发 worker 调用）
  const liveRun = slot.liveRun
  const isRunning = liveRun ? liveRun.status === 'running' || liveRun.status === 'pending' : !execution.result
  const [expanded, setExpanded] = useUiDisclosureState(`message:${partKey}:task-body`, isRunning)
  const [isContentFullscreen, setIsContentFullscreen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const effectiveExpanded = expanded || isContentFullscreen
  const shouldRenderBody = useMessageExpandRender(effectiveExpanded)
  const persistedRun = usePersistedSubagentRun(execution.call.id, slot.result, Boolean(liveRun), currentSessionId, shouldRenderBody)
  const subagentRun = liveRun ?? persistedRun
  const isError = subagentRun ? subagentRun.status === 'failed' || subagentRun.status === 'aborted' : Boolean(execution.result?.isError)
  const isCompleted = !isRunning && !isError
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

  const resultOutput = typeof slot.result?.output === 'string' ? slot.result.output
    : showAggregateOutput && execution.result ? toolResultText(execution.result) : undefined
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
        status={isRunning ? 'running' : isError ? 'error' : 'completed'}
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
            <SubSessionView run={subagentRun} />
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

  const isRunning = status === 'running' || status === 'pending'
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
// 状态行（当前工具 / token / 时长）+ 工具徽标流 + 用户/助手消息迷你气泡。
// ============================================

interface SubSessionViewProps {
  /** 实时 run（ompSubagentStore）或落盘重建的 run；两者皆缺时显示等待占位 */
  run?: OmpSubagentRun
}

const SUBVIEW_MAX_HEIGHT = 240

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
): OmpSubagentRun | undefined {
  // 只选原始值（sessionFile/cwd 字符串）：订阅整个 state 对象会让
  // 每个历史 task 行跟着父会话的每次 state 刷新重渲染
  const getParentFile = useCallback(() => {
    const state = parentSessionId ? piSessionStateStore.getState(parentSessionId) : null
    return typeof state?.sessionFile === 'string' ? state.sessionFile : null
  }, [parentSessionId])
  const parentFile = useSyncExternalStore(piSessionStateStore.subscribe, getParentFile, getParentFile)
  const baseRun = useMemo(() => {
    if (hasLiveRun || !result || !parentSessionId) return undefined
    return buildPersistedSubagentRun(callId, result, deriveChildSessionFile(result, parentFile ?? undefined), parentSessionId)
  }, [callId, hasLiveRun, parentSessionId, result, parentFile])
  const [loaded, setLoaded] = useState<{ key: string; items: OmpSubagentTranscriptItem[] }>({ key: '', items: [] })
  useEffect(() => {
    if (!enabled || !baseRun?.sessionFile || !parentSessionId) return
    let cancelled = false
    // 走 subagent.messages 磁盘兜底：只读这一份子会话文件。
    // 不要 open + previewSessionById——后者会 summarizeAll / 深度扫全部子会话。
    void getOmpSubagentMessages(parentSessionId, { sessionFile: baseRun.sessionFile })
      .then(result => {
        if (cancelled) return
        const record = result && typeof result === 'object' && !Array.isArray(result)
          ? result as Record<string, unknown>
          : undefined
        const messages = Array.isArray(record?.messages) ? record.messages as unknown[] : []
        setLoaded({ key: baseRun.id, items: transcriptItemsFromMessages(messages) })
      }).catch(() => undefined)
    return () => { cancelled = true }
  }, [baseRun?.id, baseRun?.sessionFile, parentSessionId, enabled])
  return useMemo(
    () => baseRun
      ? { ...baseRun, transcript: loaded.key === baseRun.id ? loaded.items : [] }
      : undefined,
    [baseRun, loaded],
  )
}

// 跨 pane 去重的回填飞行中标记（run.id → 正在拉取）
const subagentHistoryInFlight = new Set<string>()

/**
 * 磁盘转录回填：导航离开/页面刷新期间错过的 subagent_event 帧从子会话
 * 文件补回来（get_subagent_messages）。转录非空（实时帧已在推进）或已
 * 回填过则跳过。
 */
function useSubagentHistoryBackfill(run: OmpSubagentRun | undefined): void {
  useEffect(() => {
    if (!run || run.historyLoaded || !run.sessionFile) return
    if (subagentHistoryInFlight.has(run.id)) return
    subagentHistoryInFlight.add(run.id)
    const { sessionId, id, sessionFile } = run
    getOmpSubagentMessages(sessionId, { sessionFile })
      .then(result => {
        const record = result && typeof result === 'object' && !Array.isArray(result)
          ? result as Record<string, unknown>
          : undefined
        const messages = Array.isArray(record?.messages) ? record!.messages as unknown[] : []
        ompSubagentStore.applyHistory(sessionId, id, messages)
      })
      .catch(() => {
        // 标记已回填，避免错误后每个 store bump 都重试
        ompSubagentStore.applyHistory(sessionId, id, [])
      })
      .finally(() => subagentHistoryInFlight.delete(id))
  }, [run?.id, run?.sessionId, run?.sessionFile, run?.historyLoaded])
}

const SubSessionView = memo(function SubSessionView({ run }: SubSessionViewProps) {
  const { t } = useTranslation('message')
  useSubagentHistoryBackfill(run)
  const scrollRef = useRef<HTMLDivElement>(null)
  const transcript = run?.transcript ?? []
  const lastItem = transcript.at(-1)

  // 贴底自动滚动：仅在用户本就接近底部时跟随（流式输出不打断阅读）
  useEffect(() => {
    const node = scrollRef.current
    if (!node || transcript.length === 0) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    if (distance < 60) node.scrollTop = node.scrollHeight
  }, [transcript.length, lastItem?.text])

  if (!run) {
    return (
      <div className="rounded-md bg-bg-100/50 border border-border-200/30 overflow-hidden">
        <div className="px-3 py-2 text-[length:var(--fs-sm)] text-text-500 italic">
          {t('task.waitingForResponse')}
        </div>
      </div>
    )
  }

  const isRunning = run.status === 'running' || run.status === 'pending'
  const isError = run.status === 'failed'
  const progress = run.progress
  const visible = transcript.slice(-40)

  return (
    <div className="rounded-md bg-bg-100/50 border border-border-200/30 overflow-hidden">
      {/* 状态行 */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-200/30 bg-bg-200/30">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isRunning ? 'bg-info-100 animate-pulse' : isError ? 'bg-danger-100' : 'bg-success-100'}`} />
        <span className="text-[length:var(--fs-xxs)] font-mono text-text-400 truncate">
          {isRunning && progress?.currentTool
            ? `${progress.currentTool}${progress.currentToolArgs ? ` · ${progress.currentToolArgs.slice(0, 60)}` : ''}`
            : run.agent}
        </span>
        <span className="ml-auto shrink-0 text-[length:var(--fs-xxs)] font-mono tabular-nums text-text-500">
          {progress ? `${progress.toolCount} tools · ${formatCompactTokens(progress.tokens)} tok` : ''}
          {isRunning && progress?.durationMs ? ` · ${formatCompactDuration(progress.durationMs)}` : ''}
        </span>
      </div>
      {/* 转录流 */}
      <div
        ref={scrollRef}
        className="overflow-y-auto custom-scrollbar px-3 py-2 space-y-2"
        style={{ maxHeight: SUBVIEW_MAX_HEIGHT }}
      >
        {visible.length === 0 && (
          <div className="text-[length:var(--fs-sm)] text-text-500 italic">{t('task.waitingForResponse')}</div>
        )}
        {visible.map((item, index) => (
          <SubTranscriptItemView key={`${item.timestamp}-${index}`} item={item} isLast={index === visible.length - 1 && isRunning} />
        ))}
        {/* progress 帧的最近输出（事件帧之外的补充） */}
        {progress?.recentOutput?.length ? (
          <div className="pt-1 space-y-0.5">
            {progress.recentOutput.slice(-4).map((line, index) => (
              <div key={index} className="text-[length:var(--fs-xxs)] font-mono text-text-500 whitespace-pre-wrap break-all leading-snug">
                {line.length > 240 ? `${line.slice(0, 240)}…` : line}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
})

function SubTranscriptItemView({ item, isLast }: { item: OmpSubagentTranscriptItem; isLast: boolean }) {
  if (item.kind === 'tool') {
    return (
      <div>
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xs text-[length:var(--fs-xxs)] font-mono ${
          item.isError
            ? 'bg-danger-100/10 text-danger-100'
            : 'bg-bg-200 text-text-400'
        }`}>
          {item.toolName?.slice(0, 30) ?? 'tool'}
        </span>
      </div>
    )
  }
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-2.5 py-1.5 rounded-md bg-bg-300 text-text-100 text-[length:var(--fs-xs)] leading-relaxed whitespace-pre-wrap break-words">
          {truncateTail(item.text, 500)}
        </div>
      </div>
    )
  }
  return (
    <div className="text-[length:var(--fs-xs)] text-text-200 leading-relaxed whitespace-pre-wrap break-words">
      {isLast ? item.text : truncateTail(item.text, 500)}
      {isLast && <span className="inline-block w-1.5 h-3.5 ml-0.5 align-text-bottom bg-accent-main-100/70 animate-pulse" />}
    </div>
  )
}

function truncateTail(text: string, max: number): string {
  if (text.length <= max) return text
  return `…${text.slice(-max)}`
}

// ============================================
// Icons & Helpers
// ============================================
