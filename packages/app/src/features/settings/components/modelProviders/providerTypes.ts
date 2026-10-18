import type {
  PiModelProviderConfig,
  PiModelProviderModelConfig,
  PiModelsDevLookupResult,
} from '../../../../omp/domain/index.js'

/**
 * 「供应商」设置页的编辑态类型与纯函数。
 *
 * 数据源是 OMP 的 `~/.omp/agent/models.yml`：provider 的 api / baseUrl / apiKey
 * 以及每个 model 的 id / name / contextWindow / maxTokens / input / thinking。
 * OMP 的 schema 没有「启用」开关和能力位，所以界面不伪造这些字段，只暴露
 * models.yml 真正支持的配置。
 */

export type ProviderApiFormat = 'anthropic-messages' | 'openai-completions' | 'openai-responses'

export type ThinkingMode =
  | 'effort'
  | 'anthropic-adaptive'
  | 'anthropic-budget-effort'
  | 'budget'
  | 'google-level'

export type ModelDraft = {
  /** 编辑已有模型时记录原 id，保存时服务端据此合并（允许改 id）。 */
  originalId?: string
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  input: Array<'text' | 'image'>
  thinkingMode: ThinkingMode
  efforts: string[]
  defaultLevel: string
  /** 推理等级 → 上游参数值的映射（models.yml `thinking.effortMap`）。 */
  effortMap: Record<string, string>
}

export type ProviderDraft = {
  id: string
  name: string
  api: ProviderApiFormat
  baseUrl: string
  apiKey: string
  /** models.yml 的 authHeader：undefined 表示文件里没写，保存时保持不写。 */
  authHeader?: boolean
  models: ModelDraft[]
}

export type PickerGroup = {
  name: string
  models: string[]
}

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 32_768
export const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh']
/** 已知的推理等级，用于「添加自定义等级」的候选。 */
export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export const API_FORMAT_OPTIONS: Array<{
  value: ProviderApiFormat
  labelKey: string
  path: string
}> = [
  { value: 'anthropic-messages', labelKey: 'providers.apiFormatAnthropic', path: '/v1/messages' },
  { value: 'openai-completions', labelKey: 'providers.apiFormatOpenai', path: '/chat/completions' },
  { value: 'openai-responses', labelKey: 'providers.apiFormatResponses', path: '/responses' },
]

export const THINKING_MODE_OPTIONS: Array<{ value: ThinkingMode; labelKey: string }> = [
  { value: 'effort', labelKey: 'providers.thinkingModeEffort' },
  { value: 'anthropic-adaptive', labelKey: 'providers.thinkingModeAdaptive' },
  { value: 'anthropic-budget-effort', labelKey: 'providers.thinkingModeBudgetEffort' },
  { value: 'budget', labelKey: 'providers.thinkingModeBudget' },
  { value: 'google-level', labelKey: 'providers.thinkingModeGoogle' },
]

export function apiFormatToLabelKey(api: string): string {
  return API_FORMAT_OPTIONS.find(option => option.value === api)?.labelKey ?? 'providers.apiFormatOpenai'
}

export function apiFormatPath(api: string): string {
  return API_FORMAT_OPTIONS.find(option => option.value === api)?.path ?? '/v1'
}

export function blankModelDraft(id = ''): ModelDraft {
  return {
    id,
    name: id,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: false,
    input: ['text', 'image'],
    thinkingMode: 'effort',
    efforts: [...DEFAULT_EFFORTS],
    defaultLevel: 'high',
    effortMap: {},
  }
}

export function modelDraftFromConfig(model: PiModelProviderModelConfig): ModelDraft {
  const thinking = model.thinking
  return {
    originalId: model.id,
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    reasoning: model.reasoning ?? Boolean(thinking),
    input: Array.isArray(model.input) && model.input.length > 0 ? [...model.input] : ['text', 'image'],
    thinkingMode: normalizeThinkingMode(thinking?.mode),
    efforts: Array.isArray(thinking?.efforts) && thinking.efforts.length > 0 ? [...thinking.efforts] : [...DEFAULT_EFFORTS],
    defaultLevel: thinking?.defaultLevel ?? 'high',
    effortMap: { ...(thinking?.effortMap ?? {}) },
  }
}

function normalizeThinkingMode(mode: string | undefined): ThinkingMode {
  return THINKING_MODE_OPTIONS.some(option => option.value === mode) ? (mode as ThinkingMode) : 'effort'
}

