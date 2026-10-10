import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('places thinking next to the model and uses a variant placeholder when unset', async () => {
    getPiModelRolesMock.mockResolvedValue({ default: 'openai/gpt-4.1' })
    render(<ModelRolesSettings />)

    await waitFor(() => {
      expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4.1')
    })

    const row = screen.getAllByTestId('model-selector-stub')[0].closest('.model-role-row')
    expect(row).not.toBeNull()
    expect(row?.querySelector('.model-role-secondary')).toBeNull()
    expect(row?.querySelector('.role-variant-select')).toHaveTextContent('variant')
    expect(screen.queryByText('Thinking level')).not.toBeInTheDocument()
  })

  it('opens a click help popover with the role description', async () => {
    getPiModelRolesMock.mockResolvedValue({ default: 'openai/gpt-4.1' })
    render(<ModelRolesSettings />)

    const help = await screen.findByRole('button', {
      name: 'Main model for regular chat; also the fallback when other roles are unassigned.',
    })
    expect(screen.queryByText('Main model for regular chat; also the fallback when other roles are unassigned.')).not.toBeInTheDocument()
    fireEvent.click(help)
    expect(await screen.findByText('Main model for regular chat; also the fallback when other roles are unassigned.')).toBeInTheDocument()
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
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

  it('retains green status when reopened without issuing another request', async () => {
    getPiModelRolesMock.mockResolvedValue({ default: 'openai/gpt-4.1' })
    const first = render(<ModelRolesSettings />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveAccessibleName('Connected / synced'))
    first.unmount()
    getPiModelRolesMock.mockImplementation(() => new Promise(() => {}))
    render(<ModelRolesSettings />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Connected / synced')
    expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4.1')
    expect(getPiModelRolesMock).toHaveBeenCalledTimes(1)
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

  it('shows background updates immediately on reopening', async () => {
    getPiModelRolesMock.mockResolvedValueOnce({ default: 'openai/gpt-4o-mini' })
      .mockResolvedValueOnce({ default: 'openai/gpt-4.1' })
    const first = render(<ModelRolesSettings />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveAccessibleName('Connected / synced'))
    first.unmount()
    await loadPiModelRoles(true)
    render(<ModelRolesSettings />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Connected / synced')
    expect(screen.getAllByTestId('model-selector-stub')[0]).toHaveTextContent('openai:gpt-4.1')
    expect(getPiModelRolesMock).toHaveBeenCalledTimes(2)
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
