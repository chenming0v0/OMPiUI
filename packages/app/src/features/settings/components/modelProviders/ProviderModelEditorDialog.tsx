import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Check, ChevronDown, CircleAlert, Image, Plus, RotateCcw, Sparkles, Type, X } from 'lucide-react'
import { Dialog } from '../../../../components/ui/Dialog'
import { Button } from '../../../../components/ui/Button'
import { SpinnerIcon } from '../../../../components/Icons'
import {
  DEFAULT_EFFORTS,
  THINKING_MODE_OPTIONS,
  blankModelDraft,
  formatModelContext,
  inferThinkingModeForApi,
  inferModelDefaults,
  modelDraftDefaultsFromModelsDev,
  validateModelDraft,
  type ModelDraft,
} from './providerTypes'
import { SettingsSelect, Toggle, settingsFieldAreaClass, settingsFieldClass } from '../SettingsUI'
import { lookupModelsDevModel } from '../../../../omp/transport/index.js'
import { ProviderModelAvatar } from './ProviderModelSummary'
import './providers.css'

export type ProviderModelEditorDialogProps = {
  isOpen: boolean
  providerId?: string
  providerName: string
  providerApi?: string
  /** null = 新增 */
  model: ModelDraft | null
  /** 当前供应商已有的其它模型（重复 id 校验用，可包含 model 本身） */
  siblings: ModelDraft[]
  /** 批量配置时的进度，例如 3 / 7 */
  queueIndex?: number
  queueTotal?: number
  onClose: () => void
  onSave: (model: ModelDraft) => void
}

function cloneDraft(draft: ModelDraft): ModelDraft {
  return {
    ...draft,
    input: [...draft.input],
    efforts: [...draft.efforts],
    effortMap: { ...draft.effortMap },
  }
}

function effortMapToText(map: Record<string, string>): string {
  return Object.keys(map).length > 0 ? JSON.stringify(map, null, 2) : ''
}

function parseEffortMap(text: string): Record<string, string> | null {
  const trimmed = text.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') return null
      map[key] = value
    }
    return map
  } catch {
    return null
  }
}

const chipClass = (active: boolean) =>
  `provider-press inline-flex h-7 items-center gap-1 rounded-full border px-2.5 font-mono text-[length:var(--fs-xs)] font-medium max-md:h-9 max-md:px-3.5
  ${
    active
      ? 'border-accent-main-100/50 bg-accent-main-100/10 text-accent-main-100'
      : 'border-border-200 text-text-300 hover:bg-bg-200 hover:text-text-100'
  }`

const fieldLabelClass = 'text-[length:var(--fs-xs)] font-medium text-text-300'
const fieldHintClass = 'mt-1 text-[length:var(--fs-xxs)] leading-relaxed text-text-500'
const editorFieldClass = `${settingsFieldClass} mt-1.5 max-md:h-11 max-md:rounded-lg max-md:text-base`
const sectionTitleClass = 'px-0.5 text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wider text-text-500'
const sectionCardClass = 'rounded-xl border border-border-200/50 bg-bg-000/30 p-3.5'

const INPUT_OPTIONS = [
  { value: 'text', labelKey: 'providers.inputText', Icon: Type },
  { value: 'image', labelKey: 'providers.inputImage', Icon: Image },
] as const

