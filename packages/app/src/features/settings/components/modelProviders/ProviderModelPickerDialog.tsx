import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../../../components/ui/Dialog'
import { Button } from '../../../../components/ui/Button'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  SearchIcon,
  SpinnerIcon,
} from '../../../../components/Icons'
import { fetchModelProviderModels } from '../../../../omp/transport/index.js'
import { groupModelIds, type ProviderDraft } from './providerTypes'
import { settingsFieldClass } from '../SettingsUI'
import { useIsMobile } from '../../../../hooks'
import { MobileProviderModelPicker } from './MobileProviderModelPicker'
import './mobileProviders.css'

export type ProviderModelPickerDialogProps = {
  isOpen: boolean
  provider: ProviderDraft
  onClose: () => void
  /** 用户确认添加的模型 id（已排除当前已配置 id） */
  onAddModels: (ids: string[]) => void
  /** 用户确认移除的本地模型 id */
  onRemoveModels: (ids: string[]) => void
  saveError?: string
  onRetrySave?: () => void
}

type PickerTab = 'new' | 'removed'

function toggleInSet(source: Set<string>, value: string): Set<string> {
  const next = new Set(source)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

const checkboxClass = (checked: boolean, partial = false) =>
  `flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors
  ${
    checked || partial
      ? 'border-accent-main-100 bg-accent-main-100 text-oncolor-100'
      : 'border-border-300 bg-bg-100 text-transparent hover:border-border-200'
  }`

export function ProviderModelPickerDialog({
  isOpen,
  provider,
  onClose,
  onAddModels,
  onRemoveModels,
  saveError,
  onRetrySave,
}: ProviderModelPickerDialogProps) {
  const { t } = useTranslation('settings')
  const isMobile = useIsMobile()
  const [tab, setTab] = useState<PickerTab>('new')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [upstream, setUpstream] = useState<string[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [selectedNew, setSelectedNew] = useState<Set<string>>(new Set())
  const [selectedRemoved, setSelectedRemoved] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [reloadToken, setReloadToken] = useState(0)

  const configuredIds = useMemo(() => new Set(provider.models.map(model => model.id)), [provider.models])
  // 移动端逐行增删时保留已拉取的列表和筛选，不重复请求上游。
  const knownModelKey = isMobile ? '' : provider.models.map(model => model.id).join('\u0000')
  const newIds = useMemo(() => upstream.filter(id => !configuredIds.has(id)), [upstream, configuredIds])
  const baseUrl = provider.baseUrl.trim()
  const hasKey = provider.apiKey.trim().length > 0

  useEffect(() => {
    if (!isOpen) return
    setTab('new')
    setQuery('')
    setSelectedNew(new Set())
    setSelectedRemoved(new Set())
    setUpstream([])
    setRemoved([])
    setError(null)
    if (!baseUrl) {
      setError(t('providers.pickerNoBaseUrl'))
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void fetchModelProviderModels({
      baseUrl,
      api: provider.api,
      ...(hasKey ? { apiKey: provider.apiKey.trim() } : {}),
      knownModelIds: provider.models.map(model => model.id),
    })
      .then(result => {
        if (cancelled) return
        setUpstream(result.models)
        setRemoved(result.removed)
        setError(null)
        const groups = groupModelIds(result.models)
        if (groups.length > 1) setCollapsed(new Set(groups.slice(1).map(group => group.name)))
        else setCollapsed(new Set())
      })
      .catch(fetchError => {
        if (cancelled) return
        const message = fetchError instanceof Error ? fetchError.message : String(fetchError)
        setError(t('providers.fetchFailedWith', { message }))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, baseUrl, provider.api, provider.apiKey, knownModelKey, hasKey, reloadToken, t])

  const tabIds = tab === 'new' ? newIds : removed
  const selection = tab === 'new' ? selectedNew : selectedRemoved
  const groups = useMemo(() => groupModelIds(tabIds), [tabIds])
  const normalizedQuery = query.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return groups
    return groups
      .map(group => ({
        name: group.name,
        models: group.models.filter(
          id => id.toLowerCase().includes(normalizedQuery) || group.name.toLowerCase().includes(normalizedQuery),
        ),
      }))
      .filter(group => group.models.length > 0)
  }, [groups, normalizedQuery])
  const visibleModels = useMemo(() => filteredGroups.flatMap(group => group.models), [filteredGroups])
  const allVisibleSelected = visibleModels.length > 0 && visibleModels.every(id => selection.has(id))
  const someVisibleSelected = visibleModels.some(id => selection.has(id))

  const selectGroup = (models: string[]) => {
    const allSelected = models.every(id => selection.has(id))
    const apply = (source: Set<string>) => {
      const next = new Set(source)
      for (const id of models) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    }
    if (tab === 'new') setSelectedNew(apply)
    else setSelectedRemoved(apply)
  }

  const toggleSelectAll = () => {
    const apply = (source: Set<string>) => {
      const next = new Set(source)
      for (const id of visibleModels) {
        if (allVisibleSelected) next.delete(id)
        else next.add(id)
      }
      return next
    }
    if (tab === 'new') setSelectedNew(apply)
    else setSelectedRemoved(apply)
  }

  const toggleModel = (id: string) => {
    if (tab === 'new') setSelectedNew(source => toggleInSet(source, id))
    else setSelectedRemoved(source => toggleInSet(source, id))
  }

  const confirm = () => {
    if (selection.size === 0) return
    const ids = [...selection]
    if (tab === 'new') onAddModels(ids)
    else onRemoveModels(ids)
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('providers.pickerTitle', { name: provider.name })}
      ariaLabel={t('providers.pickerTitle', { name: provider.name })}
      width={isMobile ? '100%' : 'min(96vw, 680px)'}
      className={isMobile ? 'provider-model-sheet' : ''}
      showCloseButton={false}
      rawContent
    >
      {isMobile ? (
        <MobileProviderModelPicker
          provider={provider}
          upstream={upstream}
          loading={loading}
          error={error}
          query={query}
          onQuery={setQuery}
          onRetry={() => setReloadToken(token => token + 1)}
          onClose={onClose}
          onAdd={onAddModels}
          onRemove={onRemoveModels}
          saveError={saveError}
          onRetrySave={onRetrySave}
        />
      ) : (
      <div className="flex min-h-0 flex-1 flex-col max-h-[min(86vh,760px)]">
        <header className="shrink-0 border-b border-border-200/60 px-5 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[length:var(--fs-xxs)] font-medium uppercase tracking-wider text-text-400">
                {provider.name}
              </div>
              <h2 className="mt-0.5 text-[length:var(--fs-lg)] font-semibold text-text-100">
                {t('providers.pickerTitle', { name: provider.name })}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('providers.close')}
              className="shrink-0 flex h-8 w-8 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
            >
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-1 text-[length:var(--fs-xs)]">
            {(
              [
                ['new', t('providers.pickerNew', { count: newIds.length })],
                ['removed', t('providers.pickerRemoved', { count: removed.length })],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={`h-7 rounded-md px-2.5 font-medium transition-colors ${
                  tab === value ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:bg-bg-200/60 hover:text-text-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="shrink-0 px-5 py-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-400" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('providers.pickerSearch')}
              aria-label={t('providers.pickerSearch')}
              spellCheck={false}
              autoComplete="off"
              className={`${settingsFieldClass} pl-8`}
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[length:var(--fs-xxs)] text-text-500">
              {t('providers.pickerSearchHint')}
            </span>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 pb-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[length:var(--fs-sm)] text-text-400">
              <SpinnerIcon size={16} className="animate-spin" />
              {t('providers.pickerLoading')}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <div className="text-[length:var(--fs-sm)] text-danger-100">{error}</div>
              <Button variant="secondary" size="sm" onClick={() => setReloadToken(token => token + 1)}>
                {t('providers.retry')}
              </Button>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="py-16 text-center text-[length:var(--fs-sm)] text-text-400">{t('providers.pickerEmpty')}</div>
          ) : (
            <div className="space-y-1">
              {filteredGroups.map(group => {
                const isCollapsed = !normalizedQuery && collapsed.has(group.name)
                const selectedInGroup = group.models.filter(id => selection.has(id)).length
                const allInGroup = selectedInGroup === group.models.length
                const partial = selectedInGroup > 0 && !allInGroup
                return (
                  <section key={group.name} className="rounded-lg border border-border-200/40">
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={allInGroup ? true : partial ? 'mixed' : false}
                        aria-label={group.name}
                        onClick={() => selectGroup(group.models)}
                        className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-bg-200"
                      >
                        <span className={checkboxClass(allInGroup, partial)}>
                          {partial ? <span className="h-0.5 w-2 rounded bg-oncolor-100" /> : <CheckIcon size={10} />}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-expanded={!isCollapsed}
                        onClick={() =>
                          setCollapsed(source => {
                            const next = new Set(source)
                            if (next.has(group.name)) next.delete(group.name)
                            else next.add(group.name)
                            return next
                          })
                        }
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left"
                      >
                        <span className="text-text-400">
                          {isCollapsed ? <ChevronRightIcon size={14} /> : <ChevronDownIcon size={14} />}
                        </span>
                        <span className="truncate text-[length:var(--fs-sm)] font-medium text-text-200">{group.name}</span>
                        <span className="shrink-0 text-[length:var(--fs-xxs)] text-text-500">({group.models.length})</span>
                      </button>
                      <span className="shrink-0 text-[length:var(--fs-xxs)] tabular-nums text-text-400">
                        {selectedInGroup > 0 ? `${selectedInGroup}/${group.models.length}` : ''}
                      </span>
                    </div>
                    {!isCollapsed && (
                      <div className="grid grid-cols-1 gap-0.5 px-1.5 pb-1.5 sm:grid-cols-2">
                        {group.models.map(id => {
                          const checked = selection.has(id)
                          return (
                            <button
                              key={id}
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              onClick={() => toggleModel(id)}
                              className={`flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-left transition-colors ${
                                checked ? 'bg-accent-main-100/8' : 'hover:bg-bg-200/60'
                              }`}
                            >
                              <span className={checkboxClass(checked)}>
                                <CheckIcon size={10} />
                              </span>
                              <span
                                className={`truncate font-mono text-[length:var(--fs-xs)] ${checked ? 'text-text-100' : 'text-text-300'}`}
                                title={id}
                              >
                                {id}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </div>

        <footer className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-t border-border-200/60 px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="text-[length:var(--fs-xs)] text-text-400">
              {t('providers.pickerSelected', { selected: selection.size, total: visibleModels.length })}
            </span>
            <button
              type="button"
              role="checkbox"
              aria-checked={allVisibleSelected ? true : someVisibleSelected ? 'mixed' : false}
              onClick={toggleSelectAll}
              className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[length:var(--fs-xs)] text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
            >
              <span className={checkboxClass(allVisibleSelected, someVisibleSelected && !allVisibleSelected)}>
                {someVisibleSelected && !allVisibleSelected ? (
                  <span className="h-0.5 w-2 rounded bg-oncolor-100" />
                ) : (
                  <CheckIcon size={10} />
                )}
              </span>
              {t('providers.selectAll')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('providers.cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={selection.size === 0 || loading || Boolean(error)} onClick={confirm}>
              {tab === 'new'
                ? t('providers.pickerConfirmAdd', { count: selection.size })
                : t('providers.pickerConfirmRemove', { count: selection.size })}
            </Button>
          </div>
        </footer>
      </div>
      )}
    </Dialog>
  )
}
