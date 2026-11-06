import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { OmpRuntimeCandidate } from '@ompiui/protocol'
import { desktopServicePhase, isServiceBusy, useDesktopDiagnostics } from '../store/desktopDiagnosticsStore'
import { desktopRuntimeStore, useDesktopRuntime } from '../store/desktopRuntimeStore'
import { useServiceStore, type EnvVar } from '../store/serviceStore'
import { CpuIcon, FolderOpenIcon, RetryIcon, SpinnerIcon } from './Icons'
import { Button } from './ui/Button'

const AUTO = ''
const CUSTOM = ':custom:'
const runtimeKeys = ['OMPI_OMP_BIN', 'OMPI_OMP_RUNTIME_DIR', 'OMPI_OMP_PACKAGE_ROOT', 'OMPI_BUN_BIN']

function envValue(envVars: EnvVar[], key: string) {
  return envVars.find(item => item.key.trim().toUpperCase() === key)?.value.trim() || ''
}

/** Windows 路径大小写与分隔符不敏感；保存的路径与检测结果写法不同也要认作同一个。 */
function samePath(a?: string | null, b?: string | null) {
  if (!a || !b) return false
  const normalize = (value: string) => {
    const path = value.trim().replace(/[\\/]+/g, '/')
    return /^[a-z]:\//i.test(path) || value.includes('\\') ? path.toLowerCase() : path
  }
  return normalize(a) === normalize(b)
}

/**
 * 面板共用的后端 / 运行时视图。检测结果来自带持久化缓存的 store：
 * 打开面板先显示上次结果，只有后端进程或启动环境变化时才重新检测；
 * 重启过程中不检测，也不把“尚未读到”显示成“没有运行时”。
 */
function useRuntimeView() {
  const diagnostics = useDesktopDiagnostics()
  const { envVars, startedByUs, starting } = useServiceStore()
  const runtime = useDesktopRuntime()
  const phase = desktopServicePhase(diagnostics)
  const busy = isServiceBusy(phase) || starting
  const running = phase === 'running'
  const native = diagnostics.native
  const backend = running ? String(native?.spawnedAt ?? native?.pid ?? 'running') : null
  const environment = JSON.stringify(envVars)
  const waiting = phase === 'unknown' && !native && !diagnostics.queryError

  useEffect(() => {
    if (busy || waiting) return
    void desktopRuntimeStore.refresh(backend)
  }, [busy, waiting, backend, environment])

  const catalog = runtime.catalog
  const currentFresh = running && runtime.backend === backend
  return {
    ...runtime,
    envVars,
    startedByUs,
    busy,
    running,
    backend,
    native,
    inUse: currentFresh ? (catalog?.current?.selected ?? null) : null,
    currentError: currentFresh ? catalog?.currentError || catalog?.current?.error || null : null,
    target: catalog?.available.selected ?? null,
    candidates: catalog?.available.candidates ?? [],
    ompMissing: running && native?.workerReady === true && !native.ompVersion,
  }
}

function useRuntimeLabels() {
  const { t } = useTranslation('components')
  const kind = (item: OmpRuntimeCandidate) =>
    t(`desktopService.runtime.kind.${item.runtimeRoot ? 'bundled' : 'standalone'}`)
  const version = (value?: string | null) => (value ? `OMP ${value}` : t('desktopService.runtime.versionUnknown'))
  return { t, kind, version, describe: (item: OmpRuntimeCandidate) => `${version(item.version)} · ${kind(item)}` }
}

function Chip({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning'; children: ReactNode }) {
  const tones = {
    neutral: 'bg-bg-200 text-text-300',
    success: 'bg-success-100/10 text-success-100',
    warning: 'bg-warning-100/10 text-warning-100',
  }
  return (
    <span className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] leading-none ${tones[tone]}`}>
      {children}
    </span>
  )
}

/** 卡片外壳与后端状态卡共用，保证两张概览卡等高、同一视觉层级。 */
export function StatusCard({
  label,
  icon,
  tone,
  children,
}: {
  label: string
  icon: ReactNode
  tone: 'success' | 'warning' | 'danger' | 'busy' | 'idle'
  children: ReactNode
}) {
  const accents = {
    success: 'bg-success-100/10 text-success-100',
    warning: 'bg-warning-100/10 text-warning-100',
    danger: 'bg-danger-100/10 text-danger-100',
    busy: 'bg-accent-main-100/10 text-accent-main-100',
    idle: 'bg-bg-200 text-text-300',
  }
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border-200/60 bg-bg-100/40 p-4"
    >
      <div className="flex items-center gap-2 text-xs text-text-300">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${accents[tone]}`}>{icon}</span>
        {label}
      </div>
      {children}
    </section>
  )
}

