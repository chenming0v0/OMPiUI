import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  desktopDiagnosticsStore,
  desktopServicePhase,
  isServiceBusy,
  useDesktopDiagnostics,
} from '../store/desktopDiagnosticsStore'
import { useDesktopServiceDiagnostics } from '../hooks/useDesktopServiceDiagnostics'
import { useServiceStore } from '../store/serviceStore'
import {
  readDesktopServiceDiagnostics,
  restartDesktopService,
  startDesktopService,
  stopDesktopService,
} from '../services/desktopService'
import { isTauri, isTauriMobile } from '../utils/tauri'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { PlayIcon, RetryIcon, SpinnerIcon, StopIcon, WifiIcon } from './Icons'
import { DesktopRuntimeInUse, DesktopRuntimeSelector, StatusCard } from './DesktopRuntimePanel'

function DesktopServiceIndicator() {
  const { t, i18n } = useTranslation('components')
  const snapshot = useDesktopDiagnostics()
  const { native, operation, commandError, queryError } = snapshot
  const { startedByUs, starting } = useServiceStore()
  const phase = desktopServicePhase(snapshot)
  const busy = isServiceBusy(phase) || starting
  const running = phase === 'running'
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<'stop' | 'restart' | null>(null)
  const [controlError, setControlError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const close = useCallback(() => {
    setOpen(false)
    setConfirmation(null)
  }, [])
  useDesktopServiceDiagnostics()

  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy])

  const requestedAt = operation?.requestedAt ?? native?.requestedAt
  const elapsed = requestedAt
    ? Math.max(0, Math.floor((((busy ? now : native?.completedAt) ?? now) - requestedAt) / 1000))
    : null
  const duration = elapsed === null ? '—' : t('desktopService.seconds', { count: elapsed })
  const formatTime = (value?: number | null) =>
    value ? new Date(value).toLocaleString(i18n.language, { hour12: false }) : '—'
  const formatClock = (value: number) =>
    new Date(value).toLocaleTimeString(i18n.language, { hour12: false, hour: '2-digit', minute: '2-digit' })
  const ompMissing = running && native?.workerReady === true && !native.ompVersion
  const color = running
    ? ompMissing
      ? 'bg-warning-100'
      : 'bg-success-100'
    : ['failed', 'unreachable'].includes(phase)
      ? 'bg-danger-100'
      : 'bg-text-400'
  const worker = !running
    ? 'unavailable'
    : native?.workerReady === true
      ? 'ready'
      : native?.workerReady === false
        ? 'warming'
        : 'unknown'
  const error = controlError || commandError || native?.error

  const control = async (action: 'start' | 'stop' | 'restart') => {
    setConfirmation(null)
    setControlError('')
    try {
      if (action === 'start') await startDesktopService()
      else if (action === 'restart') await restartDesktopService()
      else await stopDesktopService()
      desktopDiagnosticsStore.receive(await readDesktopServiceDiagnostics())
    } catch (reason) {
      setControlError(String(reason))
    }
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        title={t('desktopService.open')}
        aria-label={`${t('desktopService.open')} · ${t(`desktopService.phase.${phase}`)}${ompMissing ? ` · ${t('desktopService.runtime.statusMissing')}` : ''}`}
        className="mx-2 inline-flex h-7 max-w-64 items-center gap-2 rounded-md px-2 text-xs text-text-200 transition-colors hover:bg-bg-200 focus-visible:outline-2 focus-visible:outline-accent-main-100"
      >
        {busy ? (
          <SpinnerIcon size={12} className="shrink-0 animate-spin text-accent-main-100" />
        ) : (
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />
        )}
        <span className="truncate">
          {t('desktopService.backend')} · {t(`desktopService.phase.${phase}`)}
          {ompMissing && ` · ${t('desktopService.runtime.statusMissing')}`}
        </span>
        {busy && <span className="shrink-0 tabular-nums text-text-300">{duration}</span>}
      </button>
      <Dialog isOpen={open} onClose={close} title={t('desktopService.title')} width={680}>
        <div className="space-y-5 text-sm text-text-200">
          <div className="grid gap-3 sm:grid-cols-2">
            <StatusCard
              label={t('desktopService.backend')}
              icon={<WifiIcon size={14} />}
              tone={busy ? 'busy' : running ? 'success' : ['failed', 'unreachable'].includes(phase) ? 'danger' : 'idle'}
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <div role="status" className="flex items-center gap-2 text-base font-semibold text-text-100">
                  {busy ? (
                    <SpinnerIcon size={14} className="animate-spin text-accent-main-100" />
                  ) : (
                    <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${color}`} />
                  )}
                  {t(`desktopService.phase.${phase}`)}
                  {busy && <span className="text-xs font-normal tabular-nums text-text-300">{duration}</span>}
                </div>
                <p className="text-xs leading-relaxed text-text-300">
                  {busy
                    ? t('desktopService.busyHint')
                    : running
                    ? [
                        t(`desktopService.${startedByUs ? 'startedByApp' : 'startedExternally'}`),
                        native?.pid ? t('desktopService.pid', { pid: native.pid }) : null,
                        native?.spawnedAt ? t('desktopService.since', { time: formatClock(native.spawnedAt) }) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : t('desktopService.backendHint')}
                </p>
              </div>
              <div className="mt-auto flex flex-wrap gap-1.5">
                {!running && !busy && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || phase === 'unknown'}
                    onClick={() => void control('start')}
                  >
                    <PlayIcon size={13} />
                    {t('desktopService.start')}
                  </Button>
                )}
                {running && startedByUs && (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmation('restart')}>
                    <RetryIcon size={13} />
                    {t('desktopService.restart')}
                  </Button>
                )}
                {running && startedByUs && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmation('stop')}>
                    <StopIcon size={13} />
                    {t('desktopService.stop')}
                  </Button>
                )}
              </div>
            </StatusCard>
            <DesktopRuntimeInUse />
          </div>
          {running && !startedByUs && <p className="text-xs text-text-300">{t('desktopService.externalBackend')}</p>}
          {confirmation && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning-100/30 bg-warning-100/5 px-3 py-2.5">
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-warning-100">
                {t(`desktopService.${confirmation === 'restart' ? 'restartWarning' : 'stopWarning'}`)}
              </p>
              <Button size="sm" variant="ghost" onClick={() => setConfirmation(null)}>
                {t('common:cancel')}
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void control(confirmation)}>
                {t(`desktopService.${confirmation === 'restart' ? 'confirmRestart' : 'confirmStop'}`)}
              </Button>
            </div>
          )}
          {queryError && (
            <p role="alert" className="text-xs text-danger-100">
              {t('desktopService.queryFailed')}
            </p>
          )}
          {native?.healthError === 'rejected' && (
            <p role="alert" className="text-xs text-danger-100">
              {t('desktopService.healthRejected')}
            </p>
          )}
          {error && (
            <pre
              role="alert"
              className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-danger-100/10 p-3 text-xs text-danger-100"
            >
              {error}
            </pre>
          )}
          <DesktopRuntimeSelector onRestart={startedByUs ? () => control('restart') : undefined} />
          <details className="border-t border-border-200/60 pt-4">
            <summary className="cursor-pointer text-xs font-medium text-text-200">
              {t('desktopService.diagnostics')}
            </summary>
            <div className="mt-4 space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                <dt className="text-text-300">{t('desktopService.engine')}</dt>
                <dd className="text-right">{t(`desktopService.worker.${worker}`)}</dd>
                <dt className="text-text-300">{t('desktopService.process')}</dt>
                <dd className="text-right tabular-nums">{native?.pid ?? '—'}</dd>
                <dt className="text-text-300">{t('desktopService.requestedAt')}</dt>
                <dd className="text-right tabular-nums">{formatTime(requestedAt)}</dd>
                <dt className="text-text-300">{t('desktopService.spawnedAt')}</dt>
                <dd className="text-right tabular-nums">{formatTime(native?.spawnedAt)}</dd>
                <dt className="text-text-300">{t('desktopService.completedAt')}</dt>
                <dd className="text-right tabular-nums">{formatTime(native?.completedAt)}</dd>
                <dt className="text-text-300">{t(busy ? 'desktopService.waiting' : 'desktopService.duration')}</dt>
                <dd className="text-right tabular-nums">{duration}</dd>
              </dl>
              <section>
                <h3 className="mb-2 text-xs font-medium text-text-100">{t('desktopService.timeline')}</h3>
                {native?.events.length ? (
                  <ol className="space-y-2 border-l border-border-200 pl-3 text-xs">
                    {native.events.map((event, index) => (
                      <li key={`${event.time}-${index}`} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                        <span>{t(`desktopService.phase.${event.phase}`)}</span>
                        <time dateTime={new Date(event.time).toISOString()} className="tabular-nums text-text-300">
                          {formatTime(event.time)}
                        </time>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-xs text-text-300">{t('desktopService.noEvents')}</p>
                )}
              </section>
              <details>
                <summary className="cursor-pointer text-xs font-medium text-text-100">
                  {t('desktopService.output')}
                </summary>
                <p className="my-2 text-xs text-text-300">{t('desktopService.outputHint')}</p>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-200 p-3 text-xs">
                  {native?.output.join('\n') || t('desktopService.noOutput')}
                </pre>
              </details>
            </div>
          </details>
        </div>
      </Dialog>
    </>
  )
}

export function DesktopServiceStatus() {
  // 手机端和普通浏览器不挂载指示器，也不调用桌面专属命令。
  if (!isTauri() || isTauriMobile()) return null
  return <DesktopServiceIndicator />
}
