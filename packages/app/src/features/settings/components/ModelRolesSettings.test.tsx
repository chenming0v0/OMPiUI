import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { ModelRolesSettings } from './ModelRolesSettings'
import type { AnyModel } from '../../../utils/modelUtils'
import { readModelRolesCache, writeModelRolesCache } from '../../../omp/modelSettingsCache'
import { serverStore } from '../../../store/serverStore'
import { piModelRolesStore } from '../../../omp/state/piModelRolesStore'
import { loadPiModelRoles } from '../../../omp/controllers/modelRoles'

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
    placeholder?: string
    models: Array<{ provider: string; id: string }>
    onSelect: (key: string, model: unknown) => void
  }) => (
    <button
      type="button"
      data-testid="model-selector-stub"
      data-placeholder={props.placeholder}
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
    supportedThinkingLevels: reasoning ? ['off', 'low', 'high'] : ['off'],
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
  } as AnyModel
}

const MODELS = [makeModel('gpt-4.1'), makeModel('gpt-4o-mini', false)]

function seedRoles(roles: Record<string, string>) {
  writeModelRolesCache(roles)
  piModelRolesStore.restoreCache()
}

describe('ModelRolesSettings', () => {
  beforeEach(async () => {
    localStorage.clear()
    piModelRolesStore.restoreCache()
    await i18n.changeLanguage('en')
    usePiModelsMock.mockReturnValue({ models: MODELS, isLoading: false, syncStatus: 'synced' })
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
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
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

  it('hides the save bar when collapsed and retains the draft after expanding', async () => {
    getPiModelRolesMock.mockResolvedValue({ default: 'openai/gpt-4o-mini:low' })
    render(<ModelRolesSettings />)
    await waitFor(() => expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4o-mini'))

    fireEvent.click(screen.getAllByTestId('model-selector-stub')[0])
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    const section = screen.getByRole('button', { name: /^Agent model configuration/ })
    fireEvent.click(section)
    expect(section).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()

    fireEvent.click(section)
    expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4.1')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(setPiModelRolesMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setPiModelRolesMock).toHaveBeenCalledWith({ default: 'openai/gpt-4.1:low' }))
  })

  it('updates inheritance hints with the draft without saving inherited assignments', async () => {
    render(<ModelRolesSettings />)
    await waitFor(() => expect(screen.getAllByTestId('model-selector-stub')).toHaveLength(15))
    const selectors = screen.getAllByTestId('model-selector-stub')
    expect(selectors[1]).toHaveAttribute('data-placeholder', 'Use fast model priority list')
    expect(selectors[2]).toHaveAttribute('data-placeholder', 'Use thinking model priority list')
    expect(selectors[6]).toHaveAttribute('data-placeholder', 'Inherit Fast')
    expect(selectors[7]).toHaveAttribute('data-placeholder', 'Inherit Tiny')

    fireEvent.click(selectors[0])
    expect(selectors[1]).toHaveAttribute('data-placeholder', 'Inherit Default')
    expect(selectors[2]).toHaveAttribute('data-placeholder', 'Inherit Default')
    expect(selectors[9]).toHaveAttribute('data-placeholder', 'Use thinking model priority list')
    expect(setPiModelRolesMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setPiModelRolesMock).toHaveBeenCalledWith({ default: 'openai/gpt-4.1' }))
  })

  it('opens role help on click and dismisses it on focus loss without changing assignments', async () => {
    render(<ModelRolesSettings />)
    const help = await screen.findByRole('button', { name: 'Default role help' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.click(help)
    expect(help).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Main model for regular chat')

    fireEvent.blur(help)
    expect(help).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.click(help)
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    fireEvent.blur(window)
    expect(help).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.click(help)
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(help).toHaveFocus()

    fireEvent.click(help)
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(help).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(setPiModelRolesMock).not.toHaveBeenCalled()
  })

  it('only inherits an explicitly assigned Thinking role for Advisor and restores it on cancel', async () => {
    getPiModelRolesMock.mockResolvedValue({ default: 'openai/gpt-4.1', slow: 'openai/gpt-4o-mini:low' })
    render(<ModelRolesSettings />)
    await waitFor(() => expect(screen.getAllByTestId('model-selector-stub')).toHaveLength(15))
    const advisor = screen.getAllByTestId('model-selector-stub')[9]
    expect(advisor).toHaveAttribute('data-placeholder', 'Inherit Thinking')

    const thinking = screen.getByRole('group', { name: 'Thinking' })
    fireEvent.click(within(thinking).getByRole('button', { name: 'Role options' }))
    fireEvent.click(await screen.findByText('Clear'))
    expect(advisor).toHaveAttribute('data-placeholder', 'Use thinking model priority list')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(advisor).toHaveAttribute('data-placeholder', 'Inherit Thinking')
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
  it('selects catalog efforts, saves explicitly and reads the saved effort when reopened', async () => {
    const model = { ...MODELS[0], supportedThinkingLevels: ['off', 'low', 'max'], thinkingLevelMap: { high: 'high' } }
    usePiModelsMock.mockReturnValue({ models: [model], isLoading: false, syncStatus: 'synced' })
    let persisted = { default: 'openai/gpt-4.1:low' }
    getPiModelRolesMock.mockImplementation(async () => ({ ...persisted }))
    setPiModelRolesMock.mockImplementation(async roles => {
      persisted = { ...roles }
      return { ...persisted }
    })
    const first = render(<ModelRolesSettings />)
    const effort = await screen.findByRole('button', { name: 'Default variant' })
    await waitFor(() => expect(effort).toHaveTextContent('low'))
    fireEvent.click(effort)
    const menu = screen.getByRole('listbox', { name: 'Default variant' })
    expect(within(menu).getByRole('option', { name: 'low' })).toBeInTheDocument()
    expect(within(menu).queryByRole('option', { name: 'high' })).not.toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('option', { name: 'max' }))
    expect(effort).toHaveTextContent('max')
    expect(setPiModelRolesMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument())
    expect(persisted).toEqual({ default: 'openai/gpt-4.1:max' })
    first.unmount()
    render(<ModelRolesSettings />)
    await waitFor(() => expect(getPiModelRolesMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('status')).toHaveAccessibleName('Connected / synced'))
    expect(screen.getByRole('button', { name: 'Default variant' })).toHaveTextContent('max')
    expect(readModelRolesCache()).toEqual(persisted)
  })

  it.each(['high', 'max'])('retains stored unsupported %s until the user explicitly changes effort', async level => {
    const model = { ...MODELS[0], supportedThinkingLevels: ['off', 'low'] }
    usePiModelsMock.mockReturnValue({ models: [model], isLoading: false, syncStatus: 'synced' })
    getPiModelRolesMock.mockResolvedValue({ default: `openai/gpt-4.1:${level}` })
    render(<ModelRolesSettings />)
    const effort = await screen.findByRole('button', { name: 'Default variant' })
    await waitFor(() => expect(effort).toHaveTextContent(level))
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    fireEvent.click(effort)
    const menu = screen.getByRole('listbox', { name: 'Default variant' })
    expect(within(menu).queryByRole('option', { name: level })).not.toBeInTheDocument()
    expect(setPiModelRolesMock).not.toHaveBeenCalled()
    expect(readModelRolesCache()).toEqual({ default: `openai/gpt-4.1:${level}` })
    fireEvent.click(within(menu).getByRole('option', { name: 'low' }))
    expect(effort).toHaveTextContent('low')
    expect(setPiModelRolesMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setPiModelRolesMock).toHaveBeenCalledWith({ default: 'openai/gpt-4.1:low' }))
  })

  it('renders cached roles immediately, then refreshes them and turns green', async () => {
    seedRoles({ default: 'openai/gpt-4o-mini' })
    let resolve!: (roles: Record<string, string>) => void
    getPiModelRolesMock.mockReturnValue(new Promise(done => { resolve = done }))
    render(<ModelRolesSettings />)
    expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4o-mini')
    expect(screen.getByRole('status')).toHaveClass('text-text-400')
    resolve({ default: 'openai/gpt-4.1' })
    await waitFor(() => expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4.1'))
    expect(screen.getByRole('status')).toHaveClass('text-success-100')
    expect(readModelRolesCache()).toEqual({ default: 'openai/gpt-4.1' })
  })

  it('keeps unsaved edits when a delayed refresh updates untouched roles', async () => {
    seedRoles({ default: 'openai/gpt-4o-mini' })
    let resolve!: (roles: Record<string, string>) => void
    getPiModelRolesMock.mockReturnValue(new Promise(done => { resolve = done }))
    render(<ModelRolesSettings />)
    fireEvent.click(screen.getAllByTestId('model-selector-stub')[0])
    resolve({ default: 'openai/gpt-4o-mini', smol: 'openai/gpt-4o-mini:low' })
    await waitFor(() => expect(screen.getAllByTestId('model-selector-stub')[1]).toHaveTextContent('openai:gpt-4o-mini'))
    expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4.1')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(readModelRolesCache()).toEqual({
      default: 'openai/gpt-4.1', smol: 'openai/gpt-4o-mini:low',
    }))
  })

  it('does not let an old read overwrite a successful save', async () => {
    seedRoles({ default: 'openai/gpt-4o-mini' })
    let resolve!: (roles: Record<string, string>) => void
    getPiModelRolesMock.mockReturnValue(new Promise(done => { resolve = done }))
    render(<ModelRolesSettings />)
    fireEvent.click(screen.getAllByTestId('model-selector-stub')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(readModelRolesCache()).toEqual({ default: 'openai/gpt-4.1' }))
    resolve({ default: 'openai/gpt-4o-mini' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument())
    expect(readModelRolesCache()).toEqual({ default: 'openai/gpt-4.1' })
  })

  it('retains cached roles and a red status when the request fails', async () => {
    seedRoles({ default: 'openai/gpt-4o-mini' })
    getPiModelRolesMock.mockRejectedValue(new Error('network unavailable'))
    render(<ModelRolesSettings />)
    expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4o-mini')
    await screen.findByRole('alert')
    expect(screen.getByRole('status')).toHaveClass('text-danger-100')
  })

  it('recovers roles after a failed first request when the shared connection refreshes', async () => {
    getPiModelRolesMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ default: 'openai/gpt-4.1' })
    render(<ModelRolesSettings />)
    await waitFor(() => expect(getPiModelRolesMock).toHaveBeenCalledTimes(1))
    await act(async () => { await loadPiModelRoles(true) })
    await waitFor(() => expect(screen.getByRole('status')).toHaveClass('text-success-100'))
    expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4.1')
  })


  it('does not reset a pending request when closed and reopened', async () => {
    seedRoles({ default: 'openai/gpt-4o-mini' })
    let resolve!: (roles: Record<string, string>) => void
    getPiModelRolesMock.mockReturnValue(new Promise(done => { resolve = done }))
    const first = render(<ModelRolesSettings />)
    first.unmount()
    render(<ModelRolesSettings />)
    expect(getPiModelRolesMock).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ default: 'openai/gpt-4.1' }) })
    await waitFor(() => expect(screen.getByRole('status')).toHaveAccessibleName('Connected / synced'))
  })

  it('tracks connection loss while closed and reopens red without discarding cached data', async () => {
    getPiModelRolesMock.mockResolvedValue({ default: 'openai/gpt-4.1' })
    const first = render(<ModelRolesSettings />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveAccessibleName('Connected / synced'))
    first.unmount()
    piModelRolesStore.markDisconnected()
    getPiModelRolesMock.mockImplementation(() => new Promise(() => {}))
    render(<ModelRolesSettings />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Disconnected')
    expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4.1')
  })

  it('reads an externally changed role when reopening a previously synced page', async () => {
    getPiModelRolesMock.mockResolvedValueOnce({ default: 'openai/gpt-4o-mini' })
    const first = render(<ModelRolesSettings />)
    await waitFor(() => expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4o-mini'))
    first.unmount()
    getPiModelRolesMock.mockResolvedValue({ default: 'openai/gpt-4.1' })
    render(<ModelRolesSettings />)
    await waitFor(() => expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4.1'))
  })

  it('does not persist an old-server save into the newly selected server cache', async () => {
    seedRoles({ default: 'openai/gpt-4o-mini' })
    let resolve!: (roles: Record<string, string>) => void
    setPiModelRolesMock.mockReturnValue(new Promise(done => { resolve = done }))
    const remote = serverStore.addServer({ name: 'Cache test', url: 'http://cache-test.invalid' })
    const originalId = serverStore.getActiveServerId()
    const { unmount } = render(<ModelRolesSettings />)
    fireEvent.click(screen.getAllByTestId('model-selector-stub')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    try {
      serverStore.setActiveServer(remote.id)
      resolve({ default: 'openai/gpt-4.1' })
      await waitFor(() => expect(readModelRolesCache()).toBeNull())
    } finally {
      unmount()
      serverStore.setActiveServer(originalId)
      serverStore.removeServer(remote.id)
    }
  })
})