export function ProviderModelEditorDialog({
  isOpen,
  providerId,
  providerName,
  providerApi,
  model,
  siblings,
  queueIndex,
  queueTotal,
  onClose,
  onSave,
}: ProviderModelEditorDialogProps) {
  const { t } = useTranslation('settings')
  const [draft, setDraft] = useState<ModelDraft | null>(null)
  const [initial, setInitial] = useState<ModelDraft | null>(null)
  const [effortMapText, setEffortMapText] = useState('')
  const [error, setError] = useState<ReturnType<typeof validateModelDraft>>(null)
  const [jsonError, setJsonError] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(true)
  const [smartConfig, setSmartConfig] = useState(true)
  const [lookupState, setLookupState] = useState<'idle' | 'matched' | 'fallback'>('idle')
  const [lookupPending, setLookupPending] = useState(false)
  // 'loading' is derived so entering it costs no effect-body setState.
  const smartConfigState = lookupPending ? 'loading' as const : lookupState
  const [customLevel, setCustomLevel] = useState('')
  const [customLevelOpen, setCustomLevelOpen] = useState(false)
  // Bumped on each rejected save so the error banner shakes again.
  const [errorShake, setErrorShake] = useState(0)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const lookupSequenceRef = useRef(0)
  const lookupAbortRef = useRef<AbortController | null>(null)

  // Provider hint changes start a new lookup without discarding the draft.
  const [prevProviderId, setPrevProviderId] = useState(providerId)
  if (prevProviderId !== providerId) {
    setPrevProviderId(providerId)
    if (isOpen && smartConfig && draft?.id.trim()) {
      setLookupState('idle')
      setLookupPending(true)
    }
  }

  // Reset the editor when it opens or its inputs change; adjusted during render
  // so the dialog never paints the previous model's draft. The null sentinel
  // makes the first render always sync (mount with isOpen=true still resets).
  const [prevResetKey, setPrevResetKey] = useState<{ isOpen: boolean; model: typeof model; providerApi: typeof providerApi } | null>(null)
  if (prevResetKey === null || prevResetKey.isOpen !== isOpen || prevResetKey.model !== model || prevResetKey.providerApi !== providerApi) {
    setPrevResetKey({ isOpen, model, providerApi })
    if (isOpen) {
      const next = model ? cloneDraft(model) : blankModelDraft()
      const autoConfigure = !next.originalId
      setDraft({
        ...next,
        ...(autoConfigure && next.id.trim() ? inferModelDefaults(next.id) : {}),
        ...(!next.thinkingConfigured ? { thinkingMode: inferThinkingModeForApi(providerApi) } : {}),
      })
      setInitial(cloneDraft(next))
      setEffortMapText(effortMapToText(next.effortMap))
      setError(null)
      setJsonError(false)
      setSmartConfig(autoConfigure)
      setLookupState('idle')
      setLookupPending(autoConfigure && Boolean(next.id.trim()))
      setCustomLevel('')
      setCustomLevelOpen(false)
      setAdvancedOpen(true)
    }
  }

  useEffect(() => {
    if (!isOpen) {
      lookupAbortRef.current?.abort()
      lookupSequenceRef.current += 1
      return
    }
    return () => {
      lookupAbortRef.current?.abort()
      lookupSequenceRef.current += 1
    }
  }, [isOpen, model, providerApi])

  useEffect(() => {
    if (!isOpen) return
    const frame = requestAnimationFrame(() => nameInputRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [isOpen])

  const title = useMemo(() => {
    if (!draft) return t('providers.editorEditTitle')
    return draft.originalId ? t('providers.editorEditTitle') : t('providers.editorCreateTitle')
  }, [draft, t])

  const update = (patch: Partial<ModelDraft>) => {
    if (Object.keys(patch).some(key => key !== 'name')) {
      lookupAbortRef.current?.abort()
      lookupSequenceRef.current += 1
      setSmartConfig(false)
      setLookupState('idle'); setLookupPending(false)
    }
    const configKeys: Array<keyof ModelDraft> = ['thinkingMode', 'efforts', 'defaultLevel', 'effortMap']
    const configChanged = configKeys.some(key => key in patch)
    setDraft(current =>
      current
        ? {
            ...current,
            ...patch,
            ...(configChanged ? { thinkingConfigured: true } : {}),
          }
        : current,
    )
    setError(null)
  }

  const toggleInput = (value: 'text' | 'image') => {
    if (!draft) return
    const input = draft.input.includes(value) ? draft.input.filter(item => item !== value) : [...draft.input, value]
    update({ input })
  }

  const toggleEffort = (level: string) => {
    if (!draft) return
    const efforts = draft.efforts.includes(level)
      ? draft.efforts.filter(item => item !== level)
      : [...draft.efforts, level]
    update({ efforts })
    if (!efforts.includes(draft.defaultLevel) && efforts.length > 0) {
      update({ defaultLevel: efforts[0]! })
    }
  }

  const addCustomLevel = () => {
    if (!draft) return
    const value = customLevel.trim()
    if (!value) return
    if (!draft.efforts.includes(value)) update({ efforts: [...draft.efforts, value] })
    setCustomLevel('')
    setCustomLevelOpen(false)
  }

  const applySmartConfig = useCallback(
    (id: string) => {
      lookupAbortRef.current?.abort()
      const controller = new AbortController()
      lookupAbortRef.current = controller
      const sequence = ++lookupSequenceRef.current
      // Pending was already marked optimistically by the change handler / open
      // reset; this only resolves it.
      void lookupModelsDevModel(
        {
          modelId: id,
          ...(providerId ? { providerHint: providerId } : {}),
          ...(providerApi ? { api: providerApi } : {}),
        },
        controller.signal,
      )
        .then(result => {
          if (sequence !== lookupSequenceRef.current || controller.signal.aborted) return
          if (!result.found) {
            setLookupState('fallback'); setLookupPending(false)
            return
          }
          const remote = modelDraftDefaultsFromModelsDev(result, providerApi)
          setEffortMapText(effortMapToText(remote.effortMap ?? {}))
          setDraft(current => {
            if (!current) return current
            const next = { ...current, ...remote, name: current.name }
            if (current.name.trim() === current.id.trim() || !current.name.trim()) {
              next.name = remote.name ?? current.name
            }
            return next
          })
          setLookupState('matched'); setLookupPending(false)
        })
        .catch(() => {
          if (sequence === lookupSequenceRef.current && !controller.signal.aborted) {
            setLookupState('fallback')
            setLookupPending(false)
          }
        })
    },
    [providerId, providerApi],
  )

  useEffect(() => {
    if (!isOpen || !smartConfig || !draft?.id.trim()) {
      lookupAbortRef.current?.abort()
      lookupSequenceRef.current += 1
      return
    }
    // applySmartConfig only aborts the previous lookup and starts the fetch;
    // pending was set optimistically at event time, and resolution happens in
    // the promise callbacks, so no setState runs in this effect body.
    applySmartConfig(draft.id)
    return () => {
      lookupAbortRef.current?.abort()
      lookupSequenceRef.current += 1
    }
  }, [isOpen, model, smartConfig, draft?.id, applySmartConfig])

  const handleModelIdChange = (value: string) => {
    if (!draft) return
    lookupAbortRef.current?.abort()
    lookupSequenceRef.current += 1
    setLookupState('idle')
    // Event-time optimistic pending: the lookup effect fires right after commit,
    // so Save must already treat the model as in-flight here.
    setLookupPending(smartConfig && value.trim() !== '')
    const next = {
      ...(smartConfig ? blankModelDraft(value) : draft),
      originalId: draft.originalId,
      id: value,
      name: draft.name === draft.id ? value : draft.name,
    }
    setDraft(
      smartConfig
        ? { ...next, ...inferModelDefaults(value), thinkingMode: inferThinkingModeForApi(providerApi) }
        : next,
    )
    if (smartConfig) setEffortMapText('')
    setError(null)
  }

  const handleSave = () => {
    if (!draft) return
    const issue = validateModelDraft(draft, siblings)
    if (issue) {
      setError(issue)
      setErrorShake(value => value + 1)
      return
    }
    const effortMap = parseEffortMap(effortMapText)
    if (effortMap === null) {
      setJsonError(true)
      setErrorShake(value => value + 1)
      return
    }
    setJsonError(false)
    onSave({ ...cloneDraft(draft), effortMap })
  }

  const handleReset = () => {
    if (!initial) return
    lookupAbortRef.current?.abort()
    lookupSequenceRef.current += 1
    setDraft(cloneDraft(initial))
    setEffortMapText(effortMapToText(initial.effortMap))
    setError(null)
    setJsonError(false)
    setSmartConfig(false)
    setLookupState('idle'); setLookupPending(false)
  }

  if (!draft) return null

  const reasoningDisabled = !draft.reasoning
  const progress = queueTotal && queueTotal > 1 ? (queueIndex ?? 0) + 1 : undefined
  const errorText =
    error === 'idRequired'
      ? t('providers.modelIdRequired')
      : error === 'duplicateId'
        ? t('providers.modelIdDuplicate')
        : error === 'invalidNumbers'
          ? t('providers.invalidNumbers')
          : null

  const toggleSmartConfig = () => {
    const next = !smartConfig
    lookupAbortRef.current?.abort()
    lookupSequenceRef.current += 1
    setSmartConfig(next)
    setLookupState('idle')
    setLookupPending(next && Boolean(draft.id.trim()))
    if (next) {
      setDraft(current => (current ? { ...current, ...inferModelDefaults(current.id) } : current))
    }
  }

  const configureReasoning = {
    thinkingConfigured: true,
    thinkingMode: inferThinkingModeForApi(providerApi),
    efforts: [...DEFAULT_EFFORTS],
    defaultLevel: 'high',
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      ariaLabel={title}
      width="min(96vw, 640px)"
      className="provider-editor"
      showCloseButton={false}
      rawContent
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="relative shrink-0 border-b border-border-200/60 px-5 pb-3.5 pt-4 max-md:px-4 max-md:pt-1">
          <div className="flex items-center gap-3">
            <ProviderModelAvatar id={draft.id || draft.name || '?'} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5 text-[length:var(--fs-xxs)] font-medium uppercase tracking-wider text-text-400">
                <span className="truncate">{providerName}</span>
                {progress !== undefined && (
                  <span className="shrink-0 rounded-full bg-bg-200 px-1.5 py-px normal-case tracking-normal tabular-nums text-text-300">
                    {progress} / {queueTotal}
                  </span>
                )}
              </div>
              <h2 className="mt-0.5 truncate text-[length:var(--fs-lg)] font-semibold text-text-100 max-md:text-lg">
                {title}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('providers.close')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100 max-md:h-10 max-md:w-10 max-md:bg-bg-200/70"
            >
              <X size={17} />
            </button>
          </div>
          {progress !== undefined && queueTotal && (
            <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-bg-200/60">
              <div
                className="h-full bg-accent-main-100 transition-[width] duration-500 ease-out"
                style={{ width: `${(progress / queueTotal) * 100}%` }}
              />
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-4 custom-scrollbar max-md:px-4">
          <div
            className={`relative overflow-hidden rounded-xl border p-3.5 transition-colors duration-300 ${
              smartConfig ? 'border-accent-main-100/35 bg-accent-main-100/6' : 'border-border-200/60 bg-bg-200/30'
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-300 ${
                  smartConfig ? 'bg-accent-main-100/15 text-accent-main-100' : 'bg-bg-200 text-text-400'
                }`}
              >
                <Sparkles size={18} className={smartConfigState === 'loading' ? 'provider-spark' : ''} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[length:var(--fs-md)] font-medium text-text-100">{t('providers.smartConfig')}</span>
                  {smartConfigState === 'loading' && (
                    <span
                      key="loading"
                      className="provider-fade inline-flex items-center gap-1 rounded-full bg-bg-200 px-2 py-0.5 text-[length:var(--fs-xxs)] text-text-300"
                    >
                      <SpinnerIcon size={10} className="animate-spin" />
                      {t('providers.smartConfigLoading')}
                    </span>
                  )}
                  {smartConfigState === 'matched' && (
                    <span
                      key="matched"
                      className="provider-fade inline-flex items-center gap-1 rounded-full bg-success-100/12 px-2 py-0.5 text-[length:var(--fs-xxs)] text-success-100"
                    >
                      <Check size={11} strokeWidth={3} className="provider-pop" />
                      {t('providers.smartConfigMatched')}
                    </span>
                  )}
                  {smartConfigState === 'fallback' && (
                    <span
                      key="fallback"
                      className="provider-fade inline-flex items-center rounded-full bg-bg-200 px-2 py-0.5 text-[length:var(--fs-xxs)] text-text-400"
                    >
                      {t('providers.smartConfigFallback')}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
                  {t('providers.smartConfigHint')}
                </p>
              </div>
              <div className="pt-1">
                <Toggle enabled={smartConfig} onChange={toggleSmartConfig} ariaLabel={t('providers.smartConfig')} />
              </div>
            </div>
            {smartConfigState === 'loading' && (
              <span aria-hidden className="provider-scan pointer-events-none absolute inset-x-0 bottom-0 h-0.5" />
            )}
          </div>

          <section className="mt-5 space-y-2">
            <h3 className={sectionTitleClass}>{t('providers.sectionBasics')}</h3>
            <div className={`${sectionCardClass} space-y-3.5`}>
              <label className="block">
                <span className={fieldLabelClass}>{t('providers.modelId')}</span>
                <input
                  ref={nameInputRef}
                  value={draft.id}
                  onChange={event => handleModelIdChange(event.target.value)}
                  placeholder={t('providers.modelIdPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  className={`${editorFieldClass} font-mono`}
                />
              </label>

              <label className="block">
                <span className={fieldLabelClass}>{t('providers.modelName')}</span>
                <input
                  value={draft.name}
                  onChange={event => update({ name: event.target.value })}
                  placeholder={t('providers.modelNamePlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  className={editorFieldClass}
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    ['contextWindow', 'providers.contextWindow'],
                    ['maxTokens', 'providers.maxOutput'],
                  ] as const
                ).map(([key, labelKey]) => (
                  <label key={key} className="block min-w-0">
                    <span className={`${fieldLabelClass} block truncate`}>{t(labelKey)}</span>
                    <div className="relative">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        value={draft[key]}
                        onChange={event => {
                          const value = Number(event.target.value)
                          update(key === 'contextWindow' ? { contextWindow: value } : { maxTokens: value })
                        }}
                        className={`${editorFieldClass} pr-14 font-mono tabular-nums`}
                      />
                      <span className="pointer-events-none absolute right-2 top-[calc(50%+3px)] -translate-y-1/2 rounded-md bg-bg-300/50 px-1.5 py-0.5 font-mono text-[length:var(--fs-xxs)] text-text-400">
                        {formatModelContext(draft[key]) || t('providers.tokensUnit')}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section className="mt-5 space-y-2">
            <h3 className={sectionTitleClass}>{t('providers.sectionCapabilities')}</h3>
            <div className={`${sectionCardClass} space-y-3.5`}>
              <div>
                <div className={fieldLabelClass}>{t('providers.inputTypes')}</div>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {INPUT_OPTIONS.map(({ value, labelKey, Icon }) => {
                    const active = draft.input.includes(value)
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleInput(value)}
                        className={`provider-press flex h-10 items-center gap-2 rounded-lg border px-3 text-left text-[length:var(--fs-sm)] font-medium max-md:h-12 ${
                          active
                            ? 'border-accent-main-100/50 bg-accent-main-100/10 text-accent-main-100'
                            : 'border-border-200 text-text-300 hover:bg-bg-200 hover:text-text-100'
                        }`}
                      >
                        <Icon size={16} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
                        <span
                          aria-hidden
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-all duration-200 ${
                            active
                              ? 'scale-100 bg-accent-main-100 text-oncolor-100'
                              : 'scale-90 border border-border-300 text-transparent'
                          }`}
                        >
                          <Check size={10} strokeWidth={3.5} />
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className={fieldHintClass}>{t('providers.inputTypesHint')}</div>
              </div>

              <div className="flex items-center gap-3 border-t border-border-200/40 pt-3.5">
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-300 ${
                    draft.reasoning ? 'bg-accent-secondary-100/15 text-accent-secondary-100' : 'bg-bg-200 text-text-400'
                  }`}
                >
                  <Brain size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[length:var(--fs-sm)] font-medium text-text-100">{t('providers.reasoning')}</div>
                  <div className="mt-0.5 text-[length:var(--fs-xs)] text-text-400">{t('providers.reasoningHint')}</div>
                </div>
                <Toggle
                  enabled={draft.reasoning}
                  ariaLabel={t('providers.reasoning')}
                  onChange={() =>
                    update({
                      reasoning: !draft.reasoning,
                      ...(!draft.reasoning && !draft.thinkingConfigured ? configureReasoning : {}),
                    })
                  }
                />
              </div>
            </div>
          </section>

          <section className="mt-5">
            <button
              type="button"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen(value => !value)}
              className="group flex w-full items-center justify-between gap-2 rounded-md py-1 text-left"
            >
              <span className={`${sectionTitleClass} transition-colors group-hover:text-text-300`}>
                {t('providers.advanced')}
              </span>
              <ChevronDown
                size={15}
                className={`text-text-400 transition-transform duration-300 ${advancedOpen ? 'rotate-180' : ''}`}
              />
            </button>

            <div className="provider-collapse" data-open={advancedOpen} inert={!advancedOpen}>
              <div className="-m-0.5 p-0.5">
                <div
                  className={`${sectionCardClass} mt-2 transition-opacity duration-300 ${
                    reasoningDisabled ? 'pointer-events-none opacity-50' : ''
                  }`}
                >
                  {!draft.thinkingConfigured && draft.reasoning ? (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-[length:var(--fs-xs)] text-text-400">{t('providers.noReasoningLevels')}</div>
                      <Button size="sm" variant="secondary" onClick={() => update(configureReasoning)}>
                        {t('providers.configureReasoning')}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <div className={fieldLabelClass}>{t('providers.reasoningMode')}</div>
                          <div className="mt-1.5">
                            <SettingsSelect
                              value={draft.thinkingMode}
                              ariaLabel={t('providers.reasoningMode')}
                              className="max-md:h-11 max-md:text-base"
                              options={THINKING_MODE_OPTIONS.map(option => ({
                                value: option.value,
                                label: t(option.labelKey),
                              }))}
                              onChange={value => update({ thinkingMode: value })}
                            />
                          </div>
                        </div>
                        <div>
                          <div className={fieldLabelClass}>{t('providers.defaultLevel')}</div>
                          <div className="mt-1.5">
                            <SettingsSelect
                              value={draft.defaultLevel}
                              ariaLabel={t('providers.defaultLevel')}
                              className="max-md:h-11 max-md:text-base"
                              options={(draft.efforts.length > 0 ? draft.efforts : DEFAULT_EFFORTS).map(level => ({
                                value: level,
                                label: level,
                              }))}
                              onChange={value => update({ defaultLevel: value })}
                            />
                          </div>
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className={fieldLabelClass}>{t('providers.reasoningLevels')}</div>
                          <button
                            type="button"
                            onClick={() => setCustomLevelOpen(value => !value)}
                            className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-[length:var(--fs-xxs)] text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100 max-md:h-9"
                          >
                            <Plus size={12} className={`transition-transform duration-200 ${customLevelOpen ? 'rotate-45' : ''}`} />
                            {t('providers.addLevel')}
                          </button>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {(draft.efforts.length > 0 ? draft.efforts : DEFAULT_EFFORTS).map(level => {
                            const active = draft.efforts.includes(level)
                            return (
                              <button
                                key={level}
                                type="button"
                                aria-pressed={active}
                                onClick={() => toggleEffort(level)}
                                className={chipClass(active)}
                              >
                                {level}
                              </button>
                            )
                          })}
                          {customLevelOpen && (
                            <span className="provider-fade inline-flex items-center gap-1">
                              <input
                                autoFocus
                                value={customLevel}
                                onChange={event => setCustomLevel(event.target.value)}
                                onKeyDown={event => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    addCustomLevel()
                                  }
                                  if (event.key === 'Escape') setCustomLevelOpen(false)
                                }}
                                placeholder={t('providers.customLevelPlaceholder')}
                                className={`${settingsFieldClass} h-7 w-28 rounded-full max-md:h-9`}
                              />
                              <Button size="sm" variant="secondary" className="rounded-full max-md:h-9" onClick={addCustomLevel}>
                                {t('providers.add')}
                              </Button>
                            </span>
                          )}
                        </div>
                        <div className={fieldHintClass}>{t('providers.reasoningLevelsHint')}</div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className={fieldLabelClass}>{t('providers.reasoningParams')}</div>
                          <button
                            type="button"
                            onClick={() => {
                              const map = parseEffortMap(effortMapText)
                              if (map === null) {
                                setJsonError(true)
                                return
                              }
                              setEffortMapText(effortMapToText(map))
                              setJsonError(false)
                            }}
                            className="inline-flex h-6 items-center rounded-full px-2 text-[length:var(--fs-xxs)] text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100 max-md:h-9"
                          >
                            {t('providers.formatJson')}
                          </button>
                        </div>
                        <textarea
                          value={effortMapText}
                          onChange={event => {
                            update({ thinkingConfigured: true })
                            setEffortMapText(event.target.value)
                            setJsonError(false)
                          }}
                          rows={5}
                          spellCheck={false}
                          placeholder={t('providers.reasoningParamsPlaceholder')}
                          aria-label={t('providers.reasoningParams')}
                          className={`${settingsFieldAreaClass} mt-1.5 font-mono ${jsonError ? '!border-danger-100/60' : ''}`}
                        />
                        <div className={fieldHintClass}>{t('providers.reasoningParamsHint')}</div>
                        {jsonError && (
                          <div
                            key={errorShake}
                            className="provider-shake mt-1 flex items-center gap-1.5 text-[length:var(--fs-xs)] text-danger-100"
                            role="alert"
                          >
                            <CircleAlert size={13} aria-hidden />
                            {t('providers.invalidJson')}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {errorText && (
            <div
              key={errorShake}
              className="provider-shake mt-4 flex items-center gap-2 rounded-lg border border-danger-100/30 bg-danger-100/8 px-3 py-2.5 text-[length:var(--fs-xs)] text-danger-100"
              role="alert"
            >
              <CircleAlert size={14} aria-hidden className="shrink-0" />
              {errorText}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-border-200/60 px-5 py-3 max-md:px-4 max-md:pb-[max(12px,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={handleReset}
            aria-label={t('providers.reset')}
            title={t('providers.reset')}
            className="group inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] text-text-400 transition-colors hover:bg-bg-200 hover:text-text-200 max-md:h-11 max-md:w-11 max-md:justify-center max-md:rounded-full max-md:bg-bg-200/70 max-md:px-0"
          >
            <RotateCcw size={14} className="transition-transform duration-500 group-active:-rotate-180 max-md:size-[18px]" />
            <span className="max-md:hidden">{t('providers.reset')}</span>
          </button>
          <div className="ml-auto flex items-center gap-2 max-md:ml-0 max-md:flex-1">
            <Button variant="secondary" size="sm" onClick={onClose} className="max-md:h-11 max-md:flex-1 max-md:text-base">
              {t('providers.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={smartConfigState === 'loading'}
              className="min-w-20 max-md:h-11 max-md:flex-[2] max-md:text-base"
            >
              {t('providers.save')}
            </Button>
          </div>
        </footer>
      </div>
    </Dialog>
  )
}
