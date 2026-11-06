import { useMemo } from 'react'
import { Check, CheckCheck, CloudOff, Plus, RefreshCw, Search, SearchX, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../../components/ui/Button'
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
  const all = useMemo(() => [...new Set([...upstream, ...configured.keys()])], [upstream, configured])
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return all.filter(
      id => id.toLowerCase().includes(normalized) || configured.get(id)?.name.toLowerCase().includes(normalized),
    )
  }, [all, configured, query])
  const available = visible.filter(id => !configured.has(id))
  const ready = !loading && !error

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-100">
      <header className="flex shrink-0 items-start gap-2 px-4 pb-3 pt-1">
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="text-lg font-semibold text-text-100">{t('providers.availableModels')}</h2>
          <p className="mt-0.5 truncate text-xs text-text-400">
            {provider.name}
            {ready && all.length > 0 && (
              <span className="tabular-nums">
                {' · '}
                {t('providers.pickerAddedCount', { added: configured.size, total: all.length })}
              </span>
            )}
          </p>
        </div>
        {ready && available.length > 0 && (
          <button
            type="button"
            onClick={() => onAdd(available)}
            className="provider-press provider-fade mt-1 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-accent-main-100/12 px-3.5 text-sm font-medium text-accent-main-100 active:bg-accent-main-100/20"
          >
            <CheckCheck size={16} aria-hidden />
            {t('providers.selectAll')} ({available.length})
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title={t('providers.close')}
          aria-label={t('providers.close')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-bg-200/70 text-text-300 transition-colors active:bg-bg-300"
        >
          <X size={20} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 custom-scrollbar">
        {loading ? (
          <div role="status" className="space-y-2">
            <p className="flex items-center justify-center gap-2 pb-1 pt-2 text-sm text-text-400">
              <SpinnerIcon size={16} className="animate-spin" />
              {t('providers.pickerLoading')}
            </p>
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                aria-hidden
                className="provider-skeleton h-[68px] rounded-2xl"
                style={{ animationDelay: `${index * 90}ms` }}
              />
            ))}
          </div>
        ) : error ? (
          <div className="provider-fade flex flex-col items-center gap-3 px-4 py-12 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-3xl bg-danger-100/10 text-danger-100">
              <CloudOff size={26} strokeWidth={1.6} />
            </span>
            <p role="alert" className="max-w-xs break-words text-sm leading-relaxed text-danger-100">
              {error}
            </p>
            <Button variant="secondary" onClick={onRetry} className="!h-10 !rounded-full !px-4">
              <RefreshCw size={16} />
              {t('providers.retry')}
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="provider-fade flex flex-col items-center gap-3 py-14 text-center text-text-400">
            <SearchX size={30} strokeWidth={1.5} />
            <p className="text-sm">{t('providers.pickerEmpty')}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((id, index) => {
              const model = configured.get(id)
              const label = model ? t('providers.deleteModel') : t('providers.addModel')
              return (
                <li key={id} className="provider-rise" style={{ '--stagger': index } as React.CSSProperties}>
                  <button
                    type="button"
                    onClick={() => (model ? onRemove([id]) : onAdd([id]))}
                    aria-label={`${label} ${id}`}
                    title={`${label} ${id}`}
                    className={`provider-press flex min-h-[68px] w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left ${
                      model
                        ? 'border-accent-main-100/40 bg-accent-main-100/6'
                        : 'border-border-200/60 bg-bg-000/40 active:bg-bg-200/60'
                    }`}
                  >
                    <ProviderModelAvatar id={id} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-text-100">{model?.name || id}</span>
                      {model && model.name && model.name !== id && (
                        <span className="block truncate font-mono text-xs text-text-400">{id}</span>
                      )}
                      {model && <ProviderModelCapabilities model={model} />}
                    </span>
                    <span
                      key={model ? 'added' : 'idle'}
                      className={`provider-pop flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
                        model
                          ? 'bg-accent-main-100 text-oncolor-100 shadow-sm'
                          : 'border border-border-300 text-text-300'
                      }`}
                    >
                      {model ? <Check size={17} strokeWidth={2.6} /> : <Plus size={18} strokeWidth={2} />}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <footer className="shrink-0 border-t border-border-200/50 bg-bg-100 px-3 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">
        {saveError && (
          <div role="alert" className="provider-fade mb-2 flex items-center justify-between gap-2 px-1 text-sm text-danger-100">
            <span className="min-w-0 truncate" title={saveError}>
              {t('providers.saveFailed')}
            </span>
            <button type="button" onClick={onRetrySave} className="min-h-11 shrink-0 px-2 font-medium">
              {t('providers.retrySave')}
            </button>
          </div>
        )}
        <div className="relative">
          <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-text-400" />
          <input
            value={query}
            onChange={event => onQuery(event.target.value)}
            aria-label={t('providers.filterModels')}
            placeholder={t('providers.filterModels')}
            spellCheck={false}
            autoComplete="off"
            className={`${settingsFieldClass} !h-12 !rounded-full !pl-11 !pr-12 !text-base`}
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery('')}
              title={t('search.clear')}
              aria-label={t('search.clear')}
              className="provider-pop absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-text-400 active:bg-bg-300"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}
