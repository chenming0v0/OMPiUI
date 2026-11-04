import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OmpRuntimeCandidate } from '@ompiui/protocol'
import {
  getDesktopRuntimeCatalog,
  saveDesktopRuntimeSelection,
  type DesktopRuntimeCatalog,
} from '../services/desktopService'
import { serviceStore, useServiceStore } from '../store/serviceStore'
import { CpuIcon, FolderOpenIcon, RetryIcon } from './Icons'
import { Button } from './ui/Button'

interface DesktopRuntimePanelProps {
  backendRunning: boolean
  busy?: boolean
  refreshKey?: number | null
  onApply?: () => void
}

const sourceKeys = { bundled: 'bundled', environment: 'environment', path: 'pathSource' } as const
const CUSTOM = ':custom:'

function savedBin() {
  return serviceStore.envVars.find(item => item.key.trim().toUpperCase() === 'OMPI_OMP_BIN')?.value.trim() || ''
}

export function DesktopRuntimePanel({ backendRunning, busy = false, refreshKey, onApply }: DesktopRuntimePanelProps) {
  const { t } = useTranslation('components')
  const { envVars } = useServiceStore()
  const environmentSignature = JSON.stringify(envVars)
  const id = useId()
  const requestId = useRef(0)
  const [catalog, setCatalog] = useState<DesktopRuntimeCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [choice, setChoice] = useState(savedBin)
  const [customPath, setCustomPath] = useState(savedBin)

  const load = useCallback(async (resetChoice = false) => {
    const request = ++requestId.current
    setLoading(true)
    setError('')
    try {
      const next = await getDesktopRuntimeCatalog()
      if (request !== requestId.current) return
      setCatalog(next)
      if (resetChoice) {
        const bin = savedBin()
        setChoice(bin && !next.available.candidates.some(item => item.path === bin) ? CUSTOM : bin)
        setCustomPath(bin)
      }
    } catch (reason) {
      if (request === requestId.current) {
        setCatalog(null)
        setError(String(reason))
      }
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void load(true) })
    return () => {
      active = false
      requestId.current += 1
    }
  }, [load, environmentSignature, refreshKey, backendRunning])

  const inspection = backendRunning ? catalog?.current : catalog?.available
  const selected = inspection?.selected
  const detected = !!selected?.version && !selected.error && !inspection?.error
  const status = !catalog && loading ? 'loading' : !inspection ? 'unavailable' : detected ? 'available' : 'missing'
  const pending =
    !!catalog?.current &&
    (catalog.current.configuredBin !== catalog.available.configuredBin ||
      catalog.current.configuredRuntimeDir !== catalog.available.configuredRuntimeDir ||
      catalog.current.selected?.path !== catalog.available.selected?.path)
  const candidates = catalog?.available.candidates ?? []
  const candidate = candidates.find(item => item.path === choice)
  const desiredPath = choice === CUSTOM ? customPath.trim() : choice
  const unchanged =
    choice === ''
      ? !envVars.some(item =>
          ['OMPI_OMP_BIN', 'OMPI_OMP_RUNTIME_DIR', 'OMPI_OMP_PACKAGE_ROOT', 'OMPI_BUN_BIN'].includes(
            item.key.trim().toUpperCase(),
          ) && item.value.trim(),
        )
      : desiredPath === savedBin()
  const nextDetected =
    !!catalog?.available.selected?.version && !catalog.available.selected.error && !catalog.available.error
  const blocked = busy || loading || saving
  const sourceLabel = (item: OmpRuntimeCandidate) => t(`desktopService.runtime.${sourceKeys[item.source]}`)

  const save = async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await saveDesktopRuntimeSelection(desiredPath || null, candidate?.runtimeRoot)
      setSaved(true)
      await load()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSaving(false)
    }
  }

  const browse = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const path = await open({ multiple: false, directory: false, title: t('desktopService.runtime.path') })
      if (typeof path === 'string') {
        setChoice(CUSTOM)
        setCustomPath(path)
        setSaved(false)
      }
    } catch (reason) {
      setError(String(reason))
    }
  }

  return (
    <section aria-label={t('desktopService.runtime.title')} className="space-y-4 text-sm text-text-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-text-100">
          <CpuIcon size={18} />
          {t('desktopService.runtime.title')}
        </h3>
        <span
          role="status"
          className={`inline-flex items-center gap-1.5 text-xs ${detected ? 'text-success-100' : 'text-warning-100'}`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${detected ? 'bg-success-100' : 'bg-warning-100'}`}
          />
          {t(`desktopService.runtime.${status}`)}
        </span>
      </div>
      <div
        className={`rounded-xl border p-4 ${detected ? 'border-accent-main-100/30 bg-accent-main-100/5' : 'border-warning-100/30 bg-warning-100/5'}`}
      >
        <div className="mb-2 text-xs text-text-300">
          {t(`desktopService.runtime.${backendRunning ? 'current' : 'next'}`)}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-lg font-semibold text-text-100">
            {selected
              ? `OMP ${selected.version ? `v${selected.version}` : ''}`
              : t('desktopService.runtime.notSelected')}
          </span>
          {selected && (
            <span className="rounded-md bg-bg-200 px-2 py-0.5 text-xs text-text-200">{sourceLabel(selected)}</span>
          )}
          {selected && !selected.version && (
            <span className="text-xs text-text-300">{t('desktopService.runtime.versionUnknown')}</span>
          )}
        </div>
        {selected && (
          <p className="mt-2 select-text break-all font-mono text-xs leading-relaxed text-text-200">{selected.path}</p>
        )}
        {!detected && (
          <p className="mt-2 text-xs leading-relaxed text-text-200">
            {backendRunning && !catalog?.current
              ? t('desktopService.runtime.currentQueryFailed')
              : t('desktopService.runtime.missingHint')}
          </p>
        )}
        {(selected?.error || (inspection?.error && candidates.length > 0)) && (
          <p role="alert" className="mt-2 break-all text-xs text-danger-100">
            {selected?.error || inspection?.error}
          </p>
        )}
      </div>
      {catalog && (
        <p className="text-xs leading-relaxed text-text-300">
          {t(`desktopService.runtime.${catalog.available.bundled ? 'full' : 'lightweight'}`)}
        </p>
      )}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`${id}-selection`} className="text-xs font-medium text-text-100">
            {t('desktopService.runtime.selection')}
          </label>
          <Button
            variant="ghost"
            size="sm"
            disabled={blocked}
            onClick={() => void load()}
            aria-label={t('desktopService.runtime.refresh')}
          >
            <RetryIcon size={13} />
            {t('desktopService.runtime.refresh')}
          </Button>
        </div>
        <select
          id={`${id}-selection`}
          value={choice}
          disabled={blocked}
          className="h-9 w-full min-w-0 rounded-lg border border-border-200 bg-bg-100 px-3 text-xs text-text-100 focus-visible:outline-2 focus-visible:outline-accent-main-100 disabled:opacity-50"
          onChange={event => {
            setChoice(event.target.value)
            setSaved(false)
          }}
        >
          <option value="">{t('desktopService.runtime.auto')}</option>
          {candidates.map(item => (
            <option
              key={item.path}
              value={item.path}
              disabled={!!item.error}
            >{`OMP ${item.version ?? '—'} · ${sourceLabel(item)} · ${item.path}`}</option>
          ))}
          <option value={CUSTOM}>{t('desktopService.runtime.custom')}</option>
        </select>
        {choice === '' && (
          <p className="text-xs leading-relaxed text-text-300">
            {t('desktopService.runtime.autoHint')} {t('desktopService.runtime.configuredHint')}
          </p>
        )}
        {choice === CUSTOM && (
          <div className="flex gap-2">
            <input
              aria-label={t('desktopService.runtime.path')}
              value={customPath}
              onChange={event => {
                setCustomPath(event.target.value)
                setSaved(false)
              }}
              disabled={blocked}
              spellCheck={false}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border-200 bg-bg-100 px-3 font-mono text-xs text-text-100 focus-visible:outline-2 focus-visible:outline-accent-main-100"
            />
            <Button
              variant="secondary"
              disabled={blocked}
              onClick={() => void browse()}
              aria-label={t('desktopService.runtime.browse')}
            >
              <FolderOpenIcon size={15} />
            </Button>
          </div>
        )}
        {candidates.length > 0 && (
          <ul
            aria-label={t('desktopService.runtime.available')}
            className="max-h-36 overflow-y-auto rounded-lg border border-border-200/60 divide-y divide-border-200/60 custom-scrollbar"
          >
            {candidates.map(item => (
              <li key={item.path}>
                <button
                  type="button"
                  disabled={blocked || !!item.error}
                  onClick={() => {
                    setChoice(item.path)
                    setSaved(false)
                  }}
                  aria-pressed={choice === item.path}
                  className={`flex w-full items-start gap-3 px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-main-100 disabled:opacity-50 ${choice === item.path ? 'bg-accent-main-100/10' : 'hover:bg-bg-200/70'}`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${choice === item.path ? 'border-accent-main-100 bg-accent-main-100' : 'border-text-400'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs">
                      <span className="font-medium text-text-100">OMP {item.version ?? '—'}</span>
                      <span className="flex items-center gap-2 text-text-300">
                        {backendRunning && inspection?.selected?.path === item.path && (
                          <span className="rounded bg-success-100/10 px-1.5 py-0.5 text-[11px] text-success-100">
                            {t('desktopService.runtime.inUse')}
                          </span>
                        )}
                        {sourceLabel(item)}
                      </span>
                    </span>
                    <span className="mt-1 block break-all font-mono text-[11px] leading-relaxed text-text-300">
                      {item.path}
                    </span>
                    {item.error && <span className="mt-1 block break-all text-xs text-danger-100">{item.error}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!loading && candidates.length === 0 && (
          <p className="text-xs text-text-300">{t('desktopService.runtime.empty')}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={blocked || unchanged || (choice === CUSTOM && !desiredPath) || !!candidate?.error}
          isLoading={saving}
          onClick={() => void save()}
        >
          {t('desktopService.runtime.save')}
        </Button>
        {pending && onApply && (
          <Button size="sm" disabled={blocked || !nextDetected} onClick={onApply}>
            {t('desktopService.runtime.apply')}
          </Button>
        )}
        {saved && (
          <span role="status" className="text-xs text-success-100">
            {t('desktopService.runtime.saved')}
          </span>
        )}
      </div>
      {pending && <p className="text-xs text-warning-100">{t('desktopService.runtime.pending')}</p>}
      {pending && catalog?.available.error && (
        <p role="alert" className="break-all text-xs text-danger-100">
          {catalog.available.error}
        </p>
      )}
      {error && (
        <p role="alert" className="break-all text-xs text-danger-100">
          {error}
        </p>
      )}
      {catalog?.currentError && backendRunning && (
        <p role="alert" className="break-all text-xs text-danger-100">
          {catalog.currentError}
        </p>
      )}
      <p className="text-xs leading-relaxed text-text-300">
        {t('desktopService.runtime.selectionHint')}
        <br />
        {t('desktopService.runtime.readOnlyHint')}
      </p>
    </section>
  )
}
