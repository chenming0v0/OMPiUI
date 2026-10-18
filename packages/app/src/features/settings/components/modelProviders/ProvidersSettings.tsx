import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../../components/ui/Button'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import { Dialog } from '../../../../components/ui/Dialog'
import {
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RetryIcon,
  SpinnerIcon,
  TrashIcon,
} from '../../../../components/Icons'
import {
  deleteModelProvider,
  listModelProviders,
  saveModelProvider,
} from '../../../../omp/transport/index.js'
import type { PiModelProvidersSnapshot } from '../../../../omp/domain/index.js'
import { useServerStore } from '../../../../hooks/useServerStore'
import {
  SettingsSection,
  SettingsSelect,
  settingsFieldClass,
} from '../SettingsUI'
import {
  API_FORMAT_OPTIONS,
  blankModelDraft,
  formatModelContext,
  inferModelDefaults,
  providerDraftFromConfig,
  providerDraftToConfig,
  providerSummary,
  slugifyProviderId,
  uniqueProviderId,
  type ModelDraft,
  type ProviderApiFormat,
  type ProviderDraft,
} from './providerTypes'
import { ProviderModelEditorDialog } from './ProviderModelEditorDialog'
import { ProviderModelPickerDialog } from './ProviderModelPickerDialog'

type SaveState = 'idle' | 'saving' | 'error'

