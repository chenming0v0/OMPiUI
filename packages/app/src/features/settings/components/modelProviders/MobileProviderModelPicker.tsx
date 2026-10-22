import { useMemo } from 'react'
import { Plus, RefreshCw, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SpinnerIcon } from '../../../../components/Icons'
import { settingsFieldClass } from '../SettingsUI'
import { ProviderModelAvatar, ProviderModelCapabilities } from './ProviderModelSummary'
import type { ProviderDraft } from './providerTypes'

type Props = {
  provider: ProviderDraft
  upstream: string[]
  loading: boolean
  error: string | null
  query: string
  onQuery: (value: string) => void
  onRetry: () => void
  onClose: () => void
  onAdd: (ids: string[]) => void
  onRemove: (ids: string[]) => void
  saveError?: string
  onRetrySave?: () => void
}

export function MobileProviderModelPicker({
  provider,
  upstream,
  loading,
  error,
  query,
  onQuery,
  onRetry,
  onClose,
  onAdd,
  onRemove,
  saveError,
  onRetrySave,
}: Props) {
  const { t } = useTranslation('settings')
  const configured = useMemo(() => new Map(provider.models.map(model => [model.id, model])), [provider.models])
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return [...new Set([...upstream, ...configured.keys()])].filter(
      id => id.toLowerCase().includes(normalized) || configured.get(id)?.name.toLowerCase().includes(normalized),
    )
  }, [upstream, configured, query])
  const available = visible.filter(id => !configured.has(id))

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-100">
      <header className="flex shrink-0 items-center justify-between gap-2 px-4 pb-4 pt-5">
        <h2 className="min-w-0 flex-1 text-base font-semibold text-text-100">{t('providers.availableModels')}</h2>
        {!loading && !error && available.length > 0 && (
          <button
            type="button"
            onClick={() => onAdd(available)}
            className="min-h-11 shrink-0 px-2 text-sm font-medium text-accent-main-100"
          >
            {t('providers.selectAll')} ({available.length})
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title={t('providers.close')}
          aria-label={t('providers.close')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-400 hover:bg-bg-200"
        >
          <X size={20} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 custom-scrollbar">
        {loading ? (
          <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-text-400">
            <SpinnerIcon size={18} className="animate-spin" />
            {t('providers.pickerLoading')}
          </div>
        ) : error ? (
          <div className="space-y-3 py-8 text-center">
            <p role="alert" className="break-words text-sm text-danger-100">
              {error}
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-11 items-center gap-2 px-3 text-sm text-text-200"
            >
              <RefreshCw size={16} />
              {t('providers.retry')}
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="py-12 text-center text-sm text-text-400">{t('providers.pickerEmpty')}</p>
        ) : (
          <div className="space-y-2">
            {visible.map(id => {
              const model = configured.get(id)
              const label = model ? t('providers.deleteModel') : t('providers.addModel')
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => (model ? onRemove([id]) : onAdd([id]))}
                  aria-label={`${label} ${id}`}
                  title={`${label} ${id}`}
                  className="flex min-h-[72px] w-full items-center gap-3 rounded-lg bg-bg-200 px-3 py-3 text-left transition-colors active:bg-bg-300"
                >
                  <ProviderModelAvatar />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium text-text-100">{model?.name || id}</span>
                    {model && <ProviderModelCapabilities model={model} />}
                  </span>
                  <span className="flex h-11 w-9 shrink-0 items-center justify-center text-text-300">
                    {model ? <X size={23} strokeWidth={1.5} /> : <Plus size={25} strokeWidth={1.5} />}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      <footer className="shrink-0 px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
        {saveError && (
          <div role="alert" className="mb-2 flex items-center justify-between gap-2 text-sm text-danger-100">
            <span className="min-w-0 truncate" title={saveError}>
              {t('providers.saveFailed')}
            </span>
            <button type="button" onClick={onRetrySave} className="min-h-11 shrink-0 px-2">
              {t('providers.retrySave')}
            </button>
          </div>
        )}
        <div className="relative">
          <Search size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-400" />
          <input
            value={query}
            onChange={event => onQuery(event.target.value)}
            aria-label={t('providers.filterModels')}
            placeholder={t('providers.filterModels')}
            spellCheck={false}
            autoComplete="off"
            className={`${settingsFieldClass} !min-h-14 !pl-10 !pr-11 !text-base`}
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery('')}
              title={t('search.clear')}
              aria-label={t('search.clear')}
              className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-text-400"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}
