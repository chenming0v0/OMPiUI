import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiManagementSettings } from './PiManagementSettings'

const { patchSettingsMock, scope } = vi.hoisted(() => ({ patchSettingsMock: vi.fn(), scope: { directory: '/workspace', generation: 1 } }))

const settings = {
  global: { modelRoles: { default: 'provider/global' }, compaction: { enabled: false } },
  project: { compaction: { enabled: true } },
  errors: [],
  effective: { compaction: { enabled: true } },
  definitions: [{ id: 'defaultThinkingLevel', type: 'enum', values: ['low', 'high', 'auto'] }],
}

vi.mock('../../../hooks', () => ({ useCurrentDirectory: () => scope.directory, useServerStore: () => ({ activeServerGeneration: scope.generation }) }))
vi.mock('../../../omp/hooks/index.js', () => ({ useFocusedSessionId: () => 'session' }))
vi.mock('../../../omp/transport/index.js', () => ({
  getPiSettings: vi.fn(async () => settings),
  patchPiSettings: (...args: unknown[]) => patchSettingsMock(...args),
  getPiModelRoles: vi.fn(async () => ({ default: 'provider/global' })),
}))
vi.mock('../../../omp/workspaces', () => ({
  listHostWorkspaces: vi.fn(async () => []),
  resolveWorkspacePath: vi.fn(async () => '/workspace'),
}))
vi.mock('./PiPackageManagement', () => ({ PiPackageManagement: () => null }))
vi.mock('./PiResourceManagement', () => ({ PiResourceManagement: () => null }))
vi.mock('./PiSessionManagement', () => ({ PiSessionManagement: () => null }))

describe('PiManagementSettings', () => {
  beforeEach(() => {
    patchSettingsMock.mockReset().mockResolvedValue(settings)
    scope.directory = '/workspace'
    scope.generation = 1
  })

  it('edits global preferences rather than pinning the effective project override', async () => {
    patchSettingsMock.mockResolvedValue({ ...settings, global: { modelRoles: settings.global.modelRoles } })
    render(<PiManagementSettings />)
    const compaction = await screen.findByRole('button', { name: 'Auto-compact context' })
    expect(compaction).toHaveTextContent('Off')
    fireEvent.click(compaction)
    fireEvent.click(screen.getByRole('option', { name: 'Inherit project/default' }))
    expect(compaction).toHaveTextContent('Inherit project/default')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Auto-compact context' })).toHaveTextContent('Inherit project/default')
  })

  it('keeps an unsaved draft visible and reports failure instead of success', async () => {
    patchSettingsMock.mockRejectedValue(new Error('Settings write conflict'))
    render(<PiManagementSettings />)
    const model = await screen.findByRole('textbox', { name: 'Default model selector (modelRoles.default)' })
    fireEvent.change(model, { target: { value: 'provider/unsaved' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings write conflict')
    expect(model).toHaveValue('provider/unsaved')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('retains a rejected advanced patch for correction and clears prior success feedback', async () => {
    render(<PiManagementSettings />)
    await screen.findByRole('textbox', { name: 'Default model selector (modelRoles.default)' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('status')
    fireEvent.click(screen.getByRole('button', { name: 'Advanced options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Raw settings and JSON patch' }))
    const patch = screen.getByRole('textbox', { name: 'Global patch: official nested/dotted keys; null resets an override' })
    const invalid = '{"retry.enabled":"false"}'
    fireEvent.change(patch, { target: { value: invalid } })
    patchSettingsMock.mockRejectedValueOnce(new Error('Invalid value for retry.enabled'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply patch' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid value for retry.enabled')
    expect(patch).toHaveValue(invalid)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('discards pending save feedback when switching servers', async () => {
    const pending = Promise.withResolvers<typeof settings>()
    patchSettingsMock.mockReturnValue(pending.promise)
    const view = render(<PiManagementSettings />)
    const model = await screen.findByRole('textbox', { name: 'Default model selector (modelRoles.default)' })
    fireEvent.change(model, { target: { value: 'provider/old-server-draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    scope.generation = 2
    view.rerender(<PiManagementSettings />)
    const newModel = await screen.findByRole('textbox', { name: 'Default model selector (modelRoles.default)' })
    expect(newModel).toHaveValue('provider/global')
    await act(async () => {
      pending.resolve({ ...settings, global: { ...settings.global, modelRoles: { default: 'provider/old-server-saved' } } })
      await pending.promise
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(newModel).toHaveValue('provider/global')
  })
})
