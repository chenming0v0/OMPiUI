import { useState, type ComponentProps } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchModelProviderModels } from '../../../../omp/transport/index.js'
import { blankModelDraft, type ProviderDraft } from './providerTypes'
import { ProviderModelPickerDialog } from './ProviderModelPickerDialog'

const viewport = vi.hoisted(() => ({ mobile: true }))
vi.mock('../../../../hooks', () => ({ useIsMobile: () => viewport.mobile }))
vi.mock('../../../../omp/transport/index.js', () => ({ fetchModelProviderModels: vi.fn() }))

const initialProvider: ProviderDraft = {
  id: 'demo',
  name: 'Demo',
  baseUrl: 'https://example.test/v1',
  apiKey: '',
  api: 'openai-responses',
  models: [blankModelDraft('gpt-existing'), blankModelDraft('local-only')],
}

function pendingFetch() {
  let resolve!: (result: Awaited<ReturnType<typeof fetchModelProviderModels>>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Awaited<ReturnType<typeof fetchModelProviderModels>>>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function renderPicker(overrides: Partial<ComponentProps<typeof ProviderModelPickerDialog>> = {}) {
  const props: ComponentProps<typeof ProviderModelPickerDialog> = {
    isOpen: true,
    provider: initialProvider,
    onClose: vi.fn(),
    onAddModels: vi.fn(),
    onRemoveModels: vi.fn(),
    ...overrides,
  }
  const view = render(<ProviderModelPickerDialog {...props} />)
  return {
    rerender: (next: Partial<typeof props>) => view.rerender(<ProviderModelPickerDialog {...props} {...next} />),
  }
}

function LivePicker() {
  const [provider, setProvider] = useState(initialProvider)
  return (
    <ProviderModelPickerDialog
      isOpen
      provider={provider}
      onClose={vi.fn()}
      onAddModels={ids =>
        setProvider(current => ({
          ...current,
          models: [...current.models, ...ids.map(id => blankModelDraft(id))],
        }))
      }
      onRemoveModels={ids =>
        setProvider(current => ({
          ...current,
          models: current.models.filter(model => !ids.includes(model.id)),
        }))
      }
    />
  )
}

describe('ProviderModelPickerDialog responsive flows', () => {
  beforeEach(() => {
    viewport.mobile = true
    vi.mocked(fetchModelProviderModels)
      .mockReset()
      .mockResolvedValue({
      models: ['gpt-existing', 'gpt-new', 'claude-new'],
      removed: ['local-only'],
      total: 3,
      })
  })

  it.each([true, false])('enters loading and clears the error on retry (mobile: %s)', async mobile => {
    viewport.mobile = mobile
    const pending = pendingFetch()
    vi.mocked(fetchModelProviderModels).mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(pending.promise)
    renderPicker()
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByText(/offline/)).toBeInTheDocument()
    fireEvent.click(retry)
    expect(screen.getByText('Fetching models from upstream…')).toBeInTheDocument()
    expect(screen.queryByText(/offline/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    fireEvent.click(retry)
    await act(async () => {})
    expect(fetchModelProviderModels).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Fetching models from upstream…')).toBeInTheDocument()
  })

  it.each([
    { baseUrl: 'https://other.test/v1' },
    { api: 'openai-completions' as const },
    { apiKey: 'replacement-key' },
    { models: [blankModelDraft('replacement-model')] },
  ])('enters loading on a fetch identity change after a settled response: %j', async patch => {
    viewport.mobile = false
    const pending = pendingFetch()
    vi.mocked(fetchModelProviderModels).mockReturnValueOnce(Promise.resolve({ models: [], removed: [], total: 0 }))
      .mockReturnValueOnce(pending.promise)
    const { rerender } = renderPicker()
    await waitFor(() => expect(screen.queryByText('Fetching models from upstream…')).not.toBeInTheDocument())
    const provider = { ...initialProvider, ...patch }
    rerender({ provider })
    expect(fetchModelProviderModels).toHaveBeenCalledTimes(2)
    expect(fetchModelProviderModels).toHaveBeenLastCalledWith({
      baseUrl: provider.baseUrl,
      api: provider.api,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      knownModelIds: provider.models.map(model => model.id),
    })
    expect(screen.getByText('Fetching models from upstream…')).toBeInTheDocument()
    await act(async () => {})
    expect(screen.getByText('Fetching models from upstream…')).toBeInTheDocument()
  })

  it('clears a settled fetch error when provider credentials change', async () => {
    const pending = pendingFetch()
    vi.mocked(fetchModelProviderModels).mockRejectedValueOnce(new Error('old credentials')).mockReturnValueOnce(pending.promise)
    const { rerender } = renderPicker()
    expect(await screen.findByRole('alert')).toHaveTextContent('old credentials')
    rerender({ provider: { ...initialProvider, apiKey: 'new-key' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Fetching models from upstream…')
    expect(fetchModelProviderModels).toHaveBeenCalledTimes(2)
  })

  it('does not settle the current fetch with a cancelled response', async () => {
    const previous = pendingFetch()
    const current = pendingFetch()
    vi.mocked(fetchModelProviderModels).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const { rerender } = renderPicker()
    rerender({ provider: { ...initialProvider, baseUrl: 'https://other.test/v1' } })
    await act(async () => previous.resolve({ models: ['stale-model'], removed: [], total: 1 }))
    expect(screen.getByRole('status')).toHaveTextContent('Fetching models from upstream…')
    expect(screen.queryByRole('button', { name: 'Add model stale-model' })).not.toBeInTheDocument()
    await act(async () => current.resolve({ models: ['current-model'], removed: [], total: 1 }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add model current-model' })).toBeVisible())
  })

  it('shows the missing URL error immediately and starts loading once a URL is supplied', () => {
    vi.mocked(fetchModelProviderModels).mockReturnValueOnce(pendingFetch().promise)
    const { rerender } = renderPicker({ provider: { ...initialProvider, baseUrl: '' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Fill in the Base URL and API key first')
    expect(fetchModelProviderModels).not.toHaveBeenCalled()
    rerender({ provider: initialProvider })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Fetching models from upstream…')
    expect(fetchModelProviderModels).toHaveBeenCalledTimes(1)
  })

  it('resets and reloads on reopening and ignores the previous request error', async () => {
    const previous = pendingFetch()
    const current = pendingFetch()
    vi.mocked(fetchModelProviderModels).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
    const { rerender } = renderPicker()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by model name' }), { target: { value: 'old query' } })
    rerender({ isOpen: false })
    rerender({ isOpen: true })
    expect(fetchModelProviderModels).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('textbox', { name: 'Filter by model name' })).toHaveValue('')
    await act(async () => previous.reject(new Error('cancelled request')))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Fetching models from upstream…')
  })

  it('keeps the latest mobile membership for a retry without refetching membership changes', async () => {
    const pending = pendingFetch()
    vi.mocked(fetchModelProviderModels).mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(pending.promise)
    const { rerender } = renderPicker()
    await screen.findByRole('button', { name: 'Retry' })
    rerender({ provider: { ...initialProvider, models: [blankModelDraft('latest-model')] } })
    expect(fetchModelProviderModels).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(fetchModelProviderModels).toHaveBeenLastCalledWith(expect.objectContaining({ knownModelIds: ['latest-model'] }))
    expect(screen.getByRole('status')).toHaveTextContent('Fetching models from upstream…')
  })

  it('keeps the mobile sheet and query open after adding and removing without refetching', async () => {
    render(<LivePicker />)
    await screen.findByRole('button', { name: 'Add model gpt-new' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by model name' }), { target: { value: 'gpt-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add model gpt-new' }))
    expect(screen.getByRole('button', { name: 'Delete model gpt-new' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Filter by model name' })).toHaveValue('gpt-new')
    fireEvent.click(screen.getByRole('button', { name: 'Delete model gpt-new' }))
    expect(screen.getByRole('button', { name: 'Add model gpt-new' })).toBeVisible()
    expect(fetchModelProviderModels).toHaveBeenCalledTimes(1)
  })

  it('adds only filtered unconfigured models and keeps local-only models visible', async () => {
    render(<LivePicker />)
    await screen.findByRole('button', { name: 'Add model gpt-new' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete model local-only' })).toBeVisible())
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by model name' }), { target: { value: 'gpt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select all (1)' }))
    expect(screen.getByRole('button', { name: 'Delete model gpt-new' })).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by model name' }), { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Add model claude-new' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Delete model gpt-existing' })).toBeVisible()
  })

  it('keeps desktop selection staged until confirmation', async () => {
    viewport.mobile = false
    const onAddModels = vi.fn()
    render(
      <ProviderModelPickerDialog
        isOpen
        provider={initialProvider}
        onClose={vi.fn()}
        onAddModels={onAddModels}
        onRemoveModels={vi.fn()}
      />,
    )
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search models' }), {
      target: { value: 'gpt-new' },
    })
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: 'gpt-new' })).toBeVisible())
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'gpt-new' }))
    expect(onAddModels).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add selected' }))
    expect(onAddModels).toHaveBeenCalledWith(['gpt-new'])
  })
})
