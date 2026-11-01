import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon, ChevronUpIcon, CircleIcon, MaximizeIcon, MinimizeIcon, RetryIcon, SquareIcon } from '../../../components/Icons'
import { useBackgroundJobs, type BackgroundJob } from '../../../omp/backgroundJobs'
import { usePiCapabilities } from '../../../omp/capabilities'
import { cancelPiAsyncJob, inspectPiAsyncJob } from '../../../omp/transport/index.js'
import { formatElapsed } from './formatElapsed'

export interface BackgroundJobDetails {
  command?: string
  cwd?: string
  exitCode?: number
  output?: string
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    // Re-baseline once on activation, deferred so the effect body never
    // triggers a cascading render; the ticker then refreshes every second.
    const baseline = setTimeout(() => setNow(Date.now()), 0)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearTimeout(baseline)
      clearInterval(timer)
    }
  }, [active])
  return now
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface RowProps {
  job: BackgroundJob
  now: number
  /** Maximized panel: show the full command and uncapped output. */
  wide?: boolean
  onCancel?: (id: string) => Promise<void>
  onInspect?: (id: string) => Promise<BackgroundJobDetails | null>
}

function BackgroundJobRow({ job, now, wide = false, onCancel, onInspect }: RowProps) {
  const { t } = useTranslation(['chat'])
  const [expanded, setExpanded] = useState(false)
  const [details, setDetails] = useState<BackgroundJobDetails | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const running = job.status === 'running'

  const loadDetails = async () => {
    if (!onInspect) return
    setDetailsError(null)
    setLoadingDetails(true)
    try {
      setDetails(await onInspect(job.id))
    } catch (error) {
      setDetailsError(errorMessage(error))
    } finally {
      setLoadingDetails(false)
    }
  }

  const toggle = async () => {
    const next = !expanded
    setExpanded(next)
    if (next) await loadDetails()
  }

  const cancel = async () => {
    if (!onCancel) return
    setCancelling(true)
    setCancelError(null)
    try {
      await onCancel(job.id)
    } catch (error) {
      setCancelError(errorMessage(error))
    } finally {
      setCancelling(false)
    }
  }

  return (
    <li className="px-3 py-2" data-testid="background-job-row">
      <div className="flex items-center gap-2 min-w-0">
        <CircleIcon size={14} className={`flex-shrink-0 ${running ? 'text-accent-main-100' : 'text-text-500'}`} />
        <span className="font-mono font-semibold text-[length:var(--fs-sm)] text-text-100 truncate" title={job.command ?? job.label}>
          {job.label}
        </span>
        {job.type && (
          <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[length:var(--fs-xs)] leading-none bg-bg-200 text-text-400">
            {job.type}
          </span>
        )}
        <span className="flex-shrink-0 text-[length:var(--fs-xs)] text-text-400 tabular-nums">
          {formatElapsed((job.endTime ?? now) - job.startTime, t)}
        </span>
        <span className="flex-1" />
        {onInspect && (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-label={t('backgroundJobs.details')}
            className="flex-shrink-0 p-1 rounded-md text-text-400 hover:text-text-100 hover:bg-bg-200 transition-colors"
          >
            {expanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
          </button>
        )}
        {onCancel && running && (
          <button
            type="button"
            onClick={cancel}
            disabled={cancelling}
            aria-label={t('backgroundJobs.stop')}
            className="flex-shrink-0 p-1 rounded-md text-text-400 hover:text-danger-100 hover:bg-bg-200 transition-colors disabled:opacity-50"
          >
            <SquareIcon size={12} className="fill-current" />
          </button>
        )}
      </div>
      {cancelError && (
        <div role="alert" className="mt-1 text-[length:var(--fs-xs)] text-danger-100">
          {t('backgroundJobs.stopFailed', { message: cancelError })}
        </div>
      )}
      {expanded && (
        <div className="mt-2 rounded-md bg-bg-200/60 px-2 py-1.5 text-[length:var(--fs-xs)] text-text-300">
          {detailsError ? (
            <div role="alert" className="text-danger-100">{t('backgroundJobs.detailsFailed', { message: detailsError })}</div>
          ) : details ? (
            <>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {details.command && <div className="font-mono break-all">$ {details.command}</div>}
                  {details.cwd && <div className="text-text-500 break-all">{details.cwd}</div>}
                  {details.exitCode !== undefined && <div>{t('backgroundJobs.exitCode', { code: details.exitCode })}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => void loadDetails()}
                  disabled={loadingDetails}
                  aria-label={t('backgroundJobs.refreshOutput')}
                  title={t('backgroundJobs.refreshOutput')}
                  className="flex-shrink-0 rounded p-0.5 text-text-400 transition-colors hover:bg-bg-300/60 hover:text-text-100 disabled:opacity-50"
                >
                  <RetryIcon size={12} className={loadingDetails ? 'animate-spin' : ''} />
                </button>
              </div>
              {details.output ? (
                <pre className={`mt-1 overflow-auto whitespace-pre-wrap break-all font-mono text-text-200 ${wide ? 'max-h-[calc(100dvh-16rem)]' : 'max-h-48'}`}>{details.output}</pre>
              ) : (
                <div className="text-text-500">{t('backgroundJobs.noOutput')}</div>
              )}
            </>
          ) : (
            <div className="text-text-500">{t('backgroundJobs.loadingDetails')}</div>
          )}
        </div>
      )}
    </li>
  )
}

export interface BackgroundJobsIndicatorProps {
  running: BackgroundJob[]
  recent?: BackgroundJob[]
  error?: Error | null
  onCancel?: (id: string) => Promise<void>
  onInspect?: (id: string) => Promise<BackgroundJobDetails | null>
}

export const BackgroundJobsIndicator = memo(function BackgroundJobsIndicator({
  running,
  recent = [],
  error,
  onCancel,
  onInspect,
}: BackgroundJobsIndicatorProps) {
  const { t } = useTranslation(['chat'])
  // Floating capsule: it overlays the transcript and never reserves layout
  // height. Clicking it opens the panel; only the panel's own collapse button
  // (or Escape) folds it back, so reading output is not interrupted by clicks
  // elsewhere in the chat.
  const [open, setOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const now = useNow(running.length > 0)

  // Auto-close the panel once all jobs finish; adjusted during render to
  // avoid an extra effect-driven repaint.
  const [prevRunningCount, setPrevRunningCount] = useState(running.length)
  if (running.length !== prevRunningCount) {
    setPrevRunningCount(running.length)
    if (running.length === 0) {
      setOpen(false)
      setMaximized(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  if (running.length === 0) return null

  const finished = recent.filter(job => job.status !== 'running').slice(0, 5)
  const countLabel = t('backgroundJobs.runningCount', { count: running.length })

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-haspopup="dialog"
        aria-label={countLabel}
        title={running.map(job => job.label).join('\n')}
        className="pointer-events-auto inline-flex h-7 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-border-200/60 bg-bg-000/85 pl-2.5 pr-2 text-[length:var(--fs-xs)] text-text-200 shadow-md backdrop-blur transition-colors hover:border-accent-main-100/40 hover:text-text-100"
      >
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-main-100 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-main-100" />
        </span>
        <span className="truncate">{countLabel}</span>
        <ChevronDownIcon size={12} className="shrink-0 text-text-400" />
      </button>
    )
  }

  return (
    <div
      role="dialog"
      aria-label={t('backgroundJobs.panelTitle')}
      className={`pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-border-200/60 bg-bg-000/95 shadow-xl backdrop-blur transition-[width] duration-200 ${
        maximized
          ? 'w-[min(48rem,calc(100vw-1rem))] max-h-[calc(100dvh-9rem)]'
          : 'w-[min(26rem,calc(100vw-1rem))] max-h-[min(60vh,28rem)]'
      }`}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border-200/40 py-1.5 pl-3 pr-1.5">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-main-100 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-main-100" />
        </span>
        <span className="ml-1 flex-1 truncate text-[length:var(--fs-xs)] font-medium text-text-200">
          {t('backgroundJobs.panelTitle')} · {running.length}
        </span>
        <button
          type="button"
          onClick={() => setMaximized(value => !value)}
          aria-pressed={maximized}
          aria-label={maximized ? t('backgroundJobs.restore') : t('backgroundJobs.maximize')}
          title={maximized ? t('backgroundJobs.restore') : t('backgroundJobs.maximize')}
          className="rounded-md p-1.5 text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
        >
          {maximized ? <MinimizeIcon size={13} /> : <MaximizeIcon size={13} />}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setMaximized(false) }}
          aria-label={t('backgroundJobs.collapse')}
          title={t('backgroundJobs.collapse')}
          className="rounded-md p-1.5 text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
        >
          <ChevronUpIcon size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
        <ul className="divide-y divide-border-200/40">
          {running.map(job => (
            <BackgroundJobRow key={job.id} job={job} now={now} wide={maximized} onCancel={onCancel} onInspect={onInspect} />
          ))}
        </ul>
        {error && (
          <div role="alert" className="px-3 py-1.5 text-[length:var(--fs-xs)] text-danger-100">
            {t('backgroundJobs.refreshFailed', { message: error.message })}
          </div>
        )}
        {finished.length > 0 && (
          <>
            <div className="border-t border-border-200/40 px-3 pt-2 pb-1 text-[length:var(--fs-xs)] font-medium text-text-400">{t('backgroundJobs.recentTitle')}</div>
            <ul className="divide-y divide-border-200/40 opacity-80">
              {finished.map(job => (
                <BackgroundJobRow key={job.id} job={job} now={now} wide={maximized} onInspect={onInspect} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
})

function parseDetails(raw: unknown): BackgroundJobDetails | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  return {
    command: typeof value.command === 'string' ? value.command : undefined,
    cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : undefined,
    output: typeof value.output === 'string' ? value.output : undefined,
  }
}

export function SessionBackgroundJobs({ sessionId }: { sessionId?: string | null }) {
  const { t } = useTranslation(['chat'])
  const capabilities = usePiCapabilities()
  const jobs = useBackgroundJobs(sessionId, capabilities.backgroundJobs)
  if (!sessionId) return null
  const onCancel = capabilities.backgroundJobCancel
    ? async (id: string) => {
        const result = await cancelPiAsyncJob(sessionId, id)
        if ((result as { cancelled?: unknown } | null)?.cancelled !== true) throw new Error(t('backgroundJobs.notCancelled'))
        jobs.refresh()
      }
    : undefined
  const onInspect = async (id: string) => parseDetails(await inspectPiAsyncJob(sessionId, id))
  return <BackgroundJobsIndicator running={jobs.running} recent={jobs.recent} error={jobs.error} onCancel={onCancel} onInspect={onInspect} />
}