type EditorState = {
  providerId: string
  model: ModelDraft | null
  queue: string[]
  queueIndex: number
  queueTotal: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ============================================
// Add provider dialog
// ============================================

function AddProviderDialog({
  isOpen,
  takenIds,
  onClose,
  onCreate,
}: {
  isOpen: boolean
  takenIds: string[]
  onClose: () => void
  onCreate: (draft: ProviderDraft) => void
}) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [api, setApi] = useState<ProviderApiFormat>('anthropic-messages')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setName('')
    setBaseUrl('')
    setApi('anthropic-messages')
    setApiKey('')
    setError(null)
  }, [isOpen])

  const submit = () => {
    const nextName = name.trim()
    if (!nextName) {
      setError(t('providers.nameRequired'))
      return
    }
    if (!baseUrl.trim()) {
      setError(t('providers.baseUrlRequired'))
      return
    }
    const id = uniqueProviderId(slugifyProviderId(nextName), takenIds)
    onCreate({
      id,
      name: nextName,
      api,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      authHeader: true,
      models: [],
    })
  }

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('providers.addTitle')} width={460}>
      <form
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
      >
        <p className="mb-4 text-[length:var(--fs-xs)] text-text-400">{t('providers.addHint')}</p>
        <div className="space-y-3">
          <label className="block">
            <span className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('providers.name')}</span>
            <input
              autoFocus
              value={name}
              onChange={event => {
                setName(event.target.value)
                setError(null)
              }}
              placeholder={t('providers.namePlaceholder')}
              className={`${settingsFieldClass} mt-1`}
            />
          </label>
          <label className="block">
            <span className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('providers.baseUrl')}</span>
            <input
              value={baseUrl}
              onChange={event => {
                setBaseUrl(event.target.value)
                setError(null)
              }}
              placeholder={t('providers.baseUrlPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className={`${settingsFieldClass} mt-1 font-mono`}
            />
          </label>
          <div>
            <span className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('providers.apiFormat')}</span>
            <div className="mt-1">
              <SettingsSelect
                value={api}
                ariaLabel={t('providers.apiFormat')}
                options={API_FORMAT_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) }))}
                onChange={value => setApi(value)}
              />
            </div>
          </div>
          <label className="block">
            <span className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('providers.apiKey')}</span>
            <input
              type="password"
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
              placeholder={t('providers.apiKeyPlaceholder')}
              autoComplete="off"
              className={`${settingsFieldClass} mt-1 font-mono`}
            />
            <span className="mt-1 block text-[length:var(--fs-xxs)] text-text-500">{t('providers.apiKeyHint')}</span>
          </label>
          {error && (
            <div className="text-[length:var(--fs-xs)] text-danger-100" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={onClose}>
            {t('providers.cancel')}
          </Button>
          <Button variant="primary" size="sm" type="submit">
            {t('providers.createProvider')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// ============================================
// Provider page
// ============================================

export function ProvidersSettings() {
  const { t } = useTranslation('settings')
  const { activeServerGeneration } = useServerStore()

  const [snapshot, setSnapshot] = useState<PiModelProvidersSnapshot | null>(null)
  const [drafts, setDrafts] = useState<ProviderDraft[]>([])
  const draftsRef = useRef<ProviderDraft[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({})
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({})
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const [addOpen, setAddOpen] = useState(false)
  const [pickerProviderId, setPickerProviderId] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState<ProviderDraft | null>(null)
  const [pendingClearProvider, setPendingClearProvider] = useState<ProviderDraft | null>(null)
  const [pendingDeleteModel, setPendingDeleteModel] = useState<{ providerId: string; modelId: string } | null>(null)

  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const latestDraftsRef = useRef(new Map<string, ProviderDraft>())
  const saveSeqRef = useRef(new Map<string, number>())
  const inflightRef = useRef(new Map<string, Promise<unknown>>())

  const selected = useMemo(() => drafts.find(draft => draft.id === selectedId) ?? null, [drafts, selectedId])

  const applySnapshot = useCallback((next: PiModelProvidersSnapshot, preferredId?: string) => {
    // 重新读取后，旧的防抖保存不应再把过期草稿写回文件。
    for (const timer of timersRef.current.values()) clearTimeout(timer)
    timersRef.current.clear()
    const nextDrafts = next.providers.map(providerDraftFromConfig)
    draftsRef.current = nextDrafts
    setDrafts(nextDrafts)
    setSelectedId(current => {
      const wanted = preferredId ?? current
      if (wanted && nextDrafts.some(draft => draft.id === wanted)) return wanted
      return nextDrafts[0]?.id ?? ''
    })
    setSaveStates({})
    setSaveErrors({})
  }, [])

  const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'refresh') setRefreshing(true)
    else setLoading(true)
    setLoadError(null)
    try {
      const next = await listModelProviders()
      setSnapshot(next)
      applySnapshot(next)
      setLoadError(next.error ?? null)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [applySnapshot])

  useEffect(() => {
    void load('initial')
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [load, activeServerGeneration])

  // models.yml 会被 omp CLI / 终端登录改写。收到 models.updated 后重读文件，
  // 同时取消待执行的防抖保存，避免过期草稿把外部改动覆盖回去。
  useEffect(() => {
    const onModelsUpdated = () => {
      void load('refresh')
    }
    window.addEventListener('ompiui:models-updated', onModelsUpdated)
    return () => window.removeEventListener('ompiui:models-updated', onModelsUpdated)
  }, [load])

  const persistNow = useCallback((draft: ProviderDraft) => {
    latestDraftsRef.current.set(draft.id, draft)
    const seq = (saveSeqRef.current.get(draft.id) ?? 0) + 1
    saveSeqRef.current.set(draft.id, seq)
    setSaveStates(state => ({ ...state, [draft.id]: 'saving' }))
    setSaveErrors(state => {
      const next = { ...state }
      delete next[draft.id]
      return next
    })
    const flight = saveModelProvider(providerDraftToConfig(draft))
      .then(() => {
        if (saveSeqRef.current.get(draft.id) !== seq) return
        setSaveStates(state => ({ ...state, [draft.id]: 'idle' }))
      })
      .catch(error => {
        if (saveSeqRef.current.get(draft.id) !== seq) return
        setSaveStates(state => ({ ...state, [draft.id]: 'error' }))
        setSaveErrors(state => ({ ...state, [draft.id]: errorMessage(error) }))
      })
    inflightRef.current.set(draft.id, flight)
    void flight.finally(() => {
      if (inflightRef.current.get(draft.id) === flight) inflightRef.current.delete(draft.id)
    })
  }, [])

  const scheduleSave = useCallback(
    (draft: ProviderDraft, mode: 'debounced' | 'immediate') => {
      latestDraftsRef.current.set(draft.id, draft)
      const timers = timersRef.current
      const existing = timers.get(draft.id)
      if (existing) clearTimeout(existing)
      if (mode === 'immediate') {
        timers.delete(draft.id)
        persistNow(draft)
        return
      }
      const timer = setTimeout(() => {
        timers.delete(draft.id)
        const latest = latestDraftsRef.current.get(draft.id) ?? draft
        persistNow(latest)
      }, 600)
      timers.set(draft.id, timer)
    },
    [persistNow],
  )

  const commit = useCallback(
    (next: ProviderDraft, mode: 'debounced' | 'immediate' = 'immediate') => {
      draftsRef.current = draftsRef.current.map(draft => (draft.id === next.id ? next : draft))
      setDrafts(draftsRef.current)
      scheduleSave(next, mode)
    },
    [scheduleSave],
  )

  const retrySave = useCallback(
    (providerId: string) => {
      const draft = latestDraftsRef.current.get(providerId) ?? draftsRef.current.find(item => item.id === providerId)
      if (draft) persistNow(draft)
    },
    [persistNow],
  )

  const updateSelected = useCallback(
    (updater: (draft: ProviderDraft) => ProviderDraft, mode: 'debounced' | 'immediate' = 'debounced') => {
      const current = draftsRef.current.find(draft => draft.id === selectedId)
      if (!current) return
      commit(updater(current), mode)
    },
    [commit, selectedId],
  )

  const removeModel = useCallback(
    (providerId: string, modelId: string) => {
      const current = draftsRef.current.find(draft => draft.id === providerId)
      if (!current) return
      commit({ ...current, models: current.models.filter(model => model.id !== modelId) }, 'immediate')
    },
    [commit],
  )

  const addModels = useCallback(
    (providerId: string, ids: string[]) => {
      const current = draftsRef.current.find(draft => draft.id === providerId)
      if (!current) return
      const existing = new Set(current.models.map(model => model.id))
      const added: ModelDraft[] = ids
        .filter(id => !existing.has(id))
        .map(id => ({ ...blankModelDraft(id), ...inferModelDefaults(id) }))
      if (added.length === 0) return
      commit({ ...current, models: [...current.models, ...added] }, 'immediate')
      setPickerProviderId(null)
      if (added.length > 0) {
        setEditor({
          providerId,
          model: added[0]!,
          queue: added.slice(1).map(model => model.id),
          queueIndex: 0,
          queueTotal: added.length,
        })
      }
    },
    [commit],
  )

  const saveEditorModel = useCallback(
    (draft: ModelDraft) => {
      if (!editor) return
      const current = draftsRef.current.find(item => item.id === editor.providerId)
      if (!current) return
      const editingId = editor.model ? (editor.model.originalId ?? editor.model.id) : null
      const normalized: ModelDraft = editingId ? { ...draft, originalId: editingId } : { ...draft, originalId: draft.id }
      const models = editingId
        ? current.models.map(model => ((model.originalId ?? model.id) === editingId ? normalized : model))
        : [...current.models, normalized]
      const next = { ...current, models }
      commit(next, 'immediate')

      const nextId = editor.queue[0]
      if (nextId) {
        const nextModel = models.find(model => model.id === nextId)
        if (nextModel) {
          setEditor({
            providerId: editor.providerId,
            model: nextModel,
            queue: editor.queue.slice(1),
            queueIndex: editor.queueIndex + 1,
            queueTotal: editor.queueTotal,
          })
          return
        }
      }
      setEditor(null)
    },
    [commit, editor],
  )

  const saveStatus = selected ? (saveStates[selected.id] ?? 'idle') : 'idle'
  const saveError = selected ? saveErrors[selected.id] : undefined
  const providerMissingKey = selected ? selected.apiKey.trim().length === 0 : false
  const totalModels = drafts.reduce((count, draft) => count + draft.models.length, 0)

  if (loading) {
    return (
      <SettingsSection title={t('providers.title')} description={t('providers.description')}>
        <div className="flex items-center justify-center gap-2 py-14 text-[length:var(--fs-sm)] text-text-400">
          <SpinnerIcon size={16} className="animate-spin" />
          {t('providers.loading')}
        </div>
      </SettingsSection>
    )
  }

  if (snapshot && !snapshot.supported) {
    return (
      <SettingsSection title={t('providers.title')} description={t('providers.description')}>
        <div className="py-10 text-center text-[length:var(--fs-sm)] text-text-400">{t('providers.unsupported')}</div>
      </SettingsSection>
    )
  }

  return (
    <>
      <SettingsSection
        title={t('providers.title')}
        description={t('providers.description')}
        actions={
          <>
            <button
              type="button"
              onClick={() => void load('refresh')}
              disabled={refreshing}
              title={t('providers.refresh')}
              aria-label={t('providers.refresh')}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100 disabled:opacity-50"
            >
              {refreshing ? <SpinnerIcon size={14} className="animate-spin" /> : <RetryIcon size={14} />}
            </button>
            <span data-setting-label={t('providers.addProvider')}>
              <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
                <PlusIcon size={14} />
                {t('providers.addProvider')}
              </Button>
            </span>
          </>
        }
      >
        {loadError && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-danger-100/40 bg-danger-100/5 px-3 py-2">
            <span className="min-w-0 truncate text-[length:var(--fs-xs)] text-danger-100" title={loadError}>
              {t('providers.loadFailedWith', { message: loadError })}
            </span>
            <Button variant="secondary" size="sm" onClick={() => void load('initial')}>
              {t('providers.retry')}
            </Button>
          </div>
        )}

        {drafts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-200/70 py-12 text-center">
            <PlugIcon size={22} className="text-text-500" />
            <div>
              <div className="text-[length:var(--fs-md)] font-medium text-text-100">{t('providers.empty')}</div>
              <div className="mt-1 text-[length:var(--fs-xs)] text-text-400">{t('providers.emptyHint')}</div>
            </div>
            <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
              <PlusIcon size={14} />
              {t('providers.addProvider')}
            </Button>
          </div>
        ) : (
          <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[236px_minmax(0,1fr)]">
            <aside className="min-w-0">
              <div className="overflow-hidden rounded-lg border border-border-200/50">
                <div className="flex items-center justify-between border-b border-border-200/40 px-2.5 py-2">
                  <span className="text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wider text-text-500">
                    {t('providers.listTitle')}
                  </span>
                  <span className="text-[length:var(--fs-xxs)] tabular-nums text-text-500">{drafts.length}</span>
                </div>
                <div className="max-h-[420px] space-y-0.5 overflow-y-auto custom-scrollbar p-1">
                  {drafts.map(draft => {
                    const summary = providerSummary(draft)
                    const active = draft.id === selectedId
                    return (
                      <div
                        key={draft.id}
                        className={`group flex items-center rounded-md transition-colors ${
                          active ? 'bg-bg-200' : 'hover:bg-bg-200/50'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(draft.id)
                            setMenuOpen(false)
                          }}
                          aria-current={active ? 'true' : undefined}
                          className="min-w-0 flex-1 px-2.5 py-2 text-left"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <PlugIcon size={14} className={active ? 'text-accent-main-100' : 'text-text-400'} />
                            <span className="min-w-0 flex-1 truncate text-[length:var(--fs-md)] font-medium text-text-100">
                              {draft.name}
                            </span>
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                summary.missingKey ? 'bg-warning-100' : 'bg-success-100'
                              }`}
                              title={summary.missingKey ? t('providers.missingKey') : t('providers.configured')}
                            />
                          </div>
                          <div className="mt-0.5 truncate pl-[22px] text-[length:var(--fs-xxs)] text-text-500">
                            {summary.apiPath} · {t('providers.modelsCount', { count: summary.modelCount })}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPickerProviderId(draft.id)}
                          title={t('providers.fetchModels')}
                          aria-label={t('providers.fetchModels')}
                          className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-400 opacity-0 transition-all hover:bg-bg-300 hover:text-text-100 group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <DownloadIcon size={13} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border-200/70 px-2 py-1.5 text-[length:var(--fs-xs)] text-text-400 transition-colors hover:border-border-300 hover:text-text-100"
              >
                <PlusIcon size={12} />
                {t('providers.addProvider')}
              </button>
            </aside>

            <div className="min-w-0">
              {!selected ? (
                <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border-200/60 py-16 text-[length:var(--fs-sm)] text-text-400">
                  {t('providers.emptyHint')}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bg-200 text-accent-main-100">
                        <PlugIcon size={17} />
                      </div>
                      <div className="min-w-0">
                        <h3 className="truncate text-[length:var(--fs-base)] font-semibold text-text-100">
                          {selected.name}
                        </h3>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[length:var(--fs-xxs)] text-text-400">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              providerMissingKey ? 'bg-warning-100' : 'bg-success-100'
                            }`}
                          />
                          <span>{providerMissingKey ? t('providers.missingKey') : t('providers.configured')}</span>
                          <span>·</span>
                          <span>{t('providers.modelsCount', { count: selected.models.length })}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button variant="secondary" size="sm" onClick={() => setPickerProviderId(selected.id)}>
                        <DownloadIcon size={13} />
                        {t('providers.fetchModels')}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() =>
                          setEditor({
                            providerId: selected.id,
                            model: null,
                            queue: [],
                            queueIndex: 0,
                            queueTotal: 1,
                          })
                        }
                      >
                        <PlusIcon size={14} />
                        {t('providers.addModel')}
                      </Button>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setMenuOpen(value => !value)}
                          aria-label={t('providers.more')}
                          aria-expanded={menuOpen}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
                        >
                          <MoreVerticalIcon size={15} />
                        </button>
                        {menuOpen && (
                          <>
                            <button
                              type="button"
                              aria-label={t('providers.close')}
                              className="fixed inset-0 z-40 cursor-default"
                              onClick={() => setMenuOpen(false)}
                            />
                            <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border-200 bg-bg-100 p-1 shadow-lg">
                              <button
                                type="button"
                                onClick={() => {
                                  setMenuOpen(false)
                                  setPendingClearProvider(selected)
                                }}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[length:var(--fs-sm)] text-text-200 transition-colors hover:bg-bg-200"
                              >
                                <TrashIcon size={13} />
                                {t('providers.clearModels')}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setMenuOpen(false)
                                  setPendingDeleteProvider(selected)
                                }}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[length:var(--fs-sm)] text-danger-100 transition-colors hover:bg-danger-100/10"
                              >
                                <TrashIcon size={13} />
                                {t('providers.deleteProvider')}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3 rounded-lg border border-border-200/50 p-3">
                    <label className="block">
                      <span className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('providers.baseUrl')}</span>
                      <input
                        value={selected.baseUrl}
                        onChange={event =>
                          updateSelected(draft => ({ ...draft, baseUrl: event.target.value }), 'debounced')
                        }
                        placeholder={t('providers.baseUrlPlaceholder')}
                        spellCheck={false}
                        autoComplete="off"
                        className={`${settingsFieldClass} mt-1 font-mono`}
                      />
                    </label>
                    <div>
                      <span className="text-[length:var(--fs-xs)] font-medium text-text-300">
                        {t('providers.apiFormat')}
                      </span>
                      <div className="mt-1">
                        <SettingsSelect
                          value={selected.api}
                          ariaLabel={t('providers.apiFormat')}
                          options={API_FORMAT_OPTIONS.map(option => ({
                            value: option.value,
                            label: `${t(option.labelKey)} (${option.path})`,
                          }))}
                          onChange={value => updateSelected(draft => ({ ...draft, api: value }), 'immediate')}
                        />
                      </div>
                    </div>
                    <label className="block">
                      <span className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('providers.apiKey')}</span>
                      <div className="relative mt-1">
                        <input
                          type={revealedKeys.has(selected.id) ? 'text' : 'password'}
                          value={selected.apiKey}
                          onChange={event =>
                            updateSelected(draft => ({ ...draft, apiKey: event.target.value }), 'debounced')
                          }
                          placeholder={t('providers.apiKeyPlaceholder')}
                          autoComplete="off"
                          spellCheck={false}
                          className={`${settingsFieldClass} pr-9 font-mono`}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setRevealedKeys(current => {
                              const next = new Set(current)
                              if (next.has(selected.id)) next.delete(selected.id)
                              else next.add(selected.id)
                              return next
                            })
                          }
                          title={revealedKeys.has(selected.id) ? t('providers.hideKey') : t('providers.showKey')}
                          aria-label={revealedKeys.has(selected.id) ? t('providers.hideKey') : t('providers.showKey')}
                          className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-100 hover:text-text-100"
                        >
                          {revealedKeys.has(selected.id) ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                        </button>
                      </div>
                    </label>
                  </div>

                  <div>
                    <div
                      className="mb-2 flex items-center justify-between gap-2"
                      data-setting-label={t('providers.modelsTitle')}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-[length:var(--fs-xs)] font-semibold text-text-200">
                          {t('providers.modelsTitle')}
                        </span>
                        <span className="rounded bg-bg-200 px-1.5 py-0.5 text-[length:var(--fs-xxs)] tabular-nums text-text-400">
                          {selected.models.length}
                        </span>
                      </div>
                    </div>

                    {selected.models.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-200/60 py-9 text-center">
                        <DownloadIcon size={18} className="text-text-500" />
                        <div className="text-[length:var(--fs-sm)] font-medium text-text-200">
                          {t('providers.emptyModels')}
                        </div>
                        <div className="max-w-sm text-[length:var(--fs-xs)] text-text-400">
                          {t('providers.emptyModelsHint')}
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <Button variant="secondary" size="sm" onClick={() => setPickerProviderId(selected.id)}>
                            <DownloadIcon size={13} />
                            {t('providers.fetchModels')}
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() =>
                              setEditor({
                                providerId: selected.id,
                                model: null,
                                queue: [],
                                queueIndex: 0,
                                queueTotal: 1,
                              })
                            }
                          >
                            <PlusIcon size={14} />
                            {t('providers.addModel')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="divide-y divide-border-200/40 rounded-lg border border-border-200/50">
                        {selected.models.map(model => {
                          const context = formatModelContext(model.contextWindow)
                          return (
                            <div
                              key={model.id}
                              className="group flex items-center gap-2 px-2.5 py-2 transition-colors hover:bg-bg-200/40"
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setEditor({
                                    providerId: selected.id,
                                    model,
                                    queue: [],
                                    queueIndex: 0,
                                    queueTotal: 1,
                                  })
                                }
                                className="min-w-0 flex-1 text-left"
                              >
                                <div className="truncate text-[length:var(--fs-sm)] font-medium text-text-100">
                                  {model.name || model.id}
                                </div>
                                <div className="mt-0.5 flex min-w-0 items-center gap-2">
                                  <span className="truncate font-mono text-[length:var(--fs-xs)] text-text-400">
                                    {model.id}
                                  </span>
                                  {context && (
                                    <span className="shrink-0 rounded bg-bg-200 px-1 py-0.5 font-mono text-[length:var(--fs-xxs)] text-text-500">
                                      {context}
                                    </span>
                                  )}
                                  {model.input.includes('image') && (
                                    <span className="shrink-0 rounded bg-accent-main-100/10 px-1 py-0.5 text-[length:var(--fs-xxs)] text-accent-main-100">
                                      {t('providers.inputImage')}
                                    </span>
                                  )}
                                  {model.reasoning && (
                                    <span className="shrink-0 rounded bg-bg-200 px-1 py-0.5 text-[length:var(--fs-xxs)] text-text-500">
                                      {t('providers.reasoning')}
                                    </span>
                                  )}
                                </div>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setEditor({
                                    providerId: selected.id,
                                    model,
                                    queue: [],
                                    queueIndex: 0,
                                    queueTotal: 1,
                                  })
                                }
                                title={t('providers.editModel')}
                                aria-label={t('providers.editModel')}
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-400 opacity-0 transition-all hover:bg-bg-200 hover:text-text-100 group-hover:opacity-100 focus-visible:opacity-100"
                              >
                                <PencilIcon size={13} />
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDeleteModel({ providerId: selected.id, modelId: model.id })}
                                title={t('providers.deleteModel')}
                                aria-label={t('providers.deleteModel')}
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-400 opacity-0 transition-all hover:bg-danger-100/10 hover:text-danger-100 group-hover:opacity-100 focus-visible:opacity-100"
                              >
                                <TrashIcon size={13} />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  <div className="min-h-[18px] text-[length:var(--fs-xxs)]" role="status">
                    {saveStatus === 'saving' && (
                      <span className="inline-flex items-center gap-1.5 text-text-500">
                        <SpinnerIcon size={11} className="animate-spin" />
                        {t('providers.saving')}
                      </span>
                    )}
                    {saveStatus === 'error' && (
                      <button
                        type="button"
                        onClick={() => retrySave(selected.id)}
                        title={saveError}
                        className="text-danger-100 underline decoration-dotted underline-offset-2"
                      >
                        {t('providers.retrySave')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-200/40 pt-2.5">
          <span className="min-w-0 truncate font-mono text-[length:var(--fs-xxs)] text-text-500" title={snapshot?.path}>
            {snapshot?.path ? t('providers.configPath', { path: snapshot.path }) : ''}
          </span>
          <span className="text-[length:var(--fs-xxs)] tabular-nums text-text-500">
            {t('providers.modelsCount', { count: totalModels })}
          </span>
        </div>
      </SettingsSection>

      <AddProviderDialog
        isOpen={addOpen}
        takenIds={drafts.map(draft => draft.id)}
        onClose={() => setAddOpen(false)}
        onCreate={draft => {
          setAddOpen(false)
          draftsRef.current = [...draftsRef.current, draft]
          setDrafts(draftsRef.current)
          setSelectedId(draft.id)
          scheduleSave(draft, 'immediate')
        }}
      />

      {pickerProviderId && (() => {
        const provider = drafts.find(draft => draft.id === pickerProviderId)
        if (!provider) return null
        return (
          <ProviderModelPickerDialog
            isOpen
            provider={provider}
            onClose={() => setPickerProviderId(null)}
            onAddModels={ids => addModels(provider.id, ids)}
            onRemoveModels={ids => {
              const current = draftsRef.current.find(draft => draft.id === provider.id)
              if (current) {
                commit(
                  { ...current, models: current.models.filter(model => !ids.includes(model.id)) },
                  'immediate',
                )
              }
              setPickerProviderId(null)
            }}
          />
        )
      })()}

      <ProviderModelEditorDialog
        isOpen={editor !== null}
        providerName={editor ? (drafts.find(draft => draft.id === editor.providerId)?.name ?? '') : ''}
        model={editor?.model ?? null}
        siblings={editor ? (drafts.find(draft => draft.id === editor.providerId)?.models ?? []) : []}
        queueIndex={editor?.queueIndex}
        queueTotal={editor?.queueTotal}
        onClose={() => setEditor(null)}
        onSave={saveEditorModel}
      />

      <ConfirmDialog
        isOpen={pendingDeleteProvider !== null}
        onClose={() => setPendingDeleteProvider(null)}
        onConfirm={() => {
          const target = pendingDeleteProvider
          setPendingDeleteProvider(null)
          if (!target) return
          // 取消待写的防抖保存，并等已在途的保存落地后再删除，避免删除后又被旧保存写回。
          const timer = timersRef.current.get(target.id)
          if (timer) clearTimeout(timer)
          timersRef.current.delete(target.id)
          latestDraftsRef.current.delete(target.id)
          saveSeqRef.current.set(target.id, (saveSeqRef.current.get(target.id) ?? 0) + 1)
          void (async () => {
            await inflightRef.current.get(target.id)?.catch(() => undefined)
            try {
              const next = await deleteModelProvider(target.id)
              setSnapshot(next)
              const remaining = draftsRef.current.filter(draft => draft.id !== target.id)
              draftsRef.current = remaining
              setDrafts(remaining)
              setSelectedId(current => (current === target.id ? (remaining[0]?.id ?? '') : current))
            } catch (error) {
              setSaveErrors(state => ({ ...state, [target.id]: errorMessage(error) }))
            }
          })()
        }}
        title={t('providers.deleteProviderTitle')}
        description={t('providers.deleteProviderMessage', { name: pendingDeleteProvider?.name ?? '' })}
        confirmText={t('providers.confirmDelete')}
        variant="danger"
      />

      <ConfirmDialog
        isOpen={pendingClearProvider !== null}
        onClose={() => setPendingClearProvider(null)}
        onConfirm={() => {
          const target = pendingClearProvider
          setPendingClearProvider(null)
          if (!target) return
          const current = draftsRef.current.find(draft => draft.id === target.id)
          if (current) commit({ ...current, models: [] }, 'immediate')
        }}
        title={t('providers.clearModelsTitle')}
        description={t('providers.clearModelsMessage', {
          name: pendingClearProvider?.name ?? '',
          count: pendingClearProvider?.models.length ?? 0,
        })}
        confirmText={t('providers.confirmClear')}
        variant="danger"
      />

      <ConfirmDialog
        isOpen={pendingDeleteModel !== null}
        onClose={() => setPendingDeleteModel(null)}
        onConfirm={() => {
          const target = pendingDeleteModel
          setPendingDeleteModel(null)
          if (!target) return
          removeModel(target.providerId, target.modelId)
        }}
        title={t('providers.deleteModelTitle')}
        description={t('providers.deleteModelMessage', {
          name: drafts.find(draft => draft.id === pendingDeleteModel?.providerId)?.name ?? '',
          modelId: pendingDeleteModel?.modelId ?? '',
        })}
        confirmText={t('providers.confirmDelete')}
        variant="danger"
      />
    </>
  )
}
