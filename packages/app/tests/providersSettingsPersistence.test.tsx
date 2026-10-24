import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PiModelProviderConfig, PiModelProvidersSnapshot } from '../src/omp/domain/index.js'
import { ProvidersSettings } from '../src/features/settings/components/modelProviders/ProvidersSettings'
import { readModelProvidersSnapshot, saveModelProvider as persistProvider } from '../../server/src/host/models-config'

const mocks = vi.hoisted(() => ({
  loadModels: vi.fn(),
  listProviders: vi.fn(),
  saveProvider: vi.fn(),
  deleteProvider: vi.fn(),
  lookupModel: vi.fn(),
  generation: 0,
  serverId: 'first',
}))

vi.mock('../src/omp/controllers/index.js', () => ({ loadPiModels: mocks.loadModels }))
vi.mock('../src/omp/modelSettingsSync', () => ({ refreshModelSettings: vi.fn() }))
vi.mock('../src/omp/transport/index.js', () => ({
  listModelProviders: mocks.listProviders,
  saveModelProvider: mocks.saveProvider,
  deleteModelProvider: mocks.deleteProvider,
  lookupModelsDevModel: mocks.lookupModel,
}))
vi.mock('../src/omp/hooks/index.js', () => ({
  usePiModels: () => ({ syncStatus: 'disconnected' }),
}))
vi.mock('../src/hooks/useServerStore', () => ({
  useServerStore: () => ({ activeServer: { id: mocks.serverId }, activeServerGeneration: mocks.generation }),
}))
vi.mock('../src/store/serverStore', () => ({
  serverStore: {
    getActiveServer: () => ({ id: mocks.serverId }),
    getActiveServerGeneration: () => mocks.generation,
  },
}))
vi.mock('../src/hooks', () => ({ useIsMobile: () => false }))
vi.mock('../src/features/settings/components/modelProviders/ProviderModelPickerDialog', () => ({ ProviderModelPickerDialog: () => null }))

function provider(id = 'demo', baseUrl = `https://${id}.test/v1`): PiModelProviderConfig {
  return {
    id,
    name: id === 'demo' ? 'Demo' : id,
    api: 'openai-completions',
    baseUrl,
    apiKey: 'secret',
    models: [{ id: 'A', name: 'Model A', contextWindow: 64_000, cost: { input: 7, output: 11 } }],
  }
}

function snapshot(providers: PiModelProviderConfig[]): PiModelProvidersSnapshot {
  return { supported: true, exists: true, path: '/models.yml', providers }
}

async function openSettings() {
  const view = render(<ProvidersSettings />)
  await screen.findByLabelText('Base URL')
  vi.useFakeTimers()
  return view
}

async function renameModel(id: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Configure model' }))
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: id } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
}

async function debounce() {
  await act(async () => vi.advanceTimersByTimeAsync(600))
}

function beginDelete() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete provider' }))
  fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }))
}

