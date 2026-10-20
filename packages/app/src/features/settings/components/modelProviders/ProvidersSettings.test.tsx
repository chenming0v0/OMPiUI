import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProvidersSettings } from './ProvidersSettings'

const mocks = vi.hoisted(() => ({
  loadModels: vi.fn().mockResolvedValue([]),
  listProviders: vi.fn(),
  generation: 0,
}))

vi.mock('../../../../omp/controllers/index.js', () => ({ loadPiModels: mocks.loadModels }))
vi.mock('../../../../omp/transport/index.js', () => ({
  listModelProviders: mocks.listProviders,
  saveModelProvider: vi.fn(),
  deleteModelProvider: vi.fn(),
}))
vi.mock('../../../../omp/hooks/index.js', () => ({
  usePiModels: () => ({ syncStatus: 'disconnected' }),
}))
vi.mock('../../../../hooks/useServerStore', () => ({
  useServerStore: () => ({ activeServerGeneration: mocks.generation }),
}))
vi.mock('../../../../hooks', () => ({ useIsMobile: () => false }))
vi.mock('./ProviderModelEditorDialog', () => ({ ProviderModelEditorDialog: () => null }))
vi.mock('./ProviderModelPickerDialog', () => ({ ProviderModelPickerDialog: () => null }))

describe('provider settings model sync recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generation = 0
    mocks.loadModels.mockResolvedValue([])
    mocks.listProviders.mockResolvedValue({ supported: true, path: '/models.yml', providers: [] })
  })

  it('loads live models when opened and retries them with the refresh button', async () => {
    render(<ProvidersSettings />)
    await screen.findByRole('button', { name: 'Reload' })
    expect(mocks.loadModels).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalledTimes(2))
    expect(mocks.listProviders).toHaveBeenCalledTimes(2)
  })

  it('can retry a failed sync and reloads models when switching servers', async () => {
    mocks.loadModels.mockRejectedValueOnce(new Error('omp RPC process has exited'))
    const { rerender } = render(<ProvidersSettings />)
    await screen.findByRole('button', { name: 'Reload' })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalledTimes(2))
    mocks.generation += 1
    rerender(<ProvidersSettings />)
    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalledTimes(3))
    expect(mocks.listProviders).toHaveBeenCalledTimes(3)
  })
})