/** 正在使用的运行时：只认当前后端进程报告的结果，重启中显示目标而不是告警。 */
export function DesktopRuntimeInUse() {
  const view = useRuntimeView()
  const { t, kind, version, describe } = useRuntimeLabels()
  const { busy, running, inUse, target, native, loading, ompMissing, currentError } = view
  const reported = native?.ompVersion

  let tone: 'success' | 'warning' | 'danger' | 'busy' | 'idle'
  let body: ReactNode
  if (busy) {
    tone = 'busy'
    body = (
      <>
        <div role="status" className="flex items-center gap-2 text-base font-semibold text-text-100">
          <SpinnerIcon size={14} className="animate-spin text-accent-main-100" />
          {t('desktopService.runtime.switching')}
        </div>
        <p className="text-xs text-text-300">
          {target ? t('desktopService.runtime.willUse', { name: describe(target) }) : t('desktopService.runtime.auto')}
        </p>
      </>
    )
  } else if (running && ompMissing) {
    tone = 'warning'
    body = (
      <>
        <div role="status" className="text-base font-semibold text-warning-100">
          {t('desktopService.runtime.statusMissing')}
        </div>
        <p className="text-xs leading-relaxed text-text-300">{t('desktopService.runtime.missingHint')}</p>
      </>
    )
  } else if (running && (inUse || reported)) {
    tone = inUse?.error ? 'danger' : 'success'
    body = (
      <>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span role="status" className="text-base font-semibold text-text-100">
            {version(inUse?.version ?? reported)}
          </span>
          {inUse && <Chip>{kind(inUse)}</Chip>}
        </div>
        {inUse ? (
          <p title={inUse.path} className="select-text truncate font-mono text-[11px] text-text-300">
            {inUse.path}
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-text-300">
            {loading && <SpinnerIcon size={11} className="animate-spin" />}
            {t(`desktopService.runtime.${loading ? 'reading' : 'currentQueryFailed'}`)}
          </p>
        )}
        {inUse?.error && <p role="alert" className="break-all text-xs text-danger-100">{inUse.error}</p>}
        {!inUse && !loading && currentError && (
          <p role="alert" className="break-all text-xs text-danger-100">{currentError}</p>
        )}
      </>
    )
  } else if (running) {
    tone = 'busy'
    body = (
      <div role="status" className="flex items-center gap-2 text-base font-semibold text-text-100">
        <SpinnerIcon size={14} className="animate-spin text-accent-main-100" />
        {t('desktopService.runtime.connecting')}
      </div>
    )
  } else {
    tone = 'idle'
    body = (
      <>
        <div role="status" className="text-base font-semibold text-text-200">
          {t('desktopService.runtime.notRunning')}
        </div>
        <p className="text-xs text-text-300">
          {target
            ? t('desktopService.runtime.nextStart', { name: describe(target) })
            : t('desktopService.runtime.nextStartAuto')}
        </p>
      </>
    )
  }

  return (
    <StatusCard label={t('desktopService.runtime.inUse')} icon={<CpuIcon size={14} />} tone={tone}>
      <div className="flex min-w-0 flex-col gap-1.5">{body}</div>
    </StatusCard>
  )
}

