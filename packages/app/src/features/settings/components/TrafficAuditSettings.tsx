import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { ChevronLeft, ChevronRight, Download, ListFilter, Search, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useServerStore } from '../../../hooks/useServerStore'
import { trafficAuditStore, TRAFFIC_RECORD_LIMIT } from '../../../omp/trafficAudit/store'
import { redactTrafficUrl } from '../../../omp/trafficAudit/privacy'
import { formatTrafficBytes, trafficRanking, trafficTotals } from '../../../omp/trafficAudit/summary'
import { saveData } from '../../../utils/downloadUtils'
import {
  SegmentedControl,
  SettingRow,
  SettingsDisclosure,
  SettingsSelect,
  Toggle,
  settingsFieldClass,
} from './SettingsUI'
import { TrafficAuditRecord } from './TrafficAuditRecord'

const PAGE_SIZE = 50
const iconButtonClass =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-300 hover:bg-bg-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-main-100 disabled:opacity-40'

export function TrafficAuditSettings() {
  const { t } = useTranslation('settings')
  const { activeServer } = useServerStore()
  const snapshot = useSyncExternalStore(trafficAuditStore.subscribe, trafficAuditStore.getSnapshot)
  const [serverFilter, setServerFilter] = useState('current')
  const [protocol, setProtocol] = useState<'all' | 'http' | 'ws'>('all')
  const [direction, setDirection] = useState('all')
  const [sort, setSort] = useState('latest')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const currentServer = activeServer ? redactTrafficUrl(activeServer.url).server : undefined
  const server = serverFilter === 'current' ? currentServer : serverFilter === 'all' ? undefined : serverFilter
  const totals = trafficTotals(snapshot, server)
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const records = snapshot.records.filter(
      record =>
        (!server || record.server === server) &&
        (protocol === 'all' || record.protocol === protocol) &&
        (direction === 'all' ||
          record.direction === direction ||
          (record.direction === 'exchange' &&
            (direction === 'sent' ? record.sentBytes !== null : record.receivedBytes !== null))) &&
        (!errorsOnly || record.status === 'error' || record.status === 'aborted') &&
        (!needle ||
          `${record.url} ${record.operation} ${record.sessionId ?? ''} ${record.statusCode ?? ''}`
            .toLocaleLowerCase()
            .includes(needle)),
    )
    if (sort === 'largest')
      records.sort(
        (a, b) => (b.sentBytes ?? 0) + (b.receivedBytes ?? 0) - ((a.sentBytes ?? 0) + (a.receivedBytes ?? 0)),
      )
    if (sort === 'slowest')
      records.sort((a, b) => (b.durationMs ?? b.headersMs ?? 0) - (a.durationMs ?? a.headersMs ?? 0))
    return records
  }, [snapshot.records, server, protocol, direction, errorsOnly, query, sort])
  const ranking = useMemo(() => trafficRanking(filtered), [filtered])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const rows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const changeFilter = (change: () => void) => {
    change()
    setPage(0)
    setSelectedId(null)
  }
  const exportRecords = useCallback(() => {
    const timestamp = new Date()
    const report = {
      version: 1,
      scope:
        'Current client application payloads; excludes HTTP headers, WS framing, TLS, tunnel overhead, static assets and other clients.',
      exportedAt: timestamp.toISOString(),
      startedAt: new Date(snapshot.startedAt).toISOString(),
      limit: TRAFFIC_RECORD_LIMIT,
      dropped: snapshot.dropped,
      filters: { server: server ?? 'all', protocol, direction, query, errorsOnly, sort },
      totals,
      records: filtered,
    }
    saveData(
      new TextEncoder().encode(JSON.stringify(report, null, 2)),
      `ompiui-traffic-${timestamp.getTime()}.json`,
      'application/json',
    )
  }, [snapshot, server, protocol, direction, query, errorsOnly, sort, totals, filtered])
  const summaries = [
    [t('traffic.sent'), formatTrafficBytes(totals.sentBytes)],
    [t('traffic.received'), formatTrafficBytes(totals.receivedBytes)],
    [t('traffic.httpRequests'), String(totals.httpRequests)],
    [t('traffic.wsMessages'), String(totals.wsMessages)],
    [t('traffic.connections'), String(totals.connections)],
    [t('traffic.errors'), String(totals.errors)],
  ]

  return (
    <section className="min-w-0 space-y-4" data-setting-label={t('tabs.traffic')}>
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[length:var(--fs-base)] font-semibold text-text-100">{t('tabs.traffic')}</h2>
          <p className="mt-1 break-words text-[length:var(--fs-xs)] leading-relaxed text-text-300">
            {t('traffic.scopeShort')}
          </p>
          <p className="mt-1 break-all font-mono text-[length:var(--fs-xs)] text-text-300">
            {server ?? t('traffic.allServers')}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            className={iconButtonClass}
            title={t('traffic.export')}
            aria-label={t('traffic.export')}
            disabled={!filtered.length}
            onClick={exportRecords}
          >
            <Download size={17} />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            title={t('traffic.clear')}
            aria-label={t('traffic.clear')}
            onClick={() => {
              trafficAuditStore.clear()
              setPage(0)
              setSelectedId(null)
            }}
          >
            <Trash2 size={17} />
          </button>
        </div>
      </header>
      <div>
        <SettingRow label={t('traffic.recording')} onClick={() => trafficAuditStore.setEnabled(!snapshot.enabled)}>
          <span className="flex h-11 w-11 items-center justify-center">
            <Toggle enabled={snapshot.enabled} onChange={() => trafficAuditStore.setEnabled(!snapshot.enabled)} />
          </span>
        </SettingRow>
        <SettingRow
          label={t('traffic.previews')}
          description={t('traffic.previewHint')}
          onClick={() => trafficAuditStore.setPreviews(!snapshot.previews)}
        >
          <span className="flex h-11 w-11 items-center justify-center">
            <Toggle enabled={snapshot.previews} onChange={() => trafficAuditStore.setPreviews(!snapshot.previews)} />
          </span>
        </SettingRow>
      </div>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-3 border-y border-border-200/60 py-3">
        {summaries.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[length:var(--fs-xs)] text-text-300">{label}</dt>
            <dd className="mt-1 break-all font-mono text-[length:var(--fs-base)] font-medium tabular-nums text-text-100">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="min-w-0 space-y-3" data-setting-label={t('traffic.requests')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[length:var(--fs-md)] font-medium text-text-100">{t('traffic.requests')}</h3>
          <span className={`text-[length:var(--fs-xs)] ${snapshot.enabled ? 'text-success-100' : 'text-warning-100'}`}>
            {t(snapshot.enabled ? 'traffic.active' : 'traffic.paused')}
          </span>
        </div>
        <SegmentedControl
          value={protocol}
          onChange={value => changeFilter(() => setProtocol(value))}
          options={[
            { value: 'all', label: t('traffic.all') },
            { value: 'http', label: 'HTTP' },
            { value: 'ws', label: 'WebSocket' },
          ]}
        />
        <div className="flex min-w-0 gap-2">
          <div className="relative min-w-0 flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-3.5 text-text-300" />
            <input
              aria-label={t('traffic.search')}
              placeholder={t('traffic.searchPlaceholder')}
              className={`${settingsFieldClass} !h-11 pl-9`}
              value={query}
              onChange={event => changeFilter(() => setQuery(event.target.value))}
            />
          </div>
          <button
            type="button"
            className={`${iconButtonClass} ${showFilters || direction !== 'all' || errorsOnly || sort !== 'latest' || serverFilter !== 'current' ? '!text-accent-main-100' : ''}`}
            title={t('traffic.filters')}
            aria-label={t('traffic.filters')}
            aria-expanded={showFilters}
            aria-controls="traffic-filters"
            onClick={() => setShowFilters(!showFilters)}
          >
            <ListFilter size={17} />
          </button>
        </div>
        {showFilters && (
          <div id="traffic-filters" className="min-w-0 space-y-3">
            <SettingsSelect
              ariaLabel={t('traffic.server')}
              value={serverFilter}
              onChange={value => changeFilter(() => setServerFilter(value))}
              className="!h-11"
              options={[
                { value: 'current', label: t('traffic.currentServer') },
                { value: 'all', label: t('traffic.allServers') },
                ...Object.keys(snapshot.totals).map(value => ({ value, label: value })),
              ]}
            />
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <SettingsSelect
                value={direction}
                ariaLabel={t('traffic.direction')}
                className="!h-11"
                onChange={value => changeFilter(() => setDirection(value))}
                options={[
                  { value: 'all', label: t('traffic.bothDirections') },
                  { value: 'sent', label: t('traffic.sent') },
                  { value: 'received', label: t('traffic.received') },
                  { value: 'connection', label: t('traffic.connections') },
                ]}
              />
              <SettingsSelect
                value={sort}
                ariaLabel={t('traffic.sort')}
                className="!h-11"
                onChange={value => changeFilter(() => setSort(value))}
                options={[
                  { value: 'latest', label: t('traffic.latest') },
                  { value: 'largest', label: t('traffic.largest') },
                  { value: 'slowest', label: t('traffic.slowest') },
                ]}
              />
            </div>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[length:var(--fs-xs)] text-text-300">
              <input
                type="checkbox"
                checked={errorsOnly}
                onChange={event => changeFilter(() => setErrorsOnly(event.target.checked))}
              />
              {t('traffic.errorsOnly')}
            </label>
          </div>
        )}
        <p className="text-[length:var(--fs-xs)] text-text-300">
          {t('traffic.retention', {
            count: snapshot.records.length,
            limit: TRAFFIC_RECORD_LIMIT,
            dropped: snapshot.dropped,
          })}
        </p>
        {rows.length ? (
          <ul className="min-w-0" aria-label={t('traffic.requests')}>
            {rows.map(record => (
              <TrafficAuditRecord
                key={record.id}
                record={record}
                expanded={selectedId === record.id}
                onToggle={() => setSelectedId(selectedId === record.id ? null : record.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="py-8 text-center text-[length:var(--fs-sm)] text-text-300">
            {t(snapshot.records.length ? 'traffic.noMatches' : 'traffic.empty')}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[length:var(--fs-xs)] text-text-300">
            {t('traffic.pagination', { page: currentPage + 1, pages: pageCount, count: filtered.length })}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              className={iconButtonClass}
              title={t('traffic.previous')}
              aria-label={t('traffic.previous')}
              disabled={currentPage === 0}
              onClick={() => {
                setPage(currentPage - 1)
                setSelectedId(null)
              }}
            >
              <ChevronLeft size={17} />
            </button>
            <button
              type="button"
              className={iconButtonClass}
              title={t('traffic.next')}
              aria-label={t('traffic.next')}
              disabled={currentPage + 1 >= pageCount}
              onClick={() => {
                setPage(currentPage + 1)
                setSelectedId(null)
              }}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      </div>
      {ranking.length > 0 && (
        <div className="min-w-0 border-t border-border-200/60 pt-4">
          <h3 className="mb-3 text-[length:var(--fs-md)] font-medium text-text-100">{t('traffic.ranking')}</h3>
          <ol className="space-y-3">
            {ranking.map(group => (
              <li
                key={group.label}
                className="flex min-w-0 items-start justify-between gap-3 text-[length:var(--fs-xs)]"
              >
                <span className="min-w-0 break-all font-mono text-text-300">{group.label}</span>
                <span className="shrink-0 text-right font-mono tabular-nums text-text-200">
                  {formatTrafficBytes(group.bytes)}
                  <br />
                  <span className="text-text-300">{t('traffic.times', { count: group.count })}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <SettingsDisclosure title={t('traffic.scopeDetails')}>
        <div className="space-y-2 text-[length:var(--fs-xs)] leading-relaxed text-text-300">
          <p>{t('traffic.scope')}</p>
          <p>{t('traffic.previewWarning')}</p>
        </div>
      </SettingsDisclosure>
    </section>
  )
}
