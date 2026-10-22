import { Brain, ChevronRight, Cpu, Image, Type } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModelDraft } from './providerTypes'

export function ProviderModelAvatar() {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bg-300/60 text-text-200">
      <Cpu size={23} strokeWidth={1.5} />
    </span>
  )
}

export function ProviderModelCapabilities({ model }: { model: ModelDraft }) {
  const { t } = useTranslation('settings')
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span
        title={model.input
          .map(input => t(input === 'image' ? 'providers.inputImage' : 'providers.inputText'))
          .join(', ')}
        className="inline-flex h-5 items-center gap-1 rounded bg-success-100/15 px-1.5 text-success-100"
      >
        {model.input.includes('text') && <Type size={13} aria-label={t('providers.inputText')} />}
        {model.input.includes('image') && <Image size={13} aria-label={t('providers.inputImage')} />}
        <ChevronRight size={11} />
        <Type size={13} />
      </span>
      {model.reasoning && (
        <span
          title={t('providers.reasoning')}
          className="inline-flex h-5 items-center rounded bg-accent-secondary-100/15 px-1.5 text-accent-secondary-100"
        >
          <Brain size={14} aria-label={t('providers.reasoning')} />
        </span>
      )}
    </span>
  )
}
