import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon, ChevronUpIcon, CircleIcon, SquareIcon } from '../../../components/Icons'
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
  onCancel?: (id: string) => Promise<void>
  onInspect?: (id: string) => Promise<BackgroundJobDetails | null>
}

function BackgroundJobRow({ job, now, onCancel, onInspect }: RowProps) {
  const { t } = useTranslation(['chat'])
  const [expanded, setExpanded] = useState(false)
  const [details, setDetails] = useState<BackgroundJobDetails | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const running = job.status === 'running'

  const toggle = async () => {
    const next = !expanded
    setExpanded(next)
    if (!next || !onInspect) return
    setDetailsError(null)
    try {
      setDetails(await onInspect(job.id))
    } catch (error) {
      setDetailsError(errorMessage(error))
    }
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
              {details.command && <div className="font-mono break-all">$ {details.command}</div>}
              {details.cwd && <div className="text-text-500 break-all">{details.cwd}</div>}
              {details.exitCode !== undefined && <div>{t('backgroundJobs.exitCode', { code: details.exitCode })}</div>}
              {details.output ? (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-text-200">{details.output}</pre>
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
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const now = useNow(running.length > 0)

  // Auto-close the popover once all jobs finish; adjusted during render to
  // avoid an extra effect-driven repaint.
  const [prevRunningCount, setPrevRunningCount] = useState(running.length)
  if (running.length !== prevRunningCount) {
    setPrevRunningCount(running.length)
    if (running.length === 0) setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (running.length === 0) return null

  const finished = recent.filter(job => job.status !== 'running').slice(0, 5)

  return (
    <div ref={rootRef} className="relative flex min-w-0 shrink-0 pointer-events-auto">
      {open && (
        <div
          role="dialog"
          aria-label={t('backgroundJobs.panelTitle')}
          className="absolute top-full left-0 mt-1.5 w-[min(36rem,calc(100vw-2rem))] max-h-[min(60vh,28rem)] overflow-y-auto rounded-xl border border-border-200/60 bg-bg-000 shadow-lg z-30"
        >
          <div className="px-3 pt-2.5 pb-1 text-[length:var(--fs-xs)] font-medium text-text-400">{t('backgroundJobs.panelTitle')}</div>
          <ul className="divide-y divide-border-200/40">
            {running.map(job => (
              <BackgroundJobRow key={job.id} job={job} now={now} onCancel={onCancel} onInspect={onInspect} />
            ))}
          </ul>
          {error && (
            <div role="alert" className="px-3 py-1.5 text-[length:var(--fs-xs)] text-danger-100">
              {t('backgroundJobs.refreshFailed', { message: error.message })}
            </div>
          )}
          {finished.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1 text-[length:var(--fs-xs)] font-medium text-text-400">{t('backgroundJobs.recentTitle')}</div>
              <ul className="divide-y divide-border-200/40 opacity-80">
                {finished.map(job => (
                  <BackgroundJobRow key={job.id} job={job} now={now} onInspect={onInspect} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[length:var(--fs-xs)] transition-colors ${open ? 'bg-bg-200/60 text-text-100' : 'text-text-300 hover:text-text-100 hover:bg-bg-200/50'}`}
      >
        <CircleIcon size={12} className="text-accent-main-100" />
        <span>{t('backgroundJobs.runningCount', { count: running.length })}</span>
        {open ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
      </button>
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