export function providerDraftFromConfig(provider: PiModelProviderConfig): ProviderDraft {
  return {
    id: provider.id,
    name: provider.name || provider.id,
    api: normalizeApiFormat(provider.api),
    baseUrl: provider.baseUrl ?? '',
    apiKey: provider.apiKey ?? '',
    ...(typeof provider.authHeader === 'boolean' ? { authHeader: provider.authHeader } : {}),
    models: (provider.models ?? []).map(modelDraftFromConfig),
  }
}

function normalizeApiFormat(api: string | undefined): ProviderApiFormat {
  return API_FORMAT_OPTIONS.some(option => option.value === api)
    ? (api as ProviderApiFormat)
    : 'openai-completions'
}

/** 编辑态 → models.yml 写入载荷；空 effortMap / 非推理模型不写多余字段。 */
export function providerDraftToConfig(draft: ProviderDraft): PiModelProviderConfig {
  return {
    id: draft.id,
    name: draft.name.trim(),
    api: draft.api,
    baseUrl: draft.baseUrl.trim(),
    apiKey: draft.apiKey.trim(),
    ...(typeof draft.authHeader === 'boolean' ? { authHeader: draft.authHeader } : {}),
    models: draft.models.map(model => modelDraftToConfig(model)),
  }
}

function modelDraftToConfig(model: ModelDraft): PiModelProviderModelConfig {
  const config: PiModelProviderModelConfig = {
    id: model.id.trim(),
    ...(model.originalId ? { originalId: model.originalId } : {}),
    name: model.name.trim() || model.id.trim(),
    contextWindow: Math.max(1, Math.round(model.contextWindow)),
    maxTokens: Math.max(1, Math.round(model.maxTokens)),
    reasoning: model.reasoning,
    input: model.input.length > 0 ? [...model.input] : ['text'],
  }
  if (model.reasoning) {
    config.thinking = {
      mode: model.thinkingMode,
      efforts: [...model.efforts],
      defaultLevel: model.defaultLevel,
      ...(Object.keys(model.effortMap).length > 0 ? { effortMap: { ...model.effortMap } } : {}),
    }
  }
  return config
}

export function formatModelContext(value: number | undefined): string {
  if (!value || value <= 0) return ''
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  return `${Math.round(value / 1000)}K`
}

/** 模型 ID 启发式：只用于「智能配置」一键填入，不改已有值。 */
export function inferModelDefaults(id: string): Partial<ModelDraft> {
  const normalized = id.toLowerCase()
  const vision = { input: ['text', 'image'] as Array<'text' | 'image'> }
  if (normalized.includes('claude')) {
    return { contextWindow: 1_000_000, maxTokens: 128_000, reasoning: true, ...vision }
  }
  if (normalized.includes('gemini')) {
    return { contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true, ...vision }
  }
  if (normalized.includes('grok')) {
    return { contextWindow: 500_000, maxTokens: 128_000, reasoning: true, ...vision }
  }
  if (normalized.includes('qwen')) {
    return { contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true, ...vision }
  }
  if (normalized.includes('deepseek')) {
    return { contextWindow: 640_000, maxTokens: 65_536, reasoning: true, ...vision }
  }
  if (normalized.includes('glm')) {
    return { contextWindow: 1_000_000, maxTokens: 131_072, reasoning: true, ...vision }
  }
  if (normalized.includes('kimi') || normalized.includes('moonshot')) {
    return { contextWindow: 256_000, maxTokens: 32_768, reasoning: true, ...vision }
  }
  if (normalized.includes('gpt') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) {
    return { contextWindow: 400_000, maxTokens: 128_000, reasoning: true, ...vision }
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS }
}

/** 将 models.dev 的能力字段转换为 OMP 模型编辑器字段。 */
export function modelDraftDefaultsFromModelsDev(result: PiModelsDevLookupResult): Partial<ModelDraft> {
  if (!result.found) return {}
  const patch: Partial<ModelDraft> = {}
  if (result.name) patch.name = result.name
  if (result.contextWindow) patch.contextWindow = result.contextWindow
  if (result.maxTokens) patch.maxTokens = result.maxTokens
  if (result.reasoning !== undefined) patch.reasoning = result.reasoning
  if (result.input && result.input.length > 0) patch.input = [...result.input]
  if (result.thinking) {
    if (result.thinking.mode) patch.thinkingMode = result.thinking.mode
    if (result.thinking.efforts && result.thinking.efforts.length > 0) {
      patch.efforts = [...result.thinking.efforts]
    }
    if (result.thinking.defaultLevel) patch.defaultLevel = result.thinking.defaultLevel
  }
  return patch
}

