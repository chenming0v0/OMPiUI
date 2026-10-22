import { useState } from 'react'
import {
  ArrowLeft,
  Box,
  ChevronRight,
  Eye,
  EyeOff,
  MoreVertical,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../../../components/ui/Dialog'
import { Button } from '../../../../components/ui/Button'
import { ModelSyncStatus } from '../ModelSyncStatus'
import { SettingsSelect, settingsFieldClass } from '../SettingsUI'
import { API_FORMAT_OPTIONS, providerSummary, type ModelDraft, type ProviderDraft } from './providerTypes'
import { ProviderModelAvatar, ProviderModelCapabilities } from './ProviderModelSummary'
import './mobileProviders.css'

type Props = {
  providers: ProviderDraft[]
  selected: ProviderDraft | null
  detailOpen: boolean
  refreshing: boolean
  loadError: string | null
  saveState: 'idle' | 'saving' | 'error'
  saveError?: string
  syncStatus: React.ComponentProps<typeof ModelSyncStatus>['status']
  onSelect: (id: string) => void
  onBack: () => void
  onRefresh: () => void
  onAddProvider: () => void
  onUpdate: (update: (draft: ProviderDraft) => ProviderDraft, mode?: 'debounced' | 'immediate') => void
  onFetch: () => void
  onEdit: (model: ModelDraft | null) => void
  onDeleteModel: (model: ModelDraft) => void
  onDeleteProvider: () => void
  onClearModels: () => void
  onRetrySave: () => void
}

const iconButton =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-300 transition-colors hover:bg-bg-200 focus-visible:outline-2 focus-visible:outline-accent-main-100'

export function MobileProvidersSettings({
  providers,
  selected,
  detailOpen,
  refreshing,
  loadError,
  saveState,
  saveError,
  syncStatus,
  onSelect,
  onBack,
  onRefresh,
  onAddProvider,
  onUpdate,
  onFetch,
  onEdit,
  onDeleteModel,
  onDeleteProvider,
  onClearModels,
  onRetrySave,
}: Props) {
  const { t } = useTranslation('settings')
  const [view, setView] = useState<'config' | 'models'>('models')
  const [revealed, setRevealed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <>
      <section className="min-w-0">
        <header className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-text-100">{t('providers.title')}</h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              title={t('providers.refresh')}
              aria-label={t('providers.refresh')}
              className={iconButton}
            >
              <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={onAddProvider}
              title={t('providers.addProvider')}
              aria-label={t('providers.addProvider')}
              className={`${iconButton} bg-accent-main-100/10 text-accent-main-100`}
            >
              <Plus size={22} />
            </button>
          </div>
        </header>
        <ModelSyncStatus status={syncStatus} />
        {loadError && (
          <p role="alert" className="mb-3 break-words text-sm text-danger-100">
            {t('providers.loadFailedWith', { message: loadError })}
          </p>
        )}
        <div className="mt-3 space-y-2">
          {providers.map(provider => {
            const summary = providerSummary(provider)
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => {
                  setView('models')
                  setMenuOpen(false)
                  setRevealed(false)
                  onSelect(provider.id)
                }}
                className="flex min-h-20 w-full items-center gap-3 rounded-lg border border-border-200/70 bg-bg-000/30 px-3 py-3 text-left"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bg-200 text-base font-medium text-text-200">
                  {provider.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium text-text-100">{provider.name}</span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-text-400">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${summary.missingKey ? 'bg-warning-100' : 'bg-success-100'}`}
                    />
                    {t('providers.modelsCount', { count: provider.models.length })}
                  </span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-text-400" />
              </button>
            )
          })}
        </div>
        {providers.length === 0 && (
          <div className="py-12 text-center">
            <p className="mb-4 text-sm text-text-400">{t('providers.empty')}</p>
            <Button onClick={onAddProvider}>
              <Plus size={16} />
              {t('providers.addProvider')}
            </Button>
          </div>
        )}
      </section>

      <Dialog
        isOpen={detailOpen && selected !== null}
        onClose={onBack}
        ariaLabel={selected?.name}
        width="100%"
        className="provider-mobile-page"
        showCloseButton={false}
        rawContent
      >
        {selected && (
          <div className="flex min-h-0 flex-1 flex-col bg-bg-100">
            <header className="flex min-h-20 shrink-0 items-center gap-2 px-3 py-3">
              <button
                type="button"
                onClick={onBack}
                title={t('providers.backToProviders')}
                aria-label={t('providers.backToProviders')}
                className={`${iconButton} bg-bg-200`}
              >
                <ArrowLeft size={22} />
              </button>
              <span className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-300/60 text-sm text-text-300">
                {selected.name.slice(0, 1)}
              </span>
              <h2 className="min-w-0 flex-1 truncate text-xl font-medium text-text-100" title={selected.name}>
                {selected.name}
              </h2>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen(open => !open)}
                  title={t('providers.more')}
                  aria-label={t('providers.more')}
                  aria-expanded={menuOpen}
                  className={iconButton}
                >
                  <MoreVertical size={22} />
                </button>
                {menuOpen && (
                  <>
                    <button
                      type="button"
                      className="fixed inset-0 z-10"
                      aria-label={t('providers.close')}
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="absolute right-0 top-full z-20 w-48 rounded-lg border border-border-200 bg-bg-100 p-1 shadow-lg">
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false)
                          onClearModels()
                        }}
                        className="flex min-h-11 w-full items-center gap-2 px-3 text-sm text-text-200"
                      >
                        <Trash2 size={16} />
                        {t('providers.clearModels')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false)
                          onDeleteProvider()
                        }}
                        className="flex min-h-11 w-full items-center gap-2 px-3 text-sm text-danger-100"
                      >
                        <Trash2 size={16} />
                        {t('providers.deleteProvider')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </header>
            <div
              id="provider-mobile-panel"
              role="tabpanel"
              aria-labelledby={`provider-mobile-tab-${view}`}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-3 custom-scrollbar"
            >
              {view === 'config' ? (
                <div className="space-y-6 py-2">
                  <label className="block">
                    <span className="text-sm text-text-300">{t('providers.baseUrl')}</span>
                    <input
                      value={selected.baseUrl}
                      onChange={event => onUpdate(draft => ({ ...draft, baseUrl: event.target.value }))}
                      placeholder={t('providers.baseUrlPlaceholder')}
                      spellCheck={false}
                      autoComplete="off"
                      className={`${settingsFieldClass} mt-2 min-h-12 font-mono`}
                    />
                  </label>
                  <div>
                    <span className="text-sm text-text-300">{t('providers.apiFormat')}</span>
                    <div className="mt-2">
                      <SettingsSelect
                        value={selected.api}
                        ariaLabel={t('providers.apiFormat')}
                        className="!min-h-12"
                        options={API_FORMAT_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) }))}
                        onChange={value => onUpdate(draft => ({ ...draft, api: value }), 'immediate')}
                      />
                    </div>
                  </div>
                  <label className="block">
                    <span className="text-sm text-text-300">{t('providers.apiKey')}</span>
                    <div className="relative mt-2">
                      <input
                        type={revealed ? 'text' : 'password'}
                        value={selected.apiKey}
                        onChange={event => onUpdate(draft => ({ ...draft, apiKey: event.target.value }))}
                        placeholder={t('providers.apiKeyPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        className={`${settingsFieldClass} min-h-12 pr-12 font-mono`}
                      />
                      <button
                        type="button"
                        onClick={() => setRevealed(value => !value)}
                        title={t(revealed ? 'providers.hideKey' : 'providers.showKey')}
                        aria-label={t(revealed ? 'providers.hideKey' : 'providers.showKey')}
                        className={`${iconButton} absolute right-0 top-1/2 -translate-y-1/2`}
                      >
                        {revealed ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </label>
                  <ModelSyncStatus status={syncStatus} />
                </div>
              ) : (
                <div className="space-y-2.5">
                  {selected.models.map(model => (
                    <div
                      key={model.id}
                      className="flex min-h-20 items-center gap-2 rounded-lg border border-border-200 bg-bg-000/15 px-3 py-2.5"
                    >
                      <ProviderModelAvatar />
                      <button
                        type="button"
                        onClick={() => onEdit(model)}
                        title={model.id}
                        className="min-w-0 flex-1 py-1 text-left"
                      >
                        <span className="block truncate text-base font-medium text-text-100">
                          {model.name || model.id}
                        </span>
                        <ProviderModelCapabilities model={model} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onEdit(model)}
                        title={t('providers.editModel')}
                        aria-label={`${t('providers.editModel')} ${model.id}`}
                        className={iconButton}
                      >
                        <SlidersHorizontal size={21} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteModel(model)}
                        title={t('providers.deleteModel')}
                        aria-label={`${t('providers.deleteModel')} ${model.id}`}
                        className="flex h-11 w-8 shrink-0 items-center justify-center text-text-400 hover:text-danger-100"
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  ))}
                  {selected.models.length === 0 && (
                    <p className="py-10 text-center text-sm text-text-400">{t('providers.emptyModels')}</p>
                  )}
                </div>
              )}
            </div>
            <div role="status" className="shrink-0 px-4 text-center text-xs">
              {saveState === 'saving' && <span className="text-text-400">{t('providers.saving')}</span>}
              {saveState === 'error' && (
                <button type="button" title={saveError} onClick={onRetrySave} className="min-h-11 text-danger-100">
                  {t('providers.retrySave')}
                </button>
              )}
            </div>
            {view === 'models' && (
              <div className="flex shrink-0 justify-center px-4 pb-5 pt-3">
                <div className="flex max-w-full items-center gap-2 rounded-lg bg-bg-200 p-2 shadow-sm">
                  <button
                    type="button"
                    onClick={onFetch}
                    title={t('providers.fetchModels')}
                    aria-label={t('providers.fetchModels')}
                    className={`${iconButton} relative`}
                  >
                    <Box size={24} />
                    <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded bg-warning-100 px-1 text-center text-[10px] leading-4 text-bg-100">
                      {selected.models.length}
                    </span>
                  </button>
                  <Button variant="primary" className="!min-h-11 !px-5" onClick={() => onEdit(null)}>
                    <Plus size={20} />
                    {t('providers.addModel')}
                  </Button>
                </div>
              </div>
            )}
            <nav
              role="tablist"
              aria-label={selected.name}
              className="grid shrink-0 grid-cols-2 border-t border-border-200/50 bg-bg-200/80 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-2"
            >
              {(['config', 'models'] as const).map(value => {
                const active = value === view
                const Icon = value === 'config' ? Wrench : Box
                return (
                  <button
                    key={value}
                    id={`provider-mobile-tab-${value}`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls="provider-mobile-panel"
                    onClick={() => setView(value)}
                    onKeyDown={event => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                      event.preventDefault()
                      const next = value === 'config' ? 'models' : 'config'
                      setView(next)
                      document.getElementById(`provider-mobile-tab-${next}`)?.focus()
                    }}
                    tabIndex={active ? 0 : -1}
                    className={`flex min-h-16 flex-col items-center justify-center gap-1 text-xs ${active ? 'text-accent-main-100' : 'text-text-400'}`}
                  >
                    <span
                      className={`flex h-8 w-14 items-center justify-center rounded-lg ${active ? 'bg-accent-main-100/15' : ''}`}
                    >
                      <Icon size={23} strokeWidth={1.6} />
                    </span>
                    {t(value === 'config' ? 'providers.mobileConfig' : 'providers.mobileModels')}
                  </button>
                )
              })}
            </nav>
          </div>
        )}
      </Dialog>
    </>
  )
}
