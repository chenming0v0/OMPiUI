import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Boxes,
  ChevronRight,
  CloudDownload,
  Eye,
  EyeOff,
  MoreVertical,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../../../components/ui/Dialog'
import { Button } from '../../../../components/ui/Button'
import { SpinnerIcon } from '../../../../components/Icons'
import { ModelSyncStatus } from '../ModelSyncStatus'
import { SettingsSelect, settingsFieldClass } from '../SettingsUI'
import { API_FORMAT_OPTIONS, providerSummary, type ModelDraft, type ProviderDraft } from './providerTypes'
import { ProviderAvatar, ProviderModelAvatar, ProviderModelCapabilities } from './ProviderModelSummary'
import './providers.css'

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

const TABS = ['config', 'models'] as const

const OPENED_PROVIDERS_KEY = 'ompiui:provider-mobile-opened'

function readOpenedProviders(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(OPENED_PROVIDERS_KEY) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function markProviderOpened(id: string) {
  const opened = readOpenedProviders()
  if (opened.has(id)) return
  opened.add(id)
  try {
    localStorage.setItem(OPENED_PROVIDERS_KEY, JSON.stringify([...opened]))
  } catch {
    // 存储不可用时每次都从配置页进入，不影响功能。
  }
}

const iconButton =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-300 transition-colors hover:bg-bg-200 active:bg-bg-300 focus-visible:outline-2 focus-visible:outline-accent-main-100'

const cardClass = 'rounded-2xl border border-border-200/60 bg-bg-000/40'

const fieldLabel = 'text-[13px] font-medium text-text-300'

function stagger(index: number) {
  return { '--stagger': index } as React.CSSProperties
}

function ProviderStatus({ provider }: { provider: ProviderDraft }) {
  const { t } = useTranslation('settings')
  const { missingKey } = providerSummary(provider)
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-400">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ring-[3px] ${
          missingKey ? 'bg-warning-100 ring-warning-100/20' : 'bg-success-100 ring-success-100/20'
        }`}
      />
      <span className="truncate">{missingKey ? t('providers.missingKey') : t('providers.configured')}</span>
      <span aria-hidden>·</span>
      <span className="shrink-0 tabular-nums">{t('providers.modelsCount', { count: provider.models.length })}</span>
    </span>
  )
}

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
  const [view, setView] = useState<(typeof TABS)[number]>('config')
  const [revealed, setRevealed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  // 首次打开某个供应商先进「配置」填 URL / Key，之后默认进「模型」。
  // 按打开的供应商在渲染期重置，新建供应商后自动打开详情页也走这里。
  const openId = detailOpen && selected ? selected.id : null
  const [prevOpenId, setPrevOpenId] = useState<string | null>(null)
  if (prevOpenId !== openId) {
    setPrevOpenId(openId)
    if (openId && selected) {
      setView(selected.baseUrl.trim() && readOpenedProviders().has(openId) ? 'models' : 'config')
      setMenuOpen(false)
      setRevealed(false)
    }
  }

  useEffect(() => {
    if (openId) markProviderOpened(openId)
  }, [openId])

  const saveStatus = (
    <div role="status" className="pointer-events-auto mb-2 text-center text-xs empty:hidden">
      {saveState === 'saving' && (
        <span className="provider-fade inline-flex items-center gap-1.5 rounded-full bg-bg-200/90 px-3 py-1.5 text-text-400">
          <SpinnerIcon size={12} className="animate-spin" />
          {t('providers.saving')}
        </span>
      )}
      {saveState === 'error' && (
        <button
          type="button"
          title={saveError}
          onClick={onRetrySave}
          className="provider-shake min-h-9 rounded-full bg-danger-100/10 px-4 font-medium text-danger-100"
        >
          {t('providers.retrySave')}
        </button>
      )}
    </div>
  )

  return (
    <>
      <section className="min-w-0">
        <header className="mb-4 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-lg font-semibold text-text-100">{t('providers.title')}</h2>
            <ModelSyncStatus status={syncStatus} />
          </div>
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
              className="provider-press flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-main-000 text-oncolor-100 shadow-sm hover:bg-accent-main-200 focus-visible:outline-2 focus-visible:outline-accent-main-100"
            >
              <Plus size={22} />
            </button>
          </div>
        </header>
        {loadError && (
          <div
            role="alert"
            className="provider-rise mb-3 flex items-center gap-3 rounded-2xl border border-danger-100/30 bg-danger-100/8 px-4 py-3"
          >
            <span className="min-w-0 flex-1 break-words text-sm text-danger-100">
              {t('providers.loadFailedWith', { message: loadError })}
            </span>
            <button type="button" onClick={onRefresh} className="min-h-11 shrink-0 px-1 text-sm font-medium text-danger-100">
              {t('providers.retry')}
            </button>
          </div>
        )}
        <ul className="space-y-2.5">
          {providers.map((provider, index) => (
            <li key={provider.id} className="provider-rise" style={stagger(index)}>
              <button
                type="button"
                onClick={() => onSelect(provider.id)}
                className={`provider-press group flex min-h-[76px] w-full items-center gap-3 px-3.5 py-3 text-left shadow-sm active:bg-bg-200/60 ${cardClass}`}
              >
                <ProviderAvatar label={provider.name} size="lg" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-text-100">{provider.name}</span>
                  <span className="mt-1 block">
                    <ProviderStatus provider={provider} />
                  </span>
                </span>
                <ChevronRight
                  size={18}
                  className="shrink-0 text-text-400 transition-transform group-active:translate-x-0.5"
                />
              </button>
            </li>
          ))}
        </ul>
        {providers.length === 0 && (
          <div className="provider-rise flex flex-col items-center px-6 py-14 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-accent-main-100/10 text-accent-main-100">
              <Server size={28} strokeWidth={1.6} />
            </span>
            <p className="mt-4 text-base font-semibold text-text-100">{t('providers.empty')}</p>
            <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-text-400">{t('providers.emptyHint')}</p>
            <Button onClick={onAddProvider} className="mt-5 !h-11 !rounded-full !px-5">
              <Plus size={18} />
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
          <div className="relative flex min-h-0 flex-1 flex-col bg-bg-100">
            <header className="shrink-0 px-2 pt-2">
              <div className="flex min-h-14 items-center gap-1">
                <button
                  type="button"
                  onClick={onBack}
                  title={t('providers.backToProviders')}
                  aria-label={t('providers.backToProviders')}
                  className={iconButton}
                >
                  <ArrowLeft size={22} />
                </button>
                <ProviderAvatar label={selected.name} />
                <div className="min-w-0 flex-1 pl-2">
                  <h2 className="truncate text-lg font-semibold leading-tight text-text-100" title={selected.name}>
                    {selected.name}
                  </h2>
                  <div className="mt-0.5">
                    <ProviderStatus provider={selected} />
                  </div>
                </div>
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
                      <div className="provider-menu absolute right-1 top-full z-20 w-52 overflow-hidden rounded-2xl border border-border-200/70 bg-bg-100 p-1.5 shadow-xl">
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpen(false)
                            onClearModels()
                          }}
                          className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-sm text-text-200 active:bg-bg-200"
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
                          className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-sm text-danger-100 active:bg-danger-100/10"
                        >
                          <Trash2 size={16} />
                          {t('providers.deleteProvider')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
              <nav
                role="tablist"
                aria-label={selected.name}
                className="relative isolate mx-2 mb-3 mt-2 grid grid-cols-2 rounded-xl bg-bg-200/70 p-1"
              >
                <span
                  aria-hidden
                  className="absolute inset-y-1 left-1 -z-10 w-[calc(50%-4px)] rounded-lg bg-bg-000 shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
                  style={{ transform: `translateX(${TABS.indexOf(view) * 100}%)` }}
                />
                {TABS.map((value, index) => {
                  const active = value === view
                  const Icon = value === 'config' ? Settings2 : Boxes
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
                        const next = TABS[(index + 1) % TABS.length]!
                        setView(next)
                        document.getElementById(`provider-mobile-tab-${next}`)?.focus()
                      }}
                      tabIndex={active ? 0 : -1}
                      className={`flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors duration-200 ${
                        active ? 'text-text-100' : 'text-text-400'
                      }`}
                    >
                      <Icon size={17} strokeWidth={1.8} />
                      {t(value === 'config' ? 'providers.mobileConfig' : 'providers.mobileModels')}
                      {value === 'models' && (
                        <span
                          className={`min-w-5 rounded-full px-1.5 text-[11px] leading-5 tabular-nums transition-colors ${
                            active ? 'bg-accent-main-100/15 text-accent-main-100' : 'bg-bg-300/60 text-text-400'
                          }`}
                        >
                          {selected.models.length}
                        </span>
                      )}
                    </button>
                  )
                })}
              </nav>
            </header>
            <div
              id="provider-mobile-panel"
              role="tabpanel"
              aria-labelledby={`provider-mobile-tab-${view}`}
              className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 custom-scrollbar ${
                view === 'models' ? 'pb-36' : 'pb-4'
              }`}
            >
              {view === 'config' ? (
                <div key="config" className="provider-fade space-y-4">
                  <div className={`space-y-5 p-4 ${cardClass}`}>
                    <label className="block">
                      <span className={fieldLabel}>{t('providers.baseUrl')}</span>
                      <input
                        value={selected.baseUrl}
                        onChange={event => onUpdate(draft => ({ ...draft, baseUrl: event.target.value }))}
                        placeholder={t('providers.baseUrlPlaceholder')}
                        spellCheck={false}
                        autoComplete="off"
                        className={`${settingsFieldClass} mt-2 min-h-12 !rounded-xl font-mono`}
                      />
                    </label>
                    <div>
                      <span className={fieldLabel}>{t('providers.apiFormat')}</span>
                      <div className="mt-2">
                        <SettingsSelect
                          value={selected.api}
                          ariaLabel={t('providers.apiFormat')}
                          className="!min-h-12 !rounded-xl"
                          options={API_FORMAT_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) }))}
                          onChange={value => onUpdate(draft => ({ ...draft, api: value }), 'immediate')}
                        />
                      </div>
                    </div>
                    <label className="block">
                      <span className={fieldLabel}>{t('providers.apiKey')}</span>
                      <div className="relative mt-2">
                        <input
                          type={revealed ? 'text' : 'password'}
                          value={selected.apiKey}
                          onChange={event => onUpdate(draft => ({ ...draft, apiKey: event.target.value }))}
                          placeholder={t('providers.apiKeyPlaceholder')}
                          autoComplete="off"
                          spellCheck={false}
                          className={`${settingsFieldClass} min-h-12 !rounded-xl pr-12 font-mono`}
                        />
                        <button
                          type="button"
                          onClick={() => setRevealed(value => !value)}
                          title={t(revealed ? 'providers.hideKey' : 'providers.showKey')}
                          aria-label={t(revealed ? 'providers.hideKey' : 'providers.showKey')}
                          className={`${iconButton} absolute right-0.5 top-1/2 -translate-y-1/2`}
                        >
                          <span key={String(revealed)} className="provider-pop">
                            {revealed ? <EyeOff size={18} /> : <Eye size={18} />}
                          </span>
                        </button>
                      </div>
                      <span className="mt-2 block text-xs leading-relaxed text-text-500">{t('providers.apiKeyHint')}</span>
                    </label>
                  </div>
                  <div className="flex justify-center">
                    <ModelSyncStatus status={syncStatus} />
                  </div>
                </div>
              ) : selected.models.length === 0 ? (
                <div key="empty" className="provider-fade flex flex-col items-center px-6 py-14 text-center">
                  <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-accent-main-100/10 text-accent-main-100">
                    <Boxes size={28} strokeWidth={1.6} />
                  </span>
                  <p className="mt-4 text-base font-semibold text-text-100">{t('providers.emptyModels')}</p>
                  <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-text-400">
                    {t('providers.emptyModelsHint')}
                  </p>
                </div>
              ) : (
                <ul key="models" className="space-y-2">
                  {selected.models.map((model, index) => (
                    <li key={model.id} className="provider-rise" style={stagger(index)}>
                      <div className={`provider-press flex items-center gap-1 py-1.5 pl-3 pr-1 active:bg-bg-200/50 ${cardClass}`}>
                        <button
                          type="button"
                          onClick={() => onEdit(model)}
                          title={model.id}
                          aria-label={`${t('providers.editModel')} ${model.id}`}
                          className="flex min-w-0 flex-1 items-center gap-3 py-1.5 text-left"
                        >
                          <ProviderModelAvatar id={model.id} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[15px] font-medium text-text-100">
                              {model.name || model.id}
                            </span>
                            {model.name && model.name !== model.id && (
                              <span className="block truncate font-mono text-xs text-text-400">{model.id}</span>
                            )}
                            <ProviderModelCapabilities model={model} />
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteModel(model)}
                          title={t('providers.deleteModel')}
                          aria-label={`${t('providers.deleteModel')} ${model.id}`}
                          className={`${iconButton} text-text-400 hover:text-danger-100 active:bg-danger-100/10 active:text-danger-100`}
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {view === 'models' ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center bg-gradient-to-t from-bg-100 via-bg-100/85 to-transparent px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-10">
                {saveStatus}
                <div className="provider-dock pointer-events-auto flex items-center gap-1.5 rounded-full border border-border-200/60 bg-bg-200/90 p-1.5 shadow-lg backdrop-blur-md">
                  <button
                    type="button"
                    onClick={onFetch}
                    title={t('providers.fetchModels')}
                    aria-label={t('providers.fetchModels')}
                    className="provider-press relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-text-200 hover:bg-bg-300/70 active:bg-bg-300"
                  >
                    <CloudDownload size={22} strokeWidth={1.8} />
                    <span
                      key={selected.models.length}
                      className="provider-pop absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-accent-main-100 px-1 text-center text-[10px] font-semibold leading-[18px] tabular-nums text-oncolor-100 ring-2 ring-bg-200"
                    >
                      {selected.models.length}
                    </span>
                  </button>
                  <span aria-hidden className="h-7 w-px bg-border-200/80" />
                  <Button
                    variant="primary"
                    className="!h-12 !rounded-full !pl-5 !pr-6 !text-[15px] shadow-sm"
                    onClick={() => onEdit(null)}
                  >
                    <Plus size={20} />
                    {t('providers.addModel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="shrink-0 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-2">{saveStatus}</div>
            )}
          </div>
        )}
      </Dialog>
    </>
  )
}