/** 供应商 ID 用于 models.yml 的 key：小写、保留字母数字和 -_.，其余折叠为 -。 */
export function slugifyProviderId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `custom-${Date.now().toString(36)}`
}

export function uniqueProviderId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`
    if (!used.has(candidate)) return candidate
  }
}

const GROUP_ORDER = [
  'Anthropic',
  'OpenAI',
  'Gemini',
  'xAI',
  'DeepSeek',
  '智谱',
  '通义千问',
  'Moonshot',
  'Mistral',
  'Llama',
  'Cohere',
  'MiniMax',
  '其他',
]

const FAMILY_MATCHERS: Array<{ group: string; test: (id: string) => boolean }> = [
  { group: 'Anthropic', test: id => id.includes('claude') },
  { group: 'OpenAI', test: id => id.includes('gpt') || /^o[134](?:-|$)/.test(id) || id.includes('dall-e') },
  { group: 'Gemini', test: id => id.includes('gemini') || id.includes('imagen') },
  { group: 'xAI', test: id => id.includes('grok') },
  { group: 'DeepSeek', test: id => id.includes('deepseek') },
  { group: '智谱', test: id => id.includes('glm') || id.includes('z-ai') },
  { group: '通义千问', test: id => id.includes('qwen') },
  { group: 'Moonshot', test: id => id.includes('kimi') || id.includes('moonshot') },
  {
    group: 'Mistral',
    test: id => ['mistral', 'codestral', 'devstral', 'pixtral', 'ministral', 'magistral'].some(token => id.includes(token)),
  },
  { group: 'Llama', test: id => id.includes('llama') },
  { group: 'Cohere', test: id => id.includes('command') || id.includes('aya') || id.includes('c4ai') },
  { group: 'MiniMax', test: id => id.includes('minimax') },
]

/**
 * 拉取结果的展示分组：先按已知模型家族归类，带 `vendor/` 前缀的 id 归到
 * vendor 组，其余进「其他」。顺序稳定（已知家族 → 前缀组 → 其他）。
 */
export function groupModelIds(ids: string[]): PickerGroup[] {
  const groups = new Map<string, string[]>()
  const prefixed: Array<{ name: string; models: string[] }> = []
  const prefixedIndex = new Map<string, string[]>()

  for (const rawId of ids) {
    const id = rawId.trim()
    if (!id) continue
    const family = FAMILY_MATCHERS.find(matcher => matcher.test(id.toLowerCase()))
    if (family) {
      const bucket = groups.get(family.group) ?? []
      bucket.push(id)
      groups.set(family.group, bucket)
      continue
    }
    const slash = id.indexOf('/')
    if (slash > 0 && slash < id.length - 1) {
      const prefix = id.slice(0, slash)
      const bucket = prefixedIndex.get(prefix) ?? []
      bucket.push(id)
      prefixedIndex.set(prefix, bucket)
      continue
    }
    const other = groups.get('其他') ?? []
    other.push(id)
    groups.set('其他', other)
  }

  for (const [name, models] of prefixedIndex) prefixed.push({ name, models })

  const ordered: PickerGroup[] = []
  for (const name of GROUP_ORDER) {
    if (name === '其他') continue
    const models = groups.get(name)
    if (models && models.length > 0) ordered.push({ name, models })
  }
  prefixed.sort((left, right) => left.name.localeCompare(right.name))
  ordered.push(...prefixed.filter(group => !GROUP_ORDER.includes(group.name)))
  const other = groups.get('其他')
  if (other && other.length > 0) ordered.push({ name: '其他', models: other })
  return ordered
}

export type ModelDraftIssue = 'idRequired' | 'duplicateId' | 'invalidNumbers'

export function validateModelDraft(draft: ModelDraft, siblings: ModelDraft[]): ModelDraftIssue | null {
  const id = draft.id.trim()
  if (!id) return 'idRequired'
  if (siblings.some(model => model.id.trim() === id && model.originalId !== draft.originalId)) return 'duplicateId'
  if (!Number.isFinite(draft.contextWindow) || draft.contextWindow < 1) return 'invalidNumbers'
  if (!Number.isFinite(draft.maxTokens) || draft.maxTokens < 1) return 'invalidNumbers'
  return null
}

/** 供应商列表行的元信息：API 格式 + 模型数。 */
export function providerSummary(provider: ProviderDraft): { apiPath: string; modelCount: number; missingKey: boolean } {
  return {
    apiPath: apiFormatPath(provider.api),
    modelCount: provider.models.length,
    missingKey: provider.apiKey.trim().length === 0,
  }
}
