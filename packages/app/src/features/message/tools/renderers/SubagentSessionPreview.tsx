import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useResponsiveMaxHeight } from '../../../../hooks/useResponsiveMaxHeight'
import { getOmpSubagentMessages } from '../../../../omp/transport/index.js'
import { ompSubagentStore, type OmpSubagentRun, type OmpSubagentTranscriptItem } from '../../../../omp/ompSubagentStore'
import { SubagentTranscriptPreview } from './SubagentTranscriptPreview'

const EMPTY_TRANSCRIPT: OmpSubagentTranscriptItem[] = []

/** 跨 pane 合并历史回填请求；落盘结果不覆盖已经推进的实时转录。 */
function useSubagentHistoryBackfill(run: OmpSubagentRun | undefined, enabled: boolean): { loading: boolean; error?: string; reload: () => void } {
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; error?: string }>({ key: '' })
  const id = run?.id
  const sessionId = run?.sessionId
  const sessionFile = run?.sessionFile
  const runId = run?.runId
  const key = JSON.stringify([sessionId, id, runId, sessionFile, revision])
  const historyLoaded = run?.historyLoaded
  const hasLiveTranscript = Boolean(run?.transcript.length) && (run?.status === 'running' || run?.status === 'pending')
  useEffect(() => {
    if (!enabled || !id || !sessionId || !sessionFile || (historyLoaded && revision === 0) || hasLiveTranscript) return
    const controller = new AbortController()
    getOmpSubagentMessages(sessionId, { sessionFile }, controller.signal)
      .then(result => {
        const record =
          result && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : undefined
        if (controller.signal.aborted) return
        setLoaded({ key })
        ompSubagentStore.applyHistory(sessionId, id, Array.isArray(record?.messages) ? record.messages : [],
          { truncated: Boolean(record?.truncated), hasMore: Boolean(record?.hasMore) }, { runId, sessionFile })
      })
      .catch(cause => {
        if (!controller.signal.aborted) {
          setLoaded({ key, error: cause instanceof Error ? cause.message : String(cause) })
        }
      })
    return () => controller.abort()
  }, [id, runId, sessionId, sessionFile, historyLoaded, hasLiveTranscript, enabled, revision, key])
  return { loading: loaded.key !== key, error: loaded.key === key ? loaded.error : undefined, reload: () => setRevision(value => value + 1) }
}

export const SubagentSessionPreview = memo(function SubagentSessionPreview({
  run,
  loading = false,
  onLoadMore,
}: {
  run?: OmpSubagentRun
  loading?: boolean
  onLoadMore?: () => void
}) {
  const { t } = useTranslation('message')
  const history = useSubagentHistoryBackfill(run, !onLoadMore && !loading)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const maxHeight = useResponsiveMaxHeight(0.25, 120, 240)
  const transcript = run?.transcript ?? EMPTY_TRANSCRIPT
  const isRunning = run?.status === 'running'
  const progress = run?.progress
  const isLoading = loading || Boolean(run?.sessionFile && !run.historyLoaded && transcript.length === 0 && !history.error)
  const identity = run?.runId ?? run?.id
  const previousRunIdRef = useRef(identity)
  const wasRunningRef = useRef(isRunning)

  const handleScroll = useCallback(() => {
    const node = scrollRef.current
    if (node) isAtBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60
  }, [])
  // 使用用户上次滚动的位置判断，而不是新内容撑高以后才重新计算距底距离。
  useLayoutEffect(() => {
    if (previousRunIdRef.current !== identity) {
      previousRunIdRef.current = identity
      isAtBottomRef.current = true
      wasRunningRef.current = isRunning
    }
    const node = scrollRef.current
    if (node && isAtBottomRef.current && (isRunning || wasRunningRef.current)) node.scrollTop = node.scrollHeight
    wasRunningRef.current = isRunning
  }, [transcript, maxHeight, isLoading, isRunning, identity])

  const progressSummary = [progress?.currentTool, progress?.lastIntent, ...(progress?.recentOutput ?? [])]
    .filter(Boolean)
    .join('\n')

  const historyError = history.error ? <div className="px-3 py-2"><p role="alert" className="break-words text-[length:var(--fs-xs)] text-danger-100">{history.error}</p><button type="button" onClick={history.reload} disabled={history.loading} className="mt-1 text-[length:var(--fs-xs)] text-text-200 disabled:opacity-50">{t('common:retry')}</button></div> : null
  if (historyError && transcript.length === 0) return historyError
  if (isLoading && transcript.length === 0 && !progressSummary) {
    return (
      <div
        role="status"
        aria-label={t('common:loading')}
        className="rounded-md bg-bg-100/50 border border-border-200/30 p-3 space-y-2"
      >
        <div className="h-3 bg-bg-300/50 rounded animate-pulse w-3/4" />
        <div className="h-3 bg-bg-300/50 rounded animate-pulse w-1/2" />
        <div className="h-3 bg-bg-300/50 rounded animate-pulse w-2/3" />
      </div>
    )
  }
  const hasProgressStats = Boolean(progress && (
    progress.currentTool ||
    progress.lastIntent ||
    progress.toolCount > 0 ||
    progress.requests > 0 ||
    progress.tokens > 0
  ))

  if (transcript.length === 0) {
    const summary = progressSummary
    if (summary) {
      return <div role="status" className="text-[length:var(--fs-sm)] text-text-300 whitespace-pre-wrap break-words py-2">{summary}</div>
    }
    return <div className="text-[length:var(--fs-sm)] text-text-500 italic py-2">{t('task.waitingForResponse')}</div>
  }
  return (
    <div className="rounded-md bg-bg-100/50 border border-border-200/30 overflow-hidden">
      {hasProgressStats && (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-200/30 px-3 py-1.5 text-[length:var(--fs-xxs)] text-text-400"
        >
          {progress?.currentTool && (
            <span className="font-mono text-accent-main-100">{progress.currentTool}</span>
          )}
          {progress?.lastIntent && (
            <span className="min-w-0 max-w-full truncate">{progress.lastIntent}</span>
          )}
          {progress && progress.toolCount > 0 && (
            <span>{t('task.tools', { count: progress.toolCount })}</span>
          )}
          {progress && progress.requests > 0 && (
            <span>{t('task.requests', { count: progress.requests })}</span>
          )}
          {progress && progress.tokens > 0 && (
            <span>{t('task.tokens', { count: progress.tokens })}</span>
          )}
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-y-auto custom-scrollbar px-3 py-2 space-y-2"
        style={{ maxHeight }}
      >
        <SubagentTranscriptPreview items={transcript} isRunning={isRunning} />
      </div>
      {historyError}
      {run?.historyTruncated && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-t border-border-200/30 px-3 py-2 text-[length:var(--fs-xxs)] text-text-400">
          <span>{t('task.partialTranscript')}</span>
          {run.historyHasMore && (
            <button type="button" onClick={onLoadMore ?? history.reload} disabled={loading || history.loading}
              title={t('task.loadMoreTranscript')}
              className="inline-flex items-center gap-1 text-text-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2">
              <ArrowDown size={14} aria-hidden="true" />{t('task.loadMoreTranscript')}
            </button>
          )}
        </div>
      )}
    </div>
  )
})
