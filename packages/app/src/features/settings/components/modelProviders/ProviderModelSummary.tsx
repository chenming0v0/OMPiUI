import { Brain, Image } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatModelContext, modelFamily, type ModelDraft } from './providerTypes'

function hueOf(text: string): number {
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}

const avatarSize = {
  sm: 'h-7 w-7 rounded-lg text-xs',
  md: 'h-10 w-10 rounded-xl text-sm',
  lg: 'h-11 w-11 rounded-xl text-base',
} as const

/** 名称首字 + 由名称得出的稳定色相，同一供应商/模型家族在各处颜色一致。 */
export function ProviderAvatar({ label, size = 'md' }: { label: string; size?: keyof typeof avatarSize }) {
  const hue = hueOf(label.trim().toLowerCase())
  const initial = Array.from(label.trim())[0]?.toUpperCase() ?? '?'
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center font-semibold ${avatarSize[size]}`}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 70% 55% / 0.2), hsl(${(hue + 40) % 360} 70% 55% / 0.1))`,
        boxShadow: `inset 0 0 0 1px hsl(${hue} 60% 50% / 0.18)`,
        color: `hsl(${hue} 55% 50%)`,
      }}
    >
      {initial}
    </span>
  )
}

export function ProviderModelAvatar({ id, size = 'md' }: { id: string; size?: keyof typeof avatarSize }) {
  return <ProviderAvatar label={modelFamily(id) ?? id} size={size} />
}

const capabilityClass = 'inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium leading-none'

export function ProviderModelCapabilities({ model }: { model: ModelDraft }) {
  const { t } = useTranslation('settings')
  const context = formatModelContext(model.contextWindow)
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1">
      {context && (
        <span title={t('providers.contextWindow')} className={`${capabilityClass} bg-bg-200 font-mono text-text-300`}>
          {context}
        </span>
      )}
      {model.input.includes('image') && (
        <span className={`${capabilityClass} bg-success-100/12 text-success-100`}>
          <Image size={12} aria-hidden />
          {t('providers.inputImage')}
        </span>
      )}
      {model.reasoning && (
        <span className={`${capabilityClass} bg-accent-secondary-100/12 text-accent-secondary-100`}>
          <Brain size={12} aria-hidden />
          {t('providers.reasoning')}
        </span>
      )}
    </span>
  )
}
