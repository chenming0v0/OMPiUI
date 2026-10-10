import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useResponsiveMaxHeight } from '../../../../hooks/useResponsiveMaxHeight'
import { getOmpSubagentMessages } from '../../../../omp/transport/index.js'
import { ompSubagentStore, type OmpSubagentRun, type OmpSubagentTranscriptItem } from '../../../../omp/ompSubagentStore'
import { SubagentTranscriptPreview } from './SubagentTranscriptPreview'

const EMPTY_TRANSCRIPT: OmpSubagentTranscriptItem[] = []
const subagentHistoryInFlight = new Set<string>()

/** 跨 pane 合并历史回填请求；落盘结果不覆盖已经推进的实时转录。 */
function useSubagentHistoryBackfill(run: OmpSubagentRun | undefined): void {
  const id = run?.id
  const sessionId = run?.sessionId
  const sessionFile = run?.sessionFile
  const historyLoaded = run?.historyLoaded
  useEffect(() => {
    if (!id || !sessionId || !sessionFile || historyLoaded || subagentHistoryInFlight.has(id)) return
    subagentHistoryInFlight.add(id)
    getOmpSubagentMessages(sessionId, { sessionFile })
      .then(result => {
        const record =
          result && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : undefined
        ompSubagentStore.applyHistory(sessionId, id, Array.isArray(record?.messages) ? record.messages : [])
      })
      .catch(() => ompSubagentStore.applyHistory(sessionId, id, []))
      .finally(() => subagentHistoryInFlight.delete(id))
  }, [id, sessionId, sessionFile, historyLoaded])
}

export const SubagentSessionPreview = memo(function SubagentSessionPreview({
  run,
  loading = false,
}: {
  run?: OmpSubagentRun
  loading?: boolean
}) {
  const { t } = useTranslation('message')
  useSubagentHistoryBackfill(run)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const maxHeight = useResponsiveMaxHeight(0.25, 120, 240)
  const transcript = run?.transcript ?? EMPTY_TRANSCRIPT
  const isRunning = run?.status === 'running' || run?.status === 'pending'
  const isLoading = loading || Boolean(run?.sessionFile && !run.historyLoaded && transcript.length === 0)
  const previousRunIdRef = useRef(run?.id)
  const wasRunningRef = useRef(isRunning)

  const handleScroll = useCallback(() => {
    const node = scrollRef.current
    if (node) isAtBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60
  }, [])
  // 使用用户上次滚动的位置判断，而不是新内容撑高以后才重新计算距底距离。
  useLayoutEffect(() => {
    if (previousRunIdRef.current !== run?.id) {
      previousRunIdRef.current = run?.id
      isAtBottomRef.current = true
      wasRunningRef.current = isRunning
    }
    const node = scrollRef.current
    if (node && isAtBottomRef.current && (isRunning || wasRunningRef.current)) node.scrollTop = node.scrollHeight
    wasRunningRef.current = isRunning
  }, [transcript, maxHeight, isLoading, isRunning, run?.id])

  if (isLoading && transcript.length === 0) {
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
  if (transcript.length === 0) {
    return <div className="text-[length:var(--fs-sm)] text-text-500 italic py-2">{t('task.waitingForResponse')}</div>
  }
  return (
    <div className="rounded-md bg-bg-100/50 border border-border-200/30 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-y-auto custom-scrollbar px-3 py-2 space-y-2"
        style={{ maxHeight }}
      >
        <SubagentTranscriptPreview items={transcript} isRunning={isRunning} />
      </div>
    </div>
  )
})
