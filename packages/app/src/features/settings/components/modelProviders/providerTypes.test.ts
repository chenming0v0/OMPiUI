import { describe, expect, it } from 'vitest'
import {
  blankModelDraft,
  groupModelIds,
  inferThinkingModeForApi,
  inferModelDefaults,
  modelDraftDefaultsFromModelsDev,
  providerDraftFromConfig,
  providerDraftToConfig,
  validateModelDraft,
  type ProviderDraft,
} from './providerTypes'

describe('providerTypes', () => {
  it('groups upstream model ids by family and vendor prefix', () => {
    const groups = groupModelIds([
      'claude-opus-4-6',
      'gpt-6-astra',
      'gemini-3.0-pro',
      'grok-4',
      'deepseek-v4.1-flash',
      'glm-5.3-flash',
      'qwen3-max',
      'kimi-k2.5',
      'mistral-large-3',
      'llama-4-scout',
      'command-r-plus',
      'minimax-m2.1',
      'z-ai/glm-5.3',
      'community/model-01',
      'openrouter/auto',
      'mystery-model',
    ])
    expect(groups.map(group => group.name)).toEqual([
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
      'community',
      'openrouter',
      '其他',
    ])
    expect(groups.find(group => group.name === '智谱')!.models).toEqual(['glm-5.3-flash', 'z-ai/glm-5.3'])
    expect(groups.find(group => group.name === '其他')!.models).toEqual(['mystery-model'])
    expect(groups[0]!.models).toEqual(['claude-opus-4-6'])
  })

  it('infers sensible defaults from the model id', () => {
    expect(inferModelDefaults('claude-opus-4-6')).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: true,
    })
    expect(inferModelDefaults('totally-unknown').contextWindow).toBe(128_000)
  })

  it('maps models.dev capabilities into an editable model draft', () => {
    expect(
      modelDraftDefaultsFromModelsDev({
        found: true,
        name: 'GPT Test',
        contextWindow: 400_000,
        maxTokens: 128_000,
        reasoning: true,
        input: ['text', 'image'],
        thinking: { mode: 'effort', efforts: ['low', 'high'], defaultLevel: 'high' },
      }),
    ).toMatchObject({
      name: 'GPT Test',
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ['text', 'image'],
      thinkingMode: 'effort',
      efforts: ['low', 'high'],
      defaultLevel: 'high',
      thinkingConfigured: true,
    })
  })

  it('uses exact preset efforts and keeps reasoning-only models level-free', () => {
    expect(
      modelDraftDefaultsFromModelsDev({
        found: true,
        reasoning: true,
        thinking: { mode: 'anthropic-adaptive', efforts: ['low', 'medium', 'high', 'max'], defaultLevel: 'high' },
      }),
    ).toMatchObject({
      reasoning: true,
      thinkingConfigured: true,
      thinkingMode: 'anthropic-adaptive',
      efforts: ['low', 'medium', 'high', 'max'],
      defaultLevel: 'high',
    })

    expect(
      modelDraftDefaultsFromModelsDev({ found: true, reasoning: true, thinking: null }, 'google-generative-ai'),
    ).toMatchObject({
      reasoning: true,
      thinkingConfigured: false,
      thinkingMode: 'google-level',
      efforts: [],
      defaultLevel: '',
    })
  })

  it('infers provider-native OMP thinking modes', () => {
    expect(inferThinkingModeForApi('anthropic-messages')).toBe('anthropic-adaptive')
    expect(inferThinkingModeForApi('google-generative-ai')).toBe('google-level')
    expect(inferThinkingModeForApi('openai-responses')).toBe('effort')
  })

  it('does not serialize invented effort levels for a reasoning-only model', () => {
    const draft: ProviderDraft = {
      id: 'demo',
      name: 'Demo',
      api: 'openai-completions',
      baseUrl: 'https://relay.test/v1',
      apiKey: '',
      models: [
        {
          ...blankModelDraft('glm-reasoner'),
          reasoning: true,
          thinkingConfigured: false,
        },
      ],
    }
    expect(providerDraftToConfig(draft).models[0]).toMatchObject({
      reasoning: true,
    })
    expect(providerDraftToConfig(draft).models[0]!.thinking).toBeNull()
  })

  it('sends an empty parameter map explicitly to clear an existing mapping', () => {
    const draft = providerDraftFromConfig({
      id: 'demo',
      name: 'Demo',
      api: 'openai-responses',
      baseUrl: 'https://relay.test/v1',
      apiKey: '',
      models: [{
        id: 'gpt-test',
        reasoning: true,
        thinking: { mode: 'effort', efforts: ['high'], effortMap: { high: 'old-value' } },
      }],
    })
    draft.models[0]!.effortMap = {}
    expect(providerDraftToConfig(draft).models[0]!.thinking?.effortMap).toEqual({})
  })

  it('round-trips a draft and omits thinking when reasoning is disabled', () => {
    const draft: ProviderDraft = {
      id: 'demo',
      name: 'Demo',
      api: 'anthropic-messages',
      baseUrl: 'https://relay.test/v1',
      apiKey: 'sk-x',
      authHeader: true,
      models: [
        {
          ...blankModelDraft('claude-x'),
          originalId: 'claude-x',
          name: 'Claude X',
          contextWindow: 200_000,
          maxTokens: 32_000,
          reasoning: false,
          effortMap: { high: 'high' },
        },
      ],
    }
    const config = providerDraftToConfig(draft)
    expect(config.models[0]).toMatchObject({
      id: 'claude-x',
      name: 'Claude X',
      contextWindow: 200_000,
      maxTokens: 32_000,
      reasoning: false,
    })
    expect(config.models[0]!.thinking).toBeUndefined()

    const restored = providerDraftFromConfig(config)
    expect(restored.models[0]!.input).toEqual(['text', 'image'])
    expect(restored.models[0]!.thinkingMode).toBe('effort')
  })

  it('keeps originalId so a renamed model keeps its unexposed models.yml fields', () => {
    const draft: ProviderDraft = {
      id: 'demo',
      name: 'Demo',
      api: 'openai-completions',
      baseUrl: 'https://relay.test/v1',
      apiKey: '',
      models: [{ ...blankModelDraft('demo-large-v2'), originalId: 'demo-large' }],
    }
    const config = providerDraftToConfig(draft)
    expect(config.models[0]).toMatchObject({ id: 'demo-large-v2', originalId: 'demo-large' })
    expect(providerDraftFromConfig(config).models[0]!.originalId).toBe('demo-large-v2')
  })

  it('validates duplicate ids and invalid numbers', () => {
    const sibling = { ...blankModelDraft('dup'), originalId: 'dup' }
    expect(validateModelDraft(blankModelDraft(''), [])).toBe('idRequired')
    expect(validateModelDraft(blankModelDraft('dup'), [sibling])).toBe('duplicateId')
    expect(validateModelDraft({ ...blankModelDraft('new'), contextWindow: 0 }, [sibling])).toBe('invalidNumbers')
    expect(validateModelDraft(blankModelDraft('new'), [sibling])).toBeNull()
  })
})
