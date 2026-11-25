import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { REASONING_TRANSLATION_CONCURRENCY } from '@ompiui/protocol'
import { Button } from '../../../components/ui/Button'
import { setReasoningTranslationConcurrency, useReasoningTranslationConfig } from '../../../store/reasoningTranslationConfig'
import { SettingField, settingsFieldAreaClass } from './SettingsUI'

export function ReasoningTranslationConcurrencySetting() {
  const { t } = useTranslation('settings')
  const config = useReasoningTranslationConfig()
  const [draft, setDraft] = useState(String(config.concurrency))
  useEffect(() => setDraft(String(config.concurrency)), [config.concurrency, config.generation])
  const value = Number(draft)
  const valid = draft !== '' && Number.isInteger(value) && value >= REASONING_TRANSLATION_CONCURRENCY.min && value <= REASONING_TRANSLATION_CONCURRENCY.max
  return <SettingField label={t('agent.reasoningTranslationConcurrency')} description={t('agent.reasoningTranslationConcurrencyDesc')}>
    <div className="flex items-center gap-2">
      <input
        type="number" min={REASONING_TRANSLATION_CONCURRENCY.min} max={REASONING_TRANSLATION_CONCURRENCY.max} step={1}
        aria-label={t('agent.reasoningTranslationConcurrency')}
        className={`${settingsFieldAreaClass} max-w-24`}
        value={draft} disabled={config.loading}
        onChange={event => setDraft(event.target.value)}
      />
      <Button size="sm" disabled={!valid || config.loading || value === config.concurrency} onClick={() => void setReasoningTranslationConcurrency(value)}>
        {t('common:save')}
      </Button>
    </div>
    {config.failed && <p role="alert" className="mt-1 text-[length:var(--fs-xs)] text-danger-100">{t('agent.reasoningTranslationConfigError')}</p>}
  </SettingField>
}
