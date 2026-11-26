import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiModelProvidersSnapshot } from '../../../../omp/domain/index.js'
import { notifyReconnected } from '../../../../hooks/useGlobalEvents'
import { ProvidersSettings } from './ProvidersSettings'

const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn() }))
vi.mock('../../../../omp/transport/index.js', () => ({
  listModelProviders: mocks.list,
  saveModelProvider: mocks.save,
  deleteModelProvider: vi.fn(),
  lookupModelsDevModel: vi.fn(async () => ({ found: false })),
}))
vi.mock('../../../../omp/controllers/index.js', () => ({ loadPiModels: vi.fn(async () => []) }))
vi.mock('../../../../omp/modelSettingsSync', () => ({ refreshModelSettings: vi.fn() }))
vi.mock('../../../../omp/hooks/index.js', () => ({ usePiModels: () => ({ syncStatus: 'synced' }) }))
vi.mock('../../../../hooks', () => ({ useIsMobile: () => false }))
vi.mock('./ProviderModelPickerDialog', () => ({ ProviderModelPickerDialog: () => null }))

function configuration(contextWindow = 128_000): PiModelProvidersSnapshot {
  return {
    supported: true,
    exists: true,
    path: '/models.yml',
    providers: [{
      id: 'relay', name: 'Relay', api: 'openai-responses',
      baseUrl: 'https://original.example/v1', apiKey: 'original-key', authHeader: true,
      models: [{ id: 'demo-model', name: 'Original model', contextWindow, maxTokens: 32_000, reasoning: false, input: ['text'] }],
    }],
  }
}

async function incoming(snapshot: PiModelProvidersSnapshot) {
  mocks.list.mockResolvedValue(snapshot)
  await act(async () => { window.dispatchEvent(new CustomEvent('ompiui:models-updated')) })
}

describe('authoritative provider configuration', () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue(configuration())
    mocks.save.mockReset().mockImplementation(async provider => ({ ...configuration(), providers: [provider] }))
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('replaces B dirty model modal after A changes context, and B rename retains A context', async () => {
    render(<ProvidersSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Configure model' }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'B unsaved' } })
    await incoming(configuration(256_000))
    expect(screen.getByLabelText('Display name')).toHaveValue('Original model')
    expect(screen.getByLabelText(/Context window/)).toHaveValue(256_000)
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'B rename' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
    expect(mocks.save.mock.calls[0][0].models[0]).toMatchObject({ name: 'B rename', contextWindow: 256_000 })
  })

  it('replaces the entire dirty supplier including secrets and cancels its pending autosave', async () => {
    render(<ProvidersSettings />)
    const url = await screen.findByLabelText('Base URL')
    vi.useFakeTimers()
    fireEvent.change(url, { target: { value: 'https://b-unsaved.example/v1' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'b-unsaved-key' } })
    const remote = configuration(256_000)
    remote.providers[0] = { ...remote.providers[0], baseUrl: 'https://a.example/v1', apiKey: 'a-key', authHeader: false }
    await incoming(remote)
    expect(url).toHaveValue('https://a.example/v1')
    expect(screen.getByLabelText('API Key')).toHaveValue('a-key')
    await act(async () => { await vi.advanceTimersByTimeAsync(650) })
    expect(mocks.save).not.toHaveBeenCalled()
    fireEvent.change(url, { target: { value: 'https://b-new.example/v1' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(650) })
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ baseUrl: 'https://b-new.example/v1', apiKey: 'a-key', authHeader: false })
    expect(mocks.save.mock.calls[0][0].models[0].contextWindow).toBe(256_000)
  })

  it('ignores an older asynchronous provider read after a newer read is effective', async () => {
    render(<ProvidersSettings />)
    await screen.findByLabelText('Base URL')
    const old = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.list.mockReturnValueOnce(old.promise)
    act(() => { window.dispatchEvent(new CustomEvent('ompiui:models-updated')) })
    await incoming(configuration(256_000))
    await act(async () => { old.resolve(configuration(64_000)) })
    fireEvent.click(screen.getByRole('button', { name: 'Configure model' }))
    expect(screen.getByLabelText(/Context window/)).toHaveValue(256_000)
  })

  it('does not apply a stale save response over a newer successful supplier read', async () => {
    render(<ProvidersSettings />)
    const url = await screen.findByLabelText('Base URL')
    vi.useFakeTimers()
    const old = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.save.mockReturnValueOnce(old.promise)
    fireEvent.change(url, { target: { value: 'https://old-save.example/v1' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(650) })
    const remote = configuration(256_000)
    remote.providers[0] = { ...remote.providers[0], baseUrl: 'https://a.example/v1' }
    await incoming(remote)
    await act(async () => { old.resolve(configuration(64_000)) })
    expect(url).toHaveValue('https://a.example/v1')
    fireEvent.click(screen.getByRole('button', { name: 'Configure model' }))
    expect(screen.getByLabelText(/Context window/)).toHaveValue(256_000)
  })

  it('reports a provider reload failure even when the model catalog is synced, then recovers', async () => {
    render(<ProvidersSettings />)
    await screen.findByLabelText('Base URL')
    mocks.list.mockRejectedValueOnce(new Error('Provider read failed'))
    await act(async () => { notifyReconnected() })
    expect(screen.getByRole('status', { name: 'Could not sync provider configuration' })).toBeInTheDocument()
    expect(screen.getByText(/Provider read failed/)).toBeInTheDocument()

    await incoming(configuration())
    expect(screen.getByRole('status', { name: 'Connected / synced' })).toBeInTheDocument()
  })

  it('reloads and overwrites dirty supplier and modal on reconnect', async () => {
    render(<ProvidersSettings />)
    const url = await screen.findByLabelText('Base URL')
    vi.useFakeTimers()
    fireEvent.change(url, { target: { value: 'https://b-unsaved.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Configure model' }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'B unsaved model' } })
    const remote = configuration(256_000)
    remote.providers[0] = { ...remote.providers[0], baseUrl: 'https://a.example/v1' }
    mocks.list.mockResolvedValue(remote)
    await act(async () => { notifyReconnected() })
    expect(url).toHaveValue('https://a.example/v1')
    expect(screen.getByLabelText('Display name')).toHaveValue('Original model')
    expect(screen.getByLabelText(/Context window/)).toHaveValue(256_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(650) })
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
