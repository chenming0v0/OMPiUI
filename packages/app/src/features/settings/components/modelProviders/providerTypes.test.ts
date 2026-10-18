import { describe, expect, it } from 'vitest'
import {
  blankModelDraft,
  groupModelIds,
  inferModelDefaults,
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

  it('validates duplicate ids and invalid numbers', () => {
    const sibling = { ...blankModelDraft('dup'), originalId: 'dup' }
    expect(validateModelDraft(blankModelDraft(''), [])).toBe('idRequired')
    expect(validateModelDraft(blankModelDraft('dup'), [sibling])).toBe('duplicateId')
    expect(validateModelDraft({ ...blankModelDraft('new'), contextWindow: 0 }, [sibling])).toBe('invalidNumbers')
    expect(validateModelDraft(blankModelDraft('new'), [sibling])).toBeNull()
  })
})
