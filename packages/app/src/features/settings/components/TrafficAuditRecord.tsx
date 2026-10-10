import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TrafficRecord } from '../../../omp/trafficAudit/store'
import { formatTrafficBytes } from '../../../omp/trafficAudit/summary'

export function TrafficAuditRecord({
  record,
  expanded,
  onToggle,
}: {
  record: TrafficRecord
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation('settings')
  const failed = record.status === 'error' || record.status === 'aborted'
  const duration = record.durationMs ?? record.headersMs
  const fields = [
    [t('traffic.url'), record.url],
    [t('traffic.server'), record.server],
    [
      t('traffic.status'),
      `${t(`traffic.statuses.${record.status}`)}${record.statusCode === undefined ? '' : ` · ${record.statusCode}`}`,
    ],
    [t('traffic.sent'), formatTrafficBytes(record.sentBytes)],
    [t('traffic.received'), formatTrafficBytes(record.receivedBytes)],
    [t('traffic.headersTime'), record.headersMs === undefined ? undefined : `${Math.round(record.headersMs)} ms`],
    [t('traffic.duration'), record.durationMs === undefined ? undefined : `${Math.round(record.durationMs)} ms`],
    [t('traffic.attempt'), record.attempt],
    [t('traffic.connection'), record.connectionId],
    [t('traffic.session'), record.sessionId],
    [t('traffic.contentType'), record.contentType],
    [t('traffic.contentEncoding'), record.contentEncoding],
    [
      t('traffic.declaredBytes'),
      record.declaredBytes === undefined ? undefined : formatTrafficBytes(record.declaredBytes),
    ],
    [t('traffic.error'), record.error],
  ].filter(([, value]) => value !== undefined)

  return (
    <li className="min-w-0 border-b border-border-200/60 last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`traffic-record-${record.id}`}
        onClick={onToggle}
        className="flex min-h-11 w-full min-w-0 flex-col gap-1.5 py-3 text-left transition-colors hover:bg-bg-200/40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-main-100"
      >
        <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-xs)]">
          <time className="font-mono tabular-nums text-text-300" dateTime={new Date(record.timestamp).toISOString()}>
            {new Date(record.timestamp).toLocaleTimeString()}
          </time>
          <span className="text-text-300">{record.protocol.toUpperCase()}</span>
          <span className="min-w-0 break-all font-medium text-text-100">{record.operation}</span>
          {record.direction !== 'exchange' && (
            <span className="text-text-300">{t(`traffic.directions.${record.direction}`)}</span>
          )}
          <span className={`ml-auto ${failed ? 'text-danger-100' : 'text-text-300'}`}>
            {record.statusCode ?? t(`traffic.statuses.${record.status}`)}
          </span>
          <ChevronDown size={14} className={`shrink-0 text-text-300 ${expanded ? 'rotate-180' : ''}`} />
        </div>
        <span className="w-full truncate font-mono text-[length:var(--fs-xs)] text-text-300" title={record.url}>
          {record.url}
        </span>
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[length:var(--fs-xs)] tabular-nums">
          <span className="flex items-center gap-1 text-accent-main-100" title={t('traffic.sent')}>
            <ArrowUp size={13} aria-label={t('traffic.sent')} />
            {formatTrafficBytes(record.sentBytes)}
          </span>
          <span className="flex items-center gap-1 text-success-100" title={t('traffic.received')}>
            <ArrowDown size={13} aria-label={t('traffic.received')} />
            {formatTrafficBytes(record.receivedBytes)}
          </span>
          {duration !== undefined && <span className="ml-auto text-text-300">{Math.round(duration)} ms</span>}
        </div>
      </button>
      {expanded && (
        <div
          id={`traffic-record-${record.id}`}
          className="min-w-0 space-y-3 border-t border-border-200/40 py-3 text-[length:var(--fs-xs)]"
        >
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            {fields.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-text-300">{label}</dt>
                <dd className="min-w-0 break-all font-mono text-text-200">{value}</dd>
              </div>
            ))}
          </dl>
          {[
            [t('traffic.requestPreview'), record.requestPreview],
            [t('traffic.responsePreview'), record.responsePreview],
          ].map(
            ([label, preview]) =>
              preview && (
                <div key={label} className="min-w-0">
                  <h3 className="mb-1 font-medium text-text-200">{label}</h3>
                  <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-text-300 custom-scrollbar">
                    {preview}
                  </pre>
                </div>
              ),
          )}
          {!record.requestPreview && !record.responsePreview && (
            <p className="text-text-300">{t('traffic.noPreview')}</p>
          )}
        </div>
      )}
    </li>
  )
}
