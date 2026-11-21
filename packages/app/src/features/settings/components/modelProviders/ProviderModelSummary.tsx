import { Brain, Image, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../../../components/ui/Dialog'
import { formatModelContext, type ModelDraft } from './providerTypes'

// Brand assets come from https://github.com/lobehub/lobe-icons under MIT; see public/provider-icons/LICENSE.txt.
const providerIcons: Array<{ match: RegExp; icon: string }> = [
  { match: /gemini|nano-banana/i, icon: 'gemini-color.svg' },
  { match: /google/i, icon: 'google-color.svg' },
  { match: /claude/i, icon: 'claude-color.svg' },
  { match: /anthropic/i, icon: 'anthropic.svg' },
  { match: /deepseek/i, icon: 'deepseek-color.svg' },
  { match: /grok/i, icon: 'xai.svg' },
  { match: /qwen|qwq|qvq|通义千问|\bwanx?[\d-]/i, icon: 'qwen-color.svg' },
  { match: /doubao|豆包|火山/i, icon: 'doubao-color.svg' },
  { match: /openrouter/i, icon: 'openrouter.svg' },
  { match: /zhipu|智谱|glm/i, icon: 'zhipu-color.svg' },
  { match: /mistral|codestral|devstral|pixtral|ministral|magistral/i, icon: 'mistral-color.svg' },
  { match: /meta\b|(?<!o)llama|muse/i, icon: 'meta-color.svg' },
  { match: /hunyuan|tencent|\bhy(?:\b|\d)/i, icon: 'hunyuan-color.svg' },
  { match: /gemma/i, icon: 'gemma-color.svg' },
  { match: /perplexity/i, icon: 'perplexity-color.svg' },
  { match: /aliyun|阿里云|百炼/i, icon: 'alibabacloud-color.svg' },
  { match: /bytedance|字节/i, icon: 'bytedance-color.svg' },
  { match: /silicon|硅基/i, icon: 'siliconcloud-color.svg' },
  { match: /aihubmix/i, icon: 'aihubmix-color.svg' },
  { match: /ollama/i, icon: 'ollama.svg' },
  { match: /github/i, icon: 'github.svg' },
  { match: /cloudflare/i, icon: 'cloudflare-color.svg' },
  { match: /minimax/i, icon: 'minimax-color.svg' },
  { match: /kimi|k3/i, icon: 'kimi-color.svg' },
  { match: /moonshot|月之暗面/i, icon: 'moonshot.svg' },
  { match: /302/i, icon: 'ai302-color.svg' },
  { match: /step|阶跃/i, icon: 'stepfun-color.svg' },
  { match: /intern|书生/i, icon: 'internlm-color.svg' },
  { match: /cohere|command-.+/i, icon: 'cohere-color.svg' },
  { match: /cerebras/i, icon: 'cerebras-color.svg' },
  { match: /nvidia|nemotron|英伟达/i, icon: 'nvidia-color.svg' },
  { match: /sensenova|sensetime|sensechat|商汤|日日新/i, icon: 'sensenova-color.svg' },
  { match: /ppio|派欧/i, icon: 'ppio-color.svg' },
  { match: /vercel/i, icon: 'vercel.svg' },
  { match: /groq/i, icon: 'groq.svg' },
  { match: /mimo|xiaomi|小米/i, icon: 'xiaomimimo.svg' },
  { match: /longcat/i, icon: 'longcat-color.svg' },
  { match: /openai|chatgpt|gpt|\bo[134](?:-|$)/i, icon: 'openai.svg' },
]

function providerIconForName(name: string): string | undefined {
  return providerIcons.find(entry => entry.match.test(name))?.icon
}

const PROVIDER_ICON_OVERRIDES_KEY = 'ompiui:provider-icon-overrides'
const PROVIDER_ICON_CHANGE_EVENT = 'ompiui:provider-icons-updated'

function readProviderIconOverrides(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROVIDER_ICON_OVERRIDES_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

function setProviderIconOverride(providerId: string, icon: string | null) {
  const overrides = readProviderIconOverrides()
  if (icon) overrides[providerId] = icon
  else delete overrides[providerId]
  localStorage.setItem(PROVIDER_ICON_OVERRIDES_KEY, JSON.stringify(overrides))
  window.dispatchEvent(new Event(PROVIDER_ICON_CHANGE_EVENT))
}

function providerIconForApi(api: string | undefined): string {
  switch (api) {
    case 'anthropic-messages':
      return 'claude-color.svg'
    case 'google-generative-ai':
      return 'gemini-color.svg'
    case 'openai-completions':
    case 'openai-responses':
    default:
      return 'openai.svg'
  }
}

const monochromeIcons = new Set([
  'anthropic.svg',
  'github.svg',
  'groq.svg',
  'moonshot.svg',
  'ollama.svg',
  'openai.svg',
  'openrouter.svg',
  'vercel.svg',
  'xai.svg',
])

const avatarSize = {
  sm: 'h-7 w-7 rounded-lg text-xs',
  md: 'h-10 w-10 rounded-xl text-sm',
  lg: 'h-11 w-11 rounded-xl text-base',
} as const

function LogoAvatar({
  icon,
  fallbackIcon = 'openai.svg',
  size = 'md',
}: {
  icon: string
  fallbackIcon?: string
  size?: keyof typeof avatarSize
}) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center overflow-hidden ${avatarSize[size]}`}
      style={{
        background: 'hsl(var(--bg-200))',
        boxShadow: 'inset 0 0 0 1px hsl(var(--border-200) / 0.65)',
      }}
    >
      <img
        src={icon.startsWith('http') ? icon : `${import.meta.env.BASE_URL}provider-icons/${icon}`}
        alt=""
        data-monochrome={monochromeIcons.has(icon) ? 'true' : undefined}
        className="provider-logo h-full w-full object-contain p-1.5"
        onError={event => {
          event.currentTarget.onerror = null
          event.currentTarget.src = `${import.meta.env.BASE_URL}provider-icons/${fallbackIcon}`
        }}
      />
    </span>
  )
}

/** 供应商头像使用 API 格式默认图标，并允许单独覆盖。 */
export function ProviderAvatar({
  label,
  api,
  baseUrl = '',
  providerId,
  editable = false,
  size = 'md',
}: {
  label: string
  api?: string
  baseUrl?: string
  providerId?: string
  editable?: boolean
  size?: keyof typeof avatarSize
}) {
  const { t } = useTranslation('settings')
  const [override, setOverride] = useState<string | undefined>(() =>
    providerId ? readProviderIconOverrides()[providerId] : undefined,
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [iconUrlDraft, setIconUrlDraft] = useState('')
  useEffect(() => {
    if (!providerId) return
    const update = () => setOverride(readProviderIconOverrides()[providerId])
    window.addEventListener(PROVIDER_ICON_CHANGE_EVENT, update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener(PROVIDER_ICON_CHANGE_EVENT, update)
      window.removeEventListener('storage', update)
    }
  }, [providerId])

  const defaultIcon = providerIconForApi(api)
  const icon = override ?? defaultIcon
  const websiteIcon = (() => {
    try {
      const origin = new URL(baseUrl).origin
      return `${origin}/favicon.ico`
    } catch {
      return ''
    }
  })()
  return (
    <>
      {editable && providerId ? (
        <button
          type="button"
          title={t('providers.changeIcon')}
          aria-label={t('providers.changeIconFor', { name: label })}
          onClick={() => setPickerOpen(true)}
          className="provider-avatar-edit relative shrink-0 rounded-xl focus-visible:outline-2 focus-visible:outline-accent-main-100"
        >
          <LogoAvatar icon={icon} fallbackIcon={defaultIcon} size={size} />
          <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-border-200 bg-bg-100 text-text-400 shadow-sm">
            <Pencil size={9} aria-hidden />
          </span>
        </button>
      ) : (
        <LogoAvatar icon={icon} fallbackIcon={defaultIcon} size={size} />
      )}
      {editable && providerId && (
        <Dialog isOpen={pickerOpen} onClose={() => setPickerOpen(false)} title={t('providers.changeIcon')} width={520}>
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => {
                setProviderIconOverride(providerId, null)
                setPickerOpen(false)
              }}
              className="flex w-full items-center gap-3 rounded-lg border border-border-200/60 px-3 py-2.5 text-left hover:bg-bg-200"
            >
              <img
                src={`${import.meta.env.BASE_URL}provider-icons/${defaultIcon}`}
                alt=""
                className="h-8 w-8 object-contain"
              />
              <span>
                <span className="block text-sm font-medium text-text-100">{t('providers.defaultIcon')}</span>
                <span className="text-xs text-text-400">{t('providers.defaultIconHint')}</span>
              </span>
            </button>
            {websiteIcon && (
              <button
                type="button"
                onClick={() => {
                  setProviderIconOverride(providerId, websiteIcon)
                  setPickerOpen(false)
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-border-200/60 px-3 py-2.5 text-left hover:bg-bg-200"
              >
                <img src={websiteIcon} alt="" className="h-8 w-8 rounded-md object-contain" />
                <span>
                  <span className="block text-sm font-medium text-text-100">{t('providers.websiteIcon')}</span>
                  <span className="block max-w-[360px] truncate text-xs text-text-400">{websiteIcon}</span>
                </span>
              </button>
            )}
            <label className="block text-xs font-medium text-text-300">
              {t('providers.iconUrl')}
              <div className="mt-1.5 flex gap-2">
                <input
                  value={iconUrlDraft}
                  onChange={event => setIconUrlDraft(event.target.value)}
                  placeholder="https://example.com/icon.png"
                  className="min-w-0 flex-1 rounded-md border border-border-200 bg-bg-100 px-3 py-2 text-sm text-text-100"
                />
                <button
                  type="button"
                  disabled={!/^https?:\/\//i.test(iconUrlDraft.trim())}
                  onClick={() => {
                    setProviderIconOverride(providerId, iconUrlDraft.trim())
                    setPickerOpen(false)
                  }}
                  className="rounded-md bg-accent-main-100 px-3 text-sm font-medium text-oncolor-100 disabled:opacity-50"
                >
                  {t('providers.applyIcon')}
                </button>
              </div>
            </label>
            <div>
              <div className="mb-2 text-xs font-medium text-text-300">{t('providers.builtinIcons')}</div>
              <div className="grid max-h-56 grid-cols-6 gap-2 overflow-y-auto sm:grid-cols-8">
                {providerIcons.map(({ icon: builtin }) => (
                  <button
                    key={builtin}
                    type="button"
                    title={builtin.replace(/(?:-color)?\.svg$/, '')}
                    onClick={() => {
                      setProviderIconOverride(providerId, builtin)
                      setPickerOpen(false)
                    }}
                    className="flex aspect-square items-center justify-center rounded-md border border-border-200/50 bg-bg-100 p-2 hover:border-accent-main-100/60 hover:bg-bg-200"
                  >
                    <img
                      src={`${import.meta.env.BASE_URL}provider-icons/${builtin}`}
                      alt=""
                      className="h-full w-full object-contain"
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Dialog>
      )}
    </>
  )
}

export function ProviderModelAvatar({ id, size = 'md' }: { id: string; size?: keyof typeof avatarSize }) {
  const icon = providerIconForName(id) ?? 'openai.svg'
  return <LogoAvatar icon={icon} size={size} />
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
