import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelQuickConfig } from './ModelQuickConfig'
import type { AnyModel } from '../../../utils/modelUtils'

const {
  usePiModelsMock,
  useFocusedSessionIdMock,
  setPiModelMock,
  setPiThinkingLevelMock,
  refreshPiSessionStateMock,
  prefStore,
} = vi.hoisted(() => ({
  usePiModelsMock: vi.fn(),
  useFocusedSessionIdMock: vi.fn(),
  setPiModelMock: vi.fn(),
  setPiThinkingLevelMock: vi.fn(),
  refreshPiSessionStateMock: vi.fn(),
  prefStore: {
    preferred: null as string | null,
    variants: {} as Record<string, string | undefined>,
  },
}))

vi.mock('../../../omp/hooks/index.js', () => ({
  usePiModels: usePiModelsMock,
  useFocusedSessionId: useFocusedSessionIdMock,
}))

vi.mock('../../../omp/controllers/index.js', () => ({
  setPiModel: setPiModelMock,
  setPiThinkingLevel: setPiThinkingLevelMock,
  refreshPiSessionState: refreshPiSessionStateMock,
}))

const { getPiModelRolesMock, setPiModelRolesMock } = vi.hoisted(() => ({
  getPiModelRolesMock: vi.fn(),
  setPiModelRolesMock: vi.fn(),
}))

vi.mock('../../../omp/transport/index.js', () => ({
  getPiModelRoles: getPiModelRolesMock,
  setPiModelRoles: setPiModelRolesMock,
}))

vi.mock('../../chat/ModelSelector', () => ({
  ModelSelector: (props: {
    selectedModelKey: string | null
    models: Array<{ provider: string; id: string }>
    onSelect: (key: string, model: unknown) => void
  }) => (
    <button
      type="button"
      data-testid="model-selector-stub"
      onClick={() => {
        const model = props.models[0]
        props.onSelect(`${model.provider}:${model.id}`, model)
      }}
    >
      {props.selectedModelKey ?? 'none'}
    </button>
  ),
}))

vi.mock('../../../utils/modelUtils', () => ({
  getModelKey: (model: { provider: string; id: string }) => `${model.provider}:${model.id}`,
  recordModelUsage: vi.fn(),
  getPreferredModelKey: () => prefStore.preferred,
  setPreferredModelKey: (key: string) => {
    prefStore.preferred = key
  },
  getModelVariantPref: (key: string) => prefStore.variants[key],
  saveModelVariantPref: (key: string, variant: string | undefined) => {
    if (variant) prefStore.variants[key] = variant
    else delete prefStore.variants[key]
  },
}))

function makeModel(id: string, reasoning = true): AnyModel {
  return {
    id,
    name: id,
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  } as AnyModel
}

const MODELS = [makeModel('gpt-4.1'), makeModel('gpt-4o-mini', false)]