function RuntimeOption({
  checked,
  disabled,
  onSelect,
  title,
  badges,
  detail,
  error,
  children,
}: {
  checked: boolean
  disabled?: boolean
  onSelect: () => void
  title: string
  badges?: ReactNode
  detail?: ReactNode
  error?: string | null
  children?: ReactNode
}) {
  return (
    <div
      className={`rounded-lg border transition-colors ${checked ? 'border-accent-main-100/50 bg-accent-main-100/10' : 'border-border-200/60 hover:bg-bg-200/50'}`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        onClick={onSelect}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-main-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${checked ? 'border-accent-main-100' : 'border-text-400'}`}
        >
          {checked && <span className="h-1.5 w-1.5 rounded-full bg-accent-main-100" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-text-100">{title}</span>
            {badges}
          </span>
          {detail && <span className="mt-0.5 block truncate text-[11px] text-text-300">{detail}</span>}
          {error && <span className="mt-1 block break-all text-xs text-danger-100">{error}</span>}
        </span>
      </button>
      {children}
    </div>
  )
}

interface DesktopRuntimeSelectorProps {
  /** 应用启动的后端才可重启；未提供时只保存，下次启动生效。 */
  onRestart?: () => Promise<unknown> | void
}

export function DesktopRuntimeSelector({ onRestart }: DesktopRuntimeSelectorProps) {
  const view = useRuntimeView()
  const { t, i18n } = useTranslation('components')
  const { kind, version, describe } = useRuntimeLabels()
  const { envVars, candidates, inUse, target, busy, running, startedByUs, backend, loading, checkedAt } = view
  const [draft, setDraft] = useState<string | null>(null)
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const savedBin = envValue(envVars, 'OMPI_OMP_BIN')
  const configured = runtimeKeys.some(key => envValue(envVars, key))
  const savedChoice = savedBin ? (candidates.find(item => samePath(item.path, savedBin))?.path ?? CUSTOM) : AUTO
  const choice = draft ?? savedChoice
  const customPath = customDraft ?? (savedChoice === CUSTOM ? savedBin : '')
  const candidate = candidates.find(item => item.path === choice)
  const desiredPath = choice === CUSTOM ? customPath.trim() : choice
  const changed = choice === AUTO ? configured : !samePath(desiredPath, savedBin)
  const invalid = (choice === CUSTOM && !desiredPath) || !!candidate?.error
  const canRestart = running && startedByUs && !!onRestart
  const pending = !changed && running && !busy && !!inUse && !!target && !samePath(inUse.path, target.path)
  const choiceName =
    choice === AUTO ? t('desktopService.runtime.auto') : candidate ? describe(candidate) : desiredPath || '—'

  const select = (value: string) => {
    setDraft(value)
    setNotice('')
    setError('')
  }

  const apply = async () => {
    const restart = canRestart
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await desktopRuntimeStore.save(desiredPath || null, candidate?.runtimeRoot, backend)
      setDraft(null)
      setCustomDraft(null)
      if (restart) await onRestart?.()
      else setNotice(t(`desktopService.runtime.${running ? 'savedExternal' : 'saved'}`))
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
        select(CUSTOM)
        setCustomDraft(path)
      }
    } catch (reason) {
      setError(String(reason))
    }
  }

  const badges = (path: string) => (
    <>
      {inUse && samePath(inUse.path, path) && <Chip tone="success">{t('desktopService.runtime.inUseBadge')}</Chip>}
      {pending && target && samePath(target.path, path) && (
        <Chip tone="warning">{t('desktopService.runtime.nextBadge')}</Chip>
      )}
    </>
  )
  const checkedTime = checkedAt
    ? new Date(checkedAt).toLocaleTimeString(i18n.language, { hour12: false, hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <section aria-label={t('desktopService.runtime.selection')} className="space-y-3 text-sm text-text-200">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-100">{t('desktopService.runtime.selection')}</h3>
        <div className="flex items-center gap-2 text-xs text-text-400">
          {checkedTime && !loading && <span>{t('desktopService.runtime.checkedAt', { time: checkedTime })}</span>}
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || busy}
            onClick={() => void desktopRuntimeStore.refresh(backend, true)}
          >
            {loading ? <SpinnerIcon size={13} className="animate-spin" /> : <RetryIcon size={13} />}
            {t(`desktopService.runtime.${loading ? 'checking' : 'refresh'}`)}
          </Button>
        </div>
      </div>

      <div role="radiogroup" aria-label={t('desktopService.runtime.selection')} className="space-y-1.5">
        <RuntimeOption
          checked={choice === AUTO}
          disabled={saving}
          onSelect={() => select(AUTO)}
          title={t('desktopService.runtime.auto')}
          detail={
            savedChoice === AUTO && target
              ? t('desktopService.runtime.autoResolved', { name: describe(target) })
              : t('desktopService.runtime.autoHint')
          }
        />
        {candidates.map(item => (
          <RuntimeOption
            key={item.path}
            checked={choice === item.path}
            disabled={saving || !!item.error}
            onSelect={() => select(item.path)}
            title={version(item.version)}
            badges={
              <>
                <Chip>{kind(item)}</Chip>
                {badges(item.path)}
              </>
            }
            detail={<span title={item.path} className="font-mono">{item.path}</span>}
            error={item.error}
          />
        ))}
        {!candidates.length && (
          <p className="flex items-center gap-2 rounded-lg border border-dashed border-border-200/60 px-3 py-2.5 text-xs text-text-300">
            {loading && <SpinnerIcon size={12} className="animate-spin" />}
            {t(`desktopService.runtime.${loading ? 'detecting' : view.catalog?.available.bundled ? 'empty' : 'lightweight'}`)}
          </p>
        )}
        <RuntimeOption
          checked={choice === CUSTOM}
          disabled={saving}
          onSelect={() => select(CUSTOM)}
          title={t('desktopService.runtime.custom')}
          detail={choice === CUSTOM ? null : t('desktopService.runtime.customHint')}
          badges={savedChoice === CUSTOM ? badges(savedBin) : null}
        >
          {choice === CUSTOM && (
            <div className="flex gap-2 px-3 pb-3 pl-10">
              <input
                aria-label={t('desktopService.runtime.path')}
                value={customPath}
                placeholder={t('desktopService.runtime.path')}
                onChange={event => {
                  setCustomDraft(event.target.value)
                  setNotice('')
                }}
                disabled={saving}
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-md border border-border-200 bg-bg-100 px-2.5 font-mono text-xs text-text-100 focus-visible:outline-2 focus-visible:outline-accent-main-100"
              />
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => void browse()}
                aria-label={t('desktopService.runtime.browse')}
              >
                <FolderOpenIcon size={15} />
              </Button>
            </div>
          )}
        </RuntimeOption>
      </div>

      {changed && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent-main-100/30 bg-accent-main-100/5 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-text-100">
              {t('desktopService.runtime.switchTo', { name: choiceName })}
            </p>
            <p className="mt-0.5 text-[11px] text-text-300">
              {t(
                `desktopService.runtime.${canRestart ? 'restartHint' : running ? 'externalHint' : 'nextStartHint'}`,
              )}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setDraft(null)
              setCustomDraft(null)
            }}
          >
            {t('desktopService.runtime.revert')}
          </Button>
          <Button size="sm" disabled={busy || invalid} isLoading={saving} onClick={() => void apply()}>
            {t(`desktopService.runtime.${canRestart ? 'applyRestart' : 'save'}`)}
          </Button>
        </div>
      )}
      {pending && target && inUse && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning-100/30 bg-warning-100/5 px-3 py-2.5">
          <p className="min-w-0 flex-1 text-xs text-text-200">
            {t('desktopService.runtime.pending', { next: describe(target), current: describe(inUse) })}
          </p>
          {canRestart && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onRestart?.()}>
              {t('desktopService.runtime.restartToApply')}
            </Button>
          )}
        </div>
      )}
      {notice && !pending && (
        <p role="status" className="text-xs text-success-100">
          {notice}
        </p>
      )}
      {(error || view.error) && (
        <p role="alert" className="break-all text-xs text-danger-100">
          {error || view.error}
        </p>
      )}
      <p className="text-[11px] leading-relaxed text-text-400">{t('desktopService.runtime.readOnlyHint')}</p>
    </section>
  )
}

/** 设置页使用的完整版：正在使用 + 选择列表。 */
export function DesktopRuntimePanel({ onRestart }: DesktopRuntimeSelectorProps) {
  return (
    <div className="space-y-4">
      <DesktopRuntimeInUse />
      <DesktopRuntimeSelector onRestart={onRestart} />
    </div>
  )
}
