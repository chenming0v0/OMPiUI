import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktopServicePhase, isServiceBusy, useDesktopDiagnostics } from '../store/desktopDiagnosticsStore'
import { useDesktopServiceDiagnostics } from '../hooks/useDesktopServiceDiagnostics'
import { isTauri, isTauriMobile } from '../utils/tauri'
import { Dialog } from './ui/Dialog'
import { SpinnerIcon } from './Icons'

function DesktopServiceIndicator() {
  const { t, i18n } = useTranslation('components')
  const snapshot = useDesktopDiagnostics()
  const { native, operation, commandError, queryError } = snapshot
  const phase = desktopServicePhase(snapshot)
  const busy = isServiceBusy(phase)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const close = useCallback(() => setOpen(false), [])
  useDesktopServiceDiagnostics()

  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [busy])

  const requestedAt = operation?.requestedAt ?? native?.requestedAt
  const elapsed = requestedAt
    ? Math.max(0, Math.floor(((busy ? now : native?.completedAt) ?? now) - requestedAt) / 1000)
    : null
  const duration = elapsed === null ? '—' : t('desktopService.seconds', { count: Math.floor(elapsed) })
  const formatTime = (value?: number | null) =>
    value ? new Date(value).toLocaleString(i18n.language, { hour12: false }) : '—'
  const color =
    phase === 'running' ? 'bg-success-100' : ['failed', 'unreachable'].includes(phase) ? 'bg-danger-100' : 'bg-text-400'
  const worker =
    busy || phase !== 'running'
      ? 'unavailable'
      : native?.workerReady === true
        ? 'ready'
        : native?.workerReady === false
          ? 'warming'
          : 'unknown'
  const error = commandError || native?.error

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        title={t('desktopService.open')}
        aria-label={`${t('desktopService.open')} · ${t(`desktopService.phase.${phase}`)}`}
        className="mx-2 inline-flex h-7 max-w-56 items-center gap-2 rounded-md px-2 text-xs text-text-200 transition-colors hover:bg-bg-200 focus-visible:outline-2 focus-visible:outline-accent-main-100"
      >
        {busy ? (
          <SpinnerIcon size={12} className="shrink-0 animate-spin text-accent-main-100" />
        ) : (
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />
        )}
        <span className="truncate">
          {t('desktopService.backend')} · {t(`desktopService.phase.${phase}`)}
        </span>
        {busy && <span className="shrink-0 tabular-nums text-text-400">{duration}</span>}
      </button>
      <Dialog isOpen={open} onClose={close} title={t('desktopService.title')} width={580}>
        <div className="space-y-5 text-sm text-text-200">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border-200 bg-bg-100/60 p-3">
              <div className="mb-2 text-xs text-text-400">{t('desktopService.backend')}</div>
              <div className="font-medium text-text-100" role="status">
                {t(`desktopService.phase.${phase}`)}
              </div>
            </div>
            <div className="rounded-lg border border-border-200 bg-bg-100/60 p-3">
              <div className="mb-2 text-xs text-text-400">{t('desktopService.engine')}</div>
              <div className="font-medium text-text-100">{t(`desktopService.worker.${worker}`)}</div>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-text-400">{t('desktopService.runtimeHint')}</p>
          {queryError && (
            <p role="alert" className="text-danger-100">
              {t('desktopService.queryFailed')}
            </p>
          )}
          {native?.healthError === 'rejected' && (
            <p role="alert" className="text-danger-100">
              {t('desktopService.healthRejected')}
            </p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-xs">
            <dt className="text-text-400">{t('desktopService.requestedAt')}</dt>
            <dd className="text-right tabular-nums">{formatTime(requestedAt)}</dd>
            <dt className="text-text-400">{t('desktopService.spawnedAt')}</dt>
            <dd className="text-right tabular-nums">{formatTime(native?.spawnedAt)}</dd>
            <dt className="text-text-400">{t('desktopService.completedAt')}</dt>
            <dd className="text-right tabular-nums">{formatTime(native?.completedAt)}</dd>
            <dt className="text-text-400">{t(busy ? 'desktopService.waiting' : 'desktopService.duration')}</dt>
            <dd className="text-right tabular-nums">{duration}</dd>
            <dt className="text-text-400">{t('desktopService.process')}</dt>
            <dd className="text-right tabular-nums">{native?.pid ?? '—'}</dd>
          </dl>
          {error && (
            <pre
              role="alert"
              className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-danger-100/10 p-3 text-xs text-danger-100"
            >
              {error}
            </pre>
          )}
          <section>
            <h3 className="mb-2 text-xs font-medium text-text-100">{t('desktopService.timeline')}</h3>
            {native?.events.length ? (
              <ol className="space-y-2 border-l border-border-200 pl-3 text-xs">
                {native.events.map((event, index) => (
                  <li key={`${event.time}-${index}`} className="flex justify-between gap-4">
                    <span>{t(`desktopService.phase.${event.phase}`)}</span>
                    <time dateTime={new Date(event.time).toISOString()} className="shrink-0 tabular-nums text-text-400">
                      {formatTime(event.time)}
                    </time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-text-400">{t('desktopService.noEvents')}</p>
            )}
          </section>
          <details>
            <summary className="cursor-pointer text-xs font-medium text-text-100">{t('desktopService.output')}</summary>
            <p className="my-2 text-xs text-text-400">{t('desktopService.outputHint')}</p>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg-200 p-3 text-xs">
              {native?.output.join('\n') || t('desktopService.noOutput')}
            </pre>
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
