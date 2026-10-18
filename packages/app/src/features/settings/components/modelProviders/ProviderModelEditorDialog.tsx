import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../../../components/ui/Dialog'
import { Button } from '../../../../components/ui/Button'
import { CheckIcon, CloseIcon, PlusIcon } from '../../../../components/Icons'
import {
  DEFAULT_EFFORTS,
  THINKING_MODE_OPTIONS,
  blankModelDraft,
  inferModelDefaults,
  modelDraftDefaultsFromModelsDev,
  validateModelDraft,
  type ModelDraft,
} from './providerTypes'
import { SettingsSelect, settingsFieldAreaClass, settingsFieldClass } from '../SettingsUI'
import { lookupModelsDevModel } from '../../../../omp/transport/index.js'

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

const chipClass = (active: boolean, disabled = false) =>
  `inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[length:var(--fs-xs)] font-medium transition-colors
  ${
    active
      ? 'border-accent-main-100/50 bg-accent-main-100/10 text-accent-main-100'
      : 'border-border-200 text-text-300 hover:bg-bg-200 hover:text-text-100'
  }
  ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`

const fieldLabelClass = 'text-[length:var(--fs-xs)] font-medium text-text-300'

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
  const [smartConfigState, setSmartConfigState] = useState<'idle' | 'loading' | 'matched' | 'fallback'>('idle')
  const [customLevel, setCustomLevel] = useState('')
  const [customLevelOpen, setCustomLevelOpen] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const lookupSequenceRef = useRef(0)
  const lookupAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!isOpen) {
      lookupAbortRef.current?.abort()
      lookupSequenceRef.current += 1
      return
    }
    const next = model ? cloneDraft(model) : blankModelDraft()
    setDraft(next.id.trim() ? { ...next, ...inferModelDefaults(next.id) } : next)
    setInitial(cloneDraft(next))
    setEffortMapText(effortMapToText(next.effortMap))
    setError(null)
    setJsonError(false)
    setSmartConfig(true)
    setSmartConfigState('idle')
    setCustomLevel('')
    setCustomLevelOpen(false)
    setAdvancedOpen(true)
    return () => {
      lookupAbortRef.current?.abort()
      lookupSequenceRef.current += 1
    }
  }, [isOpen, model])

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
    setDraft(current => (current ? { ...current, ...patch } : current))
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

  const applySmartConfig = useCallback((id: string) => {
    lookupAbortRef.current?.abort()
    const controller = new AbortController()
    lookupAbortRef.current = controller
    const sequence = ++lookupSequenceRef.current
    setSmartConfigState('loading')
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
          setSmartConfigState('fallback')
          return
        }
        const remote = modelDraftDefaultsFromModelsDev(result)
        setDraft(current => {
          if (!current) return current
          const next = { ...current, ...remote }
          if (current.name.trim() === current.id.trim() || !current.name.trim()) {
            next.name = remote.name ?? current.name
          }
          return next
        })
        setSmartConfigState('matched')
      })
      .catch(() => {
        if (sequence === lookupSequenceRef.current && !controller.signal.aborted) setSmartConfigState('fallback')
      })
  }, [providerId, providerApi])

  useEffect(() => {
    if (!isOpen || !smartConfig || !draft?.id.trim()) {
      lookupAbortRef.current?.abort()
      lookupSequenceRef.current += 1
      return
    }
    applySmartConfig(draft.id)
    return () => {
      lookupAbortRef.current?.abort()
      lookupSequenceRef.current += 1
    }
  }, [isOpen, smartConfig, draft?.id, applySmartConfig])

  const handleModelIdChange = (value: string) => {
    if (!draft) return
    const next = { ...draft, id: value, name: draft.name === draft.id ? value : draft.name }
    setDraft(smartConfig ? { ...next, ...inferModelDefaults(value) } : next)
    setError(null)
  }

  const handleSave = () => {
    if (!draft) return
    const issue = validateModelDraft(draft, siblings)
    if (issue) {
      setError(issue)
      return
    }
    const effortMap = parseEffortMap(effortMapText)
    if (effortMap === null) {
      setJsonError(true)
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
    setSmartConfig(true)
    setSmartConfigState('idle')
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

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      ariaLabel={title}
      width="min(96vw, 640px)"
      showCloseButton={false}
      rawContent
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="shrink-0 flex items-start justify-between gap-3 border-b border-border-200/60 px-5 py-3.5">
          <div className="min-w-0">
            <div className="text-[length:var(--fs-xxs)] font-medium uppercase tracking-wider text-text-400">
              {providerName}
              {progress !== undefined && <span className="ml-1.5 text-text-500">{progress} / {queueTotal}</span>}
            </div>
            <h2 className="mt-0.5 text-[length:var(--fs-lg)] font-semibold text-text-100">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('providers.close')}
            className="shrink-0 flex h-8 w-8 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 py-4">
          <div className="flex items-center justify-between gap-4 rounded-lg bg-bg-200/40 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[length:var(--fs-md)] font-medium text-text-100">{t('providers.smartConfig')}</div>
              <div className="mt-0.5 text-[length:var(--fs-xs)] text-text-400">
                {t('providers.smartConfigHint')}
                {smartConfigState === 'loading' && <span className="ml-1">{t('providers.smartConfigLoading')}</span>}
                {smartConfigState === 'matched' && (
                  <span className="ml-1 text-success-100">{t('providers.smartConfigMatched')}</span>
                )}
                {smartConfigState === 'fallback' && <span className="ml-1">{t('providers.smartConfigFallback')}</span>}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={smartConfig}
              aria-label={t('providers.smartConfig')}
              onClick={() => {
                const next = !smartConfig
                setSmartConfig(next)
                if (!next) {
                  lookupAbortRef.current?.abort()
                  setSmartConfigState('idle')
                } else {
                  setDraft(current =>
                    current ? { ...current, ...inferModelDefaults(current.id) } : current,
                  )
                }
              }}
              className={`relative shrink-0 rounded-full transition-colors ${smartConfig ? 'bg-accent-main-100' : 'bg-bg-300'}`}
              style={{ width: 36, height: 20 }}
            >
              <span
                className="absolute left-[2px] top-[2px] rounded-full bg-white transition-transform"
                style={{ width: 16, height: 16, transform: smartConfig ? 'translateX(16px)' : 'translateX(0)' }}
              />
            </button>
          </div>

          <div className="mt-4 space-y-4">
            <label className="block">
              <span className={fieldLabelClass}>{t('providers.modelId')}</span>
              <input
                ref={nameInputRef}
                value={draft.id}
                onChange={event => handleModelIdChange(event.target.value)}
                placeholder={t('providers.modelIdPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                className={`${settingsFieldClass} mt-1 font-mono`}
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
                className={`${settingsFieldClass} mt-1`}
              />
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={fieldLabelClass}>{t('providers.contextWindow')}</span>
                <div className="relative mt-1">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.contextWindow}
                    onChange={event => update({ contextWindow: Number(event.target.value) })}
                    className={`${settingsFieldClass} pr-14`}
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[length:var(--fs-xxs)] text-text-500">
                    {t('providers.tokensUnit')}
                  </span>
                </div>
              </label>
              <label className="block">
                <span className={fieldLabelClass}>{t('providers.maxOutput')}</span>
                <div className="relative mt-1">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={draft.maxTokens}
                    onChange={event => update({ maxTokens: Number(event.target.value) })}
                    className={`${settingsFieldClass} pr-14`}
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[length:var(--fs-xxs)] text-text-500">
                    {t('providers.tokensUnit')}
                  </span>
                </div>
              </label>
            </div>

            <div>
              <button
                type="button"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen(value => !value)}
                className="flex items-center gap-1.5 text-[length:var(--fs-xs)] font-medium text-text-300 transition-colors hover:text-text-100"
              >
                <span className={`inline-block transition-transform ${advancedOpen ? '' : '-rotate-90'}`}>▾</span>
                {t('providers.advanced')}
              </button>

              {advancedOpen && (
                <div className="mt-3 space-y-4 rounded-lg border border-border-200/50 p-3">
                  <div>
                    <div className={fieldLabelClass}>{t('providers.inputTypes')}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {(
                        [
                          ['text', 'providers.inputText'],
                          ['image', 'providers.inputImage'],
                        ] as const
                      ).map(([value, labelKey]) => {
                        const active = draft.input.includes(value)
                        return (
                          <button
                            key={value}
                            type="button"
                            aria-pressed={active}
                            onClick={() => toggleInput(value)}
                            className={chipClass(active)}
                          >
                            {active && <CheckIcon size={12} />}
                            {t(labelKey)}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className={fieldLabelClass}>{t('providers.reasoning')}</div>
                      <div className="mt-0.5 text-[length:var(--fs-xs)] text-text-400">{t('providers.reasoningHint')}</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={draft.reasoning}
                      aria-label={t('providers.reasoning')}
                      onClick={() => update({ reasoning: !draft.reasoning })}
                      className={`relative shrink-0 rounded-full transition-colors ${draft.reasoning ? 'bg-accent-main-100' : 'bg-bg-300'}`}
                      style={{ width: 36, height: 20 }}
                    >
                      <span
                        className="absolute left-[2px] top-[2px] rounded-full bg-white transition-transform"
                        style={{ width: 16, height: 16, transform: draft.reasoning ? 'translateX(16px)' : 'translateX(0)' }}
                      />
                    </button>
                  </div>

                  <div className={reasoningDisabled ? 'pointer-events-none opacity-50' : ''}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <div className={fieldLabelClass}>{t('providers.reasoningMode')}</div>
                        <div className="mt-1">
                          <SettingsSelect
                            value={draft.thinkingMode}
                            ariaLabel={t('providers.reasoningMode')}
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
                        <div className="mt-1">
                          <SettingsSelect
                            value={draft.defaultLevel}
                            ariaLabel={t('providers.defaultLevel')}
                            options={(draft.efforts.length > 0 ? draft.efforts : DEFAULT_EFFORTS).map(level => ({
                              value: level,
                              label: level,
                            }))}
                            onChange={value => update({ defaultLevel: value })}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="mt-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className={fieldLabelClass}>{t('providers.reasoningLevels')}</div>
                        <button
                          type="button"
                          onClick={() => setCustomLevelOpen(value => !value)}
                          className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[length:var(--fs-xxs)] text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
                        >
                          <PlusIcon size={12} />
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
                          <span className="inline-flex items-center gap-1">
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
                              className={`${settingsFieldClass} h-7 w-28`}
                            />
                            <Button size="sm" variant="secondary" onClick={addCustomLevel}>
                              {t('providers.add')}
                            </Button>
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[length:var(--fs-xxs)] text-text-500">
                        {t('providers.reasoningLevelsHint')}
                      </div>
                    </div>

                    <div className="mt-3">
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
                          className="inline-flex h-6 items-center rounded px-1.5 text-[length:var(--fs-xxs)] text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
                        >
                          {t('providers.formatJson')}
                        </button>
                      </div>
                      <textarea
                        value={effortMapText}
                        onChange={event => {
                          setEffortMapText(event.target.value)
                          setJsonError(false)
                        }}
                        rows={5}
                        spellCheck={false}
                        placeholder={t('providers.reasoningParamsPlaceholder')}
                        aria-label={t('providers.reasoningParams')}
                        className={`${settingsFieldAreaClass} mt-1.5 font-mono`}
                      />
                      <div className="mt-1 text-[length:var(--fs-xxs)] text-text-500">{t('providers.reasoningParamsHint')}</div>
                      {jsonError && (
                        <div className="mt-1 text-[length:var(--fs-xs)] text-danger-100" role="alert">
                          {t('providers.invalidJson')}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {errorText && (
              <div className="text-[length:var(--fs-xs)] text-danger-100" role="alert">
                {errorText}
              </div>
            )}
          </div>
        </div>

        <footer className="shrink-0 flex items-center justify-between gap-3 border-t border-border-200/60 px-5 py-3">
          <button
            type="button"
            onClick={handleReset}
            className="text-[length:var(--fs-xs)] text-text-400 transition-colors hover:text-text-200"
          >
            {t('providers.reset')}
          </button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('providers.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={handleSave}>
              {t('providers.save')}
            </Button>
          </div>
        </footer>
      </div>
    </Dialog>
  )
}