async function usePersistedProviders() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ompiui-provider-drafts-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', directory)
  vi.stubEnv('OMP_PROFILE', 'default')
  vi.stubEnv('PI_PROFILE', 'default')
  const file = path.join(directory, 'models.yml')
  await writeFile(file, `providers:
  demo:
    name: Demo
    api: openai-completions
    baseUrl: https://demo.test/v1
    apiKey: secret
    models:
      - id: A
        name: Model A
        contextWindow: 64000
        cost: { input: 7, output: 11 }
        compat: { reasoningContentField: reasoning_content }
`)
  mocks.listProviders.mockImplementation(readModelProvidersSnapshot)
  mocks.saveProvider.mockImplementation((config: PiModelProviderConfig) => persistProvider({ ...config }))
  return {
    read: async () => parseYaml(await readFile(file, 'utf8')).providers.demo,
    cleanup: async () => {
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function finishSaves() {
  for (const result of mocks.saveProvider.mock.results) {
    await act(async () => { await result.value })
  }
}

describe('provider settings persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.generation = 0
    mocks.serverId = 'first'
    mocks.loadModels.mockResolvedValue([])
    mocks.lookupModel.mockResolvedValue({ found: false })
    mocks.listProviders.mockResolvedValue(snapshot([provider()]))
    mocks.saveProvider.mockImplementation(async (config: PiModelProviderConfig) => snapshot([config]))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('retains hidden model fields after a rename and a later provider save', async () => {
    const persisted = await usePersistedProviders()
    try {
      await openSettings()
      await renameModel('B')
      await finishSaves()
      fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://edited.test/v1' } })
      await debounce()
      await finishSaves()
      const stored = await persisted.read()
      expect(stored.baseUrl).toBe('https://edited.test/v1')
      expect(stored.models).toEqual([expect.objectContaining({
        id: 'B', cost: { input: 7, output: 11 }, compat: { reasoningContentField: 'reasoning_content' },
      })])
      expect(screen.getByLabelText('Base URL')).toHaveValue('https://edited.test/v1')
      expect(screen.getByText('B')).toBeVisible()
    } finally {
      cleanup()
      await finishSaves()
      await persisted.cleanup()
    }
  })

  it('retains hidden fields through multiple queued renames and newer provider edits', async () => {
    const persisted = await usePersistedProviders()
    const firstSave = Promise.withResolvers<void>()
    const secondSave = Promise.withResolvers<void>()
    mocks.saveProvider
      .mockImplementationOnce(async (config: PiModelProviderConfig) => {
        await firstSave.promise
        return persistProvider({ ...config })
      })
      .mockImplementationOnce(async (config: PiModelProviderConfig) => {
        await secondSave.promise
        return persistProvider({ ...config })
      })
    try {
      await openSettings()
      await renameModel('B')
      await renameModel('C')
      fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://newer.test/v1' } })
      await debounce()
      expect(mocks.saveProvider.mock.calls.map(call => call[0].models[0].id)).toEqual(['B'])
      await act(async () => {
        firstSave.resolve()
        await mocks.saveProvider.mock.results[0]!.value
      })
      await renameModel('D')
      fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'later-secret' } })
      await debounce()
      expect(mocks.saveProvider.mock.calls.map(call => call[0].models[0].id)).toEqual(['B', 'C'])
      await act(async () => {
        secondSave.resolve()
        await mocks.saveProvider.mock.results[1]!.value
      })
      await debounce()
      await finishSaves()
      const stored = await persisted.read()
      expect(stored).toMatchObject({ baseUrl: 'https://newer.test/v1', apiKey: 'later-secret' })
      expect(stored.models).toEqual([expect.objectContaining({
        id: 'D', cost: { input: 7, output: 11 }, compat: { reasoningContentField: 'reasoning_content' },
      })])
      expect(screen.getByText('D')).toBeVisible()
    } finally {
      firstSave.resolve()
      secondSave.resolve()
      cleanup()
      await finishSaves()
      await persisted.cleanup()
    }
  })

  it('does not copy a renamed model identity or hidden fields to a new model reusing its old id', async () => {
    const persisted = await usePersistedProviders()
    const firstSave = Promise.withResolvers<void>()
    mocks.saveProvider.mockImplementationOnce(async (config: PiModelProviderConfig) => {
      await firstSave.promise
      return persistProvider({ ...config })
    })
    try {
      await openSettings()
      await renameModel('B')
      fireEvent.click(screen.getByRole('button', { name: 'Add model' }))
      fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'A' } })
      await act(async () => { await Promise.resolve() })
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
      firstSave.resolve()
      await finishSaves()
      const stored = await persisted.read()
      expect(stored.models).toEqual([
        expect.objectContaining({ id: 'B', cost: { input: 7, output: 11 }, compat: { reasoningContentField: 'reasoning_content' } }),
        expect.objectContaining({ id: 'A' }),
      ])
      expect(stored.models[1].cost).toBeUndefined()
      expect(stored.models[1].compat).toBeUndefined()
    } finally {
      firstSave.resolve()
      cleanup()
      await finishSaves()
      await persisted.cleanup()
    }
  })

  it('uses the current identity when an editor was open during save completion', async () => {
    const firstSave = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.saveProvider.mockReturnValueOnce(firstSave.promise)
    await openSettings()
    await renameModel('B')
    fireEvent.click(screen.getByRole('button', { name: 'Configure model' }))
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'C' } })
    await act(async () => firstSave.resolve(snapshot([{ ...provider(), models: [{ id: 'B' }] }])))
    expect(screen.getByLabelText('Model ID')).toHaveValue('C')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
    expect(mocks.saveProvider.mock.lastCall![0].models[0]).toMatchObject({ id: 'C', originalId: 'B' })
    expect(screen.getByText('C')).toBeVisible()
  })

  it.each(['notification', 'manual'] as const)('keeps pending edits on %s refresh while clean providers update', async mode => {
    mocks.listProviders.mockResolvedValue(snapshot([provider(), provider('other'), provider('clean')]))
    const firstSave = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.saveProvider.mockReturnValueOnce(firstSave.promise)
    await openSettings()
    await renameModel('B')
    fireEvent.click(screen.getByRole('button', { name: /^other/ }))
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://pending.test/v1' } })
    mocks.listProviders.mockResolvedValue(snapshot([
      { ...provider(), models: [{ id: 'B', name: 'Model A' }] },
      provider('other'), provider('clean', 'https://external.test/v1'),
    ]))
    const refresh = async () => act(async () => {
      if (mode === 'notification') window.dispatchEvent(new Event('ompiui:models-updated'))
      else fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    })
    await refresh()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://pending.test/v1')
    await act(async () => firstSave.resolve(snapshot([{ ...provider(), models: [{ id: 'B' }] }])))
    await refresh()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://pending.test/v1')
    await debounce()
    expect(mocks.saveProvider.mock.lastCall![0]).toMatchObject({ id: 'other', baseUrl: 'https://pending.test/v1' })
    fireEvent.click(screen.getByRole('button', { name: /^clean/ }))
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://external.test/v1')
    fireEvent.click(screen.getByRole('button', { name: /^Demo/ }))
    expect(screen.getByText('B')).toBeVisible()
  })

  it('does not let a pre-save refresh erase the successful rename', async () => {
    const staleRead = Promise.withResolvers<PiModelProvidersSnapshot>()
    const firstSave = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.saveProvider.mockReturnValueOnce(firstSave.promise)
    await openSettings()
    await renameModel('B')
    mocks.listProviders.mockReturnValueOnce(staleRead.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await act(async () => firstSave.resolve(snapshot([{ ...provider(), models: [{ id: 'B' }] }])))
    await act(async () => staleRead.resolve(snapshot([provider()])))
    expect(screen.getByText('B')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://after.test/v1' } })
    await debounce()
    expect(mocks.saveProvider.mock.lastCall![0].models[0]).toMatchObject({ id: 'B', originalId: 'B' })
  })

  it('cancels delayed delete and queued writes on switch', async () => {
    const firstSave = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.saveProvider.mockReturnValueOnce(firstSave.promise)
    const view = await openSettings()
    await renameModel('B')
    await renameModel('C')
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://unsaved.test/v1' } })
    beginDelete()
    mocks.serverId = 'second'
    mocks.generation += 1
    mocks.listProviders.mockResolvedValue(snapshot([provider('demo', 'https://second.test/v1')]))
    await act(async () => view.rerender(<ProvidersSettings />))
    await act(async () => firstSave.resolve(snapshot([{ ...provider(), models: [{ id: 'B' }] }])))
    await debounce()
    expect(mocks.deleteProvider).not.toHaveBeenCalled()
    expect(mocks.saveProvider.mock.calls.map(call => call[0].models[0].id)).toEqual(['B'])
    expect(mocks.saveProvider.mock.calls[0]![1].aborted).toBe(true)
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://second.test/v1')
    expect(screen.getByText('A')).toBeVisible()
  })

  it('lets queued writes finish on unmount', async () => {
    const firstSave = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.saveProvider.mockReturnValueOnce(firstSave.promise)
    const view = await openSettings()
    await renameModel('B')
    await renameModel('C')
    view.unmount()
    await act(async () => firstSave.resolve(snapshot([{ ...provider(), models: [{ id: 'B' }] }])))
    await debounce()
    expect(mocks.saveProvider.mock.calls.map(call => call[0].models[0].id)).toEqual(['B', 'C'])
    expect(mocks.saveProvider.mock.calls[1]![1].aborted).toBe(false)
  })

  it('flushes a debounced edit when the page closes before the debounce fires', async () => {
    const view = await openSettings()
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://closing.test/v1' } })
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(mocks.saveProvider).not.toHaveBeenCalled()
    view.unmount()
    await act(async () => { await vi.runAllTimersAsync() })
    expect(mocks.saveProvider).toHaveBeenCalledTimes(1)
    expect(mocks.saveProvider.mock.calls[0]![0].baseUrl).toBe('https://closing.test/v1')
    expect(mocks.saveProvider.mock.calls[0]![1].aborted).toBe(false)
  })

  it('does not send a debounced edit to the next server after a server switch', async () => {
    const view = await openSettings()
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://first-only.test/v1' } })
    mocks.serverId = 'second'
    mocks.generation += 1
    mocks.listProviders.mockResolvedValue(snapshot([provider('demo', 'https://second.test/v1')]))
    await act(async () => view.rerender(<ProvidersSettings />))
    await act(async () => { await vi.runAllTimersAsync() })
    expect(mocks.saveProvider).not.toHaveBeenCalled()
  })

  it('fences a delayed delete immediately when the server generation changes before rendering', async () => {
    const firstSave = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.saveProvider.mockReturnValueOnce(firstSave.promise)
    const view = await openSettings()
    await renameModel('B')
    await renameModel('C')
    beginDelete()
    // Reconnecting the same server must fence the old queue even before the hook rerenders.
    mocks.generation += 1
    await act(async () => firstSave.resolve(snapshot([{ ...provider(), models: [{ id: 'B' }] }])))
    await debounce()
    expect(mocks.deleteProvider).not.toHaveBeenCalled()
    expect(mocks.saveProvider.mock.calls.map(call => call[0].models[0].id)).toEqual(['B'])
    await act(async () => view.rerender(<ProvidersSettings />))
    expect(screen.getByText('A')).toBeVisible()
  })

  it('ignores a delete result from the previous server', async () => {
    const deletion = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.deleteProvider.mockReturnValueOnce(deletion.promise)
    const view = await openSettings()
    beginDelete()
    await act(async () => { await Promise.resolve() })
    mocks.serverId = 'second'
    mocks.generation += 1
    mocks.listProviders.mockResolvedValue(snapshot([provider('demo', 'https://second.test/v1')]))
    await act(async () => view.rerender(<ProvidersSettings />))
    await act(async () => deletion.resolve(snapshot([])))
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://second.test/v1')
    expect(screen.getByText('A')).toBeVisible()
  })

  it('ignores old-server reads and out-of-order refresh results', async () => {
    const oldServerRead = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.listProviders.mockReturnValueOnce(oldServerRead.promise)
    const view = render(<ProvidersSettings />)
    mocks.serverId = 'second'
    mocks.generation += 1
    mocks.listProviders.mockResolvedValue(snapshot([provider('demo', 'https://second.test/v1')]))
    await act(async () => view.rerender(<ProvidersSettings />))
    await screen.findByDisplayValue('https://second.test/v1')
    await act(async () => oldServerRead.resolve(snapshot([provider()])))
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://second.test/v1')
    const staleRead = Promise.withResolvers<PiModelProvidersSnapshot>()
    mocks.listProviders.mockReturnValueOnce(staleRead.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    mocks.listProviders.mockResolvedValue(snapshot([provider('demo', 'https://latest.test/v1')]))
    await act(async () => window.dispatchEvent(new Event('ompiui:models-updated')))
    await act(async () => staleRead.resolve(snapshot([provider('demo', 'https://obsolete.test/v1')])))
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://latest.test/v1')
  })

  it('cancels a pending debounce on switch without transporting it', async () => {
    const view = await openSettings()
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'old-server-secret' } })
    mocks.serverId = 'second'
    mocks.generation += 1
    mocks.listProviders.mockResolvedValue(snapshot([provider('demo', 'https://second.test/v1')]))
    await act(async () => view.rerender(<ProvidersSettings />))
    await debounce()
    expect(mocks.saveProvider).not.toHaveBeenCalled()
    expect(screen.getByLabelText('API Key')).toHaveValue('secret')
  })

  it('preserves edits across refresh errors and allows retrying a failed rename save', async () => {
    mocks.saveProvider.mockRejectedValueOnce(new Error('write denied'))
    await openSettings()
    vi.mocked(mocks.loadModels).mockRejectedValueOnce(new Error('omp RPC process has exited'))
    await renameModel('B')
    expect(screen.getByRole('button', { name: 'Retry save' })).toHaveAttribute('title', 'write denied')
    mocks.listProviders.mockResolvedValueOnce({ ...snapshot([]), error: 'invalid YAML' })
    await act(async () => window.dispatchEvent(new Event('ompiui:models-updated')))
    expect(screen.getByText('B')).toBeVisible()
    expect(screen.getByText(/invalid YAML/)).toBeVisible()
    mocks.listProviders.mockRejectedValueOnce(new Error('network unavailable'))
    await act(async () => window.dispatchEvent(new Event('ompiui:models-updated')))
    expect(screen.getByText('B')).toBeVisible()
    expect(screen.getByText(/network unavailable/)).toBeVisible()
    mocks.listProviders.mockResolvedValueOnce(snapshot([provider()]))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reload' })))
    expect(screen.getByText('B')).toBeVisible()
    expect(screen.queryByText(/network unavailable/)).not.toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry save' })))
    expect(mocks.saveProvider.mock.lastCall![0].models[0]).toMatchObject({ id: 'B', originalId: 'A' })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'retry-secret' } })
    await debounce()
    expect(mocks.saveProvider.mock.lastCall![0]).toMatchObject({
      apiKey: 'retry-secret', models: [{ id: 'B', originalId: 'B' }],
    })
  })
})