describe('ModelQuickConfig', () => {
  beforeEach(() => {
    prefStore.preferred = null
    prefStore.variants = {}
    usePiModelsMock.mockReturnValue({ models: MODELS, isLoading: false })
    useFocusedSessionIdMock.mockReturnValue(null)
    setPiModelMock.mockReset().mockResolvedValue(undefined)
    setPiThinkingLevelMock.mockReset().mockResolvedValue(undefined)
    refreshPiSessionStateMock.mockReset().mockResolvedValue(undefined)
    getPiModelRolesMock.mockReset().mockResolvedValue({})
    setPiModelRolesMock.mockReset().mockImplementation(async (roles: Record<string, string>) => roles)
  })

  it('persists the picked model as the preferred default', () => {
    render(<ModelQuickConfig />)

    expect(screen.getByTestId('model-selector-stub')).toHaveTextContent('none')

    fireEvent.click(screen.getByTestId('model-selector-stub'))

    expect(prefStore.preferred).toBe('openai:gpt-4.1')
    expect(screen.getByTestId('model-selector-stub')).toHaveTextContent('openai:gpt-4.1')
  })

  it('saves the thinking level on the preferred model', () => {
    prefStore.preferred = 'openai:gpt-4.1'
    render(<ModelQuickConfig />)

    const thinkingSelect = screen.getByRole('button', { name: 'Thinking level' })
    fireEvent.click(thinkingSelect)
    fireEvent.click(screen.getByRole('option', { name: 'xhigh' }))

    expect(prefStore.variants['openai:gpt-4.1']).toBe('xhigh')
  })

  it('disables the thinking select until a default model is picked', () => {
    render(<ModelQuickConfig />)

    expect(screen.getByRole('button', { name: 'Thinking level' })).toBeDisabled()
  })

  it('offers non-reasoning models only the off level', () => {
    prefStore.preferred = 'openai:gpt-4o-mini'
    render(<ModelQuickConfig />)

    fireEvent.click(screen.getByRole('button', { name: 'Thinking level' }))

    expect(screen.getByRole('option', { name: 'off' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'high' })).not.toBeInTheDocument()
  })

  it('applies the default model and thinking level to the focused session', async () => {
    prefStore.preferred = 'openai:gpt-4.1'
    prefStore.variants['openai:gpt-4.1'] = 'xhigh'
    useFocusedSessionIdMock.mockReturnValue('session-1')
    render(<ModelQuickConfig />)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      expect(setPiModelMock).toHaveBeenCalledWith('session-1', 'openai', 'gpt-4.1')
      expect(setPiThinkingLevelMock).toHaveBeenCalledWith('session-1', 'xhigh')
      expect(refreshPiSessionStateMock).toHaveBeenCalledWith('session-1')
    })
  })

  it('skips the thinking command when no level preference exists', async () => {
    prefStore.preferred = 'openai:gpt-4.1'
    useFocusedSessionIdMock.mockReturnValue('session-1')
    render(<ModelQuickConfig />)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => {
      expect(setPiModelMock).toHaveBeenCalledWith('session-1', 'openai', 'gpt-4.1')
    })
    expect(setPiThinkingLevelMock).not.toHaveBeenCalled()
  })

  it('hides the roles section when the driver has no modelRoles command', async () => {
    getPiModelRolesMock.mockRejectedValue(new Error('unknown command'))
    render(<ModelQuickConfig />)

    await waitFor(() => {
      expect(screen.queryByText('Model roles')).not.toBeInTheDocument()
    })
  })

  it('writes a role assignment with thinking suffix when a role model is picked', async () => {
    getPiModelRolesMock.mockResolvedValue({ smol: 'openai/gpt-4o-mini:low' })
    render(<ModelQuickConfig />)

    // 角色区的选择器：第一个 stub 是默认模型，第二个是 DEFAULT 角色（列表第一行）
    await waitFor(() => {
      expect(screen.getAllByTestId('model-selector-stub').length).toBeGreaterThan(1)
    })
    const rolePickers = screen.getAllByTestId('model-selector-stub').slice(1)
    fireEvent.click(rolePickers[0]) // DEFAULT 角色行

    await waitFor(() => {
      expect(setPiModelRolesMock).toHaveBeenCalledWith({
        smol: 'openai/gpt-4o-mini:low',
        default: 'openai/gpt-4.1',
      })
    })
  })

  it('clears a role assignment', async () => {
    getPiModelRolesMock.mockResolvedValue({ default: 'openai/gpt-4.1:xhigh' })
    render(<ModelQuickConfig />)

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Clear' }).length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0])

    await waitFor(() => {
      expect(setPiModelRolesMock).toHaveBeenCalledWith({})
    })
  })

  it('keeps the thinking suffix when changing a role model without touching levels', async () => {
    getPiModelRolesMock.mockResolvedValue({ slow: 'openai/gpt-4o-mini:high' })
    render(<ModelQuickConfig />)

    await waitFor(() => {
      expect(screen.getAllByTestId('model-selector-stub').length).toBeGreaterThan(1)
    })
    // slow 是第三个 chat 角色（default, smol, slow）
    fireEvent.click(screen.getAllByTestId('model-selector-stub')[3])

    await waitFor(() => {
      expect(setPiModelRolesMock).toHaveBeenCalledWith({ slow: 'openai/gpt-4.1:high' })
    })
  })
})
