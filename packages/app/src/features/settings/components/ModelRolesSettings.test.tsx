import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { ModelRolesSettings } from './ModelRolesSettings'
import type { AnyModel } from '../../../utils/modelUtils'

const { usePiModelsMock } = vi.hoisted(() => ({
  usePiModelsMock: vi.fn(),
}))

vi.mock('../../../omp/hooks/index.js', () => ({
  usePiModels: usePiModelsMock,
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

describe('ModelRolesSettings', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    usePiModelsMock.mockReturnValue({ models: MODELS, isLoading: false })
    getPiModelRolesMock.mockReset().mockResolvedValue({})
    setPiModelRolesMock.mockReset().mockImplementation(async (roles: Record<string, string>) => roles)
  })

  it('hides the roles section when the driver has no modelRoles command', async () => {
    getPiModelRolesMock.mockRejectedValue(new Error('unknown command'))
    render(<ModelRolesSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Agent model configuration')).not.toBeInTheDocument()
    })
  })

  it('keeps edits local until Save, then writes the role assignment', async () => {
    getPiModelRolesMock.mockResolvedValue({ smol: 'openai/gpt-4o-mini:low' })
    render(<ModelRolesSettings />)

    await waitFor(() => {
      expect(screen.getAllByTestId('model-selector-stub').length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getAllByTestId('model-selector-stub')[0]) // DEFAULT 角色行
    expect(setPiModelRolesMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(setPiModelRolesMock).toHaveBeenCalledWith({
        smol: 'openai/gpt-4o-mini:low',
        default: 'openai/gpt-4.1',
      })
    })
  })

  it('reverts draft edits when Cancel is clicked', async () => {
    getPiModelRolesMock.mockResolvedValue({ default: 'openai/gpt-4o-mini' })
    render(<ModelRolesSettings />)

    await waitFor(() => {
      expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4o-mini')
    })
    fireEvent.click(screen.getAllByTestId('model-selector-stub')[0])
    expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4.1')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4o-mini')
    })
    expect(setPiModelRolesMock).not.toHaveBeenCalled()
  })

  it('clears a role assignment from the row kebab menu after Save', async () => {
    getPiModelRolesMock.mockResolvedValue({ default: 'openai/gpt-4.1:xhigh' })
    render(<ModelRolesSettings />)

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Role options' }).length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Role options' })[0])

    const clearItem = await screen.findByText('Clear')
    fireEvent.click(clearItem)
    expect(setPiModelRolesMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(setPiModelRolesMock).toHaveBeenCalledWith({})
    })
  })

  it('keeps the thinking suffix when changing a role model without touching levels', async () => {
    getPiModelRolesMock.mockResolvedValue({ slow: 'openai/gpt-4o-mini:high' })
    render(<ModelRolesSettings />)

    await waitFor(() => {
      expect(screen.getAllByTestId('model-selector-stub').length).toBeGreaterThan(2)
    })
    // slow 是第三个 chat 角色（default, smol, slow）
    fireEvent.click(screen.getAllByTestId('model-selector-stub')[2])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(setPiModelRolesMock).toHaveBeenCalledWith({ slow: 'openai/gpt-4.1:high' })
    })
  })
})
